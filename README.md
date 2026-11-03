# shlink

MCP connector for a self-hosted [Shlink](https://github.com/shlinkio/shlink) server, tested against Shlink 5.1.8. It speaks REST API v3 over stdio and over stateless Streamable HTTP on localhost.

Shlink is MIT software. Copyright 2016-2024 Alejandro Celaya. This connector does not copy the PHP server. `vendor/shlink-openapi` is a copy of the Shlink OpenAPI spec, including that MIT license. The connector is not affiliated with Shlink.

`shlink.routes.json` lists every operation in that spec. 23 operations are tools. 3 are exclusions. `scripts/gen-operations.mjs` writes `src/operations.ts` from the spec. Do not edit `src/operations.ts` by hand.

`SHLINK_URL` and `SHLINK_API_KEY` are required. There is no default origin.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication of its own. Keep it on localhost.

```json
{
  "mcpServers": {
    "shlink": {
      "command": "node",
      "args": ["/workspace/connectors/shlink/dist/index.js"],
      "env": {
        "SHLINK_URL": "http://127.0.0.1:8096",
        "SHLINK_API_KEY": "...",
        "SHLINK_ALLOW_WRITES": "false",
        "SHLINK_TOOLSETS": "short_urls,visits,tags,domains,redirect_rules,meta"
      }
    }
  }
}
```

Docker, HTTP, no authentication, keep it on localhost:

```bash
docker build -t shlink-mcp .
docker run -p 127.0.0.1:3000:3000 \
  -e SHLINK_URL=http://127.0.0.1:8096 \
  -e SHLINK_API_KEY=... \
  shlink-mcp
```

Do not put secrets in the image.

Regenerate the registry after a spec bump.

```bash
npm run gen:operations
```

`scripts/live-check.mjs` talks to a real server over stdio. It reads the API key from `SHLINK_API_KEY` or from `SHLINK_API_KEY_FILE` (default `/workspace/tools/shlink/api.key`). It unsets `DATABASE_URL`. It sets `SHLINK_TOOLSETS=all` for the child process. It prints pass or fail lines only, and it redacts the key.

## Config

| Variable               | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `SHLINK_URL`           | Required. Origin, `http` or `https`, no userinfo, query, or hash. Example `http://127.0.0.1:8096`. |
| `SHLINK_API_KEY`       | Required. Sent as the header `X-Api-Key`. Redacted in logs, errors, and tool results.              |
| `SHLINK_ALLOW_WRITES`  | Must be the literal `true` before a confirmed write is sent.                                       |
| `SHLINK_TOOLSETS`      | Comma list, or `all`. Default is the read-only set below.                                          |
| `SHLINK_PER_MINUTE`    | Local request budget. Default 30. Cache hits do not spend it.                                      |
| `SHLINK_TIMEOUT_MS`    | Upstream timeout. Default 20000.                                                                   |
| `SHLINK_CACHE_TTL_SEC` | Read cache TTL. Default 60. Writes clear the cache.                                                |
| `SHLINK_CONTACT`       | Contact token in the User-Agent. Must not contain the API key.                                     |
| `MCP_TRANSPORT`        | `stdio` or `http`. `--http` overrides.                                                             |
| `PORT`                 | HTTP port. Default 3000.                                                                           |

Invalid values are reported by field name and issue code. The rejected value is not included.

The REST version path parameter is fixed at `3`. Callers do not pass it. Health is `GET /rest/health` and sends no API key. Every other mapped route sends `X-Api-Key`.

## Safety

Default toolsets are reads. Create, edit, delete, tag rename, tag delete, visit deletes, domain not-found redirects, and redirect-rule replacement live on separate toolsets. Those toolsets are off until `SHLINK_TOOLSETS` includes them or is `all`.

A write on an enabled toolset still needs `confirm` set to the boolean `true` and `SHLINK_ALLOW_WRITES=true`. The string `"true"` is rejected. Otherwise the tool returns a dry-run preview of method, path, query, and body, and it sends nothing.

Shlink errors use `application/problem+json`. HTTP 401 is unauthorized. HTTP 403 is forbidden. HTTP 404 is not found. HTTP 400, 409, and 422 are invalid input. HTTP 429 includes Retry-After when the header is present. Other failures are server, network, or timeout. Response bodies are capped at 1,000,000 bytes.

## Tools

Default `SHLINK_TOOLSETS` publishes 6 tools and 14 read operations. `SHLINK_TOOLSETS=all` publishes 11 tools and 23 operations. Each tool takes `action` plus optional `params`, `query`, `body`, and, on write tools, `confirm`.

`action` `help` with optional `target` returns the fields for one action. Descriptions list action names only, so the tool list stays small.

| Toolset              | Tool                          | Operations                                         | Default |
| -------------------- | ----------------------------- | -------------------------------------------------- | ------- |
| short_urls           | `shlink_short_urls`           | list, get                                          | yes     |
| visits               | `shlink_visits`               | global, short_url, tag, domain, orphan, non_orphan | yes     |
| tags                 | `shlink_tags`                 | list, stats                                        | yes     |
| domains              | `shlink_domains`              | list                                               | yes     |
| redirect_rules       | `shlink_redirect_rules`       | list                                               | yes     |
| meta                 | `shlink_meta`                 | health, mercure                                    | yes     |
| short_urls_write     | `shlink_short_urls_write`     | create, edit, delete                               | no      |
| visits_write         | `shlink_visits_write`         | delete_short_url, delete_orphan                    | no      |
| tags_write           | `shlink_tags_write`           | rename, delete                                     | no      |
| domains_write        | `shlink_domains_write`        | set_not_found                                      | no      |
| redirect_rules_write | `shlink_redirect_rules_write` | set                                                | no      |

`params.shortCode` is the path short code. `params.tag` and `params.domain` are path parameters on the visit routes that need them. Filters such as `page`, `searchTerm`, `tags[]`, and `domain` go in `query`. Create and edit bodies follow the Shlink JSON schema. `customSlug` and `tags` are create fields.

## What this connector leaves out

`GET /rest/v{version}/short-urls/shorten` is the deprecated query-string create. It accepts `apiKey` in the query string. Use `create` instead.

`GET /{shortCode}` is the public redirect. It records a visit and returns 302. It is not a JSON tool. Hit it with plain HTTP.

`GET /{shortCode}/track` is a tracking pixel. It returns an image.

## Other Shlink MCP servers

`gh search repos "shlink mcp"` on 2026-11-03 returned three public repositories. A second search for `mcp-shlink` also returned `magnus919/mcp-shlink`. Stars below are from `gh repo view` the same day.

[magnus919/mcp-shlink](https://github.com/magnus919/mcp-shlink) is archived Python, 4 stars, 6 tools (`create_short_url`, `list_short_urls`, `get_short_url`, `delete_short_url`, `list_tags`, `get_metrics`). Writes are not confirm-gated. `list_short_urls` takes no filters.

[andrielson/shlink-mcp](https://github.com/andrielson/shlink-mcp) is TypeScript, 0 stars, 12 tools in `src/tools.ts` for short URLs, tags, and some visits. There is no confirm argument and no env kill switch. Domains, redirect rules, orphan visits, and health are absent.

[AlexGreenUK/XS-Shlink-MCP](https://github.com/AlexGreenUK/XS-Shlink-MCP) is TypeScript, 0 stars, 23 tools, including QR, Mercure, domains, and redirect rules. Deletes need `SHLINK_ALLOW_DESTRUCTIVE` and `confirm: true`. Create, edit, rename, and redirect writes are not behind that flag.

[bauer-group/IP-Shlink-MCPServer](https://github.com/bauer-group/IP-Shlink-MCPServer) is Python, 0 stars, 23 tools generated from OpenAPI plus `health` and `export_short_urls`. It drops `/short-urls/shorten`, the public short URL, and Mercure. Inbound OAuth gates who may connect. Individual writes are not confirm-gated. One Shlink API key backs every caller.

This connector covers the same REST v3 resources as XS and Bauer, except QR and CSV export. It keeps reads on by default and keeps every write behind both an opt-in toolset and `confirm` plus `SHLINK_ALLOW_WRITES=true`.

## Live check

See `LIVE-CHECK.md` for the last run against Shlink 5.1.8 at `http://127.0.0.1:8096`.

## License

MIT. See `LICENSE`. The vendored OpenAPI spec stays under the Shlink MIT license in `vendor/shlink-openapi/LICENSE`.
