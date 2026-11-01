# Parser and timing coverage inventory

**Captured**: 2026-11-01 · **Feature**: 259 (`FR-R4-F12`, FR-022) · **Tree**: `repo/` at `62265e71`, plus the uncommitted work of feature 259 (the new files it adds are counted below)

**Refresh obligation**: whoever adds or removes a seeded generative test at a parser or settings boundary, or a
real-timer wait, refreshes the affected row in the same change. A count here is what its rule printed at the
tree named above and nothing more; a row that has drifted since is a refresh, not a failure.

## What this page is

A counted statement of three things the review asked to have counted rather than described: which deterministic
(seeded) tests guard each parser and settings boundary, which tests wait on a real timer, and which tests control
the clock. Every number is produced by an exact command, listed whole in the last section, and paired with a
control that must hit, so that a zero is a measured zero. It claims **no flake rate**. A real-timer wait is a
place where one could occur, not a measurement that one does, and tier concurrency is a known amplifier of any of
them.

It is a captured survey, not a gate: the counts move with every unrelated test, so asserting them would only add a
number to keep in step. Rerunning the commands at the tree above reproduces every count.

## Categories

| Category | What counts | Risk statement |
|---|---|---|
| `deterministic-property` | tests or fixtures that import `tests/fixtures/seeded-rng.ts` or define `mulberry32`, and files named `*.property.test.ts` | none from timing |
| `integration-timing` | single-line real-timer waits (`new Promise` and `setTimeout` on one line) under `tests/integration/` | each exercises a real boundary and is kept (FR-024) |
| `unmeasured-flake-risk` | the same rule under `tests/unit/` and `tests/lint/` | not measured; the inventory states that a wait exists |
| `controlled-clock` | files using `useFakeTimers` | none from wall time |

## The counts

| Id | Category | Boundary | Count | Owner |
|---|---|---|---|---|
| D1 | deterministic-property | Stdout parser and audit region | 2 files | F12/259 |
| D2 | deterministic-property | Prompt contract | 1 files | F12/259 |
| D3 | deterministic-property | Stream-json framing | 0 files | F06/253 |
| D4 | deterministic-property | Process YAML and authoring settings | 2 files | F07/254 |
| D5 | deterministic-property | Redaction | 4 files | F10/257 |
| D6 | deterministic-property | IPC validators | 1 files | feature 207 (mapped) |
| D7 | deterministic-property | Retry, watchdog scheduling and runner lifecycle | 0 files | F02, F06/253 |
| D8 | deterministic-property | Shared fixtures (not tests) | 2 files | F10/257 (redaction-corpus), shared (seeded-rng) |
| P1 | deterministic-property | Files named *.property.test.ts (all boundaries) | 2 files | feature 207, F10/257 |
| I1 | integration-timing | Real process and filesystem timing (all of tests/integration) | 24 lines in 21 files | F06/253 |
| U1 | unmeasured-flake-risk | Stdout parser, prompt, YAML, settings, IPC, redaction (unit) | 0 lines in 0 files | F12/259, F07/254, F10/257, feature 207 |
| U2 | unmeasured-flake-risk | Runner and stream framing (unit) | 5 lines in 4 files | F06/253 |
| U3 | unmeasured-flake-risk | Retry, watchdog and controller scheduling (unit) | 7 lines in 4 files | F02 |
| U4 | unmeasured-flake-risk | Every other unit directory | 33 lines in 21 files | unowned by this round (named in FR-024 only as left alone) |
| U5 | unmeasured-flake-risk | Lint tier gates | 7 lines in 2 files | F02 (bounded waits, `waits-are-bounded-by-time.test.ts`) |
| K1 | controlled-clock | Runner and stream framing (unit) | 12 files | F06/253 |
| K2 | controlled-clock | Retry, watchdog and controller scheduling (unit) | 7 files | F02 |
| K3 | controlled-clock | Every other unit directory | 14 files | unowned by this round |
| K4 | controlled-clock | Integration tier | 6 files | F06/253, F02 |

The `D` rows split the seeded census by path. They sum to the census (control C3): 2 + 1 + 0 + 2 + 4 + 1 + 0 + 2
= 12. The `U` rows sum to the unit total: 0 + 5 + 7 + 33 = 45 lines in 0 + 4 + 4 + 21 = 29 files. The `K` unit
rows sum to the unit total of files using `useFakeTimers`: 12 + 7 + 14 = 33. The single-line rule counts 76
real-timer lines in all: 45 unit, 24 integration, 7 lint.

### Controls

| Id | What it shows | Count at capture |
|---|---|---|
| C1 | a directory with real-timer waits must hit | 13 |
| C2 | a directory with fake timers must hit | 12 |
| C3 | the seeded-generator census must be non-empty, so a zero row is a measured zero | 12 |
| C4 | the property-named rule must find files | 2 |

### Against the plan's figures

The plan counted 76 real-timer lines (45 unit in 29 files, 24 integration in 21 files, 7 lint in 2 files) and 32
unit and 6 integration files using fake timers. Every figure reproduces except one: the unit fake-timer files are
**33**, one more than the plan's 32. The new file is `tests/unit/controller/phase-start-prompt-identity.test.ts`
(feature 259), which holds only the `Date` clock still across two reads of the metrics service.

### The review's figure

A principal review totalled 53 timing waits against its own listed 31 + 17 + 4 = 52 (`ebf589fa`, by a rule the
review did not state). That figure is quoted as the review's and is **not reconciled** with this page: this page
states its own rule, above, and reconciling two rules would need the first. A real timer is not automatically a
flaky test; the `unmeasured-flake-risk` rows count waits, not failures.

## Owned by this feature (FR-023)

The completion parser and the prompt contract are this feature's boundaries. Its owned hostile-input and bounded-time
cases are:

- `tests/unit/parser/no-region-token.test.ts` (T010, the matrix and the oracle, FR-R4-004 / S-05) and
  `tests/unit/parser/completion-hostile-inputs.test.ts` (T013, 400 seeded cases of at most 256 KiB, FR-R4-004 / S-05);
- `tests/perf/completion-detection-bounded-work.test.ts` (T039, bounded time at 8 and 16 MiB, FR-R4-004 / S-05);
- `tests/unit/runner/prompt-identity.test.ts` (T056, the seeded case at the prompt boundary, FR-R4-102).

## Deferred (owned here, not delivered)

**The blank line after `Remaining issues:`.** The shared fixture `tests/fixtures/parser/remaining-issues-blank-line.ts`
(handed over by FR-R4-F15) records a parse of a `Remaining issues:` block whose list is interrupted by a blank line.
It is a completion-parser gap owned by this feature and **deferred**: FR-005 keeps `Remaining issues:` handling
unchanged, and reading past the blank line changes which bullets count, so it needs its own compatibility decision.
The fixture's `expectedParse` is unchanged by this feature.

## Gaps and their owners

No test is added at these boundaries by this feature (FR-024); each names its owner.

| Boundary | Gap | Owner |
|---|---|---|
| Process YAML and authoring settings | rows D4, U1: seeded tests exist, no real-timer wait; breadth belongs to the YAML feature | F07/254 |
| Redaction | rows D5, U1: covered by the seeded and bounded-work tests of the credential-protection feature | F10/257 |
| Retry and watchdog scheduling | rows U3, K2: real-timer waits and controlled clocks | F02 |
| Runner lifecycle and stream framing | rows D3, D7, U2, K1: no seeded test at stream framing; real-timer waits in the runner | F06/253 |
| Real process and filesystem timing | row I1: kept as written, each wait exercises a real boundary | F06/253 |
| IPC validators | row D6, mapped by `docs/development/ipc-fuzz-hazard-map.md` | feature 207 |

## The commands

Run each from `repo/`. A `D`, `U`, `I` or `K` row prints one count (files) or two (lines, then files); a control
prints one. The ids match the tables above.

```text
C1: rg -c 'new Promise[^\n]*setTimeout' tests/unit/audit | awk -F: '{n+=$NF} END{print n+0}'
C2: rg -l 'useFakeTimers' tests/unit/runner | wc -l | tr -d ' '
C3: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | wc -l | tr -d ' '
C4: find tests -name '*.property.test.ts' | wc -l | tr -d ' '
D1: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg '^tests/(unit/parser|perf/completion-detection)' | wc -l | tr -d ' '
D2: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg '^tests/unit/runner/prompt-' | wc -l | tr -d ' '
D3: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg 'stream|framer' | wc -l | tr -d ' '
D4: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg '^tests/unit/(process-yaml|config)' | wc -l | tr -d ' '
D5: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg '^tests/(unit/lib|unit/redaction-sinks|perf/(sanitize|secretlint))' | wc -l | tr -d ' '
D6: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg '^tests/unit/contracts' | wc -l | tr -d ' '
D7: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg 'watchdog|retry|lifecycle' | wc -l | tr -d ' '
D8: rg -l 'mulberry32|seeded-rng' tests -g '*.ts' | rg '^tests/fixtures/' | wc -l | tr -d ' '
P1: find tests -name '*.property.test.ts' | wc -l | tr -d ' '
I1: rg -c 'new Promise[^\n]*setTimeout' tests/integration | awk -F: '{n+=$NF; f+=1} END{print n+0, f+0}'
U1: rg -c 'new Promise[^\n]*setTimeout' tests/unit/parser tests/unit/process-yaml tests/unit/config tests/unit/contracts tests/unit/lib tests/unit/redaction-sinks | awk -F: '{n+=$NF; f+=1} END{print n+0, f+0}'
U2: rg -c 'new Promise[^\n]*setTimeout' tests/unit/runner | awk -F: '{n+=$NF; f+=1} END{print n+0, f+0}'
U3: rg -c 'new Promise[^\n]*setTimeout' tests/unit/controller tests/unit/monitor tests/unit/watchdog | awk -F: '{n+=$NF; f+=1} END{print n+0, f+0}'
U4: rg -c 'new Promise[^\n]*setTimeout' tests/unit -g '!**/runner/**' -g '!**/controller/**' -g '!**/monitor/**' -g '!**/watchdog/**' -g '!**/parser/**' -g '!**/process-yaml/**' -g '!**/config/**' -g '!**/contracts/**' -g '!**/lib/**' -g '!**/redaction-sinks/**' | awk -F: '{n+=$NF; f+=1} END{print n+0, f+0}'
U5: rg -c 'new Promise[^\n]*setTimeout' tests/lint | awk -F: '{n+=$NF; f+=1} END{print n+0, f+0}'
K1: rg -l 'useFakeTimers' tests/unit/runner | wc -l | tr -d ' '
K2: rg -l 'useFakeTimers' tests/unit/controller tests/unit/monitor tests/unit/watchdog | wc -l | tr -d ' '
K3: rg -l 'useFakeTimers' tests/unit -g '!**/runner/**' -g '!**/controller/**' -g '!**/monitor/**' -g '!**/watchdog/**' | wc -l | tr -d ' '
K4: rg -l 'useFakeTimers' tests/integration | wc -l | tr -d ' '
```
