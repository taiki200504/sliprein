# Release checklist (no publication performed)

Use semantic versions: fixes PATCH, backwards-compatible functionality MINOR, incompatible public behavior MAJOR (pre-1.0 minor releases may change behavior). Keep root/gateway versions and lockfile aligned. Record changes in CHANGELOG.md.

1. Review all changes, run required acceptance CI and CodeQL, and inspect `npm pack --dry-run --json`. Runtime dependencies must remain empty; exclude research, tests, state, credentials and developer ledgers.
2. Use supported Node.js 24.x. Run `node scripts/check-package.mjs` under the shared heavy lock to verify a clean package install and local mock Quickstart.
3. Confirm the npm package identity and release ownership with its owner. This repository has not published this package; do not suggest `npx sliprein` until publication is verified.
4. Prefer npm trusted publishing from GitHub Actions with a restricted release environment and `id-token: write`, matching repository/workflow/environment in npm settings. Publish with provenance (`npm publish --provenance --access public`) only at an owner-authorized release. Do not store npm tokens in the repository.
5. Review the tarball, provenance attestation, registry version and install behavior after release; sign/tag the exact reviewed commit. Provide migration and rollback instructions for operators.

This document does not authorize a publish, change npm/GitHub settings, or create release credentials. Provenance connects an artifact to a build; it does not prove code safety. Check current npm trusted-publishing documentation before executing a release.
