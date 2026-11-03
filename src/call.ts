import { API_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";
import { definedQuery, fillOpenApiPath, jsonValueSchema } from "./json.js";
import type { Operation } from "./operations.js";
import { asJsonObject } from "./parse.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

export interface CallArgs {
  readonly params?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  readonly query?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

function asQuery(
  record:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined,
): QueryMap | undefined {
  if (record === undefined) return undefined;
  const mapped: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = value;
  return definedQuery(mapped);
}

function asParams(
  record:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") out[key] = String(value);
    else if (typeof value === "string" || typeof value === "number") out[key] = value;
    else {
      throw new ConnectorError("input", `Path parameter ${key} must be a string or a number.`);
    }
  }
  return out;
}

function withAuth<T extends object>(
  base: T,
  auth: Operation["auth"],
): T & { auth: Operation["auth"] } {
  return { ...base, auth };
}

export async function callShlink(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  const params = asParams(args.params);
  if (operation.path.includes("{version}")) params["version"] = API_VERSION;
  const path = fillOpenApiPath(operation.path, params);
  const query = asQuery(args.query);
  const ttlSec = operation.write ? 0 : runtime.cacheTtlSec;

  const run = async (): Promise<Record<string, unknown>> =>
    execute(runtime, operation, path, query, args, ttlSec);

  if (!operation.write) return run();

  return withWrite(
    runtime,
    args.confirm,
    {
      method: operation.method,
      path,
      query,
      body: args.body,
      summary: operation.summary,
      warnings: operation.warnings,
      revealSecret: false,
    },
    run,
  );
}

async function execute(
  runtime: Runtime,
  operation: Operation,
  path: string,
  query: QueryMap | undefined,
  args: CallArgs,
  ttlSec: number,
): Promise<Record<string, unknown>> {
  const fieldRedact = true;
  if (operation.kind === "empty") {
    const request = withAuth({ path, query, fieldRedact }, operation.auth);
    if (operation.method === "POST") {
      return asJsonObject((await runtime.client.postEmpty(request)).body);
    }
    if (operation.method === "PUT") {
      return asJsonObject((await runtime.client.putEmpty(request)).body);
    }
    if (operation.method === "PATCH") {
      return asJsonObject((await runtime.client.patchEmpty(request)).body);
    }
    return asJsonObject((await runtime.client.delete(request)).body);
  }
  if (operation.method === "GET") {
    return asJsonObject(
      await runtime.client.getJson(
        withAuth({ path, query, ttlSec, fieldRedact }, operation.auth),
        jsonValueSchema,
      ),
    );
  }
  const request = withAuth({ path, query, body: args.body ?? {}, fieldRedact }, operation.auth);
  if (operation.method === "POST") {
    return asJsonObject(await runtime.client.postJson(request, jsonValueSchema));
  }
  if (operation.method === "PUT") {
    return asJsonObject(await runtime.client.putJson(request, jsonValueSchema));
  }
  if (operation.method === "PATCH") {
    return asJsonObject(await runtime.client.patchJson(request, jsonValueSchema));
  }
  return asJsonObject(await runtime.client.deleteJson(request, jsonValueSchema));
}
