# Harbor CLI

Harbor CLI helps Mac Mini agents discover Harbor service-market opportunities,
run local service checks, and interact with the Harbor service market contract.

## Commands

Governed RLVR datasets can be packed with `harbor ai data pack ... --rlvr
--split train`, `--split validation`, or `--split eval`. Keep prompts disjoint;
`eval` is the final holdout and must never select a checkpoint. The trainer
requires both training and evaluation examples. Pack distinct source sets, then
combine their canonical JSONL before creating the recipe for that exact dataset
hash. Recompute the dataset manifest and lineage when combining sources; do not
reuse a component pack's manifest for the combined artifact.

`harbor ai rlvr work-item recipe.json dataset.jsonl --output work.json --json`
packages the exact sealed recipe and dataset into the trainer's canonical
wrapper. It checks the dataset commitment, verifier IDs, and disjoint splits.
The output contains private examples, is created with mode `0600`, and refuses
to overwrite an existing path. Encrypt it through the governed Vault workflow
before transport. Console output contains only paths and hashes. Network
settlement claims are independently checked by the training daemon; this local
packer does not attest consent, review quorum, or chain settlement.

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
harbor storage authorize-custodian keytrustee1 myaccount true
harbor vault keygen ~/.harbor/vault/objects/sample-42 --name object --key-id object:sample-42
harbor storage put ./sample.json --owner myaccount --encrypt \
  --recipient-public-key ~/.harbor/vault/objects/sample-42/object-public.json \
  --vault-policy-id 3 --vault-consent-id 4 \
  --purpose distillation-review --ttl-sec 86400 --key-custodians '["keytrustee1"]'
harbor storage distribute ./artifact.bin --owner myaccount --object-id 7 --content-hash abc...
harbor storage get --content-hash abc... --output ./harbor-routerd
harbor storage put-local ./artifact.bin
harbor storage manifest
harbor storage serve
harbor storage put-temporary-at myaccount <ciphertext_hash> 4096 true <erasable_recipient_key_hash> 2026-07-19T00:00:00 '["keytrustee1"]' '{"class":"raw"}'
harbor storage migrate-keys 256 --actor harborstore
harbor storage migrate-capacity 256 --actor harborstore
harbor storage set-lock-protocol harborvault true --actor harborstore
harbor storage lock-until <owner> <object_id> <controller> <reason_hash> 2026-08-19T00:00:00
harbor storage protocol-lock harborvault <owner> <object_id> <reason_hash> 2026-08-19T00:00:00
harbor storage report <object_id> <verifier> true <report_hash>
harbor storage report-replica <replica_id> <verifier> true <report_hash>
harbor storage tombstone myaccount <object_id> <reason_hash>
harbor storage retire-chunk <object_id> 256 --actor <keeper>
harbor vault encrypt ./sample.json ./sample.envelope.json \
  --recipient-public-key ~/.harbor/vault/objects/sample-42/object-public.json \
  --policy-id 3 --consent-id 4 \
  --purpose distillation-review --expires-at 1784400000
harbor vault create-policy <controller> <manifest_hash> <keyset_hash> 2592000 2 2 2 '{}'
harbor vault consent <subject> <raw_policy_id> <collector> <purpose_hash> <scope_hash> 2 true <expires_at>
harbor vault rewrap ./sample.envelope.json ./sample.trainer.hgr1.json \
  --current-private-key ~/.harbor/vault/objects/sample-42/object-private.json \
  --next-public-key ~/.harbor/vault/access/trainer-public.json \
  --receipt-id 19 --custodian keytrustee1 --grantor myaccount \
  --processor trainer --expires-at 1784390000 \
  --custodian-signing-key "$TRUSTEE_CHAIN_KEY" \
  --grantor-signing-key "$SUBJECT_CHAIN_KEY" \
  --processor-signing-key "$TRAINER_CHAIN_KEY"
harbor vault expire-rewrap <keeper> <abandoned_grant_id>
harbor vault decrypt ./sample.trainer.hgr1.json ./sample.clear.json \
  --recipient-private-key ~/.harbor/vault/access/trainer-private.json \
  --grant-id 123 --processor trainer --access-object-id <hgr1_storage_object_id> \
  --actor trainer --key "$TRAINER_CHAIN_KEY"
harbor ai infer assign-exact <requester> <infer_id> <provider>
harbor ai infer commit-seed <requester> <infer_id> <seed_commitment>
harbor ai infer accept <provider> <infer_id> <start_hash>
harbor ai infer acknowledge <requester> <infer_id> <acceptance_hash>
harbor ai infer settle <keeper> <infer_id> 0
harbor ai infer challenge <requester> <infer_id> 0 <evidence_hash> <selection_reveal>
harbor ai infer resolve <keeper> <infer_id> <svc_check_id>
harbor ai infer expire <keeper> <infer_id>
harbor ai promotion attest-canary <router> <round_id> <infer_id> <svc_check_id>
harbor ai promotion launch <owner> <round_id>
harbor ai promotion expire-execution <round_id> --actor <keeper>
harbor ai promotion migrate-stages 256 --actor harborai
harbor ai promotion migrate-funding <round_id> 256 --actor <keeper>
harbor ai promotion migrate-active-rounds 256 --actor harborai
harbor ai promotion clean-round <round_id> 256 --actor <keeper>
harbor ai promotion adjudicate-milestone <milestone_id> true <decision_hash> --actor harborai
harbor ai attestation configure 3600 86400 --actor harborai
harbor ai attestation challenge <challenger> <kind> <subject_id> <challenge_hash>
harbor ai attestation resolve <kind> <subject_id> true <decision_hash> --actor harborai
harbor ai attestation settle <kind> <subject_id> --actor <keeper>
harbor ai attestation expire <kind> <subject_id> --actor <keeper>
harbor ai treasury spend-signal <recipient> '1.0000 SYS' '0.0000 SYS' <purpose_hash> 'reviewed spend' --actor harborai
harbor ai provider seed-training-contribution <submission_id> <model_id> --actor <keeper>
# Compatibility-disabled: seed-inference-contribution always rejects because a
# deployment registration is not inference work.
harbor ai provider prune-deployment <keeper> <deployment_id>
harbor ai model set-tokenizer <actor> <model_id> <tokenizer_artifact_id> <tokenizer_hash> <vocab_size> <format_version>
harbor ai distill set-token-translation <owner> <campaign_id> <translation_artifact_id> <translation_version>
harbor ai model bind-custody <keeper> <model_id> <weights_artifact_id> <vault_contract> <vault_receipt_id>
harbor ai model adopt-weights <owner> <model_id> <weights_artifact_id>
harbor ai program close <owner> <program_id>
harbor ai program finalize <keeper> <program_id>
harbor ai program recover <keeper> <program_id>
harbor ai program reclaim-credit <owner> <program_id>
harbor ai program admit-tier <owner> <program_id> <model_id>
harbor ai program migrate-serving 256 --actor harborai
harbor ai train cancel <keeper> <train_id>
harbor ai train clean <train_id> 256 --actor <keeper>
harbor ai distill migrate-batches 256 --actor harborai
harbor ai distill clean-batch <batch_id> 256 --actor <keeper>
harbor market migrate-service-current 256 --actor <keeper>
harbor market migrate-ai-current 256 --actor <keeper>
harbor market migrate-stakes 256 --actor <keeper>
harbor market rebuild-guard 256 --actor <keeper>
harbor market migrate-holds 256 --actor svcmarket
harbor market migrate-checks 256 --actor svcmarket
harbor market prune-price <pair_id> <start_oracle> 256 --actor <keeper>
harbor market refresh-reserve <reserve_id> --actor <keeper>
harbor market set-reserve-authority <stable_contract> true --actor svcmarket
harbor market set-obligation-consumer harborai true 10800 --actor svcmarket
harbor market open-obligation harborai <infer_id> <service_id> <acceptance_hash> 10800
harbor market fund-obligation harborai <infer_id> '1.0000 SYS'
harbor market authorize-obligation harborai <infer_id> <payload_hash>
harbor market authorize-obligation-conflicts harborai <infer_id> <selection_seed> \
  '["requester","router"]'
harbor market authorize-obligation-terms harborai <infer_id> <sample_start> <sample_end> 60 60
harbor market create-obligation-check harborai <infer_id> '[]' 0 0 <payload_hash> 60 60 --actor <keeper>
harbor market close-obligation harborai <infer_id>
harbor market expire-obligation harborai <infer_id> --actor <keeper>
harbor market step-inflation 256 --actor <keeper>
harbor market sweep-epoch <epoch_id> 256 --actor <keeper>
harbor market set-oracle-candidate 18 <oracle> true --actor svcmarket
harbor market set-scheduler-candidate <provider> <verifier_service_id> true --actor svcmarket
harbor market scan-chain-quorum <chain_uid> 256 --actor <keeper>
harbor market claim-project <epoch_id> <project_contract> <project_id> --actor <keeper>
harbor ai distill bind-data-consent <user> <infer_id> <vault_consent_id>
harbor ai distill expire-data <actor> <infer_id>
harbor ai distill withdraw-sample <requester> <infer_id>
harbor ai distill expire-batch <batch_id>
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
ports, and generate launchd plists. `harbor storage put` streams public files
through SHA-256 and directly to the router without retaining whole model shards
in memory. For governed data it applies the platform-bounded governed-data envelope,
hashes the stored bytes, and pushes
`harborstore::putobject` for public/plaintext objects or `harborstore::puttempat`
for governed ciphertext, resolves the unique object created in the transaction's
before/after id window, discovers an
active router from `svcmarket`, records a short-lived one-shot
`harborstore::authroute` authorization from the owner to that router, and sends
the bytes for replicated storage assignment. The contract accepts only the
authorized router's exact initial replica set, so another router cannot append
providers or deletion obligations. An explicit `--router-url` must still match
an active on-chain router identity. Governed uploads require an explicit Vault
policy, consent, purpose, unique custody public key, TTL, and key custodians; the removed
password-derived `--private-key` path fails closed. `harbor storage distribute`
retries only the router distribution step after a successful chain registration
and therefore takes the exact already-prepared envelope bytes. Provider/operator
workflows that only need local content-addressed bytes can use
`harbor storage put-local`. The storage server exposes a lightweight manifest
API that oracles and verifiers can sample:

- `GET /health`
- `GET /manifest`
- `GET /files/<path>`

Before registering randomized governed ciphertext, the CLI durably writes the
exact persisted HGD1 representation to `~/.harbor/prepared-storage/<content-hash>.hgd1.json` (or
`--prepared-output`). If registration or router upload fails, use that file—not
the plaintext—to retry `storage distribute`; regenerating the envelope would
produce a different nonce, DEK, and content hash. The chain registration uses
`puttempat` with the envelope's exact absolute expiry. Small envelopes retain
the original canonical JSON/hex wrapper. When that wrapper would exceed Node's
string limit, the same canonical HGD1 bytes are persisted directly; both forms
have the same envelope commitment and are accepted by the CLI. The former
512 MiB constant has been removed in favor of libsodium's AEAD limit bounded by
the current Node Buffer platform. HGD1 encryption/decryption is still a
whole-buffer operation. True chunk streaming needs a separately versioned,
cross-runtime chunked-AEAD format; multi-gigabyte public weights and model shards
continue to use the streaming Harbor or Walrus path.

For large AI weights, `harbor storage put --backend walrus` hashes the source as
a stream and passes the exact source path directly to Walrus, verifies the
SHA-256 bytes Harbor will register, pushes the
same hash to `harborstore`, and preserves Walrus `blob_id`, Sui object id when
reported, publisher/aggregator URLs, epochs, and content format in object
metadata. `harborstore` remains the on-chain source of truth; Walrus is an
optional storage backend reference.

Before an owner can name a separate key custodian, that custodian must opt in
with `authorize-custodian <custodian> <owner> true`; setting it to `false`
blocks future custody assignments without changing obligations for existing
objects. Self-custody needs no appointment. Temporary governed objects use the
additive `put-temporary`, `set-expiry`, `lock-until`,
`tombstone`, replica-deletion, and key-erasure commands. Tombstoning blocks new
assignments immediately; final deletion requires the recorded replica operators
and independent key custodians to satisfy their obligations. The generic
finite lock records an explicit horizon at or before the object expiry; legacy
`lock-object` remains the indefinite form for non-expiring artifacts.
Governance enables trusted system contracts with `set-lock-protocol`; those
controllers use `protocol-lock` (normally as an inline action) so a Vault or
other generic workflow can extend its own finite retention obligation without
receiving the object's owner authority.
`storage report` intentionally preserves the published object-level `report`
action; use `storage report-replica` for the additive per-replica `repreport`
action.
`harbor vault` surface then binds versioned consent, purpose-limited grants,
cross-policy sanitized derivatives, reviews, lineage, and staged rewards to
those encrypted objects.

`harbor vault encrypt` uses a random per-object 256-bit DEK with
XChaCha20-Poly1305-IETF and wraps only that key to a Curve25519 recipient using
libsodium sealed boxes. The CLI and worker runtime share the deterministic
HGA1/HGR1/HGD1 wire format. Initial HGD1 custody authenticates only information
known before storage: policy, consent, purpose, lifetime, and the unique recipient
key identity and commitment. Its receipt id, object id, grant id, and processor
fields are canonically empty—neither a collector nor the CLI predicts chain ids.
A later HGR1 rewrap binds the actual Vault grant, processor, and access-key id.
Processors must verify that grant, its accepted receipt and consent, and the live
HarborStore object on chain before decrypting. The grant also binds the admitted
source storage locator and transport hash, the unchanged inner ciphertext
commitment, the immutable custodian that attested the rewrap, and the complete
HGR1 envelope commitment; envelope identity hints are never
authorization. Collectors accept only
the public-key JSON format, so accidentally passing a private-key file is
rejected. Generate a fresh recipient key for every temporary object. The CLI
registers its public-key commitment as HarborStore's `encryption_key_hash`, and
HarborStore rejects commitment reuse across objects. Destroying that unique
private key at expiry makes retained HGD1 ciphertext unreadable; a reusable
campaign key cannot provide per-object erasure. A trustee may `rewrap` the DEK
to a distinct, expiring processor access key without decrypting or changing the
payload. The CLI registers the exact HGR1 bytes as a processor-owned encrypted
`puttempat` object with the grant expiry, the processor as immutable key
custodian, and metadata binding the receipt, grant, processor, source ciphertext,
and full access-envelope commitment through a compact binding hash. It then
authorizes an authenticated router
and distributes those exact bytes before the custodian attestation or Vault grant
can complete. The provider sees ciphertext and public commitments, never the
processor's encryption private key; `--processor-signing-key` is only the
processor's chain authorization key. The CLI's decrypt command validates the
private key and, as part of grant consumption, verifies the exact processor-owned
HGR1 HarborStore object and its live lifecycle before and after the chain action.
It durably creates a canonical grant-use recovery record, submits
`usegrant`, reconciles the exact `grantuses` row and one-step grant counter/status
transition, and only then opens bytes. A retry uses the same recovery record and
never consumes the grant twice, so `max_uses` is enforced by the chain before
decryption. Envelope and private-key files use private permissions and
existing paths are never overwritten. Private-key reads reject symlinks, hard
links, foreign ownership, and group/world access. The JSON private-key command
is a local development tool; production threshold deployments should issue
per-object keys inside a trustee/KMS and never export private key material to
this CLI.

`harbor vault rewrap` authorizes the accepted source receipt, live storage
object, consent, and immutable custodian before loading the custody private key.
It generates a random uint64 grant id strictly between zero and `UINT64_MAX`
(or accepts `--grant-id` for exact
recovery), embeds that id and processor in HGR1, durably writes the rewrap,
registers and distributes its exact governed HarborStore object, and then submits
`attestrewrap` as the actual source-object key custodian. It next submits
`grantaccess` as the subject or delegated controller with the same caller-chosen
id and exact source-ciphertext, wrapped-key, and full-envelope commitments.
If registration fails, the error reports the retained HGR1 path and id so the
same artifact can be recovered without predicting a table counter. Re-running
the same command reuses that canonical HGR1 and its exact live storage lifecycle,
retries distribution when needed, verifies any existing attestation or grant
field-for-field, skips completed steps, and resumes at the first missing transaction.
If the grantor abandons that second phase, any authenticated account can call
`harbor vault expire-rewrap <keeper> <grant_id>` after the recorded deadline.
The contract rejects early cleanup and erases only that pending attestation;
normal grant registration still consumes its matching attestation atomically.

Vault, HarborStore, and HarborAI action arguments declared as ABI `uint64` are
parsed and serialized as canonical decimal strings (including `uint64[]` vote
rankings), so values above JavaScript's safe-integer range are never rounded.
Boolean action arguments accept only `true`, `1`, `false`, or `0`.

`storage_content_hash` is SHA-256 of the exact persisted canonical HGD1 representation and is
the value registered as HarborStore `content_hash` and the Vault receipt's
ABI-legacy `ciphertext_hash`. `ciphertext_commitment` is a separate inner hash
of the nonce and AEAD ciphertext; it must not be substituted for the storage
content hash. The CLI prints both names explicitly.

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
`harbor run router` or `harbor run airouter`. The separate `keycustody` service
type can be installed with `harbor run keycustody`; it reserves one-time public
keys and keeps private material out of inference services. Fine-tune demand can be requested
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
with training, prompt, and response scopes and a successful PII-review hash. An
outcome-bearing RLVR trace additionally requires feedback consent (mask `23` in
total), an accepted nonzero SvcMarket oracle check, and committed oracle/verifier
evidence. It must also identify a paid, settled inference, its selected provider
account, model id, and result hash. Repeating a prompt therefore preserves each
independent provider rollout instead of deduplicating equal answers. A bare
`training_candidate` flag is never sufficient, even with
`--include-all`.
Direct user identifiers are omitted from example provenance; policy, campaign,
and consent receipt hashes remain auditable.

Because the resulting dataset contains consented prompt and completion text,
`harbor ai data register` requires a v2 manifest and the governed public-key
envelope before upload. It registers ciphertext as a temporary object, never a
permanent password-encrypted object. Store and register that dataset for a
governed offline workflow:

```sh
harbor ai data pack ~/.harbor/ai-traces \
  --rlvr \
  --contributor myaccount \
  --base-model-id 1 \
  --base-model-hash <base_model_hash> \
  --tokenizer-hash <tokenizer_hash> \
  --expert-role code \
  --output query-dataset.jsonl \
  --manifest-output query-dataset.manifest.json
harbor vault keygen ~/.harbor/vault/objects/query-dataset-19 \
  --name trainer --key-id object:query-dataset-19
harbor ai data register myaccount query-dataset.jsonl \
  --manifest query-dataset.manifest.json \
  --recipient-public-key ~/.harbor/vault/objects/query-dataset-19/trainer-public.json \
  --vault-policy-id 8 --vault-consent-id 12 \
  --key-custodians '["keytrustee1"]' \
  --backend walrus
```

The legacy `ai tune contribute-data` and `ai tune reward-data` wrappers remain
compatibility-disabled. `ai data contribute` now uses the modern Vault-backed
batch lifecycle instead of the rejected legacy `contribdata` action. Build the
sealed recipe, register it as the campaign's recipe artifact, then prepare and
seal a reviewed batch:

```sh
harbor ai rlvr recipe mlx-community/gemma-3-270m-4bit \
  --base-model-hash <base_model_hash> \
  --tokenizer-hash <tokenizer_hash> \
  --dataset-hash <dataset_hash> \
  --rollout-source network \
  --network-model-id <on_chain_model_id> \
  --minimum-rollout-providers 2 \
  --verifier verifier.json \
  --output rlvr-recipe.json
harbor ai data contribute myaccount <campaign_id> <dataset_artifact_id> \
  --sample <infer_id>:<accepted_evidence_hash> \
  --dataset-object-id <sanitized_object_id> \
  --dataset-policy-id <sanitized_policy_id> \
  --transform-id <accepted_lineage_id> \
  --recipe-artifact-id <recipe_artifact_id> \
  --dataset-hash <dataset_hash> \
  --input-lineage-hash <lineage_root> \
  --recipe-hash <recipe_hash>
```

The four supported verifier types are exact text, numeric tolerance, bounded
JSON constraints, and token-sequence similarity. Verifiers are sealed and
oracle-approved; no command or arbitrary reward code is accepted.
Network recipes require exactly one sealed optimizer round, four completions per
prompt by default, and at least two independent providers in every group. The
trainer rejects missing, duplicate, unsettled, wrong-model, or hash-mismatched
rollout receipts and never replaces them with locally generated completions.

For a challengeable inference, generate a fresh private 32-byte
`selection_reveal` and commit
`sha256(pack("aicseedv1"_n, harborai, infer_id, requester,
selection_reveal))` before the provider accepts. Keep the reveal private until
`infer challenge`; HarborAI then combines it with the provider's already-frozen
start, acceptance, and delivery commitments to derive the SvcMarket committee
seed. Never reuse either the commitment or reveal.

Continuous specialist distillation is an explicit lifecycle; no command starts
automatically after installation. A community first accepts a tune whose
dataset reference is the public data-policy artifact. The program owner then
opens and funds the campaign, users grant versioned scope bits and opt
individual requests in, and a curator seals only encrypted
datasets:

```sh
harbor ai distill open <owner> <program_id> <accepted_tune_id> <teacher_model_id> \
  7 1000 '0.2500 SYS' '25.0000 SYS' 32 512 8500 9500 9000 \
  100 9900 \
  'Coding specialist distillation' '{"worker_enabled":false}'
harbor ai distill consent <user> <campaign_id> 7 2592000
harbor ai distill opt-in <user> <infer_id> <campaign_id>
# After route assignment selects the provider, bind that provider's exact
# active HarborVault consent before it accepts the inference.
harbor ai distill bind-data-consent <user> <infer_id> <vault_consent_id>
harbor ai provider set-signal-capabilities <provider> <deployment_id> 11 20 \
  <tokenizer_hash> <runtime_hash> <schema_hash> <attestation_hash> '{}'
harbor ai distill set-protocol <owner> <campaign_id> harborvault \
  <raw_policy_id> <sanitized_policy_id> 11 20 2 2 86400 \
  '0.0500 SYS' '0.0500 SYS' '0.1000 SYS' '{}'
harbor ai distill fund-sample-rewards <owner> <campaign_id> '10.0000 SYS'
harbor ai distill commit-sample <provider> <infer_id> 11 20 \
  <envelope_hash> <signal_hash> <tail_mass_hash> <object_id> <raw_policy_id> \
  <consent_id> <receipt_id> <review_grant_id> <object_hash> <key_hash> \
  <svc_check_id> 86400 '{}'
harbor ai distill review-sample <validator> <infer_id> true true true true true \
  <validator_review_grant_id> <svc_check_id> <report_hash>
harbor ai distill resolve-sample <infer_id>
harbor ai distill open-batch <owner> <campaign_id> <curator> '{}'
harbor ai distill add-sample <curator> <batch_id> <infer_id> <evidence_hash>
harbor ai distill withdraw-sample <requester> <infer_id>
harbor ai distill set-batch-spec <curator> <batch_id> <dataset_object_id> \
  <sanitized_policy_id> <transform_id> <recipe_artifact_id> <dataset_hash> \
  <input_lineage_hash> <recipe_hash> '{}'
harbor ai distill seal-batch <curator> <batch_id> <encrypted_dataset_artifact_id>
harbor ai distill plan-canary <owner> <batch_id> <router> <max_requests>
harbor ai distill expire-batch <batch_id>
```

Here scope `7` means training plus prompt and response use, while `100 9900`
requires at least 100 independently reported canary requests with 99% success.
The requester's gross quote and campaign-funded rebate are reserved before
assignment. Assignment freezes the provider's net payout and HarborAI's
protocol-retained signal share. The requester must then bind the exact active
HarborVault consent for the selected provider before acceptance. Completion
leaves the discount and a provider sample-performance bond pending. Accepted
encrypted evidence releases the bond and credits the discount. A genuine
provider commitment failure or independently rejected sample still credits the
customer, but slashes the bond to replenish the campaign; revoked authorization
or an incomplete review is neutral and earns no discount. Admission and
promotion rewards remain evidence-gated. Governance can move retained signal
funds only through `ai treasury spend-signal`, whose purpose commitment and
quantities are recorded on-chain. Direct `reqinfer` jobs also require
the requester to run `infer assign-exact` before the named provider can complete
them, while routed jobs retain router quote/assignment. Training, independent
batch scoring, and promotion remain separate `start-batch`, `score-batch`,
`plan-canary`, `record-canary`, `report-canary`, and `promote-batch` actions.
`plan-canary` authorizes each router's bounded cohort before routing. Each
`record-canary` binds a globally unique completed inference, route log,
candidate revision, and—when marked successful—a settled passing `svcmarket`
check from currently eligible independent oracles.
`report-canary` only aggregates those canonical records; a router cannot submit
self-declared success totals. `cancel-batch` safely releases samples from an
unsealed batch. Before curation, the original requester can `withdraw-sample`;
after a sealed batch's deadline, anyone can reconcile it with `expire-batch`.
Sanitized derivative receipts can be connected to the exact grant use and
attestation with `harbor vault add-lineage`.

After a contract upgrade, keep writers and AI routing paused while the bounded
companions are constructed. Run `storage migrate-keys` and `storage
migrate-capacity`; then run `market migrate-stakes`, `market migrate-holds`,
`market migrate-checks`, `market migrate-service-current`, and `market
migrate-ai-current` to completion. Rebuild the reserve guard only after the
stake migration. Seed the final oracle and scheduler candidate sets before
running `market prune-price` for every pair, establish fresh price quorums, and
rebuild the reserve guard again after the final prices. Scan each sidechain with
`market scan-chain-quorum` before setting it active.

Next run `ai distill migrate-batches`, `ai program migrate-serving`, `ai
promotion migrate-stages`, and `ai promotion migrate-active-rounds` to
completion. Run `ai promotion migrate-funding` for each legacy round. Use `ai
distill clean-batch`, `ai train clean`, `ai promotion clean-round`, and
`ai promotion adjudicate-milestone` for bounded quarantined legacy children
that cannot be attached safely; do not silently discard their accrued rights.
Seed eligible historical training contribution witnesses with
`ai provider seed-training-contribution`. The
`seed-inference-contribution` compatibility command always rejects; providers
establish inference history by completing a paid, independently settled
inference for another account. Use the contract account as `--actor` where an
action requires it, and verify every completion singleton and companion row
before resuming encrypted registration, service replacement, routing, or
promotion execution. Any signed keeper may use
`ai infer expire` strictly after an open inference job's one-hour request
deadline; the contract refunds its escrow and releases unused data reservations.
The same keeper pattern applies to `ai train cancel` after its force-cancel
grace period and `ai promotion expire-execution` after a selected or staged
promotion misses its execution deadline. `ai provider prune-deployment`
deactivates a stale deployment and removes its contribution eligibility
without scanning historical deployments.

Tombstoning snapshots retirement work; keepers finish large replica histories
in bounded `storage retire-chunk` calls before deletion or loss attestations.
Closed AI programs let each owner `reclaim-credit`, while `program admit-tier`
is the explicit owner-governed path for a valid non-staged serving checkpoint.
Legacy current checkpoints and serving tiers are backfilled in bounded
`program migrate-serving` pages before normal program operations resume.

Paid inference uses an explicit handshake and independent settlement path. The
assigned provider `accept`s and then completes the work. After delivery, the
requester may `acknowledge` the result immediately; otherwise a signed keeper
may `settle` it optimistically with a zero check id only after the challenge
window closes. A requester instead starts `challenge` with evidence and its
committed selection-seed reveal, after which the selected verifier scheduler
creates the bound SvcMarket check. `resolve` closes that challenge against the
final independent check, or neutrally refunds it when the collateralized
scheduler misses its admission deadline.

The market's generic obligation actions bind that handshake to reserved
provider penalty stake, exact consumer-funded oracle budget, immutable check
terms, and one independently settled check. Governance enables consumers and
reserve writers; the consumer opens, funds, authorizes terms and payload, and
closes its own obligation. The bound scheduler must create the check before its
short deadline; a missed schedule closes neutrally and refunds the requester
instead of manufacturing a provider pass. Check creation, expiry, exact unused
budget claims, price pruning, reserve refresh, quorum scans, inflation
stepping, project claims, and epoch sweeping remain explicit bounded keeper
work.

The ABI-retained `market set-referral-config` and `market set-referrer`
wrappers are compatibility-disabled and fail locally. Native invites are
configured with `eosio::setinvitecfg`, and immutable invite links are created
with `eosio::inviteacct`; SvcMarket no longer stores or mutates its legacy
referral configuration or link tables.

Tokenizer identity is explicit per model. A distillation campaign whose teacher
and base use different tokenizers must bind its versioned translation artifact
with `ai distill set-token-translation`; identical-tokenizer campaigns do not
invent a translation layer. Encrypted generated checkpoints bind their exact
weights artifact to an accepted Vault receipt with `ai model bind-custody`
before adoption or serving. Program owners can start a bounded sunset with
`ai program close`; keepers then `finalize` a clean shutdown or `recover` the
last viable checkpoint after the contract's respective safety conditions hold.

Campaigns that opt into `set-protocol` use the strict path. Signal masks are
sequence `1`, top-k `2`, full distribution `4`, and additive outcome evidence
`8`; top-k and full distribution are mutually exclusive. A sample must match an
immutable deployment tokenizer/runtime capability, an encrypted raw-policy
vault receipt, and the exact independent review quorum before a curator can add
it. Trainers receive bounded sanitized-policy grants, and strict submissions
must call `harbor ai train attest-lineage` before scoring. Admission rewards pay
the consenting user and signal provider after review; the user promotion
dividend is released only if the resulting specialist passes evaluation and
canary promotion.

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

An encrypted governed checkpoint is not routable merely because a provider
publishes that topology. After the output owner grants and rewraps the exact
weights receipt and the provider records its Vault use, bind the deployment
with `harbor ai provider bind-deployment-access <provider> <deployment_id>
<vault_contract> <receipt_id> <grant_id> <use_id> <purpose_hash> <use_hash>`.
The provider must also be an object-scoped HarborStore key custodian so later
cryptographic erasure accounts for serving copies.

Expired subscriptions are erased when `provider unsubscribe` returns their
bond. Providers upgrading from an older table can remove bounded pages of
inactive zero-bond history with `provider clean-subscriptions <provider>
<start_id> <max_rows>` before renewing.

Fusion models are registered as normal Harbor AI models whose weights artifact
is a canonical `harbor.fusion.v1` manifest. Use
`harbor ai fusion manifest create` to build one from explicit experts or
`--auto-experts <count>` for router-side capability discovery, then
`harbor ai fusion register` to store the manifest through Harborstore/Walrus and
call the existing `addartifact` and `regmodel` actions. `harbor ai fusion
inspect` reads the model, manifest artifact metadata, route logs, and subcalls
to show which experts participated.

Training jobs now represent one shared round with 2–15 registered `aitrain`
participants. In existing action signatures, `max_submissions` specifies that
participant count; it no longer enables rival finished models. The lifecycle is:

```sh
harbor ai train start <creator> <tune_id> <base_model_id> <dataset_artifact_id> "5.0000 SYS" 2 '{}' 3600
harbor ai train configure-round <creator> <train_id> <aggregator> <recipe_hash> '[1,1]' 8000
harbor ai train join <participant_a> <train_id>
harbor ai train join <participant_b> <train_id>
harbor ai train contribute <participant_a> <train_id> <artifact_a> <manifest_hash> <metrics_a> '{}'
harbor ai train contribute <participant_b> <train_id> <artifact_b> <manifest_hash> <metrics_b> '{}'
harbor ai train aggregation-manifest <train_id> --out /tmp/shared-round.json
harbor ai train aggregate <aggregator> <train_id> <aggregate_artifact> <contribution_root> <metrics_hash> '{}'
```

Use the complete manifest hash from `trainrounds` after both participants join.
The governed runtime obtains shard assignments directly from `trainparts`; a
local planning file cannot authorize training. The aggregation manifest reads
and validates the exact chain contributions for `gemma_mlx_aggregate.py
--round-manifest`. Independent oracles score every contribution and the
aggregate before `harbor ai train settle <train_id>` distributes the frozen
network-token shares. Only the combined checkpoint becomes a model. A promotion
job may first need `harbor ai train fund <payer> <train_id> <quantity>` before
configuration. Private contributions and aggregation retain all Vault grants,
reviewed lineage and access/output uses.

`train submit` is removed. Historical funded jobs are refund-only through
`train cancel`; they cannot be converted to shared rounds. Existing balances
and settled history are preserved. The `fusion distributed plan` helper only
prepares an advisory layout; actual participation and weights come from chain
state. Inference collection, dataset review, enrollment and release still need
operator/controller orchestration for a continuous learning network.

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
