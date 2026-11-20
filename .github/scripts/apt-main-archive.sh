#!/usr/bin/env bash
# Point apt at Ubuntu's main archive over HTTPS before any install. Hosted runners ship a
# regional mirror that varies by image (azure.archive.ubuntu.com, us-east-2.ec2.archive...)
# and can stall installs past job limits.
# Usage: sudo bash .github/scripts/apt-main-archive.sh [ROOT]   (ROOT is for tests)
set -euo pipefail
apt="${1:-}/etc/apt"
files=("$apt/apt-mirrors.txt" "$apt/sources.list")
if [[ -d "$apt/sources.list.d" ]]; then files+=("$apt"/sources.list.d/*); fi
for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue
  sed -i -E \
    -e 's#https?://[a-z0-9.-]+\.archive\.ubuntu\.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' \
    -e 's#http://(archive|security)\.ubuntu\.com/ubuntu#https://\1.ubuntu.com/ubuntu#g' \
    "$file"
done
{ grep -hoE 'https?://[a-z0-9.-]*ubuntu\.com/ubuntu' "${files[@]}" 2>/dev/null || true; } | sort -u | sed 's/^/apt archive host: /'
