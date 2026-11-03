import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import { WRITES_DISABLED } from "../src/write-gate.js";
import { API_KEY, jsonFetch, jsonResponse, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();

function leakyBody(): Record<string, unknown> {
  return {
    shortCode: "abc12",
    longUrl: "https://example.com/mcp",
    apiKey: API_KEY,
    title: `hello ${API_KEY}`,
    stack: "at /var/shlink/App.php:10",
  };
}

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  if (Object.keys(operation.sampleQuery).length > 0) args["query"] = operation.sampleQuery;
  if (operation.sampleBody !== undefined) args["body"] = operation.sampleBody;
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(API_KEY);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("shlink tools", () => {
  it("publishes every tool with a compact description and confirm on writes", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse(leakyBody()));
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      expect(names).toHaveLength(11);
      for (const tool of listed.tools) {
        const description = tool.description ?? "";
        expect(description).toContain("action help");
        expect(description.length).toBeGreaterThan(40);
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).toContain("help");
        if (toolIsWrite(tool.name)) expect(schema).toContain("confirm");
        else expect(schema).not.toContain("confirm");
      }
    });
  });

  it("scopes the published set to SHLINK_TOOLSETS", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { SHLINK_TOOLSETS: "meta,short_urls" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "shlink_meta",
        "shlink_short_urls",
      ]);
    });
  });

  it("describes one action without calling upstream", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse(leakyBody()));
    await withClient(fetchImpl, {}, async (client) => {
      const described = await call(client, "shlink_short_urls_write", {
        action: "help",
        target: "create",
      });
      expect(described.isError).toBe(false);
      expect(described.json).toMatchObject({
        action: "create",
        method: "POST",
        path: "/rest/v{version}/short-urls",
        write: true,
      });
      expect(calls).toHaveLength(0);
    });
  });

  it("redacts the API key in a read result", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expect(captured.apiKey).toBe(API_KEY);
      return jsonResponse(leakyBody());
    });
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await call(client, "shlink_short_urls", { action: "list" });
      expect(listed.isError).toBe(false);
      const raw = JSON.stringify(listed.json);
      expect(raw).toContain("abc12");
      expect(raw).toContain("[redacted]");
      expect(raw).not.toContain(API_KEY);
      expect(raw).not.toContain("App.php");
      expect(calls[0]?.url).toBe("https://shlink.test/rest/v3/short-urls");
      expect(calls[0]?.apiKey).toBe(API_KEY);
    });
  });

  it("previews a write without confirm and executes when confirm is true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ shortCode: "mcpdemo" }));
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "shlink_short_urls_write", {
        action: "create",
        body: { longUrl: "https://example.com/mcp", customSlug: "mcpdemo", tags: ["demo"] },
      });
      expect(preview.json).toMatchObject({
        executed: false,
        dry_run: true,
        blocked: false,
        method: "POST",
      });
      expect(calls).toHaveLength(0);

      const sent = await call(client, "shlink_short_urls_write", {
        action: "create",
        body: { longUrl: "https://example.com/mcp", customSlug: "mcpdemo", tags: ["demo"] },
        confirm: true,
      });
      expect(sent.isError).toBe(false);
      expect(sent.json).toMatchObject({ executed: true, dry_run: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toBe("https://shlink.test/rest/v3/short-urls");
      expect(calls[0]?.apiKey).toBe(API_KEY);
      expect(calls[0]?.body).toEqual({
        longUrl: "https://example.com/mcp",
        customSlug: "mcpdemo",
        tags: ["demo"],
      });
    });
  });

  it("blocks writes when SHLINK_ALLOW_WRITES is not true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ ok: true }));
    await withClient(fetchImpl, { SHLINK_ALLOW_WRITES: "false" }, async (client) => {
      const blocked = await call(client, "shlink_short_urls_write", {
        action: "create",
        body: { longUrl: "https://example.com/mcp" },
        confirm: true,
      });
      expect(blocked.json).toMatchObject({ executed: false, dry_run: true, blocked: true });
      expect(JSON.stringify(blocked.json)).toContain(WRITES_DISABLED);
      expect(calls).toHaveLength(0);
    });
  });

  it("maps 401, 404, 422, and 429 through the tool", async () => {
    const cases: { status: number; needle: string }[] = [
      { status: 401, needle: "[unauthorized]" },
      { status: 404, needle: "[not-found]" },
      { status: 422, needle: "[input]" },
      { status: 429, needle: "[rate-limit]" },
    ];
    for (const item of cases) {
      const { fetchImpl } = jsonFetch(() =>
        jsonResponse(
          {
            type: "https://shlink.io/api/error/example",
            title: "Example",
            detail: "nope",
            status: item.status,
          },
          item.status,
          item.status === 429 ? { "retry-after": "3" } : undefined,
        ),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "shlink_short_urls", {
          action: "get",
          params: { shortCode: "missing" },
        });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(item.needle);
        expect(result.text).not.toContain(API_KEY);
      });
    }
  });

  it("uses sample args on a confirmed write without leaking the key", async () => {
    const write = OPERATIONS.find((row) => row.operationId === "createShortUrl");
    expect(write).toBeDefined();
    if (write === undefined) return;
    const { fetchImpl } = jsonFetch(() => jsonResponse({ shortCode: "mcpdemo", apiKey: API_KEY }));
    await withClient(fetchImpl, {}, async (client) => {
      const result = await call(client, write.tool, { ...argsFor(write), confirm: true });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("mcpdemo");
      expect(result.text).not.toContain(API_KEY);
    });
  });
});
