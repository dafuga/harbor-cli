#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 3 ]]; then
  echo "usage: bash $0 <Harbor-checkout> <build-dir> <artifact-dir>" >&2
  exit 2
fi
source_dir="$(cd "$1" && pwd)"
build_dir="$2"
output="$3"
case "$(uname -s):$(uname -m)" in
  Linux:aarch64|Linux:arm64) target=linux-arm64 ;;
  Linux:x86_64) target=linux-x64 ;;
  Darwin:arm64) target=darwin-arm64 ;;
  Darwin:x86_64) target=darwin-x64 ;;
  *) echo 'use a supported macOS or Linux native host (WSL2 for Windows)' >&2; exit 1 ;;
esac

cmake -S "$source_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir" --parallel "${HARBOR_BUILD_JOBS:-2}" --target nodeos
binary="$build_dir/programs/nodeos/nodeos"
"$binary" --version
mkdir -p "$output"
asset="nodeos-$target"
install -m 755 "$binary" "$output/$asset"
git -C "$source_dir" rev-parse HEAD > "$output/$asset.git-revision"
cd "$output"
if [[ "$target" == darwin-* ]]; then
  shasum -a 256 "$asset" > "$asset.sha256"
else
  sha256sum "$asset" > "$asset.sha256"
fi
