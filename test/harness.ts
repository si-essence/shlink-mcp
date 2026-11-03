import { loadConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const API_KEY = "super-secret/key+value=99";
export const BASE = "https://shlink.test";

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SHLINK_URL: BASE,
    SHLINK_API_KEY: API_KEY,
    SHLINK_CACHE_TTL_SEC: "0",
    SHLINK_ALLOW_WRITES: "true",
    SHLINK_TOOLSETS: "all",
    ...extra,
  };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(env(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | null;
  contentType: string | null;
  body: unknown;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const headers = new Headers(init?.headers);
  let body: unknown;
  if (init?.body === undefined) body = undefined;
  else if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
    }
  } else body = init.body;
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    apiKey: headers.get("x-api-key"),
    contentType: headers.get("content-type"),
    body,
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
