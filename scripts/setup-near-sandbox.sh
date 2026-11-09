#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
archive=.tools/near-sandbox-2.13.4.tar.gz
binary=.tools/near-sandbox-2.13.4/near-sandbox
url=https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.13.4/near-sandbox.tar.gz
archive_sha=5690a4635172263cf026683f75965cac09dd916912584f12709974fed620163f
binary_sha=4e89fbc0f2958634e84af44634f90e87c246288fa11b067d2121ce1394cba2c2

mkdir -p .tools/near-sandbox-2.13.4
if [ ! -f "$archive" ]; then
  curl -fLSs "$url" -o "$archive"
fi
printf '%s  %s\n' "$archive_sha" "$archive" | sha256sum --check --status
if [ ! -f "$binary" ]; then
  tar -xf "$archive" -C .tools/near-sandbox-2.13.4 --strip-components=1
fi
printf '%s  %s\n' "$binary_sha" "$binary" | sha256sum --check --status
chmod +x "$binary"
"$binary" --version
