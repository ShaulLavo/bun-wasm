#!/usr/bin/env bash
# sccache 0.19.0 hashes direct externs, but staticlibs also bundle transitive code.
set -euo pipefail
crate_type_next=0
for argument in "$@"; do
  crate_types=''
  if [[ $crate_type_next == 1 ]]; then
    crate_types=$argument
    crate_type_next=0
  fi
  case "$argument" in
    --crate-type) crate_type_next=1 ;;
    --crate-type=*) crate_types=${argument#--crate-type=} ;;
  esac
  case ",$crate_types," in
    *,staticlib,*) exec "$@" ;;
  esac
done
exec sccache "$@"
