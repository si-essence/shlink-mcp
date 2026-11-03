import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { createRuntime } from "../src/runtime.js";

const KEY = "super-secret/key+value=99";
const URL = "https://shlink.test";
const recordSchema = z.object({ status: z.string(), version: z.string() });

function runtimeFor(options: {
  fetchImpl: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}) {
  return createRuntime(
    loadConfig(
      {
        SHLINK_URL: URL,
        SHLINK_API_KEY: KEY,
        ...options.env,
      },
      [],
    ),
    {
      fetchImpl: options.fetchImpl,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  const record = input as { url?: unknown; href?: unknown };
  if (typeof record.url === "string") return record.url;
  if (typeof record.href === "string") return record.href;
  return "";
}

describe("HttpClient", () => {
  it("sends no key on health, caches the body, and does not prefix a path", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      urls.push(requestUrl(input));
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBeNull();
      return Promise.resolve(Response.json({ status: "pass", version: "5.1.8" }));
    });
    let now = 0;
    const runtime = runtimeFor({
      fetchImpl,
      env: { SHLINK_CACHE_TTL_SEC: "30" },
      now: () => now,
    });
    const first = await runtime.client.getJson(
      { path: "rest/health", query: undefined, ttlSec: 30, auth: "none" },
      recordSchema,
    );
    const second = await runtime.client.getJson(
      { path: "rest/health", query: undefined, ttlSec: 30, auth: "none" },
      recordSchema,
    );
    expect(first).toEqual({ status: "pass", version: "5.1.8" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(urls[0]).toBe(`${URL}/rest/health`);
    expect(urls.join("\n")).not.toContain(KEY);
    now = 31_000;
    await runtime.client.getJson(
      { path: "rest/health", query: undefined, ttlSec: 30, auth: "none" },
      recordSchema,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends X-Api-Key on authenticated routes and never Authorization", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe(KEY);
      expect(headers.get("authorization")).toBeNull();
      return Promise.resolve(Response.json({ status: "pass", version: "5.1.8" }));
    });
    const runtime = runtimeFor({ fetchImpl });
    const body = await runtime.client.getJson(
      { path: "rest/v3/short-urls", query: undefined, ttlSec: 0, auth: "key" },
      z.unknown(),
    );
    expect(body).toEqual({ status: "pass", version: "5.1.8" });
  });

  it("does not spend the rate limit on a cache hit and blocks the next miss", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ status: "pass", version: "5.1.8" })),
    );
    const runtime = runtimeFor({
      fetchImpl,
      env: { SHLINK_PER_MINUTE: "1", SHLINK_CACHE_TTL_SEC: "60" },
      now: () => 0,
    });
    await runtime.client.getJson(
      { path: "rest/health", query: undefined, ttlSec: 60, auth: "none" },
      recordSchema,
    );
    await expect(
      runtime.client.getJson(
        { path: "rest/v3/tags", query: undefined, ttlSec: 0, auth: "key" },
        z.unknown(),
      ),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("redacts a secret that the upstream body or a network error tried to echo", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error(`connect failed ${KEY} ${encodeURIComponent(KEY)}`);
    });
    const runtime = createRuntime(loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY }, []), {
      fetchImpl,
      logger: { info: () => undefined, error: (message) => logs.push(message) },
    });
    await expect(
      runtime.client.getJson(
        { path: "rest/v3/short-urls", query: undefined, ttlSec: 0, auth: "key" },
        z.unknown(),
      ),
    ).rejects.toThrow(ConnectorError);
    try {
      await runtime.client.getJson(
        { path: "rest/v3/short-urls", query: undefined, ttlSec: 0, auth: "key" },
        z.unknown(),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain(encodeURIComponent(KEY));
      expect(error.message).toContain("[redacted]");
    }
    expect(logs.join("\n")).not.toContain(KEY);
  });

  it("maps 401, 403, 404, 400, 422, and 429, and parses problem+json", async () => {
    const notFound = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "https://shlink.io/api/error/short-url-not-found",
            title: "Short URL not found",
            detail: "No URL found for abc",
            status: 404,
          }),
          { status: 404, headers: { "content-type": "application/problem+json" } },
        ),
      ),
    );
    await expect(
      runtimeFor({ fetchImpl: notFound }).client.getJson(
        { path: "rest/v3/short-urls/abc", query: undefined, ttlSec: 0, auth: "key" },
        z.unknown(),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    const unauth = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("nope", { status: 401 })),
    );
    await expect(
      runtimeFor({ fetchImpl: unauth }).client.getJson(
        { path: "rest/v3/short-urls", query: undefined, ttlSec: 0, auth: "key" },
        z.unknown(),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });

    const forbidden = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("nope", { status: 403 })),
    );
    await expect(
      runtimeFor({ fetchImpl: forbidden }).client.delete({
        path: "rest/v3/tags",
        query: undefined,
        auth: "key",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const invalid = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "https://shlink.io/api/error/invalid-data",
            title: "Invalid data",
            detail: "Provided data is not valid",
            status: 400,
            invalidElements: ["customSlug"],
          }),
          { status: 400, headers: { "content-type": "application/problem+json" } },
        ),
      ),
    );
    try {
      await runtimeFor({ fetchImpl: invalid }).client.postJson(
        { path: "rest/v3/short-urls", query: undefined, body: {}, auth: "key" },
        z.unknown(),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("input");
      expect(error.message).toContain("Invalid data");
      expect(error.message).toContain("customSlug");
      expect(error.message).not.toContain(KEY);
    }

    const unprocessable = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("bad", { status: 422 })),
    );
    await expect(
      runtimeFor({ fetchImpl: unprocessable }).client.delete({
        path: "rest/v3/short-urls/abc",
        query: undefined,
        auth: "key",
      }),
    ).rejects.toMatchObject({ code: "input" });

    const limited = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(`slow ${KEY}`, { status: 429, headers: { "retry-after": "4" } }),
      ),
    );
    try {
      await runtimeFor({ fetchImpl: limited }).client.getJson(
        { path: "rest/v3/short-urls", query: undefined, ttlSec: 0, auth: "key" },
        z.unknown(),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "rate_limit", retryAfterSeconds: 4 });
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.message).not.toContain(KEY);
    }
  });

  it("maps timeout", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("missing abort signal"));
          return;
        }
        const abort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    const timeoutRuntime = runtimeFor({
      fetchImpl: hanging,
      env: { SHLINK_TIMEOUT_MS: "100" },
    });
    await expect(
      timeoutRuntime.client.getJson(
        { path: "rest/health", query: undefined, ttlSec: 0, auth: "none" },
        recordSchema,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses to put a secret in the query string", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json({ status: "pass", version: "5.1.8" })),
    );
    const runtime = runtimeFor({ fetchImpl });
    await expect(
      runtime.client.getJson(
        { path: "rest/v3/short-urls", query: { searchTerm: KEY }, ttlSec: 0, auth: "key" },
        z.unknown(),
      ),
    ).rejects.toThrow(/request URL/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
