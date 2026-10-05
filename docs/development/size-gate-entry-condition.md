# The size gate's entry condition: 1,000 lines

**Decided**: 2026-10-01 (`FR-R3-183`, feature 217), proposed at planning on 2026-09-17 and
confirmed against the tree re-measured after the feature's first workstream landed · **Gate**:
`repo/tests/lint/source-loc-budget.test.ts` enforces it as `ENTRY_CONDITION_LINES` and names this
file in its failure message

<!-- Source: tests/lint/source-loc-budget.test.ts -->

The size gate held sixteen entries for 530 source files. A file entered its table only when somebody
added it, so the files most likely to need a bound were the ones nobody had looked at.
`src/contracts/audit-events.ts` and `src/controller/phase-runner.ts` were both larger than every
ceiling in the table, and neither had an entry. This record is the rule that closes the gap: the size
at which a file has to be in an explicit state in the gate's table.

One of the two was bounded all along, by a different gate. Feature 057's
`repo/tests/lint/phase-runner-loc-budget.test.ts` holds `phase-runner.ts` at 1,403 lines by `wc -l`,
which is its size. The filing that raised this listed both files under *"No bound of any kind"*, and
that is true only of `audit-events.ts`. The rule below reads only this gate's table, so it captures
`phase-runner.ts` all the same; how its two bounds sit together is set out beside its waiver.

## Decision

**A `.ts` file under `src/` that is 1,000 lines or longer must carry an entry in the gate's table:
a ceiling or a waiver.** A file that reaches 1,000 lines with no entry fails the gate, which names
the file with its size and lists the three states its author may choose:

1. **Reduce it** below 1,000 lines, where it needs no entry.
2. **Declare a ceiling**, `{ path, maxLines }`. The ceiling must sit more than `tightMargin` above
   the file and within `WAIVER_FACTOR` times it. The gate already holds every new ceiling to both.
3. **Declare a waiver**, `{ path, waiver: { decision, decidedOn, reference, highWaterMark } }`. It
   quotes the decision, gives the ISO date it was taken, references the place it is written down by
   path, and records the file's size as the mark.

The gate matches on every entry's `path` field and never on a particular path (hard rule 67), so the
condition applies to the next file to grow this large, not only to the ones named here.

Lines are counted the way the gate counts them, `split(/\r?\n/).length`. That is one more than
`wc -l` for a file that ends in a newline.

## Measurement

The three-state distribution over every `src/**/*.ts` file, measured against the gate's table. The
figures are generated from the tree by
`node ../specs/217-evidence-posture-and-bounds/measure/size-dist.mjs .`, run from `repo/`, not
transcribed. "Unbounded" means what the entry condition reads: the file has no entry in this table,
neither a ceiling nor a waiver. The script does not read other gates. Of the files 700 lines or
longer, one it counts unbounded has a bound elsewhere, `phase-runner.ts`, so from 700 to 1,300 each
row's unbounded count is one higher than the number of files bounded by nothing.

Both measurements were taken on 2026-10-01: one before any of this work had landed, and one after
its first workstream had, before any entry was added. The decision rests on the second.

| Threshold | Before: at or above | Before: unbounded | After: at or above | After: unbounded |
|---|---|---|---|---|
| 700 | 26 | 20 | 27 | 21 |
| 800 | 20 | 15 | 20 | 15 |
| 900 | 12 | 7 | 13 | 8 |
| **1,000** | **11** | **6** | **12** | **7** |
| 1,100 | 9 | 5 | 9 | 5 |
| 1,200 | 5 | 2 | 6 | 3 |
| 1,300 | 4 | 2 | 4 | 2 |
| 1,500 | 3 | 1 | 3 | 1 |
| 2,000 | 2 | 0 | 2 | 0 |

The tree held 530 files before and 532 after, the two new ones being the workstream's own small
modules. The largest ceiling in the table is 1,330 (`src/services/run-driver.ts`). Two files with no
entry were larger than it at both measurements, `audit-events.ts` and `phase-runner.ts`, and one of
them was bounded by nothing: `audit-events.ts` (`FR-038`).

Between the two measurements the workstream took `src/lib/runtime-log/runtime-log-sink.ts` from 899
to 1,018 lines, so 1,000 captures seven files rather than the six planned. Both measurements, with
every file at or above 1,000, are in
[measurements.md](../../../specs/217-evidence-posture-and-bounds/measurements.md#2-size-distribution).

## Reason

The acceptance band comes from the requirement (`FR-040`): a threshold is acceptable only when it
captures between 1 and 20 currently unbounded files. A threshold that captures none has no present
effect. One that captures more than twenty cannot have each captured file placed in a considered
state in one change. Within the band, the distribution selects 1,000 for three reasons.

1. **It is where the table's coverage already was.** Before this work, 5 of the 11 files at or
   above 1,000 lines carried an entry: two waivers, and ceilings on `run-driver.ts`,
   `sidebar-ipc.ts` and `workflow-controller.ts`. A sixth, `phase-runner.ts`, was held by feature
   057's gate. Between 700 and 999 lines, 1 of 15 carried an entry. The condition makes mandatory,
   for every file this size, what was already done for six of the eleven. A lower threshold would
   start governing a band the table has so far left alone, which is a different decision with its
   own argument.
2. **Every higher threshold leaves a file unbounded beside a bounded peer of the same size.**
   `src/state/queue-state-migrator.ts` and `src/controller/workflow-controller.ts` both measure
   1,008 lines, and only the second had a ceiling.
3. **It sits below the largest ceiling**, so a file cannot meet it merely by being smaller than
   something already bounded.

Thresholds considered and rejected, with what each captures in the tree the decision rests on:

| Threshold | Unbounded files captured | Why not |
|---|---|---|
| 700 | 21 | Outside the band. Counting `phase-runner.ts` as bounded makes it 20, the band's edge, and it would then fall for the reason 800 does, over a wider band: it reaches into 700–999 lines, where 1 of 15 files carries an entry. |
| 800 | 15 | Inside the band, but it reaches into 800–999 lines, where none of the eight files carries an entry. It would start a practice rather than complete one. |
| 900 | 8 | Inside the band. The one file it adds is `src/catalog/catalog-store.ts` at 946, the only file between 900 and 999. Same reason as 800, for one file. |
| 1,100 | 5 | Leaves `queue-state-migrator.ts` and `runtime-log-sink.ts` unbounded, beside `workflow-controller.ts`, which is bounded at their size. |
| 1,200 | 3 | Also leaves `src/ui/sidebar/snapshot.ts` and `src/monitor/claude-cli-monitor.ts` unbounded, while `sidebar-ipc.ts` at 1,110 carries a ceiling. Before this work it captured only the two files the filing named by hand, so it did nothing beyond them. |
| 1,300 | 2 | Only the two files the filing named. |
| 1,500 | 1 | Only `audit-events.ts`. |
| 2,000 | 0 | Outside the band: no present effect. |

### The state each captured file takes

| File | Lines | State |
|---|---|---|
| `src/contracts/audit-events.ts` | 1,551 | waiver, mark 1,551 |
| `src/controller/phase-runner.ts` | 1,404 | waiver, mark 1,404; feature 057's gate holds it at the same size |
| `src/monitor/cli-transport-sink.ts` | 1,281 | ceiling 1,320 |
| `src/ui/sidebar/snapshot.ts` | 1,186 | ceiling 1,225 |
| `src/monitor/claude-cli-monitor.ts` | 1,100 | ceiling 1,140 |
| `src/lib/runtime-log/runtime-log-sink.ts` | 1,018 | ceiling 1,060 |
| `src/state/queue-state-migrator.ts` | 1,008 | ceiling 1,050 |

Both waiver entries quote the decision below in their `decision` field and cite this file as their
`reference`:

> audit-events.ts and phase-runner.ts are accepted at their measured size and given no room to grow:
> neither is required to shrink, and neither may get longer unless its highWaterMark is raised in a
> diff that says why

The two files take the waiver because it is the tighter bound, not the looser one. A plain ceiling
counts as a budget only while it keeps more than `tightMargin` above its file, so every ceiling
grants room to grow that nobody has to decide on. A waiver's mark grants none: the next added line
fails the gate, and the only way past it is a diff that raises the mark. The review calls
`audit-events.ts` *"the most likely next god-file"*. Both files are larger than every ceiling in
the table, and the waiver is the form their two larger peers, `workspace-state.ts` and
`queue-manager.ts`, already carry. It makes no claim that either file should be smaller.

`audit-events.ts` had no stated size anywhere. `phase-runner.ts` had one: feature 057's gate holds it
at 1,403 by `wc -l`, which is 1,404 by this gate's count, the mark its waiver records. The two bounds
agree, so the waiver gives the file no room that gate denied and denies none it gave, and it is the
entry the condition needs. Growing the file now means raising both numbers. The waiver is the
stricter of the two, because its mark must also come down once the file shrinks by more than 100
lines, so feature 057's entry is the one that could be removed without loss. It was not removed:
this work places files in states, and taking a bound out of another gate is a separate decision.

The other five take ceilings with about forty lines of headroom. That is the form the table already
gives files of their size: `run-driver.ts`, `sidebar-ipc.ts` and `workflow-controller.ts`.

Nothing was split and no helper was extracted to place any of the seven (`FR-046`). Each was placed
by adding an entry to the table. The two waivers that existed before this record,
`workspace-state.ts` and `queue-manager.ts`, and their marks are unchanged.

## What would reopen it

Any one of these:

1. **More than twenty files reach 1,000 lines.** Twelve do today. The band that selected this
   threshold was about how many files one change can place in a considered state. Past twenty, the
   condition is reaching files that are ordinary for this tree, and it should be re-chosen against
   a fresh distribution.
2. **A review names a file below 1,000 lines as a cohesion problem**, as `FR-R3-183` named
   `audit-events.ts`. That is evidence the threshold sits above the size at which this tree's files
   go wrong.
3. **A ceiling placed under this condition is raised in the same change that grows its file.** That
   is the shape the table's header retires: a number nobody decided on. If it happens to these
   ceilings, the threshold is producing entries faster than decisions, and the answer may be a
   waiver or a different threshold.
4. **`tightMargin` or `WAIVER_FACTOR` changes.** They define what a ceiling under this condition
   has to look like, so the five ceilings above were chosen against today's values.

The gate enforces the condition itself and the shape of every entry. It does not watch these four
conditions. The first is measured by the script above, and the other three are events in a change or
a review that only a reader will notice. This record exists so that reader knows what to look for.
