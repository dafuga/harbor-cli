# Harbor runtime

`harbor run` starts a foreground daemon. `harbor service` installs an on-demand
background registration with the desktop user's launchd session on macOS or
systemd user session on Linux and Windows WSL2. Both share artifact resolution,
runtime configuration, health checks, logs, and CPU and memory settings.

## Install and run

Install Node.js 20.18+ and the CLI release tarball with `npm install -g ./harbornet-cli-0.1.0.tgz`.
Linux binaries require Ubuntu 22.04-compatible glibc and libcurl 4. macOS release
binaries use the system libcurl. The CLI selects `macos-arm64`, `macos-x64`,
`linux-arm64`, or `linux-x64`. A Windows WSL2 distribution uses the matching
Linux asset for its architecture.

```sh
harbor doctor --json
harbor run router --dry-run
harbor service install router --source github --version latest
harbor service start router --json
harbor service status router --json
harbor service logs router --follow
harbor service restart router
harbor service stop router
harbor service uninstall router
```

Install creates a stopped registration. The same interface is available as
`harbor agent service`. Use `--system` on Linux with root permissions and a
consistent `HARBOR_HOME` for system-wide units. Start and restart wait for the
daemon's `/health` response. Logs and data are retained after uninstall.
`service status --json` returns an array when the service name is omitted.
Each result reports `installed`, `state`, and `healthy` and includes the port,
config, and limits for installed services. Running services include a fresh
`usage` sample with CPU cores, RSS, and any host-policy pause reason when available.
`service logs --supervisor` reads
startup failures. `doctor --strict` makes unsuccessful checks exit with status 1.
Use `harbor agent init --account ACCOUNT` to create a private agent config and
`harbor agent doctor --json` to inspect its configured local services.

Artifacts use `<daemon>-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, or
`-linux-x64` suffixes and are verified against `SHASUMS256.txt`.
The resolver supports local packages, sibling builds, PATH, HarborStore,
GitHub, and direct URLs with an explicit SHA-256. Packagers can provide an
absolute `HARBOR_DAEMON_DIR` with executables under their original daemon names.
The target-specific cache records the source and digest in `artifact.json`.
An existing `runtime.toml` determines the port and data directory. An explicit
`--port` or `--data-dir` must match it, or use a separate `--config` file.
For a node peer use `harbor run nodeos --config config.ini --data-dir DATA`.
Supply the intended chain's genesis for a fresh peer with `--genesis-json`.
The node exposes loopback RPC on 8888 by default. Configure P2P listeners and
peers in `config.ini`. Readiness uses `/v1/chain/get_info`.
The Linux ARM64 build produces `nodeos-linux-arm64` with its SHA-256 and Harbor
source revision. Use `--source github --version TAG` once that artifact is
published, or use `--source url --binary-url URL --sha256 DIGEST` with a
verified artifact served from a trusted location.

## Windows and Electron

Use WSL2 so Windows shares the Linux daemon and systemd implementation. Install
the CLI in the distribution, enable systemd in `/etc/wsl.conf`, then restart
the distribution. Set `HARBOR_WSL_DISTRO` to choose the distribution and
`HARBOR_WSL_CLI` to select an absolute Linux launcher when `harbor` is outside
the distribution's default PATH. A Windows Node CLI can then issue `run` and
`service` commands using Linux paths. For Windows app shutdown, call
`harbor service stop <service> --json` so systemd stops the guest workload.
WSL can suspend idle distributions, including ones with systemd services.
[Microsoft WSL systemd documentation](https://learn.microsoft.com/en-us/windows/wsl/systemd)

Electron can use the service JSON interface above or own a foreground
`harbor run aiinfer` process on macOS and Linux. Probe `/health` for readiness
and send SIGTERM to stop the foreground process. Persist limits for new
workloads with `harbor agent limits set --cpu 50 --gpu 50 --mem 50`, or pass
`--cpu-percent`, `--gpu-percent`, and `--memory-percent` for one run.
Linux uses systemd quotas when available. macOS also applies background
task policy and priority. The process-group monitor samples CPU and RSS,
pauses for detected battery or heat conditions, and backs off when the user
is active. New workloads require 1 GiB memory and 2 GiB disk free. Hardware
signals exposed by WSL2 depend on the guest and Windows device.

## Inference

```sh
harbor ai local-model --json
ollama pull qwen3:8b-q4_K_M
harbor run aiinfer --model-profile auto
```

New `aiinfer` configs default to the local OpenAI-compatible Ollama endpoint.
Start Ollama and pull Qwen3 8B Q4_K_M in the same runtime environment.
`harbor ai local-model --json` checks the 16 GiB host minimum and whether the
estimated 5.7 GiB working set fits the configured budget. To manage Ollama in the same resource
budget as Harbor, pass `--ollama /path/to/ollama` and use a free local backend
port. Harbor sets parallel slots from the memory budget and uses an 8-bit KV
cache for managed backends. GPU caps are applied through available backend
memory or layer settings. Externally launched backends have their own limits.
[Qwen3 weights and tags](https://registry.ollama.com/library/qwen3/tags)

With managed llama.cpp, local chat clients can send a stable, randomly
generated `X-Harbor-Chat-Id` to the loopback backend endpoint. Harbor saves
idle slots to the private `~/.harbor/kv-cache` directory and restores a chat
when the same ID returns. The cache is bounded to 2 GiB per backend identity
and seven days of inactivity. Common prefixes use llama.cpp's bounded RAM
cache. A memory-pressure pause gives in-flight requests a short window to
finish, saves available idle slots, and unloads the engine. After memory
recovers, Harbor reloads the engine and restores slots as the corresponding
chats return. Only requests with a local chat ID use disk persistence.
[llama.cpp slot API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

Train experts as QLoRA adapters against the exact Qwen3 8B checkpoint.
`harbor ai local-model --json` reports the base and the official MLX and AWQ
checkpoints. For GGUF serving, pass `--llama-server /path/to/llama-server`,
`--base-gguf BASE.gguf`, and `--expert-gguf EXPERT.gguf`. Keep the base
revision and adapter provenance together. Use `--backend-api-key-env` for an
authenticated backend, or `--backend-protocol raw` for existing raw backends.
[llama.cpp adapter documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/completion/README.md)

`POST /ai/infer` is served on port 9117 by default. `infer_id: 0` is for local
testing. Use the existing `harbor ai offer inference` workflow for marketplace
registration and configure the separate paid transaction flow.
Training can use the existing `harbor ai offer training`, `harbor ai distill`,
and `harbor ai rlvr work-item` commands. Run the configured worker with
`harbor run aitrain --idle-only --config training.toml` to keep the workload
under these limits and require confirmed user inactivity.

## Local or VM verification

On a clean macOS or Linux host, install Node.js, the native daemon dependencies,
and ImageMagick. On Windows do the runtime work inside a WSL2 Linux
distribution with systemd enabled. Run `npm ci`, then set
`HARBOR_DAEMON_DIR` to the native build directory and `HARBOR_SMOKE_EVIDENCE` to
an output directory before invoking `bash scripts/verify-runtime.sh`. Set
`HARBOR_VERIFY_NODEOS=1` to exercise an installed native nodeos in an isolated
local chain. To qualify the download path, set `HARBOR_NODEOS_ARTIFACT` to the
absolute path of the build's versioned asset alongside its `.sha256` file.
The smoke serves the asset on loopback and installs it with the provided digest.
On Linux, also run `node scripts/node-smoke.mjs --system` as root with the
same artifact path to verify the system service manager.

`scripts/build-nodeos.sh` builds and checksums native nodeos from a pinned
Harbor checkout with initialized submodules and the build dependencies installed.
The Linux ARM64 workflow uses Ubuntu 22.04, static liboqs 0.15.0, and Ninja.
Use `bash scripts/build-nodeos.sh /path/to/harbor node-build node-dist -G Ninja`
to run the same build on a native ARM64 host or Linux ARM64 VM.

The public CI matrix runs `npm ci`, compile, type checking, and the full CLI
suite on macOS and Linux on both architectures. Trusted branch or manual runs
can enable native artifacts by setting `HARBOR_NATIVE_ARTIFACTS=enabled`.
Native builds use the repository's read-only `HARBOR_OPPORTUNITIES_TOKEN` and
`HARBOR_NODE_SOURCE_TOKEN` secrets to fetch their respective pinned private
sources. The build and smoke can run locally with the same checked-out sources.
Windows WSL2 qualification is an optional manual job.

`scripts/qwen-batched-bench.mjs` plans or runs Qwen3 8B Q4_K_M at batches
1, 4, 8, 16, and 32, with 2K, 4K, and 8K contexts and q8 or f16 KV caches.
`scripts/qwen-harbor-eval.mjs` compares tool-call outcomes using two isolated
loopback evaluation endpoints.
For SSD resume measurements, run `scripts/qwen-kv-resume-bench.mjs` against an
isolated Qwen3 8B Q4 llama-server with q8 KV, a temporary slot directory, and
`--cache-ram 0`. The report records cold prefill, SSD restore plus warm
prefill, bytes per saved chat, and how many such prefixes fit on disk. Active
decode slots still depend on the 8 GiB RAM budget on a 16 GiB machine.

The workflow uploads runtime smoke transcripts and transcript images. The
inference smoke uses a loopback backend fixture. `node-smoke.mjs` checks node
RPC readiness, restart, port closure, service removal, and the configured
cgroup limits on Linux.


### Harbor local runtime on Apple Silicon

To run the pinned Qwen3 8B MLX checkpoint, point `harbor run aiinfer` to the Python environment and `tools/local_inference/serve.py` in the Harbor checkout.

```sh
harbor run aiinfer --harbor-runtime /path/to/harbor/tools/local_inference/serve.py \
  --harbor-python /path/to/venv/bin/python --harbor-weights /path/to/qwen/snapshot \
  --model-profile qwen3-8b-mlx --harbor-prefix /path/to/rendered-prefix.txt
```

Choose `inkling-8` or `inkling-12` for an official-source Inkling GGUF and pass the Harbor-patched executable with `--llama-server`. Omit `--harbor-prefix` for requests without a shared system and tools prompt. The launcher determines concurrency from the selected model and the smaller of the configured memory and GPU budgets. `--dry-run --json` shows the resulting `managed_backend.parallel`.
