// Feature 103 (T082, US8 — FR-049) — a filtered view is a list, not a report.
//
// The pull toward the other thing is strong and reasonable-sounding. Once an
// operator can filter to "this Pipeline, v4, failed, last 7 days", the very next
// question is "how often does that happen", and the rows to answer it are
// already on screen. One `reduce` in a `$derived` and History grows a success
// rate.
//
// It must not, because Metrics already answers that question from
// `metrics-rollup.jsonl` — the durable per-run summaries, complete over the
// retention window. History holds `HISTORY_CAP_PER_QUEUE` entries per queue and
// drops the oldest. A rate computed over what History happens to still hold is
// a rate over a truncated, silently-moving denominator, and it would sit beside
// the Metrics number that disagrees with it. Two answers to one question, one
// of them wrong, and no indication which.
//
// So the claim is structural, not behavioural. A behavioural test can only show
// that no aggregate was computed for the inputs it drove. These assertions show
// the surface contains no machinery to compute one: no fold, no mean, no
// declared rate. The behavioural half below covers the direction a scan cannot
// — that the projector hands back the rows it was given rather than a summary
// of them.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { projectHistory } from '../../src/ui/sidebar/history-projector';
import type { HistoryRecord } from '../../src/state/history-entry';
import type { HistoryStore } from '../../src/state/history-store';

const REPO_ROOT = path.join(__dirname, '../..');
const WEBVIEW_COMPONENTS = path.join(REPO_ROOT, 'webview-ui/src/components');

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

/**
 * Every module the History surface is made of, host and webview.
 *
 * The Svelte components are enumerated by prefix rather than listed, for the
 * same reason `tests/lint/no-html-interpolation-in-activity-feed.test.ts`
 * enumerates them: a list that names only today's seven files stops covering
 * the surface the moment an eighth lands, and it stops silently.
 */
function surfaceFiles(): readonly string[] {
  const components = readdirSync(WEBVIEW_COMPONENTS)
    .filter((name) => name.startsWith('History') && name.endsWith('.svelte'))
    .map((name) => path.join('webview-ui/src/components', name))
    .sort();

  // Non-vacuity for the enumeration itself. A `readdir` that silently returned
  // nothing would make every scan below pass over an empty set.
  expect(components.length, 'no History*.svelte components found').toBeGreaterThanOrEqual(7);

  return [
    'src/ui/sidebar/history-projector.ts',
    'src/services/history-recorder.ts',
    'src/services/history/audit-pointer-resolver.ts',
    'src/services/history/history-evidence-service.ts',
    'src/ui/sidebar/commands/cmd-resolve-audit-pointer.ts',
    'webview-ui/src/lib/history-filters.ts',
    'webview-ui/src/lib/history-rows.ts',
    'webview-ui/src/lib/history-rerun.ts',
    'webview-ui/src/lib/history-evidence-ipc.ts',
    ...components
  ];
}

/**
 * Comments stripped, `<!-- -->` included because half this surface is Svelte.
 *
 * Prose is where this rule gets *explained* — `HistoryRunDetail.svelte` says
 * "three totals and nothing more" directly above the markup that reads three
 * totals off the metrics summary. Counting that sentence as an aggregate would
 * force the file onto an exemption list, and the exemption would then cover a
 * real one. Crude on string literals in the same direction as the scan next
 * door: it can only make the scan see less, and every pattern below is proven
 * live against a positive control.
 */
function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * What computing an aggregate looks like in code.
 *
 * Each targets the *computation*, never the word. `{summary.phasesTotal}` is a
 * read of a figure the metrics service computed and FR-027 requires the detail
 * to show; `const phasesTotal = rows.reduce(...)` is this surface computing one.
 * The patterns are written so the first passes and the second does not, which
 * is why they anchor on folds, on division by a cardinality, and on *declaring*
 * a statistic rather than mentioning one.
 *
 * The camel-case tail (`(?:[A-Z][A-Za-z]*)?`) is what makes each a word rather
 * than a prefix: `sum`, `sumMs` and `phasesTotal` are declarations of a total,
 * `summary` is a different word that happens to start with one. The first draft
 * of this scan flagged `HistoryRunDetail.svelte` for holding a `summary` field,
 * which is the read FR-027 requires — a rule that cries wolf on the compliant
 * shape gets an exemption written for it, and the exemption then covers a real
 * one.
 *
 * A plain count is deliberately absent from this list. FR-052 obliges the
 * surface to say how many rows matched and how many it rendered; cardinality is
 * a property of a list, not a statistic over it. FR-049 names three things —
 * rates, averages, totals — and those are what is forbidden.
 */
const AGGREGATE_PATTERNS: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: 'a fold over the row set', re: /\.reduce\s*\(/ },
  { what: 'a mean (division by a cardinality)', re: /\/\s*[A-Za-z_$][\w.$]*\.length\b/ },
  { what: 'a declared average', re: /\b(?:avg|average|mean)(?:[A-Z][A-Za-z]*)?\s*[:=][^=]/ },
  {
    what: 'a declared rate or percentage',
    re: /\b(?:rate|[a-z]+Rate|percent(?:[A-Z][A-Za-z]*)?)\s*[:=][^=]/
  },
  {
    what: 'a declared total or sum',
    re: /\b(?:total|[a-z]+Total|sum|[a-z]+Sum)(?:[A-Z][A-Za-z]*)?\s*[:=][^=]/
  }
];

function read(relative: string): string {
  return withoutComments(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
}

// ---------------------------------------------------------------------------
// Structural — the surface has no machinery to compute one
// ---------------------------------------------------------------------------

describe('the History surface computes no aggregate (T082, FR-049)', () => {
  it('contains no fold, mean, rate or declared total anywhere', () => {
    const offenders: string[] = [];

    for (const file of surfaceFiles()) {
      const source = read(file);
      for (const { what, re } of AGGREGATE_PATTERNS) {
        if (re.test(source)) offenders.push(`${file}: ${what}`);
      }
    }

    expect(
      offenders,
      'Metrics owns rates, averages and totals. A second implementation over ' +
        "History's capped, silently-truncating row set would disagree with it."
    ).toEqual([]);
  });

  it('the patterns catch a real aggregate where one legitimately lives', () => {
    // Non-vacuity, and the reason the scan above is worth trusting. The metrics
    // service is the module that *should* fold — it is the one FR-049 points at
    // when it says the capability exists elsewhere. If these patterns stopped
    // matching, the scan above would pass on a surface that had grown a report.
    const metrics = read('src/metrics/metrics-service.ts');
    const matched = AGGREGATE_PATTERNS.filter(({ re }) => re.test(metrics)).map(({ what }) => what);

    expect(matched.length, 'the aggregate patterns match nothing even in Metrics').toBeGreaterThan(
      0
    );
  });

  it('reads the real files rather than a set of empty strings', () => {
    for (const file of surfaceFiles()) {
      expect(read(file).length, `${file} scanned as empty`).toBeGreaterThan(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavioural — the projector hands back rows, not a summary of them
// ---------------------------------------------------------------------------

function record(index: number, durationMs: number): HistoryRecord {
  return {
    runId: `run-${index}`,
    featureId: `feat-${index}`,
    descriptionPreview: `run ${index}`,
    terminalStatus: index % 2 === 0 ? 'completed' : 'failed',
    startedAt: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
    completedAt: new Date(1_700_000_000_000 + index * 60_000 + durationMs).toISOString(),
    durationMs,
    lastErrorSummary: null,
    auditLogPointer: `runId:run-${index}`,
    queueId: 'default'
  };
}

/** Durations chosen so a mean (2000) is a value no individual row carries. */
const DURATIONS: readonly number[] = [1_000, 1_500, 3_500];

function storeOf(records: readonly HistoryRecord[]): Pick<HistoryStore, 'list'> {
  return { list: () => records } as Pick<HistoryStore, 'list'>;
}

describe('the projection is one row per record (T082, FR-049)', () => {
  it('emits exactly as many rows as it was given', () => {
    const records = DURATIONS.map((ms, i) => record(i, ms));

    const rows = projectHistory(storeOf(records));

    expect(rows).toHaveLength(records.length);
    expect(rows.map((row) => row.runId)).toEqual(['run-0', 'run-1', 'run-2']);
  });

  it('carries each row’s own duration and never a figure derived across them', () => {
    const records = DURATIONS.map((ms, i) => record(i, ms));
    const mean = DURATIONS.reduce((a, b) => a + b, 0) / DURATIONS.length;
    const sum = DURATIONS.reduce((a, b) => a + b, 0);

    const rows = projectHistory(storeOf(records));

    expect(rows.map((row) => row.durationMs)).toEqual([...DURATIONS]);
    // The two figures a report would carry, asserted absent by value rather
    // than by field name: a summary bolted on under any name would have to
    // contain one of them.
    const values = rows.flatMap((row) => Object.values(row));
    expect(values, 'a mean reached the wire').not.toContain(mean);
    expect(values, 'a sum reached the wire').not.toContain(sum);
  });

  it('returns a bare array with no summary bolted onto it', () => {
    // `Object.keys` on an array is its indices. A projector that attached
    // `matched`, `failureRate` or a `summary` object to the returned array —
    // the cheapest way to ship a report without changing the row type — would
    // show up here as a non-numeric key.
    const rows = projectHistory(storeOf(DURATIONS.map((ms, i) => record(i, ms))));

    expect(Object.keys(rows).filter((key) => !/^\d+$/.test(key))).toEqual([]);
  });

  it('emits nothing at all when there is no store, rather than an empty report', () => {
    const rows = projectHistory(null);

    expect(rows).toEqual([]);
    expect(Object.keys(rows).filter((key) => !/^\d+$/.test(key))).toEqual([]);
  });
});
