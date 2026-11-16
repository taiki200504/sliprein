# Contributing

Use Node.js 24 or later. Run `npm ci`, then `npm test` with test concurrency set to one. `npm run demo` uses an offline mock upstream; no provider key is needed. Record the optional animation with `vhs demo/demo.tape`.

Add a failing regression test before changing behavior. Keep changes focused; preserve signed-client compatibility, transactional quotas, fail-closed authorization, streaming backpressure and secret isolation. Tests should cover rejected paths as well as successful calls. Never commit credentials, live SQLite stores or private research notes.

Open an issue to discuss substantial API or trust-model changes. Describe observable behavior, compatibility and the checks run in pull requests. Do not claim trustlessness or production security from local simulation alone. Contributions are accepted under Apache-2.0.
