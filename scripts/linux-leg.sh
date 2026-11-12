#!/bin/sh
# Review gap GC-18 (2026-11-12) — a second platform for the unit tier, run locally.
#
# Hosted CI was retired by operator decision (FR-R3-099), so every gate ran on one macOS machine.
# This builds `scripts/linux-leg/Dockerfile` and runs typecheck, lint, `contracts:check` and
# `test:host` on Linux against a commit (default HEAD), piped in with `git archive`. It refuses to
# run while its own files differ from HEAD, so neither the tree under test nor the harness that
# judges it can carry uncommitted work.
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
HARNESS_PATHS='scripts/linux-leg.sh scripts/linux-leg'

COMMIT=$(git -C "$ROOT" rev-parse --verify "${REV}^{commit}")

# The pin is checked against the commit under test, not the working tree.
COMMIT_NODE=$(git -C "$ROOT" show "${COMMIT}:.nvmrc" | tr -d '[:space:]')
if [ "$COMMIT_NODE" != "$PINNED_NODE" ]; then
  echo "linux-leg: $COMMIT pins Node $COMMIT_NODE in .nvmrc but the image pins $PINNED_NODE; update scripts/linux-leg/Dockerfile and this script together." >&2
  exit 2
fi

# The image is built from the working tree's harness, so that harness must be HEAD's.
# shellcheck disable=SC2086 # HARNESS_PATHS is a fixed list of pathspecs.
if ! git -C "$ROOT" diff --quiet HEAD -- $HARNESS_PATHS \
  || [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all -- $HARNESS_PATHS)" ]; then
  echo "linux-leg: the harness ($HARNESS_PATHS) has uncommitted changes; commit them and run again." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "linux-leg: no Docker daemon answered; start Docker (or OrbStack) and run again." >&2
  exit 2
fi

# The archive is written to a file first: piped straight into `docker run`, a failed `git archive`
# would hand the container an empty or truncated tree and only the container's exit would show.
TAR=$(mktemp "${TMPDIR:-/tmp}/linux-leg.XXXXXX")
trap 'rm -f "$TAR"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$ROOT" archive --format=tar --output="$TAR" "$COMMIT"

echo "linux-leg: building $IMAGE"
docker build --quiet --tag "$IMAGE" "$ROOT/scripts/linux-leg" >/dev/null
echo "linux-leg: running against $COMMIT"
# --init: PID 1 forwards signals and reaps the orphans the process-tree tests leave behind.
docker run --rm -i --init "$IMAGE" < "$TAR"
