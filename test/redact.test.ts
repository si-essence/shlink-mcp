import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { redact, redactUnknown } from "../src/redact.js";
import { createRuntime } from "../src/runtime.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);
const URL = "https://shlink.test";

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and auth headers", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://shlink.test/rest/v3/short-urls?access_token=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
      `Authorization: Basic ${KEY}`,
      `x-api-key: ${KEY}`,
      `x-auth-token: ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("access_token=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
    expect(cleaned).toContain("Basic [redacted]");
    expect(cleaned).toContain("x-api-key: [redacted]");
    expect(cleaned).toContain("x-auth-token: [redacted]");
  });

  it("redacts nested token, password, and integration secrets and leaves names", () => {
    const cleaned = redactUnknown(
      {
        username: "ada",
        token: "jwt-token-value-xxxx",
        password: "hunter2-secret-value",
        fever_password: "fever-secret-value-xx",
        googlereader_password: "greader-secret-value",
        wallabag_client_secret: "wallabag-secret-xx",
        folders: ["/data/shlink"],
        streamKeys: [{ key: "live-stream-key-value", comment: "obs" }],
        adminPassword: "admin-secret-value-xx",
      },
      [KEY],
    );
    const raw = JSON.stringify(cleaned);
    assertNoKey("nested", raw);
    expect(raw).toContain("ada");
    expect(raw).toContain("/data/shlink");
    expect(raw).not.toContain("live-stream-key-value");
    expect(raw).not.toContain("admin-secret-value-xx");
    expect(raw).not.toContain("jwt-token-value-xxxx");
    expect(raw).not.toContain("hunter2-secret-value");
    expect(raw).not.toContain("fever-secret-value-xx");
    expect(raw).not.toContain("greader-secret-value");
    expect(raw).not.toContain("wallabag-secret-xx");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });

  it("keeps the api key out of tool output, errors, and logs", async () => {
    const logs: string[] = [];
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
    });
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(Response.json({ id: 1, username: "ada", title: `hello ${KEY}` }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error_message: `bad ${KEY}` }), { status: 401 }),
      );
    });
    const runtime = createRuntime(
      loadConfig(
        {
          SHLINK_URL: URL,
          SHLINK_API_KEY: KEY,
          SHLINK_CACHE_TTL_SEC: "0",
          SHLINK_TOOLSETS: "short_urls",
        },
        [],
      ),
      {
        fetchImpl,
        logger: { info: () => undefined, error: (message) => logs.push(message) },
      },
    );
    const connected = await connectServer(runtime);
    try {
      const ok = readToolText(
        await connected.client.callTool({
          name: "shlink_short_urls",
          arguments: { action: "list" },
        }),
      );
      expect(ok.isError).toBe(false);
      assertNoKey("ok", ok.text);
      const failed = readToolText(
        await connected.client.callTool({
          name: "shlink_short_urls",
          arguments: { action: "list" },
        }),
      );
      expect(failed.isError).toBe(true);
      assertNoKey("err", failed.text);
      expect(failed.text).toContain("[unauthorized]");
    } finally {
      await connected.close();
      spy.mockRestore();
    }
    assertNoKey("logs", logs.join("\n"));
    assertNoKey("console", consoleLines.join("\n"));
  });
});
