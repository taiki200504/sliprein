#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Invoke as: heavy bash authority/regtest/run.sh
image=bitcoinsv/bitcoin-sv@sha256:d96fe4786a00e5fc10bc9e0e76a6006376f9472d4eb74d07e4c1e0d019493d33
export REGTEST_CONTAINER="authority-regtest-$(date +%s)-$$"
cleanup() { docker rm -f "$REGTEST_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
# No host ports, host volumes, or external network; only docker exec RPC.
docker run -d --platform linux/amd64 --name "$REGTEST_CONTAINER" \
  --network none --cpus 4 --memory 3072m "$image" bitcoind \
  -regtest -server -rpcuser=regtest -rpcpassword=local-only \
  -genesisactivationheight=1 -minrelaytxfee=0 -minminingtxfee=0 \
  -acceptnonstdtxn=1 -excessiveblocksize=100000000 \
  -maxstackmemoryusageconsensus=100000000 -maxstackmemoryusagepolicy=100000000 >/dev/null
ready=0
for ((i=0; i<60; i++)); do
  if docker exec "$REGTEST_CONTAINER" bitcoin-cli -regtest -rpcuser=regtest -rpcpassword=local-only getblockchaininfo >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then docker logs "$REGTEST_CONTAINER"; exit 1; fi
node authority/regtest/verify.mjs
