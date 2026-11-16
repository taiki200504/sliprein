# Authority UTXO experiments

This archive contains the original authority/covenant SDK, adversarial tests, local regtest harness and the earlier signed-approval learning baseline. It is an experimental trustless mode, not a production deployment.

Import the optional adapter from `./bsv.mjs` explicitly. It is no longer re-exported by the default gateway. Install the separate `authority/` research package (or root development dependencies) to run it.

The production-facing default remains the trusted local SQLite gateway. Chain settlement simulations do not establish external API effects or finality. Japanese research and four rounds of red-team findings remain in [docs/ja](../../docs/ja/).

Run the full regression suite from the repository root with `npm ci && npm test`. The isolated SDK can also be installed in `authority/`. Historical regtest evidence is under `authority/regtest/`; its node harness is optional and is not started by the normal tests.
