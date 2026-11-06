# Durability of the evidence writes

**Decided**: 2026-08-26 · **Item**: [`FR-R3-111`](../../../docs/features/round_3/DONE_111_FR-R3-111_durability_and_lifecycle_floors.md)
**Extended**: 2026-10-31 · **Item**: `FR-R4-F07` (the catalog store, section 4)
**Scope**: the three writes that constitute evidence, and the catalog store as a fourth decision.
Everything else is explicitly out.

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

## The writes, and the decision for each

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

### 4. The catalog store — **barrier applied on local POSIX filesystems**

Added by `FR-R4-F07`. The catalog (`.schegent/catalog/`) holds the operator's authored Phases,
Pipelines and Workflows, and drafts have no other copy. This one was not an evidence write, so it was
out of the first decision; it is in now because the loss it prevents is the operator's whole catalog.

**The loss.** A save writes a version record and then replaces `manifest.json` by writing a sibling temp
file and renaming it over (`src/catalog/atomic-write.ts`). A `rename` that reaches disk before the temp
file's contents can leave an empty or truncated `manifest.json` after a power cut. The store reads that as
malformed, and every definition in the catalog becomes unreadable.

**The process-crash order, unchanged.** Record first, then manifest. A crash between them leaves a record
no manifest entry names: it is reported as collectable, the definition still resolves at its previous
version, and nothing is lost. The reverse order would leave a manifest entry naming a record that is not
there. That order is not what this section changes.

**What that record costs.** It is debris, not corruption, and nothing in the store removes it: the only
deletion path is retention, which removes versions the manifest has just stopped naming, and an
unreferenced record is not one of them. The next save that creates a new version of that definition
computes the same version number from the manifest, finds the path taken, and refuses with
`version-exists` rather than overwrite content the store cannot account for or skip to a later number
(`tests/integration/catalog-store-concurrency.test.ts`). The Builder shows that refusal only as the generic
"The catalog store refused the write."; the reason travels in the host's result and is not displayed. No
supported way to clear such a record exists yet, and choosing one is a catalog decision, not a durability
one.

**The barrier.** In `src/host-services/catalog-fs-adapter.ts`, for each save:

1. exclusive create of the record (`wx`), write, **`sync`**, close;
2. **directory sync** of the record's directory;
3. write of the temp manifest, **`sync`**, close, `rename` over `manifest.json`;
4. **directory sync** of the store root.

The file `sync` comes before every `close` that precedes a rename or ends an exclusive create. The
directory sync is a read-only open of an existing directory, so it creates no path. A directory-sync
failure (`EINVAL`, `ENOTSUP`, `EISDIR`, `EPERM`) does not change the outcome, because the rename has
landed: the write is reported as written, and one warning carrying only the errno is logged per adapter.
`tests/integration/catalog-writer-faults.test.ts` fails each step in turn on a real directory and holds
the reported outcome, the files on disk and the next read's classification, and the order.

**The measured cost.** 200 saves per arm, alternating blocks of 20, a 4 KiB manifest and a 600-byte
record, in a directory created under the OS temp directory (macOS, arm64, APFS, Node 24.19.0,
2026-10-31, two takes):

| | Median per save | p95 |
|---|---|---|
| No barrier | 0.77 to 0.78 ms | 1.4 ms |
| Barrier (two file syncs, two directory syncs) | 15.3 to 15.9 ms | 23.7 to 23.8 ms |
| Difference | **+14.5 to +15.1 ms** | |

About 3.7 ms per barrier, which agrees with the single-`fsync` figure above. A catalog write is an
operator action, so the cost lands on a click and not on a hot path.

**The single-writer precondition.** The barrier makes one writer's files durable. It does not make two
writers safe. The manifest is replaced by `rename`, which has no compare, so the last rename wins. This
product writes the catalog from one place:

- **One store per directory per host.** `createHostCatalogStore` claims the store root, and a second
  claim while the first is held returns no store and logs one warning without a path. Within that store,
  writes run in turn (`src/catalog/write-chain.ts`).
- **The primary window is the writer.** All seven catalog-writing commands are gated on window primacy.
  A second window on the same workspace does not write.
- **If a second process writes anyway** (another editor, a script, a primacy handover), a definition's
  pointer update can be lost. Its version record survives as collectable debris, and no history record is
  lost. Measured: two independent stores racing a draft of a different definition each, 50 rounds, lost
  50 of 100 pointer updates, every one leaving its record collectable and none removed
  (`specs/254-process-authoring-exchange/measurements.md`).
- **The residual.** Primacy is checked when a command is dispatched, not at the rename. A primacy
  handover during a save that is already in flight is not fenced.

A compare-and-swap was considered and not built: the only atomic primitives in use are the exclusive
create and the rename, and a CAS needs a generation-numbered manifest (a storage-layout migration) or a
claim file (a lock in all but name, which a crash between claim and rename would wedge).

**Platform limits, stated.**

- **Windows:** no directory sync, because Node cannot open a directory there. The file `sync` still runs.
  The directory entry is not barriered.
- **Network and remote mounts:** no claim. `fsync` and directory sync are not observed to be honoured over
  NFS, SMB or a remote workspace, and nothing here tests them.
- **APFS only observed.** The measurement and the fault tests ran on one machine. Other local
  filesystems are expected to behave, and have not been observed.

**Power loss: not observed.** Pending qualification: a controlled power cut on a supported filesystem.
This section states what the writes do and what they cost. It does not claim the catalog survives a power
cut, because none was cut.

### 5. The ownership registry (`.schegent/ownership/`) — **no barrier applied (decided)**

Added by `FR-R5-F09` (`F-39`, `NF-10`, `NU-05`). The ownership registry (`src/state/ownership-registry.ts` and
`src/state/ownership-fs.ts`) stores generation-numbered claim records for workspace primacy (`primacy`) and
per-queue execution leases (`queue-<id>`) under `.schegent/ownership/<resource>/<generation>.json`.

**Why no `fsync` barrier is applied.** Unlike the audit log or catalog store, an ownership claim is an
ephemeral lease refreshed every `HEARTBEAT_INTERVAL_MS` (`5,000` ms) and valid only while `heartbeatAt` is
within `STALE_THRESHOLD_MS` (`15,000` ms). Adding a file + directory `fsync` barrier (~7.4 ms to ~15 ms) to
every primacy and per-queue lease heartbeat across up to 20 concurrent queues would place continuous
synchronous disk-flush load on the extension host for state that is intentionally invalidated after 15
seconds of silence.

**Process-crash vs. power-loss guarantees and recovery:**

1. **Exclusive generation claim (`createExclusive` / `open(target, 'wx')`):**
   - `acquire()` contends for `highestGeneration + 1` using `O_CREAT | O_EXCL` (`'wx'`), writes the JSON
     record, and closes the file descriptor.
   - **Process crash or power loss mid-create:** If a process crashes or power is lost after the directory
     entry for `<generation>.json` is created but before the JSON payload is flushed, the file on disk is
     empty (`0` bytes) or truncated. `parseRecord()` in `src/state/ownership-registry.ts` treats any empty,
     truncated, or non-JSON generation file as `null` (`parseRecord` returns `null` when `JSON.parse` fails
     or required fields are missing). `readLatest()` scans generations from highest to lowest, skips any
     unreadable generation while still recording `highestGeneration` from the filename, and returns the most
     recent valid generation record. The next `acquire()` contends for `highestGeneration + 1`, so an
     aborted generation number is never reused and never wedges election.
2. **Heartbeat refresh (`writeAtomic` — temp file + `rename`):**
   - `refresh()` writes `<dir>/.<generation>.json.<pid>.<counter>.tmp` (`mode: 0o600`) and atomically
     renames it over `<dir>/<generation>.json`.
   - **Process crash mid-refresh:** Leaves an unrenamed `.<generation>.json.<pid>.<counter>.tmp` sibling
     while the previous `<generation>.json` remains intact. `generationOf()` in `ownership-registry.ts`
     matches `/^(\d+)\.json$/`, so hidden `.tmp` files are ignored by all readers and verifiers.
   - **Power loss after `rename` before data blocks flush:** If the filesystem reorders metadata ahead of
     data blocks on power cut, `<generation>.json` may come back empty or truncated after reboot. On the
     next launch after reboot, no process from before the power cut is alive; `readLatest()` skips the
     truncated generation and the new window acquires `highestGeneration + 1` immediately.
3. **Temp-file and old-generation cleanup (`pruneBelow`):**
   - On every successful `acquire()` and `release()`, `pruneBelow(dir, generation)` removes all older
     `<g>.json` files with `g < generation` **and** sweeps any leftover `.<g>.json.<pid>.<n>.tmp` temp
     files whose target generation `g < generation` (`TEMP_GENERATION_FILE` in `ownership-registry.ts`).
     Any `.tmp` file from a failed `writeAtomic` itself is also unlinked in `writeAtomic`'s `catch` block.

## What is explicitly out of scope

Everything not named above. Transcripts, runtime logs, metrics rollups, session artifacts,
checkpoints. `FR-R3-111` §3.1 is explicit — *"Everything else is explicitly out"* — and the
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
