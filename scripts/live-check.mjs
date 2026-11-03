#!/usr/bin/env node
/**
 * Live check against a real Shlink 5.1.8 server. Spawns dist/index.js over
 * stdio. Skips when SHLINK_URL is unset. Does not print the API key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const keyFile = process.env["SHLINK_API_KEY_FILE"] ?? "/workspace/tools/shlink/api.key";

function readApiKey() {
  const fromEnv = process.env["SHLINK_API_KEY"] ?? "";
  if (fromEnv.trim().length >= 8) return fromEnv.trim();
  try {
    return readFileSync(keyFile, "utf8").trim();
  } catch {
    return "";
  }
}

const apiKey = readApiKey();
const baseUrl = process.env["SHLINK_URL"] ?? "http://127.0.0.1:8096";

/** @type {string[]} */
const secrets = [];
if (apiKey.length >= 8) secrets.push(apiKey);

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(x-api-key:\s*)\S+/gi, "$1[redacted]");
  out = out.replace(
    /"(api_?key|token|password|secret|authorization)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 200) shortened = `${shortened.slice(0, 197)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
let passed = 0;
/** @type {string[]} */
const rows = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (ok) passed += 1;
  else failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into tool output");
    }
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    const parsed = JSON.parse(text);
    json = isRecord(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

/**
 * @param {Record<string, string | undefined>} extra
 */
function childEnv(extra) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "DATABASE_URL") continue;
    if (key === "SHLINK_API_KEY" || key === "SHLINK_URL" || key === "SHLINK_ALLOW_WRITES") continue;
    env[key] = value;
  }
  delete env["DATABASE_URL"];
  env["SHLINK_URL"] = baseUrl;
  env["SHLINK_API_KEY"] = apiKey;
  env["SHLINK_TOOLSETS"] = "all";
  env["SHLINK_CACHE_TTL_SEC"] = "0";
  env["SHLINK_PER_MINUTE"] = "120";
  env["SHLINK_ALLOW_WRITES"] = "true";
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * @param {Record<string, string | undefined>} extra
 * @param {(client: import("@modelcontextprotocol/sdk/client/index.js").Client) => Promise<void>} run
 */
async function withServer(extra, run) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: childEnv(extra),
    stderr: "pipe",
  });
  const client = new Client({ name: "live-check", version: "0" });
  await client.connect(transport);
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

/**
 * @param {Record<string, unknown> | null} json
 */
function createdShortCode(json) {
  if (json === null) return undefined;
  const result = json["result"];
  if (!isRecord(result)) return undefined;
  const code = result["shortCode"];
  return typeof code === "string" ? code : undefined;
}

async function main() {
  if (baseUrl.trim().length === 0) {
    writeLine("SKIP  live-check  SHLINK_URL is unset.");
    return;
  }
  if (apiKey.length < 8) {
    writeLine("SKIP  live-check  SHLINK_API_KEY is missing.");
    return;
  }

  const stamp = Date.now().toString(36);
  const slug = `mcp${stamp}`.replace(/[^a-z0-9]/g, "").slice(0, 20);
  const longUrl = `https://example.com/mcp-live-${stamp}`;
  const otherUrl = `https://example.com/mcp-other-${stamp}`;
  const createBody = { longUrl, customSlug: slug, tags: ["mcplive"] };

  await withServer({ SHLINK_ALLOW_WRITES: "true" }, async (client) => {
    const tools = await client.listTools();
    record("tool list", tools.tools.length >= 6, `tools=${tools.tools.length}`);

    const health = await call(client, "shlink_meta", { action: "health" });
    const version =
      health.json !== null && typeof health.json["version"] === "string"
        ? health.json["version"]
        : "";
    record(
      "health",
      health.isError === false && health.json?.["status"] === "pass" && version === "5.1.8",
      clip(health.text),
    );

    const listed = await call(client, "shlink_short_urls", { action: "list", query: { page: 1 } });
    let count = "";
    const shortUrls = listed.json?.["shortUrls"];
    if (isRecord(shortUrls) && isRecord(shortUrls["pagination"])) {
      count = String(shortUrls["pagination"]["totalItems"]);
    }
    record("list short urls", listed.isError === false, `totalItems=${count} ${clip(listed.text)}`);

    const preview = await call(client, "shlink_short_urls_write", {
      action: "create",
      body: createBody,
    });
    record(
      "create preview",
      preview.isError === false &&
        preview.json?.["executed"] === false &&
        preview.json?.["dry_run"] === true &&
        preview.json?.["blocked"] === false,
      clip(preview.text),
    );
  });

  await withServer({ SHLINK_ALLOW_WRITES: "false" }, async (client) => {
    const guarded = await call(client, "shlink_short_urls_write", {
      action: "create",
      body: createBody,
      confirm: true,
    });
    record(
      "guarded create",
      guarded.isError === false &&
        guarded.json?.["executed"] === false &&
        guarded.json?.["dry_run"] === true &&
        guarded.json?.["blocked"] === true,
      clip(guarded.text),
    );
  });

  /** @type {string | undefined} */
  let shortCode;
  /** @type {string | undefined} */
  let shortUrl;

  await withServer({ SHLINK_ALLOW_WRITES: "true" }, async (client) => {
    const created = await call(client, "shlink_short_urls_write", {
      action: "create",
      body: createBody,
      confirm: true,
    });
    shortCode = createdShortCode(created.json);
    const result = created.json?.["result"];
    if (isRecord(result) && typeof result["shortUrl"] === "string") shortUrl = result["shortUrl"];
    const tags = isRecord(result) && Array.isArray(result["tags"]) ? result["tags"] : [];
    record(
      "confirmed create",
      created.isError === false &&
        created.json?.["executed"] === true &&
        shortCode === slug &&
        tags.includes("mcplive"),
      `shortCode=${shortCode ?? ""} ${clip(created.text)}`,
    );

    const duplicate = await call(client, "shlink_short_urls_write", {
      action: "create",
      body: { longUrl: otherUrl, customSlug: slug, tags: ["mcplive"] },
      confirm: true,
    });
    record(
      "duplicate slug",
      duplicate.isError === true && /\[input\]/.test(duplicate.text),
      clip(duplicate.text),
    );

    const got = await call(client, "shlink_short_urls", {
      action: "get",
      params: { shortCode: slug },
    });
    record(
      "get short url",
      got.isError === false && got.json?.["shortCode"] === slug,
      clip(got.text),
    );

    const edited = await call(client, "shlink_short_urls_write", {
      action: "edit",
      params: { shortCode: slug },
      body: { title: "Live check" },
      confirm: true,
    });
    const editedResult = edited.json?.["result"];
    record(
      "edit short url",
      edited.isError === false &&
        edited.json?.["executed"] === true &&
        isRecord(editedResult) &&
        editedResult["title"] === "Live check",
      clip(edited.text),
    );

    let hitStatus = 0;
    let hitLocation = "";
    if (shortUrl !== undefined) {
      const response = await fetch(shortUrl, { redirect: "manual" });
      hitStatus = response.status;
      hitLocation = response.headers.get("location") ?? "";
    }
    record(
      "hit short url",
      hitStatus === 302 && hitLocation.startsWith("https://example.com/mcp-live-"),
      `status=${hitStatus} location=${clip(hitLocation)}`,
    );

    const visits = await call(client, "shlink_visits", {
      action: "short_url",
      params: { shortCode: slug },
    });
    let total = -1;
    const visitPage = visits.json?.["visits"];
    if (isRecord(visitPage) && isRecord(visitPage["pagination"])) {
      const raw = visitPage["pagination"]["totalItems"];
      if (typeof raw === "number") total = raw;
    }
    record(
      "short url visits",
      visits.isError === false && total >= 1,
      `totalItems=${total} ${clip(visits.text)}`,
    );

    const tagsList = await call(client, "shlink_tags", { action: "list" });
    const tagData = tagsList.json?.["tags"];
    const names =
      isRecord(tagData) && Array.isArray(tagData["data"])
        ? tagData["data"].filter((item) => typeof item === "string")
        : [];
    record(
      "tag list",
      tagsList.isError === false && names.includes("mcplive"),
      `count=${names.length}`,
    );

    const tagStats = await call(client, "shlink_tags", { action: "stats" });
    record("tag stats", tagStats.isError === false, clip(tagStats.text));

    const domains = await call(client, "shlink_domains", { action: "list" });
    record("domains list", domains.isError === false, clip(domains.text));

    const rules = await call(client, "shlink_redirect_rules", {
      action: "list",
      params: { shortCode: slug },
    });
    record(
      "redirect rules read",
      rules.isError === false && typeof rules.json?.["defaultLongUrl"] === "string",
      clip(rules.text),
    );

    const setRules = await call(client, "shlink_redirect_rules_write", {
      action: "set",
      params: { shortCode: slug },
      body: {
        redirectRules: [
          {
            longUrl: "https://example.com/mcp-android",
            conditions: [{ type: "device", matchKey: null, matchValue: "android" }],
          },
        ],
      },
      confirm: true,
    });
    const setResult = setRules.json?.["result"];
    const ruleCount =
      isRecord(setResult) && Array.isArray(setResult["redirectRules"])
        ? setResult["redirectRules"].length
        : -1;
    record(
      "redirect rules set",
      setRules.isError === false && setRules.json?.["executed"] === true && ruleCount === 1,
      `rules=${ruleCount} ${clip(setRules.text)}`,
    );

    const deleted = await call(client, "shlink_short_urls_write", {
      action: "delete",
      params: { shortCode: slug },
      confirm: true,
    });
    record(
      "delete short url",
      deleted.isError === false && deleted.json?.["executed"] === true,
      clip(deleted.text),
    );

    const missing = await call(client, "shlink_short_urls", {
      action: "get",
      params: { shortCode: `missing${stamp}`.replace(/[^a-z0-9]/g, "").slice(0, 16) },
    });
    record(
      "unknown slug",
      missing.isError === true && missing.text.includes("[not-found]"),
      clip(missing.text),
    );
  });

  await withServer(
    { SHLINK_API_KEY: "not-the-real-key-value-xxxx", SHLINK_ALLOW_WRITES: "false" },
    async (client) => {
      const bad = await call(client, "shlink_short_urls", { action: "list" });
      record(
        "bad key",
        bad.isError === true && bad.text.includes("[unauthorized]"),
        clip(bad.text),
      );
    },
  );

  for (const row of rows) writeLine(row);
  writeLine(`RESULT  passed=${passed} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "live-check failed";
  writeError(redact(message));
  process.exitCode = 1;
});
