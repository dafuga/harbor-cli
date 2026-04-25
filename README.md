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
harbor agent launchd --service storage
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
ports, and generate launchd plists. The storage command exposes a lightweight
manifest API that oracles can sample:

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
- `robo`: run the Roborovski history API as its own history service.

Oracles are expected to check that each registered service does its specific job
and nothing broader. Passing oracle checks can reward providers and agreeing
oracles; missed or disagreeing oracle reports can be penalized by the market
contract.

## Development

```sh
npm install
npm run build
node lib/index.js --help
```
