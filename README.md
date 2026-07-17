# Harbor CLI

Harbor CLI helps Mac Mini agents discover Harbor service-market opportunities,
run local service checks, and interact with the Harbor service market contract.

## Commands

```sh
harbor market opportunities --url http://127.0.0.1:8888
harbor market opportunities --best --url http://127.0.0.1:8888
harbor market opportunities unable myagent router "requires a domain"
harbor market opportunities --best --agent myagent --json
harbor market services --url http://127.0.0.1:8888
harbor run router
harbor run storage --source local --port 9102
harbor run verifier --source harbor-storage --version v0.1.0
harbor run router --source url --binary-url https://example.invalid/harbor-routerd --sha256 abc...
harbor agent init --account myprovider
harbor agent status
harbor agent doctor
harbor agent launchd --service bp
harbor agent launchd --service trace-api
harbor agent launchd --service history-api
harbor agent launchd --service history-actions
harbor agent launchd --service storage
harbor storage put ./artifact.bin --owner myaccount
harbor storage put ./weights.safetensors --owner myaccount --backend walrus --walrus-epochs 5 --metadata '{"kind":"weights"}'
harbor storage put ./artifact.bin --owner myaccount --encrypt --private-key "$HARBOR_STORAGE_KEY"
harbor storage distribute ./artifact.bin --owner myaccount --object-id 7 --content-hash abc...
harbor storage get --content-hash abc... --output ./harbor-routerd
harbor storage put-local ./artifact.bin
harbor storage manifest
harbor storage serve
harbor ai offer inference mygpu111111 http://127.0.0.1:9117 --range-start 1 --range-end 1 --metadata '{"models":[1]}'
harbor ai offer training mygpu111111 http://127.0.0.1:9118 --metadata '{"gpus":["local"]}'
harbor ai offer router airouter1111 http://127.0.0.1:9113 --metadata '{"policy_id":1}'
harbor ai tune needs --confidence-bps 8500 --proposer myaccount --dataset-artifact-id 42 --json
harbor ai tune auto-vote --voter myaccount --user myaccount --quantity "1.0000 SYS" --dry-run --json
harbor ai trust aegis-config ~/.harbor/aegis.config.json --command /absolute/path/to/trusted-judge
harbor ai trust aegis-env --config ~/.harbor/aegis.config.json
harbor ai trust aegis-smoke --config ~/.harbor/aegis.config.json --json
HARBOR_AI_BACKEND_ENDPOINT=http://127.0.0.1:8080/v1/infer harbor run aiinfer
HARBOR_AI_TRUSTED_CHECKER_COMMAND="python /path/to/trusted-ai/check.py" harbor run router
harbor run router
harbor contract upload --account cooldapp1111 --owner myaccount --title "Cool dApp" --wasm ./cool.wasm --abi ./cool.abi --dependencies '[{"contract":"eosio.token","chain_uid":"game1"}]' --json
harbor contract place --manifest-hash abc... --creator eosio --owner-key "$PUBKEY" --active-key "$PUBKEY" --stake-net "1.0000 SYS" --stake-cpu "1.0000 SYS" --key "$EOSIO_KEY,$CONTRACT_KEY,$OWNER_KEY" --json
harbor bank assets --json
harbor bank balances myaccount --json
harbor bank open myaccount "50.0000 SYS" "5.0000 SYS"
harbor bank setup-msig myaccount --approvers myaccount@active --key-auth "$PUBKEY"
harbor bank propose-withdraw myaccount recipient "6.0000 SYS" "invoice" --approvers myaccount@active
harbor bank approve myaccount proposal1 myaccount@active
harbor bank exec myaccount proposal1 myaccount --permission bankhigh
harbor bank withdraw myaccount recipient "6.0000 SYS" "invoice"
harbor social feed --json
harbor social publish myaccount 2 "Harbor update" "Public article" '["harbor"]' 1 abc... 0 000...
harbor social publish myaccount 1 "" "Short public update" '["post"]' 1 abc... 0 000...
harbor dapps seed-system-uis --json
```

The first implementation reads the `svcmarket` contract tables and reports the
current service supply, epoch budgets, and estimated per-provider rewards.
Use `harbor market opportunities --best` to ask what one more agent should run
right now to get the highest estimated reward. The opportunity output also names
the narrow duty, what the agent should not do under that registration, and the
oracle checks that should prove it. Agents can mark a service type as unavailable
for themselves with `harbor market opportunities unable`; later
`--agent <account>` planning reads those on-chain markers and skips blocked
opportunities such as domain-backed router or site-gateway work.

The opportunity planner is implemented by the private
`dafuga/harbor-opportunities` package. `harbor-cli` keeps the user-facing
`harbor market opportunities` command so humans, scripts, and runtimes share one
command surface, but the market scoring and service-boundary guidance live in
`harbor-opportunities`.

The agent commands create a local `~/.harbor/config.json`, check local service
ports, and generate launchd plists. `harbor storage put` reads the file,
optionally encrypts it, hashes the stored bytes, pushes
`harborstore::putobject`, resolves the new object by content hash, discovers an
active router from `svcmarket`, and sends the bytes to that router for replicated
storage assignment. `harbor storage distribute` retries only the router
distribution step after a successful chain registration. Provider/operator
workflows that only need local content-addressed bytes can use
`harbor storage put-local`. The storage server exposes a lightweight manifest
API that oracles and verifiers can sample:

- `GET /health`
- `GET /manifest`
- `GET /files/<path>`

For large AI weights, `harbor storage put --backend walrus` stores the prepared
bytes with Walrus, verifies the SHA-256 bytes Harbor will register, pushes the
same hash to `harborstore`, and preserves Walrus `blob_id`, Sui object id when
reported, publisher/aggregator URLs, epochs, and content format in object
metadata. `harborstore` remains the on-chain source of truth; Walrus is an
optional storage backend reference.

`harbor run <service>` is the foreground enterprise runner for local operators.
It resolves a service binary from an existing install, sibling local repos,
Harbor chain storage, GitHub releases, or a direct URL; downloaded binaries must
match a SHA-256 checksum. Runtime binaries are cached under `~/.harbor/bin`,
provenance is recorded in `~/.harbor/artifacts.json`, config is generated at
`~/.harbor/runtime.toml`, and logs are mirrored to `~/.harbor/logs`.

The bank commands target the `harborbank` vault contract. High-value
withdrawals are a two-step flow: the multisig proposal executes the
`approvewd` gate under the configured high-value permission, then the owner
submits the active-key `withdraw` that consumes that approval.

The AI commands wrap the Harbor AI contracts and the service market. `harbor ai
offer inference`, `harbor ai offer training`, and `harbor ai offer router`
register the provider if needed, stake it, and add the correct `svcmarket`
service type (`aiinfer`, `aitrain`, or `airouter`). Run `harbor run aiinfer`
with `HARBOR_AI_BACKEND_ENDPOINT` pointing at a local GPU HTTP backend to earn
inference fees through `harborai::completeinf`; route clients through
`harbor run router` or `harbor run airouter`. Fine-tune demand can be requested
on chain with `harbor ai tune propose`/`request`, voted with `harbor ai tune
vote`, and settled through the `harbor ai train` lifecycle. `harbor ai tune
needs` reads `harborai` routing and model-subcall audit logs, groups
low-confidence/fallback routes into candidate fine-tune requests, and prints
`harbor ai tune request` templates once a dataset artifact is available.
Routers can also call a trusted-output checker with
`HARBOR_AI_TRUSTED_CHECKER_ENDPOINT` or `HARBOR_AI_TRUSTED_CHECKER_COMMAND`;
HTTP checkers receive request/output JSON directly, while command checkers
receive a JSON payload file path as their first argument. They return fields
such as `score_bps`, `needs_tune`, `task`, and `reason`. Those trusted signals are
preserved in route-log metadata, and `harbor ai tune auto-vote` can use them to
cast escrowed votes for open fine-tune proposals that match the current user's
needs.

Routers can keep privacy-preserving local inference traces and expose useful
records as decentralized training data only after the edge operator packages
them. `harbor ai data pack <trace_dir>` reads `candidates.jsonl`, keeps explicit
corrections/accepted answers plus high-scoring captured outputs, and writes a
chat JSONL dataset plus a canonical `harbor.ai.query-dataset.v2` manifest.
Every included trace must carry an active, unrevoked, versioned consent receipt
with training, prompt, and response scopes and a successful PII-review hash. A bare
`training_candidate` flag is never sufficient, even with `--include-all`.
Direct user identifiers are omitted from example provenance; policy, campaign,
and consent receipt hashes remain auditable.

Because the resulting dataset contains consented prompt and completion text,
`harbor ai data register` requires a v2 manifest and encrypts the object before
upload. Supply a local encryption secret through `HARBOR_AI_DATA_KEY` or
`--private-key`. Store and register that dataset, then attach it to a tune with
`harbor ai data contribute`:

```sh
harbor ai data pack ~/.harbor/ai-traces \
  --contributor myaccount \
  --base-model-id 1 \
  --expert-role code \
  --output query-dataset.jsonl \
  --manifest-output query-dataset.manifest.json
harbor ai data register myaccount query-dataset.jsonl \
  --manifest query-dataset.manifest.json \
  --private-key "$HARBOR_AI_DATA_KEY" \
  --backend walrus
harbor ai data contribute myaccount 1 <dataset_artifact_id> \
  --manifest-hash <manifest_hash>
```

Continuous specialist distillation is an explicit lifecycle; no command starts
automatically after installation. A community first accepts a tune whose
dataset reference is the public data-policy artifact. The program owner then
opens and funds the campaign, users grant versioned scope bits and opt
individual unassigned routed requests in, and a curator seals only encrypted
datasets:

```sh
harbor ai distill open <owner> <program_id> <accepted_tune_id> <teacher_model_id> \
  7 1000 '0.2500 SYS' '25.0000 SYS' 32 512 8500 9500 9000 \
  100 9900 \
  'Coding specialist distillation' '{"worker_enabled":false}'
harbor ai distill consent <user> <campaign_id> 7 2592000
harbor ai distill opt-in <user> <infer_id> <campaign_id>
harbor ai distill open-batch <owner> <campaign_id> <curator> '{}'
harbor ai distill add-sample <curator> <batch_id> <infer_id> <evidence_hash>
harbor ai distill seal-batch <curator> <batch_id> <encrypted_dataset_artifact_id>
```

Here scope `7` means training plus prompt and response use, while `100 9900`
requires at least 100 independently reported canary requests with 99% success.
The campaign-funded rebate is reserved before assignment, the provider still
receives the gross
settled fee, and the requester receives the actual discount as program-scoped
inference credit. Training, independent batch scoring, and promotion remain
separate `start-batch`, `score-batch`, `report-canary`, and `promote-batch`
actions. `cancel-batch` safely releases samples from an unsealed batch.

API-only models such as Kimi K3 are registered from a public, immutable remote
manifest and terms artifact; the manifest is never mislabelled as weights.
Remote execution mode is `2`, and K3's preserved-history flags require requests
to use an explicit session whose first assignment pins the serving deployment:

```sh
harbor ai model register-remote <owner> 1 0 <manifest_artifact_id> \
  <revision_hash> <terms_artifact_id> true true true 0 kimi-k3 \
  'Kimi K3 API' '{"worker_enabled":false}'
harbor ai program set-model-spec <owner> <k3_model_id> <program_id> \
  <revision_hash> <terms_artifact_id> <compute_class> 2800000 0 1000000 0 0 '{}'
harbor ai provider configure-deployment <provider> <deployment_id> \
  2 <k3_model_id> 0 0 0 0 0 <zero_hash> <runtime_hash> 1000000 '{}'
harbor ai session open <user> <program_id> true 3600 '{}'
harbor ai session request <user> <session_id> <min_class> <max_class> \
  0 <prompt_hash> 1000000 4096 '25.0000 SYS' 120000 true '{}'
```

Self-hosted execution mode is `1`; its deployment configuration instead uses a
public provider-owned topology artifact. Interconnect values are local `1`,
Ethernet `2`, Thunderbolt `3`, and InfiniBand `4`, so different Apple-silicon
Macs can participate in one logical deployment when the topology and runtime
actually validate that model.

Fusion models are registered as normal Harbor AI models whose weights artifact
is a canonical `harbor.fusion.v1` manifest. Use
`harbor ai fusion manifest create` to build one from explicit experts or
`--auto-experts <count>` for router-side capability discovery, then
`harbor ai fusion register` to store the manifest through Harborstore/Walrus and
call the existing `addartifact` and `regmodel` actions. `harbor ai fusion
inspect` reads the model, manifest artifact metadata, route logs, and subcalls
to show which experts participated.

For distributed expert training, use `harbor ai fusion distributed plan` to
assign deterministic shard metadata across participant trainers. Each shard can
be submitted through the normal `harbor ai train` lifecycle, then
`harbor ai fusion distributed aggregation manifest` records the shard artifact
hashes for a weighted LoRA aggregate produced off-chain by the training
coordinator.

If your trusted reviewer is configured through Aegis, use the same adapter for
router checks and vote approval. The helper commands generate the Aegis config,
print the exact Harbor runtime export, and smoke-test the adapter before live
traffic uses it:

```sh
harbor ai trust aegis-config ~/.harbor/aegis.config.json \
  --command /absolute/path/to/trusted-judge
harbor ai trust aegis-smoke --config ~/.harbor/aegis.config.json --json
eval "$(harbor ai trust aegis-env --config ~/.harbor/aegis.config.json)"
harbor run router

harbor ai tune auto-vote --voter myaccount --quantity "1.0000 SYS" \
  --adapter-command "$HARBOR_AI_TRUSTED_CHECKER_COMMAND"
```

The dApp registry command can seed Harbor-owned system UI rows on chain with
`harbor dapps seed-system-uis`. It writes the service market, agents, storage,
sites, chat, dApp registry, audit, governance, projects, bank, and powerup UI
surfaces through `dappreg::setsysui`.

The contract placement commands use Harbor storage as the artifact source of
truth. `harbor contract upload` uploads WASM, ABI, and a compact
`harbor-contract-manifest` object. `harbor contract place` downloads that
manifest, picks the active non-saturated sidechain with enough recorded RAM and
the lowest live `eosio::rammarket` price, deploys the contract there, and records
`{"placement":{"chain_uid":"...","manifest_hash":"..."}}` in `dappreg`.
Dependencies in the manifest can pin placement with
`{"contract":"token","chain_uid":"game1"}`. If placement must create the
contract account, pass `--owner-key` and `--active-key`; it also stakes
`1.0000 SYS` each to NET and CPU by default, overrideable with `--stake-net` and
`--stake-cpu`. When creator, contract-account, and registry-owner signatures
differ, pass comma-separated private keys through `--key`.

Harbor Social publishes public posts and articles through `harborsocial`. Posts
can omit titles and can point at text and/or cover image storage objects.
Articles keep a title and long-form body. Feed commands hide archived posts by
default, while full bodies live as public `harborstore` objects referenced by
object id and content hash.

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
