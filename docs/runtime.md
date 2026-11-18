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

Install creates a stopped registration. Start and restart wait for the
daemon's `/health` response. Logs and data are retained after uninstall.
`service status --json` returns an array when the service name is omitted.
Each result reports `installed`, `state`, and `healthy` and includes the port,
config, and limits for installed services. `service logs --supervisor` reads
startup failures. `doctor --strict` makes unsuccessful checks exit with status 1.

Artifacts are named `<daemon>-<target>` and verified against `SHASUMS256.txt`.
The resolver supports local packages, sibling builds, PATH, HarborStore,
GitHub, and direct URLs with an explicit SHA-256. Packagers can provide an
absolute `HARBOR_DAEMON_DIR` with executables under their original daemon names.
The target-specific cache records the source and digest in `artifact.json`.
An existing `runtime.toml` determines the port and data directory. An explicit
`--port` or `--data-dir` must match it, or use a separate `--config` file.

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
and send SIGTERM to stop the foreground process. Pass user limits with
`--cpu-percent` and `--memory-percent`. Both default to 40% per service.
Linux uses systemd quotas when available. macOS, foreground execution, and
systemd sessions without delegated controllers sample process-group CPU and RSS.
Sampling allows short bursts. A memory overage stops the group. An external
inference backend has its own process and resource settings.

## Inference

```sh
harbor ai local-model --json
ollama pull qwen3:8b-q4_K_M
harbor run aiinfer --model-profile auto
```

New `aiinfer` configs default to the local OpenAI-compatible Ollama endpoint.
Start Ollama and pull the tag printed by `harbor ai local-model` in the same
runtime environment. `auto` selects Qwen3 4B below 16 GiB, including 8 GB
machines, and Qwen3 8B on larger hosts. Choose `--model-profile large` for
Qwen3.5 27B with at least 48 GiB of visible RAM. The three tags use Q4_K_M.
[Qwen3 tags](https://registry.ollama.com/library/qwen3/tags) ·
[Qwen3.5 27B](https://registry.ollama.com/library/qwen3.5%3A27b-q4_K_M)

Train experts as QLoRA adapters against the exact `expert_adapter_base`
reported by the CLI. Load a compatible GGUF adapter and its Q4_K_M base into
`llama-server --model BASE.gguf --lora EXPERT.gguf`. Point Harbor at the
backend's `/v1/chat/completions` and pass its model alias via `--backend-model`.
Use `--backend-api-key-env` for an authenticated backend and set the named
variable in the service environment. Raw backends can use `--backend-protocol raw`.
[llama.cpp adapter documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/completion/README.md)

`POST /ai/infer` is served on port 9117 by default. `infer_id: 0` is for local
testing. Use the existing `harbor ai offer inference` workflow for marketplace
registration and configure the separate paid transaction flow.

## Validation

- [x] Runtime CLI and Electron contract, including Windows WSL2 forwarding.
- [x] Release matrix and checksum packaging for both macOS and Linux architectures.
- [x] Qwen profiles and OpenAI-compatible inference request through the native daemon.
- [x] macOS ARM64 launchd lifecycle, port cleanup, and screenshot from the test transcript.
- [ ] Hosted Linux x64/arm64, macOS x64, and Windows WSL2 build and lifecycle evidence.
- [ ] Validate inference with downloaded Qwen weights and a trained expert adapter.

The [macOS ARM64 smoke screenshot](evidence/macos-arm64.png) records the
actual local test against an OpenAI-compatible fixture. The workflow uploads
transcripts and screenshots from every runtime smoke job.
