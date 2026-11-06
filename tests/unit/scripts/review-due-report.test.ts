import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R5-F21 (FR-010 to FR-014, SC-002, SC-003) -- `npm run review:due` lists every dated
 * obligation with the instant it starts failing, and agrees with the gates at every boundary.
 *
 * The report imports every rule from `scripts/review-cadence.mjs`, the module the two lint gates
 * read, so a verdict here and a verdict there cannot drift. (a) pins that agreement with an
 * injected clock on both sides of each boundary, in two time zones fourteen hours apart. The rest
 * pin the statuses, the exit codes, the summary line, and that a run writes nothing.
 * Contract: `contracts/review-due-report.md` in the workspace.
 */
async function loadReport() {
  return import('../../../scripts/review-due-report.mjs');
}
async function loadCadence() {
  return import('../../../scripts/review-cadence.mjs');
}

let report: Awaited<ReturnType<typeof loadReport>>;
let cadence: Awaited<ReturnType<typeof loadCadence>>;

beforeAll(async () => {
  report = await loadReport();
  cadence = await loadCadence();
});

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts', 'review-due-report.mjs');
const SPAWN_TIMEOUT_MS = 30_000;
const MS_PER_DAY = 86_400_000;
/** The review date the boundary table is built around. */
const D = '2026-08-25';
const FAR_FUTURE = '2099-12-31';
const RECENT = '2026-11-06';
const HELD_RECORD = 'docs/release/held-major-upgrades.md';
const ZONES = ['UTC', 'Pacific/Kiritimati'] as const;

function holdRecord(rows: readonly string[]): string {
  return [
    '# Held major dependency upgrades',
    '',
    '## Held majors',
    '',
    '| Package | Tree | Held at | Current major | Reason | lastReviewed |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '---',
    ''
  ].join('\n');
}

function holdRow(pkg: string, date: string): string {
  return `| \`${pkg}\` | repo | \`^1.0.0\` | \`2.x\` | A reason long enough for a reader to act on. | ${date} |`;
}

interface FixtureOptions {
  readonly holdDate?: string;
  readonly reviewDate?: string;
  /** Marker text for the first registered record, verbatim. */
  readonly firstMarkerText?: string;
  readonly omitFirstRecord?: boolean;
  readonly extraDocs?: ReadonlyMap<string, string>;
}

function writeAt(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

/** A repository root holding the held-major record and every registered record. */
function fixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'review-due-'));
  writeAt(root, HELD_RECORD, holdRecord([holdRow('left-pad', options.holdDate ?? RECENT)]));
  cadence.DATED_REVIEW_RECORDS.forEach((record, index) => {
    if (index === 0 && options.omitFirstRecord === true) return;
    const text = index === 0 ? (options.firstMarkerText ?? options.reviewDate ?? FAR_FUTURE) : FAR_FUTURE;
    writeAt(root, record.document, `# ${record.defers}\n\n<!-- ${record.marker}: ${text} -->\n`);
  });
  for (const [path, body] of options.extraDocs ?? new Map<string, string>()) writeAt(root, path, body);
  return root;
}

function firstRecord() {
  const first = cadence.DATED_REVIEW_RECORDS.at(0);
  if (first === undefined) throw new Error('the dated-review registry is empty');
  return first;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS
  });
}

const originalTz = process.env['TZ'];
afterEach(() => {
  if (originalTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = originalTz;
});

describe('(a) the report agrees with the gates at every boundary, in any time zone', () => {
  const dayStart = Date.parse(`${D}T00:00:00.000Z`);
  const holdEdge = dayStart + 90 * MS_PER_DAY;
  const cases = ZONES.flatMap((zone) => [
    { zone, kind: 'hold', label: 'D+90d - 1 ms', nowMs: holdEdge - 1, expected: 'current' },
    { zone, kind: 'hold', label: 'D+90d', nowMs: holdEdge, expected: 'current' },
    { zone, kind: 'hold', label: 'D+90d + 1 ms', nowMs: holdEdge + 1, expected: 'overdue' },
    { zone, kind: 'review', label: 'D - 1 ms', nowMs: dayStart - 1, expected: 'current' },
    { zone, kind: 'review', label: 'D', nowMs: dayStart, expected: 'due' },
    { zone, kind: 'review', label: 'D + 1 ms', nowMs: dayStart + 1, expected: 'due' }
  ]);

  it.each(cases)('$kind at $label in $zone is $expected, as the gate says', ({ zone, kind, nowMs, expected }) => {
    process.env['TZ'] = zone;
    const root = kind === 'hold' ? fixture({ holdDate: D }) : fixture({ reviewDate: D });
    const subject = kind === 'hold' ? 'left-pad' : firstRecord().marker;
    const found = report
      .evaluate({ root, nowMs })
      .obligations.find((row) => row.kind === kind && row.subject === subject);
    expect(found, `no ${kind} obligation for ${subject}`).toBeDefined();
    if (found === undefined) return;
    expect(found.status).toBe(expected);
    const gateFails =
      kind === 'hold'
        ? cadence.isOverdue(D, nowMs, cadence.INTERVAL_DAYS)
        : cadence.reviewIsDue(D, new Date(nowMs));
    expect(found.status !== 'current', 'the report and the gate disagree').toBe(gateFails);
  });

  it('dates each obligation from the instant it starts failing', () => {
    const rows = report.evaluate({ root: fixture({ holdDate: D, reviewDate: D }), nowMs: dayStart }).obligations;
    const hold = rows.find((row) => row.kind === 'hold');
    const review = rows.find((row) => row.subject === firstRecord().marker);
    expect(hold?.failsFrom).toBe(new Date(holdEdge + 1).toISOString());
    expect(review?.failsFrom).toBe(new Date(dayStart).toISOString());
    expect(hold?.trigger).toBe('held-major review every 90 days');
    expect(review?.trigger).toBe(firstRecord().defers);
  });
});

describe('(b) to (d) a date that cannot be read is reported, never dropped', () => {
  const nowIso = '2026-11-07T00:00:00.000Z';

  it('(b) reads an impossible hold date as malformed, with its line, and exits 1', () => {
    const root = fixture({ holdDate: '2026-02-30' });
    const rows = report.evaluate({ root, nowMs: Date.parse(nowIso) }).obligations;
    const hold = rows.find((row) => row.kind === 'hold');
    expect(hold?.status).toBe('malformed');
    expect(hold?.failsFrom).toBeNull();
    const cli = run(root, '--now', nowIso);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toMatch(/^malformed {2}- {2}hold {2}docs\/release\/held-major-upgrades\.md {2}left-pad \(line \d+: impossible-date\)/m);
  });

  it('(c) reads an impossible marker date as malformed', () => {
    const rows = report.evaluate({ root: fixture({ firstMarkerText: '2026-13-45' }), nowMs: Date.parse(nowIso) })
      .obligations;
    const review = rows.find((row) => row.subject === firstRecord().marker);
    expect(review?.status).toBe('malformed');
    expect(review?.failsFrom).toBeNull();
  });

  it('(c) reads a registered record with no marker as malformed', () => {
    const rows = report.evaluate({ root: fixture({ firstMarkerText: 'none' }), nowMs: Date.parse(nowIso) })
      .obligations;
    expect(rows.find((row) => row.subject === firstRecord().marker)?.status).toBe('malformed');
  });

  it('(d) reads a marker the registry does not name as unregistered', () => {
    const extraDocs = new Map([['docs/x.md', '<!-- zz-review-date: 2026-01-01 -->\n']]);
    const rows = report.evaluate({ root: fixture({ extraDocs }), nowMs: Date.parse(nowIso) }).obligations;
    const marker = rows.find((row) => row.kind === 'marker');
    expect(marker).toEqual({
      kind: 'marker',
      owner: 'docs/x.md',
      subject: 'zz-review-date',
      failsFrom: null,
      trigger: 'not in the dated-review registry',
      status: 'unregistered'
    });
  });
});

describe('(e) to (i) the command line', () => {
  const nowIso = '2026-11-07T00:00:00.000Z';

  it('(e) exits 2 and names the record when a registered record is missing', () => {
    const cli = run(fixture({ omitFirstRecord: true }), '--now', nowIso);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain(`unreadable  ${firstRecord().document}`);
  });

  it('(e) exits 2 when the held-major record is missing, even with other obligations due', () => {
    const root = fixture({ reviewDate: '2020-01-01' });
    unlinkSync(join(root, HELD_RECORD));
    const cli = run(root, '--now', nowIso);
    expect(cli.status).toBe(2);
    expect(cli.stdout).toMatch(/^due /m);
    expect(cli.stderr).toContain(`unreadable  ${HELD_RECORD}`);
  });

  it('(e) exits 2 when the held-major record has no held-majors heading (review C2)', () => {
    const root = fixture();
    writeAt(root, HELD_RECORD, holdRecord([holdRow('left-pad', RECENT)]).replace('## Held majors', '## Held Majors'));
    const cli = run(root, '--now', nowIso);
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain(`unreadable  ${HELD_RECORD}`);
  });

  it('(f) exits 0 when every obligation is current', () => {
    const cli = run(fixture(), '--now', nowIso);
    expect(cli.status).toBe(0);
    expect(cli.stdout).not.toMatch(/^(due|overdue|malformed|unregistered) /m);
  });

  it('(f) exits 1 when a review is due', () => {
    expect(run(fixture({ reviewDate: '2026-11-07' }), '--now', nowIso).status).toBe(1);
  });

  it('(g) writes nothing: the tree is identical before and after a run', () => {
    const root = fixture({ holdDate: '2026-02-30' });
    const snapshot = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          out.push(`${relative(root, path)} ${String(statSync(path).mtimeMs)}`);
          if (entry.isDirectory()) walk(path);
        }
      };
      walk(root);
      return out.sort();
    };
    const before = snapshot();
    expect(before.length).toBeGreaterThan(cadence.DATED_REVIEW_RECORDS.length);
    run(root, '--now', nowIso);
    expect(snapshot()).toEqual(before);
  });

  it.each([[['--now', 'garbage']], [['--now', '2026-02-30T00:00:00Z']], [['--now']], [['--bogus']]])(
    '(h) exits 2 on %j',
    (args) => {
      const cli = run(fixture(), ...args);
      expect(cli.status).toBe(2);
    }
  );

  it('(i) ends with the contract summary line, sorted by the instant each obligation fails', () => {
    const extraDocs = new Map([['docs/x.md', '<!-- zz-review-date: 2026-01-01 -->\n']]);
    const cli = run(fixture({ reviewDate: '2026-11-07', extraDocs }), '--now', nowIso);
    const lines = cli.stdout.trimEnd().split('\n');
    const total = cadence.DATED_REVIEW_RECORDS.length + 2;
    expect(lines.at(-1)).toBe(
      `review-due: ${String(total)} obligation(s) at ${nowIso}: ${String(total - 2)} current, 1 due, ` +
        '0 overdue, 0 malformed, 1 unregistered'
    );
    const instants = lines.slice(0, -1).map((line) => line.split('  ').at(1) ?? '');
    expect(instants.at(0)).toBe('2026-11-07T00:00:00.000Z');
    expect(instants.at(-1)).toBe('-');
    const dated = instants.filter((value) => value !== '-');
    expect(dated).toEqual([...dated].sort());
  });
});
