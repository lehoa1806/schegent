#!/usr/bin/env bash
# document-mechanism-consistency-selftest.sh — FR-R3-116 / FR-028.
#
# "The gate fails when row 1's sentence is restored, and passes on the corrected
# tree" is a claim about a gate, and a claim about a gate is worth exactly as much
# as the last time somebody drove it red.
#
# FR-R3-114 measured what happens otherwise: a gate forbidding a particular shape
# was VACUOUS from the day it was written, because it filtered through `codeOnly()`
# — which blanks string bodies — and the shape it forbade lived inside a shell
# command string. It read as coverage for as long as nobody tested it. A regex gate
# over prose has exactly that failure mode and no natural symptom: a pattern that
# matches nothing is indistinguishable from a tree with nothing to match.
#
# So this drives EACH OF THE THREE SEEDS red and back to green, against the real
# tree, by inserting a real denial sentence into a real document.
#
# The tree is restored on every exit path — success, failure, and interrupt — by a
# trap, not by reaching the end. A self-test that leaves a planted falsehood in a
# security document when it fails is worse than no self-test.

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

GATE='tests/lint/document-mechanism-consistency.test.ts'
readonly GATE

pass=0
fail=0
declare -a planted=()

restore() {
  local file
  for file in "${planted[@]:-}"; do
    [[ -n "$file" ]] || continue
    if [[ -f "$file.selftest-backup" ]]; then
      mv -f "$file.selftest-backup" "$file"
      printf '  restored %s\n' "$file"
    fi
  done
  planted=()
}
trap restore EXIT INT TERM

run_gate() {
  npx vitest run "$GATE" --reporter=dot >/tmp/dmc-selftest.$$.log 2>&1
}

expect_green() {
  local label="$1"
  if run_gate; then
    printf '  ok   %s — gate green\n' "$label"; pass=$((pass + 1))
  else
    printf '  FAIL %s — gate should be GREEN here and is red\n' "$label"; fail=$((fail + 1))
    tail -25 /tmp/dmc-selftest.$$.log
  fi
}

expect_red_naming() {
  local label="$1" seed="$2"
  if run_gate; then
    printf '  FAIL %s — gate should be RED here and is green. The %s seed matches nothing;\n' "$label" "$seed"
    printf '       it reads as coverage and provides none.\n'
    fail=$((fail + 1))
    return
  fi
  if grep -q "\[$seed\]" /tmp/dmc-selftest.$$.log; then
    printf '  ok   %s — gate red, and names the %s seed\n' "$label" "$seed"; pass=$((pass + 1))
  else
    printf '  FAIL %s — gate is red but does not name the %s seed, so the failure it\n' "$label" "$seed"
    printf '       reported is not the one this leg planted.\n'
    fail=$((fail + 1))
  fi
}

# seed id | document | sentence to plant
plant() {
  local file="$1" sentence="$2"
  cp -p "$file" "$file.selftest-backup"
  planted+=("$file")
  printf '\n%s\n' "$sentence" >> "$file"
}

printf 'document-mechanism-consistency-selftest — three seeds, each driven red then green\n'
printf 'repo: %s\n\n' "$repo_root"

printf 'baseline\n'
expect_green 'corrected tree'

# --- seed 1: audit-chain -----------------------------------------------------
# The exact sentence FR-R3-116 row 1 found at threat-model.md:70.
printf '\nseed audit-chain\n'
plant docs/security/threat-model.md \
  'Workspace-local audit evidence can be modified or deleted by an operator or backend process. Schegent neither hashes the log as a chain nor detects post-write tampering.'
expect_red_naming 'row 1 sentence restored' 'audit-chain'
restore
expect_green 'row 1 sentence removed again'

# --- seed 2: process-tree ----------------------------------------------------
printf '\nseed process-tree\n'
plant docs/operations/backends.md \
  'On cancellation only the direct child is signalled, and descendants survive termination.'
expect_red_naming 'unqualified process-tree denial planted' 'process-tree'
restore
expect_green 'process-tree denial removed'

# --- seed 3: ownership-fence -------------------------------------------------
printf '\nseed ownership-fence\n'
plant docs/reference/file-layout.md \
  'There is no workspace ownership fencing, and concurrent windows are ungated.'
expect_red_naming 'ownership denial planted' 'ownership-fence'
restore
expect_green 'ownership denial removed'

# --- the negative fixture: a LIMIT must not be read as a denial --------------
printf '\nlimit-is-not-a-denial\n'
plant docs/security/threat-model.md \
  'Tampering is evident, not impossible: the chain head sits on the same disk, so an actor who can edit the log can recompute every later digest.'
expect_green 'a correctly-stated limit does not trip the gate'
restore

# --- the historical carve-out must not become a loophole ---------------------
printf '\nhistorical-qualifier\n'
plant docs/security/threat-model.md \
  'Until FR-R3-112 the format had no signature or hash chain.'
expect_green 'an explicitly historical denial does not trip the gate'
restore

rm -f /tmp/dmc-selftest.$$.log
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]] || exit 1
printf 'document-mechanism-consistency: all three seeds drive the gate red, and neither a\n'
printf 'stated limit nor a dated historical note does. The gate is not vacuous.\n'
