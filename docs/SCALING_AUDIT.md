# Scaling audit — 2026-11-17

Scope: one busy deployment and 10,000 independent installations. No claim of 10,000 concurrent users or production readiness. Audit recorded before implementation.

| Item | Initial state | Risk | Planned response |
| --- | --- | --- | --- |
| SQLite | WAL, busy_timeout=5000, synchronous=FULL; primary keys | Synchronous writes block one event loop; no horizontal coordination | Keep durable defaults; index expiry/monitor/receipts; document single-process boundary |
| Per-call database work | Bearer lookup + two tranche reads + ledger read + nonce lookup/insert + debit and transaction | Repeated preparation and redundant reads | Cache prepared statements; remove redundant pre-read; measure full path |
| Nonces/receipts | events retained forever | Unbounded disk use | Indexed, bounded periodic deletion after tranche expiry + 24h; never prune live nonce history |
| Request bodies | 64 KiB | Slow/oversized clients | Retain cap and request/header deadlines; regression tests |
| Upstream | Fixed operator URL, exact caller routes, manual redirects, 120s total deadline | Unsafe configured path prefix; slow connect/stream | Reject encoded/dot/backslash prefixes; bounded total deadline including connect/body |
| Streaming | pipeline backpressure and disconnect abort | Shutdown may leave upstream fetch active | Test disconnect/timeout and enforce bounded active requests |
| Admission | IP rate limit only | One agent monopolizes capacity | Agent limit across tokens; active request limit and socket cap; bounded maps |
| Health/shutdown | No health route; CLI closes sockets | No probe; signal listeners remain | /healthz liveness (not provider readiness), idempotent shutdown and listener cleanup |
| Distribution defaults | Loopback only | Remote exposure configuration unclear | Explicit --host; warn on 0.0.0.0 and recommend TLS proxy |
| Secrets | SHA-256 token digests; generic errors; request/response header allowlists | Digest comparison not explicit constant time; provider responses may reveal provider data | timingSafeEqual digest check; retain allowlists; document trust boundary |
| State permissions | directory 0700, key 0600; SQLite inherits umask | DB/sidecars too permissive; symlinks | Private creation and reject unsafe existing database files |
| Supply chain | Zero runtime dependencies, Node >=24, package files allowlist | Unbounded major runtime; no provenance guide/security scanning | Node 24.x, minimal files, changelog, provenance instructions, Dependabot/CodeQL, push+PR CI |
| 10,000 installations | Independent local SQLite stores | Updates, backups and host compromise remain operator responsibility | No central service; document patching and local trust limits |

## Implemented response

All planned code/distribution changes above are implemented. Bearer success uses six SQL statements (token lookup, ledger read, tranche read, nonce lookup, event insert, debit) plus BEGIN/COMMIT; signed success skips token lookup. Prepared statements are cached in gateway and ledger. Digest equality uses timingSafeEqual; SQL lookup and the entire endpoint are not constant-time. Default agent admission limits are shared across tokens and management endpoints; limit failures are 403 (IP limit failures are 429).

CLI maintenance runs every second and deletes at most 1,000 expired receipts per tick, retaining them until tranche expiry + 24h. Programmatic users must call pruneEvents() on their own schedule. This bounds each delete transaction, not retention lag under sustained high traffic; operators must monitor disk and export evidence. Tranche, token and settlement metadata is retained. Private existing database files are required rather than silently rewriting their permissions.

The upstream is trusted operator configuration, never client-selected. Exact routes, rejected queries/encodings/dot segments and disabled redirects prevent caller-controlled SSRF/path switching. Private upstream origins remain allowed for local gateways; this is not protection against a malicious operator or DNS changes controlled by that operator.

## Load-driven corrections

A first 200-client cold-start burst reset TCP connections on this macOS host (listen backlog 128). The steady-state harness now establishes client connections in batches of 25 before timing; cold connection storms are not covered by these numbers. Deployment proxies must handle connection bursts. The previous one-second keepalive was also too short relative to modern client keepalive safety buffers; both servers now use five seconds.

A second run found upstream connection bursts returning 502 at 200 clients. Replaced the unbounded fetch pool with Node HTTP/HTTPS agents (64 upstream sockets by default). Active request limit remains 200: excess work queues inside the bounded upstream pool, with the same abort deadline including queue, DNS, connect, headers and body. No redirects are followed. Client disconnect and server shutdown abort ongoing upstream work; closing the server destroys idle pool sockets.

## Validation

Disk usage from live tranches, settlement history and expired tranche metadata still requires operator retention/backup policy; pruning receipts is not full database compaction. SQLite WAL is not a distributed database.

### Local measurements (2026-11-17)

Commands: `heavy nice -n 15 node scripts/load.mjs` and `LOAD_DEFAULTS=1 heavy nice -n 15 node scripts/load.mjs`. Node 24.16.0, Apple M5, 10 logical CPUs, 16 GiB, Darwin 27.2.0. Local temporary disk, WAL/FULL; local HTTP mock delays 5ms then returns roughly 1KiB JSON. Each run measures 1,000 requests after warming each client in batches of 25 and waiting 1.05s. Responses are fully consumed. These short steady-state samples do not test real providers, long SSE streams, soak durability, cold connection storms, distributed hosts, or 10,000 users. Other tasks on this shared machine affect results.

| Configuration | Concurrent clients | successful rps | p50 (ms) | p99 (ms) | Non-200 rate | Status counts |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Capacity: IP/agent limits explicitly raised to 1,000,000/s | 50 | 3865.72 | 9.18 | 44.84 | 0% | 200:1000 |
| Capacity: same | 200 | 4468.91 | 42.14 | 67.01 | 0% | 200:1000 |
| Safe defaults, one token and one source IP | 50 | 1160.36 | 2.14 | 32.26 | 90% | 200:100, 403:100, 429:800 |
| Safe defaults, same | 200 | 1242.61 | 6.26 | 80.00 | 90% | 200:100, 403:100, 429:800 |

Latency includes rejections in the default-limit rows. Default runs finish in less than one second, so successful rps there is a burst quotient, not sustained throughput; the actual policy remains 100 admissions/agent/second and 200 requests/IP/second. Capacity and default rows are not comparable SLAs. Raw metadata/results: [capacity](load-capacity.jsonl), [defaults](load-defaults.jsonl). The capacity run changes only rate thresholds, not the 200-active/512-client/64-upstream connection bounds.

Regression tests: five new tests failed before implementation (RED); after fixes, 37 focused gateway/proxy/CLI tests pass, including the sixth new upstream-pool regression. Clean root/standalone gateway package installation and Quickstart pass without the BSV runtime dependency (`heavy nice -n 15 node scripts/check-package.mjs`). Acceptance CI confirms 172 tests passed (existing 166 + 6 new). The high-volume signed demo and benchmark explicitly raise agent rate limits; deployment defaults remain unchanged. The three 1600×900 PNGs were rendered from committed HTML using the mitama headless Chromium browser and visually inspected. No independent reviewer or Jev grading was run because this delegated task explicitly prohibits further delegation.

### Remaining limits

No horizontal scaling, high-availability failover, live DB sharing across hosts, billing-grade exactly-once provider effects, production soak test or provider-specific TLS/network test is claimed. Receipts only prune after authority expiry: long-lived active tranches can still consume disk. Operators must monitor retained tranche/token/settlement metadata, cleanup lag and WAL/checkpoints, provision disk, export needed receipts, and test backups. No npm publish, merge or repository settings change was performed.
