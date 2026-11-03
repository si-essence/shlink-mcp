import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  EXCLUSIONS,
  OPERATIONS,
  parseToolsets,
  toolNames,
} from "../src/operations.js";

function runScript(source: string): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "generator failed");
  }
  return result.stdout;
}

function specOperations(): { method: string; path: string; operationId: string }[] {
  const script = [
    'import { listSpecOperations } from "./scripts/gen-operations.mjs";',
    "process.stdout.write(JSON.stringify(listSpecOperations()));",
  ].join("\n");
  return JSON.parse(runScript(script)) as { method: string; path: string; operationId: string }[];
}

function planned(): { actions: string[]; exclusions: string[] } {
  const script = [
    'import { listSpecOperations, planOperations } from "./scripts/gen-operations.mjs";',
    "const plan = planOperations(listSpecOperations());",
    "process.stdout.write(JSON.stringify({",
    '  actions: plan.rows.map((row) => row.tool + ":" + row.action + " " + row.method + " " + row.path + " " + row.operationId),',
    '  exclusions: plan.exclusions.map((row) => row.method + " " + row.path + " " + row.operationId),',
    "}));",
  ].join("\n");
  return JSON.parse(runScript(script)) as { actions: string[]; exclusions: string[] };
}

describe("OpenAPI coverage", () => {
  const specOps = specOperations();
  const routes = JSON.parse(
    readFileSync(new URL("../shlink.routes.json", import.meta.url), "utf8"),
  ) as {
    operations: {
      method: string;
      path: string;
      operationId: string;
      exclude?: boolean;
      reason?: string;
    }[];
  };

  it("maps or excludes every OpenAPI operation", () => {
    const specKeys = specOps.map((op) => `${op.method} ${op.path} ${op.operationId}`).sort();
    const routeKeys = routes.operations
      .map((op) => `${op.method} ${op.path} ${op.operationId}`)
      .sort();
    expect(routeKeys).toEqual(specKeys);
    expect(specOps).toHaveLength(26);

    const mapped = routes.operations.filter((op) => op.exclude !== true);
    const excluded = routes.operations.filter((op) => op.exclude === true);
    const registry = OPERATIONS.map((op) => `${op.method} ${op.path} ${op.operationId}`).sort();
    expect(registry).toEqual(
      mapped.map((op) => `${op.method} ${op.path} ${op.operationId}`).sort(),
    );
    expect(EXCLUSIONS.map((op) => `${op.method} ${op.path} ${op.operationId}`).sort()).toEqual(
      excluded.map((op) => `${op.method} ${op.path} ${op.operationId}`).sort(),
    );
    expect(mapped.length + excluded.length).toBe(specOps.length);
    expect(OPERATIONS).toHaveLength(23);
    expect(EXCLUSIONS).toHaveLength(3);
    for (const row of excluded) {
      expect(row.reason !== undefined && row.reason.length > 20).toBe(true);
    }
  });

  it("keeps action names unique and stable against the generator", () => {
    const seen = new Set<string>();
    for (const operation of OPERATIONS) {
      const id = `${operation.tool}:${operation.action}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      expect(operation.action).not.toBe("help");
      expect(operation.action).toMatch(/^[a-z0-9_]+$/);
    }
    const plan = planned();
    expect([...plan.actions].sort()).toEqual(
      OPERATIONS.map(
        (operation) =>
          `${operation.tool}:${operation.action} ${operation.method} ${operation.path} ${operation.operationId}`,
      ).sort(),
    );
    expect(plan.exclusions.sort()).toEqual(
      EXCLUSIONS.map(
        (operation) => `${operation.method} ${operation.path} ${operation.operationId}`,
      ).sort(),
    );
  });

  it("pins version 3 inside the client and keeps writes off the default toolsets", () => {
    const health = OPERATIONS.find((row) => row.operationId === "health");
    expect(health?.auth).toBe("none");
    expect(health?.write).toBe(false);
    expect(health?.toolset).toBe("meta");
    const create = OPERATIONS.find((row) => row.operationId === "createShortUrl");
    expect(create?.write).toBe(true);
    expect(create?.toolset).toBe("short_urls_write");
    expect(DEFAULT_TOOLSETS).not.toContain("short_urls_write");
    expect(DEFAULT_TOOLSETS).toContain("short_urls");
    expect([...parseToolsets(undefined)]).toEqual([...DEFAULT_TOOLSETS]);
    expect([...parseToolsets("all")]).toEqual([...ALL_TOOLSETS]);
    expect(toolNames()).toHaveLength(11);
    const shorten = EXCLUSIONS.find((row) => row.operationId === "shortenUrl");
    expect(shorten?.reason).toMatch(/apiKey/);
  });
});
