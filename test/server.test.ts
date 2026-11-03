import { describe, expect, it } from "vitest";
import { jsonFetch, jsonResponse, runtimeFor } from "./harness.js";
import { connectServer } from "./mcp.js";

describe("createServer", () => {
  it("lists the read-only tools when SHLINK_TOOLSETS is unset", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ ok: true }));
    const runtime = runtimeFor(fetchImpl, { SHLINK_TOOLSETS: undefined });
    const connected = await connectServer(runtime);
    try {
      const listed = await connected.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "shlink_domains",
        "shlink_meta",
        "shlink_redirect_rules",
        "shlink_short_urls",
        "shlink_tags",
        "shlink_visits",
      ]);
    } finally {
      await connected.close();
    }
  });
});
