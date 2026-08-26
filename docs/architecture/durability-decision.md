# Durability of the evidence writes

**Decided**: 2026-08-26 · **Item**: [`FR-R3-111`](../../../docs/features/round_3/DONE_111_FR-R3-111_durability_and_lifecycle_floors.md)
**Scope**: the three writes that constitute evidence. Everything else is explicitly out.

## The finding

`grep -rn "fsync|fdatasync|O_SYNC" src webview-ui/src scripts` returned **zero**. Process-crash
consistency in this product is genuinely good — journaled intents, fenced commits, a
terminal-transition journal — and **power-loss durability was unaddressed**, including for
`.schegent/audit.log`, the fail-closed evidence sink, and the gate attestation a release is bound
to. A kernel-buffered append that never reached the platter is indistinguishable from one that did,
in the one file whose job is being evidence.

`FR-R3-111` §3.1 does not ask for a full-tree barrier. It asks for the writes that are *evidence* to
be named, and each to either carry a barrier or be covered by a disclosure — with the measurement
that decided it recorded either way.

## The measurement

500 appends of a realistic audit line, to a fresh file, on the development machine (macOS, arm64,
APFS, Node 24.19.0), 2026-08-26:

| | Total | Per append |
|---|---|---|
| `write` only | 6.8 ms | **0.014 ms** |
| `write` + `fsync` | 1963.9 ms | **3.928 ms** |
| Overhead | | **289×**, +3.914 ms |

Reproduce with the script recorded in `specs/156-round-3-close/baselines.md`. Verified locally,
once, on one platform — a spinning disk or a network mount would be worse, and neither was measured.

## The three writes, and the decision for each

### 1. The gate attestation — **barrier applied**

`scripts/record-gate-run.mjs` writes `.gate-attestation.json` **once per gate run**, immediately
after a gate measured at four minutes or more. 3.9 ms against four minutes is free.

The failure it prevents is specific rather than theoretical: a machine losing power between the gate
finishing and the kernel flushing leaves a release bound to a record that is absent or truncated —
and `decideRelease` refuses a truncated record as `unreadable`, which reads as *the gate never ran*
for a gate that did. The operator's remedy is to re-run four minutes of gate.

### 2. The audit log's per-event appends — **disclosed, not barriered**

`.schegent/audit.log` is appended once per audit event, on the phase-execution path. At 3.9 ms per
append and a hundred-plus events per run, a barrier would add most of a second per run in the best
case, and it bursts: monitor summaries and phase-message events arrive together.

**The disclosure, stated plainly**: `audit.log` is durable against a process crash and **not against
power loss**. Entries written in the seconds before an abrupt power failure or kernel panic may be
absent, and the last entry may be truncated mid-line. The parser already tolerates a truncated final
line — it warns and preserves what it can read — so the loss is bounded to recent entries rather than
the file.

**The cheaper option this leaves open**, recorded rather than done: a barrier at the **rotation
boundary**. Rotation happens rarely, and syncing the file being closed would bound the loss to the
current file rather than to the whole history. That is a small change with a real benefit and it is
not taken here, because `FR-R3-111` names the per-append question and answering a different one
would be answering an easier question.

### 3. The terminal-transition journal — **a barrier is not available**

This one is not a decision. `KEYS.terminalTransitionIntent` is a **VS Code `Memento` key**, not a
file this extension opens. The extension has no descriptor to sync and no control over when the host
flushes its own storage. So:

**The disclosure**: the terminal-transition journal is as durable as VS Code's workspace storage, and
this product cannot make it more so. Its purpose — surviving a *process* crash between a Run's
terminal decision and its persistence — is unaffected, because that is exactly what the Memento does
survive. Power loss between the host's write and its flush is outside anything the extension can
reach.

Recorded as *unavailable* rather than *declined*, because those are different facts and a reader
deciding whether to trust this journal needs the right one.

## What is explicitly out of scope

Everything not named above. Transcripts, runtime logs, metrics rollups, the catalog store, session
artifacts, checkpoints. `FR-R3-111` §3.1 is explicit — *"Everything else is explicitly out"* — and the
reason is that a barrier applied everywhere is a barrier nobody measured: the cost lands on paths
whose loss costs nothing, and the practice gets reverted wholesale the first time someone profiles
activation.

## What this does not claim

- **Not tested against real power loss.** No power was cut. The reasoning is about what `fsync`
  guarantees, and the measurement is of what it costs.
- **Not a claim about the filesystem.** APFS on one machine. `fsync` semantics vary, and some
  hardware acknowledges a flush it has not completed.
- **Not a substitute for the fail-closed discipline.** A failed append is still an append failure
  handled by the evidence-health machinery. Durability is about writes that succeeded.
