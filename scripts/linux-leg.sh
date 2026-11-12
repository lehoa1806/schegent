#!/bin/sh
# Review gap GC-18 (2026-11-12) — a second platform for the unit tier, run locally.
#
# Hosted CI was retired by operator decision (FR-R3-099), so every gate ran on one macOS machine.
# This builds `scripts/linux-leg/Dockerfile` and runs typecheck, lint, `contracts:check` and
# `test:host` on Linux against a commit (default HEAD), piped in with `git archive` so uncommitted
# work cannot make the leg green.
#
# Usage: scripts/linux-leg.sh [<commit>]       (npm run verify:linux)
#
# Evidence for the unit tier only: no extension host, browser or real CLI runs here, so a green
# leg is not Linux qualification (docs/operations/platform-observation-record.md).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REV=${1:-HEAD}
IMAGE=schegent-linux-leg:node-24.19.0
PINNED_NODE=24.19.0

if [ "$(cat "$ROOT/.nvmrc")" != "$PINNED_NODE" ]; then
  echo "linux-leg: .nvmrc is $(cat "$ROOT/.nvmrc") but the image pins $PINNED_NODE; update scripts/linux-leg/Dockerfile and this script together." >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "linux-leg: no Docker daemon answered; start Docker (or OrbStack) and run again." >&2
  exit 2
fi

COMMIT=$(git -C "$ROOT" rev-parse --verify "${REV}^{commit}")
echo "linux-leg: building $IMAGE"
docker build --quiet --tag "$IMAGE" "$ROOT/scripts/linux-leg" >/dev/null
echo "linux-leg: running against $COMMIT"
git -C "$ROOT" archive --format=tar "$COMMIT" | docker run --rm -i "$IMAGE"
