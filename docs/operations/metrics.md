# Metrics Coverage and the Rollup

The Dashboard's **Metrics** tab answers two different questions from two
different sources, and it labels each with its own coverage window. Getting this
distinction right matters if you quote a figure to anyone:

| Figure | Source | Horizon |
|---|---|---|
| **All-time totals** — runs, outcomes, elapsed time, cost, backend invocations | `.schegent/metrics-rollup.jsonl`, composed with whatever the audit scan still holds | Every run since the rollup file was created, plus older runs still present in the scanned log |
| **Per-run and per-phase detail** — the task table, phase analytics, cost trend | A fold over `.schegent/audit.log` and, when you opt in, its rotated archives | Only what audit-log rotation currently retains |

The detail window moves. The totals window does not.

## Why the two windows differ

The audit log rotates: an eleventh archive or a ninety-first day removes the
oldest one ([File Layout](../reference/file-layout.md)). That policy is correct —
it bounds disk use and keeps the cold-start scan fast — but it means anything
derived only from the log reports the *rotation window* rather than the history.

Before the rollup, that included the cumulative figures, so a cumulative total
went **down** when an archive was pruned. A short window is a limitation you can
work around; a cumulative total that decreases is a wrong number, and nothing in
the view distinguished the two. Worse, the effect was delayed: metrics use a
per-process byte-offset cache, so the old total held steady until the next cache
invalidation, and two VS Code windows opened at different times could report
different all-time figures for the same workspace.

The rollup removes that. It is written once per terminal run, at the moment the
run reaches `completed`, `failed`, or `canceled` — while the evidence is still
present — and it is never rewritten and never recomputed.

## What the rollup file holds

`.schegent/metrics-rollup.jsonl` is append-only JSON Lines, mode `0600`, one
record per terminal run:

```json
{"v":1,"runId":"run-4f2c","terminalStatus":"completed","startedAt":"2026-08-18T09:14:02.113Z","endedAt":"2026-08-18T10:02:44.887Z","durationMs":2922774,"phasesTotal":7,"phasesCompleted":7,"phasesSkipped":0,"backendInvocations":19,"costUsd":3.41}
```

That is the whole record: an id, a terminal status, two timestamps, six integer
counters, and an optional cost. There is **no** task description, no file path,
no prompt, and no CLI output — by design, so there is no free text in it to
redact. `costUsd` is **omitted** rather than set to `0` when the CLI reported no
cost, because "not reported" and "reported as zero" are different facts and
collapsing them understates the total.

At roughly 200 bytes per run, 10,000 runs is about 2 MB. The file has **no
retention policy** and is not pruned by any sweep — that is the point of it. If
you want to reclaim the space, see [Deleting it](#deleting-it) below.

## Reading the coverage windows in the UI

- The **All-time totals** strip carries a line naming how many runs the rollup
  covers and the date of the earliest. If no rollup exists yet, it says so
  instead — the totals are then scan-derived and will move with rotation.
- The **header chip** names the detail window: the earliest timestamp in the
  current scan, and whether archives are included.
- A cost total is shown as `12.34+` with a `+` when at least one counted run
  reported no cost. The figure is then a floor, not an exact total.
- If retention has pruned every run the rollup counts, the tab shows the totals
  strip with an explanatory empty state instead of a blank table. Totals without
  detail is a normal, expected state on a long-lived workspace — not a fault.

## Expected behaviours that look like bugs

**All-time totals exceed the task table.** Correct. The table is the retained
detail; the totals include runs whose detail has rotated away.

**Totals differ from a sum of the visible rows.** Correct, same reason. Sum the
rows and you get the retained window's subtotal, which the **Retained run detail
totals** summary cards already show.

**Turning "Include archived history" on changes the table but not the totals.**
Correct. The toggle widens the *detail* scan. Totals are already rollup-backed,
so they do not depend on it.

**A run appears in both ranges but is counted once.** Correct. Composition
deduplicates by run id, and on overlap the rollup record wins — a fold over a
partially pruned corpus can only understate a run it can still partly see.

**A brand-new workspace shows a total but "no durable rollup recorded yet".**
Correct. Runs that completed before this version shipped were never rolled up,
so their totals come from the log alone and will shrink as it rotates. New runs
from now on are durable.

## When totals can still regress

One case remains, and it is why the rollup is a tracked evidence sink:

> If the rollup append **fails** for a run — disk full, read-only filesystem,
> permissions — that run still executes and still completes, but its totals
> contribution then lasts only as long as its audit evidence. When rotation
> prunes that evidence, the totals drop by that run.

Schegent does not backfill the missed record later, because rebuilding from a
corpus that may already be incomplete reintroduces exactly the defect the rollup
exists to remove. Instead the failure is surfaced immediately:

1. The health indicator reads **evidence degraded** and names `metrics rollup`.
2. A sanitized warning is written to the runtime log carrying the run id and a
   normalized cause — `permission-denied`, `disk-full`,
   `read-only-filesystem`, or `io-error` as the catch-all — and never a path or
   a raw error message. Repeated failures with the same cause update the count
   but produce one warning.
3. The run's own progress is unaffected. A rollup failure never fails a phase.

Treat the badge as a warning about a *future* regression in reported totals, not
a current one. Fix the cause, reload the window, and subsequent runs record
normally; the runs that were missed stay missed. See
[Execution Evidence Health](evidence-health.md).

## Inspecting and reporting from the file directly

The rollup is plain JSON Lines, so ordinary tools work on it. Runs recorded:

```bash
wc -l .schegent/metrics-rollup.jsonl
```

Total cost across every recorded run, and how many reported none:

```bash
jq -s '{
  runs: length,
  costUsd: (map(.costUsd // 0) | add),
  runsWithoutCost: (map(select(.costUsd == null)) | length)
}' .schegent/metrics-rollup.jsonl
```

Cost per calendar month:

```bash
jq -r '[.endedAt[0:7], (.costUsd // 0)] | @tsv' .schegent/metrics-rollup.jsonl \
  | awk -F'\t' '{ total[$1] += $2 } END { for (m in total) printf "%s\t%.2f\n", m, total[m] }' \
  | sort
```

Outcome mix:

```bash
jq -r .terminalStatus .schegent/metrics-rollup.jsonl | sort | uniq -c
```

A duplicate `runId` would be a defect, not something to correct by hand — the
writer is idempotent per run id, including across two hosts appending
concurrently and across a crash-replayed terminal transition. Check with:

```bash
jq -r .runId .schegent/metrics-rollup.jsonl | sort | uniq -d
```

## Deleting it

Deleting `.schegent/metrics-rollup.jsonl` is safe for execution — nothing reads
it except the metrics view, and a missing file is treated as "no durable rollup"
rather than an error. It is **not** recoverable: the runs it covered are gone
from the totals permanently unless their audit evidence is still retained, and
they cannot be rebuilt from a pruned corpus.

```bash
# Irreversible for any run whose audit evidence has already rotated away.
rm -f .schegent/metrics-rollup.jsonl
```

Truncating or editing individual lines is not supported. The file is append-only
by contract; a partial rewrite is indistinguishable from corruption, and an
unreadable line is skipped with a warning rather than repaired.

## Version marker and forward compatibility

Every record carries `"v"`. The reader is deliberately **tolerant of a newer
version** than the running build: unknown fields are ignored and the record is
still counted, because refusing it would make a total drop for an operator who
downgraded — the same defect from a different direction. A record that is
malformed in a way the reader cannot interpret (bad JSON, missing version,
negative counter, non-numeric cost) is skipped and counted as unreadable rather
than guessed at.

## Related

- [Dashboard UI Guide](dashboard-ui.md) — the Metrics tab layout in context.
- [Execution Evidence Health](evidence-health.md) — what a degraded rollup means
  and the recovery playbook.
- [File Layout](../reference/file-layout.md) — everything under `.schegent/`,
  with retention behaviour per file.
- [Inspect Audit Logs](inspect-audit-logs.md) — the corpus the detail window is
  folded from.
