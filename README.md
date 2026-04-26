# Harbor CLI

Harbor CLI helps Mac Mini agents discover Harbor service-market opportunities,
run local service checks, and interact with the Harbor service market contract.

## Commands

```sh
harbor market opportunities --url http://127.0.0.1:8888
harbor market opportunities --best --url http://127.0.0.1:8888
harbor market services --url http://127.0.0.1:8888
harbor agent init --account myprovider
harbor agent status
harbor agent doctor
harbor agent launchd --service bp
harbor agent launchd --service trace-api
harbor agent launchd --service history-api
harbor agent launchd --service history-actions
harbor agent launchd --service storage
harbor storage put ./artifact.bin
harbor storage put ./artifact.bin --encrypt --private-key "$HARBOR_STORAGE_KEY"
harbor storage manifest
harbor storage serve
```

The first implementation reads the `svcmarket` contract tables and reports the
current service supply, epoch budgets, and estimated per-provider rewards.
Use `harbor market opportunities --best` to ask what one more agent should run
right now to get the highest estimated reward. The opportunity output also names
the narrow duty, what the agent should not do under that registration, and the
oracle checks that should prove it.

The agent commands create a local `~/.harbor/config.json`, check local service
ports, and generate launchd plists. `harbor storage put` copies an object into
the local storage root, optionally encrypts it, and prints the hash fields needed
for the `harborstore::putobject` action. The storage server exposes a lightweight
manifest API that oracles and verifiers can sample:

- `GET /health`
- `GET /manifest`
- `GET /files/<path>`

## Service Boundaries

- `bp`: produce and validate blocks only. Do not serve chain API, trace API, or
  storage under a BP registration.
- `chainapi`: serve chain API RPC requests only.
- `traceapi`: store and serve transaction/action traces only. Do not serve chain
  API requests under a trace API registration.
- `storage`: store declared Harbor artifacts for assigned ranges. The current
  storage runner exposes a manifest plus sampled file reads so oracles can check
  object hashes, range coverage, and freshness.
- `histcore`: ingest trace data and build Harbor History slices for a
  declared block range.
- `histactions`: serve account/action history for a declared block range.
- `histtx`: serve transaction-id lookups for a declared block range.
- `histapi`: serve the Harbor History-compatible API edge and route queries to
  backing range providers.
- `histstream`: serve real-time Harbor History event streams.
- `p2pseed`: maintain reachable p2p seed connectivity and relay blocks and
  transactions. This is not a BP or chain API registration.
- `verifier`: audit registered agents, including endpoint probes, storage
  replica audits, service-boundary checks, and signed report publication.

Oracles and verifiers are expected to check that each registered service does its
specific job and nothing broader. Passing checks can reward providers and
agreeing checkers; missed or disagreeing reports can be penalized by the market
contract.

## Development

```sh
npm install
npm run build
node lib/index.js --help
```
