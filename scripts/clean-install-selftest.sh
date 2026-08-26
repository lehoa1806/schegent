#!/usr/bin/env bash
# clean-install-selftest.sh — FR-R3-090 / SC-011.
#
# "A clean checkout followed by the documented install produces a working tree
# with no lifecycle script run except those CONTRIBUTING.md names."
#
# That is a claim about a real install, so it is proven by performing one rather
# than by asserting about text. It clones the working tree into a temporary
# directory, runs the two documented commands, and checks what happened.
#
# WHERE THIS RUNS, and two homes were rejected:
#
#   * NOT in `test:host`. That suite is deliberately hermetic (FR-R3-033, and
#     `vitest.config.ts` says so at length); a network `npm ci` inside it would
#     make a hermetic suite depend on the registry and on a 30-second per-test
#     timeout.
#   * NOT in the pre-push hook. That hook belongs to the WORKSPACE repository —
#     `core.hooksPath` is set there and `repo/` has none — so a repo-scoped check
#     would hang off the wrong repository. And a full install on every push is
#     the same weight objection relocated.
#
# It runs as its own job in `.github/workflows/full-gate.yml`, on that workflow's
# weekly/dispatch cadence, beside the other jobs that are slow on purpose: perf,
# integration and evidence-soak.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0
fail=0
note() { printf '  %s\n' "$*"; }
ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$*"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s\n' "$*" >&2; }

work="$(mktemp -d "${TMPDIR:-/tmp}/clean-install-selftest.XXXXXX")"
trap 'rm -rf "${work}"' EXIT
clone="${work}/checkout"

echo "clean-install-selftest:"

# A clean checkout: tracked files only, so node_modules and build output cannot
# leak in and make the install look like it did less than it did.
git -C "${repo_root}" archive --format=tar HEAD | (mkdir -p "${clone}" && tar -x -C "${clone}")
if [[ -f "${clone}/package.json" && -f "${clone}/.npmrc" ]]; then
  ok "clean checkout contains package.json and .npmrc"
else
  bad "clean checkout is missing package.json or .npmrc"
  exit 1
fi

# A canary: if any lifecycle script runs, it leaves this behind. The root
# postinstall is the only one either tree declares, and with ignore-scripts=true
# it must NOT run.
canary="${clone}/.lifecycle-canary"
node -e '
const fs = require("fs");
const p = process.argv[1] + "/package.json";
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.scripts = m.scripts || {};
m.scripts.postinstall = "node -e \"require(\x27fs\x27).appendFileSync(\x27.lifecycle-canary\x27, \x27postinstall\\n\x27)\"";
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "${clone}"

note "running the documented install: npm ci  &&  npm --prefix webview-ui ci"
if (cd "${clone}" && npm ci >/dev/null 2>&1); then
  ok "npm ci succeeded in a clean checkout"
else
  bad "npm ci failed in a clean checkout — the documented install does not work"
fi

if [[ -f "${canary}" ]]; then
  bad "a lifecycle script ran despite .npmrc ignore-scripts=true (canary fired)"
else
  ok "no lifecycle script ran — .npmrc is in effect for a plain npm ci"
fi

if [[ -d "${clone}/node_modules" ]]; then
  ok "root node_modules is populated"
else
  bad "root node_modules is absent after npm ci"
fi

# The webview tree is NOT populated by the root install once scripts are off.
# That is the documented consequence, and the second command is its declared
# replacement — so both halves are asserted.
if [[ -d "${clone}/webview-ui/node_modules" ]]; then
  bad "webview-ui/node_modules exists after the root install alone — the postinstall ran"
else
  ok "webview-ui/node_modules is absent after the root install, as CONTRIBUTING.md states"
fi

if (cd "${clone}" && npm --prefix webview-ui ci >/dev/null 2>&1); then
  ok "the declared webview install step succeeded"
else
  bad "npm --prefix webview-ui ci failed — the declared step does not work"
fi

if [[ -d "${clone}/webview-ui/node_modules" ]]; then
  ok "webview-ui/node_modules is populated by the declared step"
else
  bad "webview-ui/node_modules is still absent after the declared step"
fi

if [[ -f "${canary}" ]]; then
  bad "a lifecycle script ran during the webview install (canary fired)"
else
  ok "no lifecycle script ran during the webview install either"
fi

echo "clean-install-selftest: ${pass} passed, ${fail} failed"
(( fail == 0 )) || exit 1
exit 0
