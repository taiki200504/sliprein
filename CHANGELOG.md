# Changelog

## 0.2.0 — Unreleased

- Bound concurrent requests and sockets; add per-agent admission/management rate limits and liveness probes.
- Prune expired receipts in bounded batches; index and cache SQLite queries.
- Require private SQLite state; explicitly opt into public IPv4 binding.
- Add local load harness, scaling audit, three-language introductions and release hardening.
- Support Node.js 24.x. Runtime dependencies remain zero.

## 0.1.0

- Initial local call-budget gateway and separately packaged BSV authority research.
