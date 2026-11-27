# Transport-sink descriptor measurement — build/teardown, repoint and rotation cycles

**Item**: `FR-R3-137` (T1532a, T1532b) · **Taken**: 2026-08-28 · **Status**: measured; the bound is
asserted in the test, so this record is the observation and not the gate

<!-- Source: tests/perf/transport-descriptor-cycles.test.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/activation/stage2-teardown.ts -->

**The headline: the sink holds at most one append descriptor, and holds none once disposed — 200
build/teardown cycles, 200 repoint/rotation cycles and 2,000 sustained records, with a process-wide
delta of zero.** §2 is the method, §3 the figures, §5 what this does not establish.

## 1. What this measures, and why it needed measuring at all

`CliTransportSink` opens one append descriptor per destination and holds it, deliberately: the
alternative is a containment walk and a write-by-pathname on every CLI output line, which is the
defect `FR-R3-080` closed. Holding a descriptor is only safe if something closes it, and until
`FR-R3-137` nothing did. The sink had no disposal method at all, so the only thing that ever closed
one of these was the garbage collector — which announced itself on stderr:

```
Closing file descriptor 24 on garbage collection
[DEP0137] DeprecationWarning: Closing a FileHandle object on garbage collection is deprecated.
```

Fifteen of those lines were in the sink's own test output, in a green run, for as long as anyone had
been reading it. A handle whose finalizer is the collector has no lifetime: its close is unordered
against the shutdown it is supposed to be part of, so the flush it should have preceded may not have
happened.

`FR-R3-137` gave the sink `flushAndDispose()` and gave Stage 2's teardown a step that calls it. That
is a mechanism, and this is the measurement of it — the question a mechanism cannot answer about
itself is whether the count actually returns to where it started, every time, over a repetition long
enough that a per-cycle leak would be visible.

## 2. Method

One file, run under the performance config:

```
npm run test:perf -- tests/perf/transport-descriptor-cycles.test.ts
```

The exercises, all against a real temp workspace with **no injected `appendFile` port** — that last
part matters more than it looks. `write()` short-circuits past `appendHandleFor` when a port is
present, so a sink built with an injected append never opens a descriptor at all. Three of the four
suites that construct sinks emitted no descriptor warning for exactly that reason, and a stress test
with a port would have measured nothing.

1. **Build/teardown**, 200 cycles. A fresh sink per cycle; read the count before the first record
   (baseline), after one record has landed (during), and after `flushAndDispose()` (after).
2. **Repoint and rotation**, 200 cycles on one sink. Each cycle repoints `settings.path` to one of 8
   destinations and records; then drops `maxBytes` below the size of a single record so rotation
   fires, and records again; then restores the bound and records once more.
3. **Sustained**, 2,000 records over 16 run ids and one destination, sampling the count every 100.
4. **Process-wide corroboration**, `/dev/fd`, across the 200 build/teardown cycles.

The count read in 1–3 is `sink.openDescriptorCount`, which is derived from the handle map rather than
tracked beside it — a counter maintained alongside a map is a second truth that can disagree with it.

**Environment**: darwin 25.6.0, arm64, 10 cores, Node v24.19.0, commit `ac7efdeb`.

## 3. Figures

Emitted by the test itself, so a reader re-running the command above can compare directly:

| Exercise | Cycles / records | Before | During | After |
| --- | --- | --- | --- | --- |
| Build/teardown | 200 cycles | 0 | 1 | **0** |
| Repoint | 200 cycles, 8 destinations | — | 1 | — |
| Rotation | 200 cycles | — | **0** | 1 on the next record |
| Sustained | 2,000 records, 16 run ids | 0 | 1 (peak) | **0** |
| Process `/dev/fd` | 200 cycles | 21 | — | 21 (**delta 0**) |

Every reading is exact, not a bound: the assertions are `=== 1` and `=== 0` rather than `<= 1`,
because `<= 1` also passes on a sink that has stopped writing altogether, which is the failure a
descriptor test sits closest to.

## 4. Two figures that are not what a reader expects

**Rotation leaves zero descriptors, not one.** The rotation branch closes the held handle *before* the
rename — held across it, the descriptor follows the inode into the rotated generation and appends
there forever — and then writes the rotated record by pathname. So the count immediately after a
rotating record is 0 by construction, and the reopen happens on the next ordinary record. The test
asserts that sequence (`1 → 0 → 1`) rather than the flat 1 a first draft of it expected.

**The rotation bound had to go below one record's size to fire every cycle.** Measured at 256 bytes
first: rotation fired roughly every fourth cycle, because the check is
`bytesOnDisk + record > maxBytes` and a freshly repointed destination starts at zero. An exercise that
fires intermittently reports the fixture rather than the code, so the bound is now 1 byte, taking the
degenerate-but-correct branch the sink documents at its rotation check.

## 5. What this does not establish

1. **It is not a claim about a host under load.** These are synthetic cycles driving one sink directly.
   The descriptor claim for a real workspace under concurrent runs is the sibling record's, and §6
   draws that line.
2. **The process figure corroborates and never asserts.** `/dev/fd` counts descriptors this feature
   does not own — module loads, temp-directory churn and the test runner's own pipes all move it. The
   assertion in exercise 4 is a ceiling loose enough that only a real per-cycle leak reaches it (a
   delta below 50 over 200 cycles, where leaking one per cycle would read 200). Pinning the observed
   0 would make the test an instrument aimed at vitest.
3. **win32 has no corroboration half**, because it has neither `/dev/fd` nor `/proc/self/fd`. It loses
   corroboration and not coverage: exercises 1–3 assert the sink's own count on every platform, which
   is why no platform-record row is owed for the skip.
4. **This is not the warning detector.** `vitest.perf.config.ts` declares no `setupFiles`, and
   `FR-R3-137` did not add one — the `DEP0137` detector covers the default include, where the sink's
   own suites live. It costs nothing here: a count returning to zero is a strictly stronger statement
   than the absence of a warning the collector may not have got around to emitting.

## 6. How this relates to the large-workspace record

[`large-workspace-resource-measurement.md`](large-workspace-resource-measurement.md) states in §4,
third figure, at line 86:
*"**Descriptors are flat** — zero delta at every level, on the platform that can be asked."* That is a
**different measurement**, and neither record supersedes the other:

| | Large-workspace record (`FR-R3-130`) | This record (`FR-R3-137`) |
| --- | --- | --- |
| Subject | Process-wide descriptor delta | The **sink's own** handle count |
| Load | Concurrent runs, 1/2/4/8, on 2,000 tracked files | Repeated build/teardown, repoint and rotation of one sink |
| Instrument | `/dev/fd` | `openDescriptorCount`, with `/dev/fd` as corroboration |

Both were true at the same time, before this item existed, and that is the useful part. The host opens
one append handle per destination and that fixture never repoints a destination, so a **flat process
count** and an **undisposed sink** are simultaneously observable: one handle held for the process's
lifetime is invisible in a delta taken across a load window. A reader who took the flat delta as
evidence that transport descriptors were accounted for would have been reading a number that could not
have shown otherwise.

This record therefore does not restate the load-fixture claim or its figures. The sibling remains the
authority on process-wide resource behaviour under concurrency; this one is the authority on the
transport sink's own handle lifetime.
