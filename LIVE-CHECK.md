# Live check

**Result.** 2026-11-03, passed=19, failed=0.

Server is Shlink 5.1.8 at `http://127.0.0.1:8096`, PHP built-in server, SQLite. The API key was read from `/workspace/tools/shlink/api.key` into the child process. It is not printed. `DATABASE_URL` was unset. `SHLINK_TOOLSETS=all` for the child. `npm run ci` was green before this run (39 tests).

Command: `SHLINK_URL=http://127.0.0.1:8096 node scripts/live-check.mjs`

| Check | Result |
| --- | --- |
| tool list | 11 tools |
| health | status pass, version 5.1.8 |
| list short URLs | totalItems 0 before the create |
| create preview | dry_run true, blocked false, nothing sent |
| guarded create | `SHLINK_ALLOW_WRITES` not true, confirm true, blocked true, nothing sent |
| confirmed create | custom slug, tag `mcplive`, executed true |
| duplicate slug | HTTP 400, `[input]`, slug already in use |
| get | short code matches the created slug |
| edit | title `Live check` |
| hit short URL | HTTP 302, redirect not followed, location is the long URL |
| visits | totalItems 1, potentialBot false |
| tag list | count 1, includes `mcplive` |
| tag stats | shortUrlsCount 1, visits total 1 |
| domains list | default domain `127.0.0.1:8096` |
| redirect rules read | defaultLongUrl set, redirectRules empty |
| redirect rules set | one device rule, executed true |
| delete short URL | executed true, HTTP 204 body reported as ok |
| unknown slug | HTTP 404, `[not-found]` |
| bad key | HTTP 401, `[unauthorized]` |

The short URL was deleted during the run. After the 19 checks, `DELETE /rest/v3/tags?tags[]=mcplive` returned 204. A following list showed tag count 0 and short URL totalItems 0.

Excluded operations were not called as tools. The public redirect was the plain HTTP GET above.
