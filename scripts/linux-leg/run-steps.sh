#!/bin/sh
# Review gap GC-18 (2026-11-12) — what the Linux leg runs, inside the container.
#
# stdin is a tar of the tree under test (`git archive`, so a commit, never a dirty worktree). Each
# step's exit status is printed as `linux-leg: <step> rc=<n>`, and the container exits non-zero when
# any step failed, after running every step, so one run reports every red.
set -u
mkdir -p work
# An empty or truncated archive must stop the leg, not run the steps against nothing.
tar -x -C work || exit 2
test -f work/package.json || { echo 'linux-leg: the archive carried no package.json' >&2; exit 2; }
cd work || exit 2

git config --global user.name 'Linux Leg'
git config --global user.email 'linux-leg@localhost'
git config --global init.defaultBranch main
git config --global maintenance.auto false
git config --global gc.auto 0
# `git archive` carries no history, and the census gates read `git ls-files`: commit the tree as
# extracted, before any install, so tracked means exactly what the archived commit tracked.
git init -q . && git add -A && git commit -q -m 'linux-leg: tree under test' || exit 2

failed=0
step() {
  name=$1
  shift
  "$@"
  rc=$?
  echo "linux-leg: ${name} rc=${rc}"
  if [ "$rc" -ne 0 ]; then failed=1; fi
}

step install npm ci --no-audit --no-fund
step install-webview npm --prefix webview-ui ci --no-audit --no-fund
# The host suite reads the built webview bundle and the generated SBOM; a fresh tree has neither, and
# the SBOM is generated from the host module graph that only the full build writes.
step build npm run build
step sbom npm run sbom
step typecheck npm run typecheck
step typecheck-tests npm run typecheck:tests
step lint npm run lint
step contracts npm run contracts:check
step test-host npm run test:host

echo "linux-leg: $(uname -srm) node $(node --version)"
exit "$failed"
