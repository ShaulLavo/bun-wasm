#!/usr/bin/env bash
export PATH=$HOME/.local/share/mise/shims:$PATH
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
pin=41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f
source_dir=${BUNWASM_BORINGSSL_SOURCE:-$root/vendor/boringssl}
[[ -f "$source_dir/include/openssl/evp.h" ]] && exit 0
mkdir -p "$(dirname "$source_dir")"
scratch=$(mktemp -d "$(dirname "$source_dir")/boringssl-fetch-XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM
curl -fsSL "https://github.com/oven-sh/boringssl/archive/$pin.tar.gz" -o "$scratch/source.tar.gz"
mkdir "$scratch/source"
tar xzf "$scratch/source.tar.gz" --strip-components=1 -C "$scratch/source"
mv "$scratch/source" "$source_dir"
