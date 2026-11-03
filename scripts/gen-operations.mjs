#!/usr/bin/env node
/**
 * Generate shlink.routes.json and src/operations.ts from the Shlink 5.1.8
 * OpenAPI spec in vendor/shlink-openapi (MIT, Shlink). Run:
 * node scripts/gen-operations.mjs
 *
 * Public redirects, the tracking pixel, and the deprecated query-string
 * create are excluded with a reason. Every other operation is mapped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = join(root, "vendor", "shlink-openapi");
const specPath = join(specRoot, "swagger.json");
const routesPath = join(root, "shlink.routes.json");
const outPath = join(root, "src", "operations.ts");

export const DEFAULT_TOOLSETS = [
  "short_urls",
  "visits",
  "tags",
  "domains",
  "redirect_rules",
  "meta",
];

const HTTP = ["get", "post", "put", "patch", "delete", "head", "options"];

/**
 * Read toolsets are the default. Write toolsets are opt-in.
 * @type {Record<string, { toolset: string, action: string, write: boolean, destructive: boolean, warning: string }>}
 */
const MAP = {
  listShortUrls: {
    toolset: "short_urls",
    action: "list",
    write: false,
    destructive: false,
    warning: "",
  },
  getShortUrl: {
    toolset: "short_urls",
    action: "get",
    write: false,
    destructive: false,
    warning: "",
  },
  createShortUrl: {
    toolset: "short_urls_write",
    action: "create",
    write: true,
    destructive: false,
    warning: "This creates a short URL.",
  },
  editShortUrl: {
    toolset: "short_urls_write",
    action: "edit",
    write: true,
    destructive: false,
    warning: "This changes a short URL.",
  },
  deleteShortUrl: {
    toolset: "short_urls_write",
    action: "delete",
    write: true,
    destructive: true,
    warning: "This deletes a short URL.",
  },
  getGlobalVisits: {
    toolset: "visits",
    action: "global",
    write: false,
    destructive: false,
    warning: "",
  },
  getShortUrlVisits: {
    toolset: "visits",
    action: "short_url",
    write: false,
    destructive: false,
    warning: "",
  },
  getTagVisits: {
    toolset: "visits",
    action: "tag",
    write: false,
    destructive: false,
    warning: "",
  },
  getDomainVisits: {
    toolset: "visits",
    action: "domain",
    write: false,
    destructive: false,
    warning: "",
  },
  getOrphanVisits: {
    toolset: "visits",
    action: "orphan",
    write: false,
    destructive: false,
    warning: "",
  },
  getNonOrphanVisits: {
    toolset: "visits",
    action: "non_orphan",
    write: false,
    destructive: false,
    warning: "",
  },
  deleteShortUrlVisits: {
    toolset: "visits_write",
    action: "delete_short_url",
    write: true,
    destructive: true,
    warning: "This deletes visit rows for one short URL.",
  },
  deleteOrphanVisits: {
    toolset: "visits_write",
    action: "delete_orphan",
    write: true,
    destructive: true,
    warning: "This deletes orphan visit rows.",
  },
  listTags: {
    toolset: "tags",
    action: "list",
    write: false,
    destructive: false,
    warning: "",
  },
  tagsWithStats: {
    toolset: "tags",
    action: "stats",
    write: false,
    destructive: false,
    warning: "",
  },
  renameTag: {
    toolset: "tags_write",
    action: "rename",
    write: true,
    destructive: false,
    warning: "This renames a tag on every short URL that uses it.",
  },
  deleteTags: {
    toolset: "tags_write",
    action: "delete",
    write: true,
    destructive: true,
    warning: "This deletes tags.",
  },
  listDomains: {
    toolset: "domains",
    action: "list",
    write: false,
    destructive: false,
    warning: "",
  },
  setDomainRedirects: {
    toolset: "domains_write",
    action: "set_not_found",
    write: true,
    destructive: false,
    warning: "This changes not-found redirects for a domain.",
  },
  listShortUrlRedirectRules: {
    toolset: "redirect_rules",
    action: "list",
    write: false,
    destructive: false,
    warning: "",
  },
  setShortUrlRedirectRules: {
    toolset: "redirect_rules_write",
    action: "set",
    write: true,
    destructive: false,
    warning: "This replaces redirect rules for one short URL.",
  },
  health: {
    toolset: "meta",
    action: "health",
    write: false,
    destructive: false,
    warning: "",
  },
  mercureInfo: {
    toolset: "meta",
    action: "mercure",
    write: false,
    destructive: false,
    warning: "",
  },
};

/** @type {Record<string, string>} */
const EXCLUDE = {
  shortenUrl:
    "Deprecated GET create. The operation accepts apiKey as a query parameter. Use createShortUrl, which sends X-Api-Key and never puts the key in the URL.",
  shortUrl:
    "Public redirect at /{shortCode}. It is not the REST API. A request records a visit and returns 302. Hit it with plain HTTP, outside this connector.",
  trackShortUrl:
    "Tracking pixel at /{shortCode}/track. It returns an image, not a JSON REST resource.",
};

/** @type {Record<string, string>} */
const SAMPLE_PATH = {
  shortCode: "abc12",
  tag: "demo",
  domain: "example.com",
};

/** @type {Record<string, unknown>} */
const SAMPLE_BODY = {
  createShortUrl: {
    longUrl: "https://example.com/mcp",
    customSlug: "mcpdemo",
    tags: ["demo"],
  },
  editShortUrl: { title: "Demo" },
  renameTag: { oldName: "demo", newName: "demo2" },
  setDomainRedirects: {
    domain: "example.com",
    baseUrlRedirect: "https://example.com/landing",
  },
  setShortUrlRedirectRules: {
    redirectRules: [
      {
        longUrl: "https://example.com/android",
        conditions: [{ type: "device", matchKey: null, matchValue: "android" }],
      },
    ],
  },
};

const cache = new Map();

/**
 * @param {string} file
 */
function loadJson(file) {
  const hit = cache.get(file);
  if (hit !== undefined) return hit;
  const doc = JSON.parse(readFileSync(file, "utf8"));
  cache.set(file, doc);
  return doc;
}

/**
 * @param {unknown} node
 * @param {string} fromFile
 */
function resolveNode(node, fromFile) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  const record = /** @type {Record<string, unknown>} */ (node);
  if (typeof record["$ref"] === "string" && Object.keys(record).length === 1) {
    const target = normalize(join(dirname(fromFile), record["$ref"]));
    return resolveNode(loadJson(target), target);
  }
  return node;
}

/**
 * @param {unknown} schema
 */
function schemaType(schema) {
  if (schema === null || typeof schema !== "object") return "string";
  const record = /** @type {Record<string, unknown>} */ (schema);
  const raw = record["type"];
  const type = Array.isArray(raw) ? raw.find((item) => item !== "null") : raw;
  if (type === "array") return "array";
  if (type === "integer" || type === "number" || type === "boolean" || type === "string") {
    return type;
  }
  if (type === "object" || record["properties"] !== undefined || record["allOf"] !== undefined) {
    return "object";
  }
  return "string";
}

/**
 * @param {unknown} schema
 * @param {string} fromFile
 * @param {Map<string, { name: string, type: string, required: boolean }>} out
 * @param {Set<string>} required
 */
function collectProps(schema, fromFile, out, required) {
  const resolved = resolveNode(schema, fromFile);
  if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) return;
  const record = /** @type {Record<string, unknown>} */ (resolved);
  if (Array.isArray(record["allOf"])) {
    for (const part of record["allOf"]) collectProps(part, fromFile, out, required);
  }
  if (Array.isArray(record["required"])) {
    for (const name of record["required"]) {
      if (typeof name === "string") required.add(name);
    }
  }
  const properties = record["properties"];
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, prop] of Object.entries(properties)) {
      const propResolved = resolveNode(prop, fromFile);
      out.set(name, { name, type: schemaType(propResolved), required: false });
    }
  }
}

/**
 * @param {unknown} requestBody
 * @param {string} fromFile
 */
function bodyFields(requestBody, fromFile) {
  if (requestBody === undefined) return [];
  const body = resolveNode(requestBody, fromFile);
  if (body === null || typeof body !== "object") return [];
  const content = /** @type {Record<string, unknown>} */ (body)["content"];
  if (content === null || typeof content !== "object") return [];
  const json = /** @type {Record<string, unknown>} */ (content)["application/json"];
  if (json === null || typeof json !== "object") return [];
  const schema = /** @type {Record<string, unknown>} */ (json)["schema"];
  /** @type {Map<string, { name: string, type: string, required: boolean }>} */
  const props = new Map();
  const required = new Set();
  collectProps(schema, fromFile, props, required);
  return [...props.values()].map((field) => ({ ...field, required: required.has(field.name) }));
}

/**
 * @param {unknown[]} parameters
 * @param {string} fromFile
 */
function splitParams(parameters, fromFile) {
  /** @type {{ name: string, type: string, required: boolean, in: string }[]} */
  const fields = [];
  for (const parameter of parameters) {
    const resolved = resolveNode(parameter, fromFile);
    if (resolved === null || typeof resolved !== "object") continue;
    const record = /** @type {Record<string, unknown>} */ (resolved);
    const name = record["name"];
    const where = record["in"];
    if (typeof name !== "string" || typeof where !== "string") continue;
    if (name === "version") continue;
    if (where !== "path" && where !== "query" && where !== "header") continue;
    fields.push({
      name,
      type: schemaType(resolveNode(record["schema"], fromFile)),
      required: record["required"] === true,
      in: where,
    });
  }
  return fields;
}

export function listSpecOperations() {
  const spec = loadJson(specPath);
  const paths = spec["paths"];
  /** @type {{ method: string, path: string, operationId: string, summary: string, tag: string, auth: "key" | "none", parameters: unknown[], requestBody: unknown, file: string }[]} */
  const operations = [];
  for (const [specPathName, item] of Object.entries(paths)) {
    const pathItem = /** @type {Record<string, unknown>} */ (item);
    const ref = pathItem["$ref"];
    const file = typeof ref === "string" ? normalize(join(specRoot, ref)) : specPath;
    const doc = /** @type {Record<string, unknown>} */ (
      typeof ref === "string" ? loadJson(file) : pathItem
    );
    for (const method of HTTP) {
      const op = doc[method];
      if (op === undefined || op === null || typeof op !== "object") continue;
      const record = /** @type {Record<string, unknown>} */ (op);
      const operationId = record["operationId"];
      if (typeof operationId !== "string") {
        throw new Error(`Missing operationId for ${method.toUpperCase()} ${specPathName}`);
      }
      const tags = record["tags"];
      const tag = Array.isArray(tags) && typeof tags[0] === "string" ? tags[0] : "";
      const summary = typeof record["summary"] === "string" ? record["summary"] : operationId;
      const security = record["security"];
      const auth = Array.isArray(security) && security.length > 0 ? "key" : "none";
      operations.push({
        method: method.toUpperCase(),
        path: specPathName,
        operationId,
        summary,
        tag,
        auth,
        parameters: Array.isArray(record["parameters"]) ? record["parameters"] : [],
        requestBody: record["requestBody"],
        file,
      });
    }
  }
  return operations;
}

/**
 * @param {ReturnType<typeof listSpecOperations>} operations
 */
export function planOperations(operations) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {{ method: string, path: string, operationId: string, tag: string, reason: string }[]} */
  const exclusions = [];
  for (const operation of operations) {
    const reason = EXCLUDE[operation.operationId];
    if (reason !== undefined) {
      exclusions.push({
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        tag: operation.operationId,
        reason,
      });
      continue;
    }
    const mapped = MAP[operation.operationId];
    if (mapped === undefined) {
      throw new Error(`Unmapped Shlink operation ${operation.operationId}`);
    }
    const params = splitParams(operation.parameters, operation.file);
    const bodies = bodyFields(operation.requestBody, operation.file);
    const pathParams = params.filter((field) => field.in === "path").map((field) => field.name);
    const queryParams = params.filter((field) => field.in === "query").map((field) => field.name);
    const headerParams = params.filter((field) => field.in === "header").map((field) => field.name);
    /** @type {Record<string, string>} */
    const sampleParams = {};
    for (const name of pathParams) sampleParams[name] = SAMPLE_PATH[name] ?? "sample";
    const sampleBody = SAMPLE_BODY[operation.operationId];
    const kind = operation.method === "DELETE" && bodies.length === 0 ? "empty" : "json";
    rows.push({
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      summary: operation.summary,
      tool: `shlink_${mapped.toolset}`,
      action: mapped.action,
      toolset: mapped.toolset,
      tag: operation.tag,
      auth: operation.auth,
      write: mapped.write,
      destructive: mapped.destructive,
      kind,
      pathParams,
      queryParams,
      headerParams,
      fields: params.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
        in: field.in,
      })),
      bodyFields: bodies.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required,
      })),
      warnings: mapped.warning.length > 0 ? [mapped.warning] : [],
      sampleParams,
      sampleQuery: {},
      ...(sampleBody !== undefined ? { sampleBody } : {}),
    });
  }
  return { rows, exclusions };
}

/**
 * @param {unknown} value
 * @param {number} indent
 */
function emit(value, indent) {
  const pad = " ".repeat(indent);
  const next = " ".repeat(indent + 2);
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${next}${emit(item, indent + 2)}`).join(",\n")},\n${pad}]`;
  }
  const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).filter(
    (entry) => entry[1] !== undefined,
  );
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([key, entry]) => `${next}${key}: ${emit(entry, indent + 2)}`)
    .join(",\n")},\n${pad}}`;
}

/**
 * @param {ReturnType<typeof planOperations>} plan
 */
function emitOperations(plan) {
  const toolsets = new Map();
  for (const row of plan.rows) {
    const name = /** @type {string} */ (row["toolset"]);
    const bucket = toolsets.get(name) ?? [];
    bucket.push(/** @type {string} */ (row["action"]));
    toolsets.set(name, bucket);
  }
  const counts = {};
  for (const [name, actions] of [...toolsets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    counts[name] = { operations: actions.length, actions };
  }
  const all = [
    ...new Set([
      ...DEFAULT_TOOLSETS,
      ...plan.rows.map((row) => /** @type {string} */ (row["toolset"])),
    ]),
  ];
  const lines = [];
  lines.push(
    "/** Generated by scripts/gen-operations.mjs from vendor/shlink-openapi (Shlink 5.1.8, MIT). Do not edit by hand. */",
  );
  lines.push("");
  lines.push('import { ConnectorError } from "./errors.js";');
  lines.push("");
  lines.push('export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";');
  lines.push('export type SpecMethod = HttpMethod | "OPTIONS" | "HEAD";');
  lines.push('export type ResponseKind = "json" | "empty";');
  lines.push('export type ShlinkAuth = "key" | "none";');
  lines.push("");
  lines.push("export interface FieldSchema {");
  lines.push("  readonly name: string;");
  lines.push("  readonly type: string;");
  lines.push("  readonly required: boolean;");
  lines.push('  readonly in?: "path" | "query" | "header";');
  lines.push("}");
  lines.push("");
  lines.push("export interface Operation {");
  lines.push("  readonly method: HttpMethod;");
  lines.push("  readonly path: string;");
  lines.push("  readonly tool: string;");
  lines.push("  readonly action: string;");
  lines.push("  readonly toolset: string;");
  lines.push("  readonly tag: string;");
  lines.push("  readonly operationId: string;");
  lines.push("  readonly auth: ShlinkAuth;");
  lines.push("  readonly write: boolean;");
  lines.push("  readonly destructive: boolean;");
  lines.push("  readonly kind: ResponseKind;");
  lines.push("  readonly summary: string;");
  lines.push("  readonly pathParams: readonly string[];");
  lines.push("  readonly queryParams: readonly string[];");
  lines.push("  readonly headerParams: readonly string[];");
  lines.push("  readonly fields: readonly FieldSchema[];");
  lines.push("  readonly bodyFields: readonly FieldSchema[];");
  lines.push("  readonly warnings: readonly string[];");
  lines.push("  readonly sampleParams: Readonly<Record<string, string>>;");
  lines.push("  readonly sampleQuery: Readonly<Record<string, string>>;");
  lines.push("  readonly sampleBody?: unknown;");
  lines.push("}");
  lines.push("");
  lines.push("export interface ExcludedOperation {");
  lines.push("  readonly method: SpecMethod;");
  lines.push("  readonly path: string;");
  lines.push("  readonly operationId: string;");
  lines.push("  readonly tag: string;");
  lines.push("  readonly reason: string;");
  lines.push("}");
  lines.push("");
  lines.push("function row(");
  lines.push("  method: HttpMethod,");
  lines.push("  path: string,");
  lines.push("  tool: string,");
  lines.push("  options: {");
  lines.push("    action: string;");
  lines.push("    toolset: string;");
  lines.push("    tag: string;");
  lines.push("    operationId: string;");
  lines.push("    auth: ShlinkAuth;");
  lines.push("    write: boolean;");
  lines.push("    destructive: boolean;");
  lines.push("    kind: ResponseKind;");
  lines.push("    summary: string;");
  lines.push("    pathParams: readonly string[];");
  lines.push("    queryParams: readonly string[];");
  lines.push("    headerParams: readonly string[];");
  lines.push("    fields: readonly FieldSchema[];");
  lines.push("    bodyFields: readonly FieldSchema[];");
  lines.push("    warnings: readonly string[];");
  lines.push("    sampleParams: Readonly<Record<string, string>>;");
  lines.push("    sampleQuery: Readonly<Record<string, string>>;");
  lines.push("    sampleBody?: unknown;");
  lines.push("  },");
  lines.push("): Operation {");
  lines.push("  return {");
  lines.push("    method,");
  lines.push("    path,");
  lines.push("    tool,");
  lines.push("    action: options.action,");
  lines.push("    toolset: options.toolset,");
  lines.push("    tag: options.tag,");
  lines.push("    operationId: options.operationId,");
  lines.push("    auth: options.auth,");
  lines.push("    write: options.write,");
  lines.push("    destructive: options.destructive,");
  lines.push("    kind: options.kind,");
  lines.push("    summary: options.summary,");
  lines.push("    pathParams: options.pathParams,");
  lines.push("    queryParams: options.queryParams,");
  lines.push("    headerParams: options.headerParams,");
  lines.push("    fields: options.fields,");
  lines.push("    bodyFields: options.bodyFields,");
  lines.push("    warnings: options.warnings,");
  lines.push("    sampleParams: options.sampleParams,");
  lines.push("    sampleQuery: options.sampleQuery,");
  lines.push(
    "    ...(options.sampleBody !== undefined ? { sampleBody: options.sampleBody } : {}),",
  );
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push(`export const DEFAULT_TOOLSETS = ${JSON.stringify(DEFAULT_TOOLSETS)} as const;`);
  lines.push("");
  lines.push(`export const ALL_TOOLSETS = ${JSON.stringify(all)} as const;`);
  lines.push("");
  lines.push(`export const TOOLSET_COUNTS: Readonly<`);
  lines.push(
    "  Record<string, { readonly operations: number; readonly actions: readonly string[] }>",
  );
  lines.push(`> = ${emit(counts, 0)};`);
  lines.push("");
  lines.push(
    `export const EXCLUSIONS: readonly ExcludedOperation[] = ${emit(plan.exclusions, 0)};`,
  );
  lines.push("");
  lines.push("export const OPERATIONS: readonly Operation[] = [");
  for (const item of plan.rows) {
    const row = /** @type {Record<string, unknown>} */ (item);
    const options = {
      action: row["action"],
      toolset: row["toolset"],
      tag: row["tag"],
      operationId: row["operationId"],
      auth: row["auth"],
      write: row["write"],
      destructive: row["destructive"],
      kind: row["kind"],
      summary: row["summary"],
      pathParams: row["pathParams"],
      queryParams: row["queryParams"],
      headerParams: row["headerParams"],
      fields: row["fields"],
      bodyFields: row["bodyFields"],
      warnings: row["warnings"],
      sampleParams: row["sampleParams"],
      sampleQuery: row["sampleQuery"],
      ...(row["sampleBody"] !== undefined ? { sampleBody: row["sampleBody"] } : {}),
    };
    lines.push(
      `  row(${JSON.stringify(row["method"])}, ${JSON.stringify(row["path"])}, ${JSON.stringify(row["tool"])}, ${emit(options, 2)}),`,
    );
  }
  lines.push("];");
  lines.push("");
  lines.push("export function toolNames(): string[] {");
  lines.push("  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();");
  lines.push("}");
  lines.push("");
  lines.push("export function operationsForTool(name: string): Operation[] {");
  lines.push("  return OPERATIONS.filter((operation) => operation.tool === name);");
  lines.push("}");
  lines.push("");
  lines.push("export function toolIsWrite(name: string): boolean {");
  lines.push(
    "  return OPERATIONS.some((operation) => operation.tool === name && operation.write);",
  );
  lines.push("}");
  lines.push("");
  lines.push("export function requireOp(tool: string, action: string): Operation {");
  lines.push("  const found = OPERATIONS.find(");
  lines.push("    (operation) => operation.tool === tool && operation.action === action,");
  lines.push("  );");
  lines.push("  if (found === undefined) {");
  lines.push(
    '    throw new ConnectorError("input", `Unknown Shlink operation ${tool} ${action}.`);',
  );
  lines.push("  }");
  lines.push("  return found;");
  lines.push("}");
  lines.push("");
  lines.push("export function parseToolsets(raw: string | undefined): readonly string[] {");
  lines.push('  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];');
  lines.push("  const trimmed = raw.trim();");
  lines.push('  if (trimmed === "all") return [...ALL_TOOLSETS];');
  lines.push("  const wanted = trimmed");
  lines.push('    .split(",")');
  lines.push("    .map((part) => part.trim())");
  lines.push("    .filter((part) => part.length > 0);");
  lines.push("  const allowed = new Set<string>(ALL_TOOLSETS);");
  lines.push("  const unknown = wanted.filter((name) => !allowed.has(name));");
  lines.push("  if (unknown.length > 0) {");
  lines.push('    throw new ConnectorError("config", "Unknown SHLINK_TOOLSETS value.");');
  lines.push("  }");
  lines.push("  return [...new Set(wanted)];");
  lines.push("}");
  lines.push("");
  lines.push("export function toolsForToolsets(enabled: readonly string[]): string[] {");
  lines.push("  const allow = new Set(enabled);");
  lines.push("  return toolNames().filter((name) => {");
  lines.push("    const operation = OPERATIONS.find((item) => item.tool === name);");
  lines.push("    return operation !== undefined && allow.has(operation.toolset);");
  lines.push("  });");
  lines.push("}");
  lines.push("");
  return `${lines.join("\n")}`;
}

function writeRoutes(operations, plan) {
  const routeOps = operations.map((operation) => {
    const reason = EXCLUDE[operation.operationId];
    if (reason !== undefined) {
      return {
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
        summary: operation.summary,
        exclude: true,
        reason,
      };
    }
    const row = plan.rows.find((item) => item["operationId"] === operation.operationId);
    return {
      method: operation.method,
      path: operation.path,
      operationId: operation.operationId,
      summary: operation.summary,
      toolset: row["toolset"],
      action: row["action"],
      auth: row["auth"],
      write: row["write"],
      exclude: false,
    };
  });
  const document = {
    source:
      "Shlink 5.1.8 REST API v3. Spec copied from vendor/shlink-openapi (MIT, Copyright 2016-2024 Alejandro Celaya). Mapping is local. No Shlink PHP is copied.",
    version: "5.1.8",
    apiVersion: "3",
    operations: routeOps,
  };
  writeFileSync(routesPath, `${JSON.stringify(document, null, 2)}\n`);
}

function main() {
  const operations = listSpecOperations();
  const plan = planOperations(operations);
  writeRoutes(operations, plan);
  writeFileSync(outPath, emitOperations(plan));
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
