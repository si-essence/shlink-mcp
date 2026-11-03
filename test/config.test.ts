import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { ALL_TOOLSETS, DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:8096";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("requires SHLINK_URL and SHLINK_API_KEY", () => {
    const missingUrl = messageOf(catchError(() => loadConfig({}, [])));
    expect(missingUrl).toContain("SHLINK_URL");
    expect(missingUrl).toContain("required");
    const missingKey = messageOf(catchError(() => loadConfig({ SHLINK_URL: URL }, [])));
    expect(missingKey).toContain("SHLINK_API_KEY");
    expect(missingKey).toContain("required");
    expect(missingKey).not.toContain(KEY);
  });

  it("applies defaults when the URL and key are set", () => {
    const config = loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY }, []);
    expect(config.apiKey).toBe(KEY);
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, MCP_TRANSPORT: "stdio" }, [
        "node",
        "app",
        "--http",
      ]).transport,
    ).toBe("http");
  });

  it("enables writes only when SHLINK_ALLOW_WRITES is the literal true", () => {
    expect(
      loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, SHLINK_ALLOW_WRITES: "true" }, [])
        .allowWrites,
    ).toBe(true);
    expect(
      loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, SHLINK_ALLOW_WRITES: "TRUE" }, [])
        .allowWrites,
    ).toBe(false);
    expect(
      loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, SHLINK_ALLOW_WRITES: "1" }, [])
        .allowWrites,
    ).toBe(false);
  });

  it("parses SHLINK_TOOLSETS", () => {
    expect(
      loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, SHLINK_TOOLSETS: "all" }, []).toolsets,
    ).toEqual([...ALL_TOOLSETS]);
    expect(
      loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, SHLINK_TOOLSETS: "meta, short_urls" }, [])
        .toolsets,
    ).toEqual(["meta", "short_urls"]);
  });

  it("rejects an unknown toolset without echoing the value", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ SHLINK_URL: URL, SHLINK_API_KEY: KEY, SHLINK_TOOLSETS: "nope" }, []),
      ),
    );
    expect(message).toContain("SHLINK_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("rejects a URL that embeds the API key", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ SHLINK_URL: `http://127.0.0.1/${KEY}`, SHLINK_API_KEY: KEY }, []),
      ),
    );
    expect(message).toContain("SHLINK_URL");
    expect(message).toContain("contains_secret");
    expect(message).not.toContain(KEY);
  });
});
