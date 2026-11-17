# Changelog

## 0.2.0 — Unreleased

- Bound concurrent requests and sockets; add per-agent admission/management rate limits and liveness probes.
- Prune expired receipts in bounded batches; index and cache SQLite queries.
- Require private SQLite state; explicitly opt into public IPv4 binding.
- Add local load harness, scaling audit, three-language introductions and release hardening.
- Support Node.js 24.x. Runtime dependencies remain zero.

## 0.1.0

- Initial local call-budget gateway and separately packaged BSV authority research.

### PR #1 security review fixes

- Reject missing/malformed authentication and unknown/revoked/expired Bearer tokens with 401 before reading bodies or occupying execution capacity; signed requests receive format preflight before body verification. Total body deadline defaults to 5 seconds (`bodyTimeoutMs`, CLI `--body-timeout-ms`).
- Normalize IPv6 rate keys to /64; forwarded last-hop IP is trusted only with explicit `trustProxy: true` / `--trust-proxy true`.
- Deliver 413 with `Connection: close` and destroy the request after the response flushes.
- Add `token revoke <agent>` and optional `token <agent> --ttl <seconds>` with durable per-token expiry/revocation.
- Refund an admission exactly once on upstream connection failure or timeout before response headers. Any failure after upstream headers, including upstream error statuses, redirects and interrupted streams, remains counted. Refunded nonces remain recorded to prevent replay.
