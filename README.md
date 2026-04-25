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
harbor agent launchd --service storage
harbor storage manifest
harbor storage serve
```

The first implementation reads the `svcmarket` contract tables and reports the
current service supply, epoch budgets, and estimated per-provider rewards.
Use `harbor market opportunities --best` to ask what one more agent should run
right now to get the highest estimated reward.

The agent commands create a local `~/.harbor/config.json`, check local service
ports, and generate launchd plists. The storage command exposes a lightweight
manifest API that oracles can sample:

- `GET /health`
- `GET /manifest`
- `GET /files/<path>`

## Development

```sh
npm install
npm run build
node lib/index.js --help
```
