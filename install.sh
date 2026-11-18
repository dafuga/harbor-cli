#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'Usage: install.sh [--tarball <npm-package.tgz or URL>] [--prefix <directory>]'
}

package='@dafuga/harbor-cli'
prefix=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tarball|--prefix)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        usage >&2
        exit 2
      fi
      case "$1" in
        --tarball) package=$2 ;;
        --prefix) prefix=$2 ;;
      esac
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1 ||
   ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 18) ? 0 : 1)'; then
  printf '%s\n' 'Harbor CLI requires Node.js 20.18 or later.' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' 'Harbor CLI requires npm.' >&2
  exit 1
fi

if [ -n "$prefix" ]; then
  set -- --prefix "$prefix"
fi
exec npm install --global "$@" -- "$package"
