#!/bin/sh
# FR-R3-136 (T1527b) — the no-spawn sentinel.
#
# The harness installs this script at USER scope for `schegent.cli.path`,
# `schegent.codex.path` and `schegent.agy.path`. User scope, not workspace: all
# three are `application`-scoped properties, so a workspace value would never
# apply and a sentinel installed there would prove nothing (C5). What the
# extension would actually spawn is the user-scope value, and that is this file.
#
# It records the fact of the spawn and refuses to be useful. `spawned.marker` is
# written NEXT TO THE SCRIPT rather than to a path from the environment, because
# the extension controls a child's environment through
# `schegent.cli.environmentMode` and its allowlist — a marker path passed as an
# env var could be stripped by the very code under test, and the leg would then
# read a missing marker as "nothing spawned".
#
# Exit 97, not 0: the capability probe runs `<path> --help` and treats a non-zero
# exit as "backend unavailable", so one line lands per backend kind and nothing
# cascades into a real run.
set -eu
printf '%s\n' "spawned $*" >>"$(dirname "$0")/spawned.marker"
exit 97
