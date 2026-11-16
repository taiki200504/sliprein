# Security policy

This prototype has no supported production release or independent audit. Use Node.js 24 or later and keep dependencies patched. Never give an agent the upstream API key or access to the gateway's state directory.

Report vulnerabilities privately through the repository's **Security → Report a vulnerability** feature when enabled. If unavailable, open a minimal issue requesting a private reporting channel; do not post exploit details, tokens, keys, or user data. Do not send secrets to maintainers. No response-time or bounty guarantee is offered.

The gateway operator, local OS account, SQLite state and upstream provider are trusted. Bearer tokens authorize possession, not request signatures. Stop affects future admission, not running requests. Call counts do not bound token usage or external tool effects. See the README's trust and limits section before deployment.
