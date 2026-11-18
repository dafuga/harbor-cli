#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${HARBOR_DAEMON_DIR:?Set this to a directory containing the target's compiled Harbor daemons}"
: "${HARBOR_SMOKE_EVIDENCE:?Set this to the desired screenshot and transcript directory}"

npm run compile
npm run check
node --test lib
node scripts/runtime-smoke.mjs "$@"
if [[ "${HARBOR_VERIFY_NODEOS:-0}" == 1 ]]; then
  node scripts/node-smoke.mjs
fi
