import { homedir, tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-015, FR-017 to FR-019, FR-026, SC-002, SC-007, K5 to K7, R13) — the
 * record a comparison writes and the report it prints.
 *
 * `buildRecord`, `serializeRecord` and `renderReport` are pure over a comparison result, so every
 * case here runs over a hand-built result. This pins contract T7: the same inputs give
 * byte-identical output, the order is the contract's whatever order the input came in, the first
 * four lines say whether the result is complete and the introduced and worsened counts, an
 * incomplete result states no bare total, no finding is collapsed, every string taken from an input
 * is escaped before it reaches a terminal, and the record holds no machine path or environment
 * value.
 *
 * Loaded dynamically for the same TS1479 reason `gate-distance.test.ts` records.
 */
async function loadReport() {
  return import('../../../scripts/advisory-report.mjs');
}

let report: Awaited<ReturnType<typeof loadReport>>;

beforeAll(async () => {
  report = await loadReport();
});

const BASE_COMMIT = '1'.repeat(40);
const CANDIDATE_COMMIT = '2'.repeat(40);
const EVALUATED_AT = '2026-10-30T09:30:00.000Z';
const META = {
  candidate: { commit: CANDIDATE_COMMIT },
  base: { commit: BASE_COMMIT, rule: 'merge-base', target: 'develop' },
  evaluatedAt: EVALUATED_AT
} as const;
const CLASS_ORDER = ['introduced', 'worsened', 'uncertain', 'pre-existing', 'resolved', 'not-determined'];

type Cls = (typeof CLASS_ORDER)[number];

interface Overrides {
  readonly title?: string;
  readonly canonical?: string;
  readonly reasons?: readonly { code: string; pairs?: readonly { location: string; version: string }[] }[];
  readonly sides?: readonly string[];
  readonly disposition?: { readonly verdict: string; readonly entries: readonly Record<string, unknown>[] };
}

function side(pkg: string) {
  return {
    locations: [{ location: `node_modules/${pkg}`, version: '1.0.0', direct: true, production: true }],
    direct: true,
    production: true
  };
}

/** A classified finding in the shape `compareTrees` returns (K3). */
function finding(cls: Cls, tree: string, pkg: string, overrides: Overrides = {}) {
  return {
    class: cls,
    ...(overrides.sides === undefined ? {} : { sides: overrides.sides }),
    tree,
    package: pkg,
    ids: { canonical: overrides.canonical ?? 'GHSA-aaaa-bbbb-cccc', aliases: [] },
    severity: {
      base: cls === 'introduced' ? null : 'moderate',
      candidate: cls === 'resolved' ? null : 'high'
    },
    base: cls === 'introduced' ? null : side(pkg),
    candidate: cls === 'resolved' ? null : side(pkg),
    reasons: overrides.reasons ?? [],
    notes: [],
    title: overrides.title ?? `Title of ${pkg}`,
    dependents: [],
    disposition: overrides.disposition ?? { verdict: 'not-recorded', entries: [] }
  };
}

function provenance(commit: string) {
  return {
    commit,
    objectFormat: 'sha1',
    manifest: { path: 'package.json', blob: 'a1'.repeat(20) },
    lockfile: { path: 'package-lock.json', blob: 'a2'.repeat(20) },
    tool: 'npm',
    toolVersion: '11.17.0',
    command: 'npm audit --json --offline=false --include=dev --include=optional --include=peer',
    registryHost: 'registry.example.test',
    observedAt: '2026-10-30T09:00:00.000Z',
    reportFormat: 'npm-audit-report-2',
    outcome: { status: 'succeeded' },
    limitations: ['Advisory data is the registry\'s at observedAt.']
  };
}

function totalsOf(findings: readonly { class: string }[]) {
  return Object.fromEntries(
    CLASS_ORDER.map((cls) => [cls, findings.filter((f) => f.class === cls).length])
  );
}

function completeTree(tree: string, findings: readonly ReturnType<typeof finding>[]) {
  return {
    tree,
    complete: true,
    reasons: [],
    base: provenance(BASE_COMMIT),
    candidate: provenance(CANDIDATE_COMMIT),
    totals: totalsOf(findings),
    findings
  };
}

function incompleteTree(tree: string, findings: readonly ReturnType<typeof finding>[]) {
  return {
    tree,
    complete: false,
    reasons: [{ code: 'stale', side: 'base', detail: 'older-than-budget' }],
    base: provenance(BASE_COMMIT),
    candidate: provenance(CANDIDATE_COMMIT),
    totals: null,
    findings
  };
}

function sumTotals(trees: readonly { totals: Record<string, number> | null }[]) {
  return Object.fromEntries(
    CLASS_ORDER.map((cls) => [cls, trees.reduce((sum, t) => sum + (t.totals?.[cls] ?? 0), 0)])
  );
}

/** A complete result: two introduced, one worsened and a pre-existing, over both trees. */
function completeResult(order: 'forward' | 'reversed' = 'forward') {
  const root = [
    finding('introduced', 'root', 'lib-b', { canonical: 'GHSA-bbbb-bbbb-bbbb' }),
    finding('introduced', 'root', 'lib-a', { canonical: 'GHSA-aaaa-aaaa-aaaa' }),
    finding('worsened', 'root', 'lib-c', { reasons: [{ code: 'newly-direct' }] }),
    finding('pre-existing', 'root', 'lib-d')
  ];
  const webview = [
    finding('introduced', 'webview-ui', 'lib-w'),
    finding('resolved', 'webview-ui', 'lib-x')
  ];
  const trees = [
    completeTree('root', order === 'forward' ? root : [...root].reverse()),
    completeTree('webview-ui', order === 'forward' ? webview : [...webview].reverse())
  ];
  return { complete: true, reasons: [], totals: sumTotals(trees), trees };
}

/** An incomplete result: `root` is complete and `webview-ui` is stale. */
function incompleteResult() {
  const root = [finding('introduced', 'root', 'lib-a')];
  const webview = [finding('not-determined', 'webview-ui', 'lib-w', { sides: ['base', 'candidate'] })];
  return {
    complete: false,
    reasons: [{ tree: 'webview-ui', code: 'stale', side: 'base', detail: 'older-than-budget' }],
    totals: null,
    trees: [completeTree('root', root), incompleteTree('webview-ui', webview)]
  };
}

function lines(text: string): string[] {
  return text.split('\n');
}

describe('the record (K5)', () => {
  it('is report-only and version 1, with the contract keys in order', () => {
    const record = report.buildRecord(completeResult(), META);
    expect(Object.keys(record)).toEqual([
      'recordVersion',
      'mode',
      'candidate',
      'base',
      'evaluatedAt',
      'budgets',
      'complete',
      'reasons',
      'totals',
      'trees',
      'dispositions',
      'statements',
      'limitations'
    ]);
    expect(record.recordVersion).toBe(1);
    expect(record.mode).toBe('report-only');
    expect(record.budgets).toEqual({ pairingMinutes: 60, freshnessHours: 24 });
    expect(record.dispositions).toEqual({ state: 'not-supplied' });
    expect(record.candidate).toEqual({ commit: CANDIDATE_COMMIT });
    expect(record.base).toEqual({ commit: BASE_COMMIT, rule: 'merge-base', target: 'develop' });
  });

  it('carries the three fixed statements and two fixed limitations, verbatim (FR-019)', () => {
    const record = report.buildRecord(completeResult(), META);
    expect(record.statements).toEqual([
      'Report-only: this comparison changes no audit, threshold, lockfile, disposition or gate result.',
      'The absolute audit (npm run security:audit) is unaffected; a failing absolute audit still fails.',
      'This comparison is neither a waiver nor permission to integrate a candidate whose checks are red.'
    ]);
    expect(record.limitations).toEqual([
      'A lockfile digest is a git blob id: it identifies content and does not authenticate a capture.',
      'A comparison does not establish present exploitability or current registry advisory counts.'
    ]);
  });

  it('serializes as two-space JSON with a trailing newline', () => {
    const record = report.buildRecord(completeResult(), META);
    expect(report.serializeRecord(record)).toBe(`${JSON.stringify(record, null, 2)}\n`);
  });

  it('is byte-identical across two runs over the same inputs (FR-017, SC-002)', () => {
    const first = report.buildRecord(completeResult(), META);
    const second = report.buildRecord(completeResult(), META);
    expect(report.serializeRecord(first)).toBe(report.serializeRecord(second));
    expect(report.renderReport(first)).toBe(report.renderReport(second));
  });

  it('orders findings by class, package and id whatever order they arrive in (K6)', () => {
    const forward = report.buildRecord(completeResult('forward'), META);
    const reversed = report.buildRecord(completeResult('reversed'), META);
    expect(report.serializeRecord(reversed)).toBe(report.serializeRecord(forward));
    const root = forward.trees.find((t) => t.tree === 'root');
    expect(root?.findings.map((f) => `${f.class}:${f.package}`)).toEqual([
      'introduced:lib-a',
      'introduced:lib-b',
      'worsened:lib-c',
      'pre-existing:lib-d'
    ]);
  });

  it('keeps the same package apart by canonical id, compared by code unit', () => {
    const result = completeResult();
    const root = [
      finding('introduced', 'root', 'lib-a', { canonical: 'npm:200' }),
      finding('introduced', 'root', 'lib-a', { canonical: 'GHSA-zzzz-zzzz-zzzz' }),
      finding('introduced', 'root', 'lib-a', { canonical: 'GHSA-aaaa-aaaa-aaaa' })
    ];
    const record = report.buildRecord(
      { ...result, trees: [completeTree('root', root), result.trees[1] as never] },
      META
    );
    expect(record.trees[0]?.findings.map((f) => f.ids.canonical)).toEqual([
      'GHSA-aaaa-aaaa-aaaa',
      'GHSA-zzzz-zzzz-zzzz',
      'npm:200'
    ]);
  });

  it('holds no absolute path, temp root, home directory, working directory or environment value (FR-026)', () => {
    const secret = 'env-value-5d1c9e';
    process.env['ADVISORY_REPORT_TEST_VALUE'] = secret;
    try {
      const text = report.serializeRecord(report.buildRecord(completeResult(), META));
      for (const value of [tmpdir(), homedir(), process.cwd(), secret]) {
        expect(value.length).toBeGreaterThan(1);
        expect(text, `the record must not contain ${value === secret ? 'the env value' : 'a machine path'}`).not.toContain(
          value
        );
      }
    } finally {
      delete process.env['ADVISORY_REPORT_TEST_VALUE'];
    }
  });
});

describe('the first four lines (K7, SC-007)', () => {
  it('states COMPLETE with numeric counts for a complete result', () => {
    const text = report.renderReport(report.buildRecord(completeResult(), META));
    const [one, two, three, four] = lines(text);
    expect(one).toBe('Advisory comparison: COMPLETE');
    expect(two).toBe('Introduced: 3   Worsened: 1');
    expect(three).toBe(
      'Report-only. The absolute audit (npm run security:audit) is unaffected; this is not a waiver or permission to integrate.'
    );
    expect(four).toBe(
      `Candidate 2222222 vs base 1111111 (merge-base with develop), evaluated ${EVALUATED_AT}`
    );
  });

  it('states INCOMPLETE with its reason count, and not determined, for an incomplete result', () => {
    const text = report.renderReport(report.buildRecord(incompleteResult(), META));
    const [one, two, three] = lines(text);
    expect(one).toBe('Advisory comparison: INCOMPLETE (1 reason)');
    expect(two).toBe('Introduced: not determined   Worsened: not determined');
    expect(three).toContain('Report-only.');
    expect(lines(text)[1]).not.toMatch(/\d/);
  });

  it('counts the reasons in the first line, plural for more than one', () => {
    const result = incompleteResult();
    const record = report.buildRecord(
      {
        ...result,
        reasons: [
          ...result.reasons,
          { tree: 'root', code: 'missing-candidate', side: 'candidate' },
          { tree: null, code: 'base-not-selected', detail: 'target-missing' }
        ]
      },
      META
    );
    expect(lines(report.renderReport(record))[0]).toBe('Advisory comparison: INCOMPLETE (3 reasons)');
  });

  it('says so when the base is explicit, or was not selected', () => {
    const explicit = report.buildRecord(completeResult(), {
      ...META,
      base: { commit: BASE_COMMIT, rule: 'explicit', target: null }
    });
    expect(lines(report.renderReport(explicit))[3]).toContain('(explicit base)');
    const none = report.buildRecord(incompleteResult(), {
      ...META,
      base: { commit: null, rule: 'merge-base', target: 'develop' }
    });
    expect(lines(report.renderReport(none))[3]).toContain('base not selected');
  });

  it('names the report-only statement and the absolute audit in line 3 (FR-019)', () => {
    for (const result of [completeResult(), incompleteResult()]) {
      const text = report.renderReport(report.buildRecord(result, META));
      expect(lines(text)[2]).toContain('npm run security:audit');
      expect(lines(text)[2]).toMatch(/^Report-only\./);
    }
  });
});

describe('the body of the report (K7, FR-016, FR-018)', () => {
  it('heads each class section with its count and lists every finding, in K6 order', () => {
    const text = report.renderReport(report.buildRecord(completeResult('reversed'), META));
    const headings = lines(text).filter((l) => /^(Introduced|Worsened|Uncertain|Pre-existing|Resolved|Not determined) \(/.test(l));
    expect(headings).toEqual([
      'Introduced (3)',
      'Worsened (1)',
      'Uncertain (0)',
      'Pre-existing (1)',
      'Resolved (1)',
      'Not determined (0)'
    ]);
    const order = ['lib-a', 'lib-b', 'lib-w', 'lib-c', 'lib-d', 'lib-x'].map((pkg) => text.indexOf(`] ${pkg} `));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('states no bare count when one tree is incomplete: each count names the tree it covers (FR-016, D8)', () => {
    const text = report.renderReport(report.buildRecord(incompleteResult(), META));
    expect(text).toMatch(/^Introduced \(root: 1, webview-ui: not determined\)$/m);
    expect(text).toMatch(/^Worsened \(root: 0, webview-ui: not determined\)$/m);
    expect(text).not.toMatch(/^(?:Introduced|Worsened|Uncertain|Pre-existing|Resolved) \(\d+\)$/m);
  });

  it('lists what it could read of an incomplete tree under not determined, with its sides', () => {
    const text = report.renderReport(report.buildRecord(incompleteResult(), META));
    expect(text).toMatch(/^Not determined \(root: 0, webview-ui: 1\)$/m);
    expect(text).toContain('] lib-w ');
    expect(text).toMatch(/sides: base, candidate/);
  });

  it('names each reason with its tree, side, code and a sentence', () => {
    const text = report.renderReport(report.buildRecord(incompleteResult(), META));
    expect(text).toMatch(/webview-ui.*base.*stale.*older-than-budget/);
  });

  it('lists every pre-existing and uncertain finding, collapsing none (FR-018, SC-004)', () => {
    const many = [
      ...Array.from({ length: 12 }, (_, i) => finding('pre-existing', 'root', `old-${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 5 }, (_, i) =>
        finding('uncertain', 'root', `maybe-${String(i)}`, { reasons: [{ code: 'disclosed-between-captures' }] })
      )
    ];
    const result = completeResult();
    const trees = [completeTree('root', many), result.trees[1] as never];
    const text = report.renderReport(
      report.buildRecord({ complete: true, reasons: [], totals: sumTotals(trees), trees }, META)
    );
    for (const finding of many) expect(text).toContain(`] ${finding.package} `);
    expect(text).toMatch(/^Pre-existing \(12\)$/m);
    expect(text).toMatch(/^Uncertain \(5\)$/m);
    expect(text).not.toMatch(/\band \d+ more\b|\.\.\./);
  });

  it('shows each finding with its severity per side, location counts and every reason with its pairs', () => {
    const worse = finding('worsened', 'root', 'lib-p', {
      reasons: [
        { code: 'new-pair', pairs: [{ location: 'node_modules/x/node_modules/lib-p', version: '1.0.1' }] },
        { code: 'severity-raised' }
      ]
    });
    const result = completeResult();
    const trees = [completeTree('root', [worse]), result.trees[1] as never];
    const text = report.renderReport(
      report.buildRecord({ complete: true, reasons: [], totals: sumTotals(trees), trees }, META)
    );
    expect(text).toContain('severity: base moderate, candidate high');
    expect(text).toContain('locations: base 1, candidate 1');
    expect(text).toContain('new-pair');
    expect(text).toContain('node_modules/x/node_modules/lib-p@1.0.1');
    expect(text).toContain('severity-raised');
  });

  it('closes with the limitations, and names provenance for each tree and side', () => {
    const text = report.renderReport(report.buildRecord(completeResult(), META));
    expect(text).toContain('A comparison does not establish present exploitability');
    expect(text).toMatch(/root base: commit 1111111/);
    expect(text).toMatch(/webview-ui candidate: commit 2222222/);
    expect(text).toContain('registry.example.test');
    expect(text.endsWith('\n')).toBe(true);
  });
});

describe('escaping (R13)', () => {
  it('replaces C0, DEL and C1 controls with \\xNN', () => {
    expect(report.escapeForTerminal('a\x1b[31mb\x07c\x7fd\x9be')).toBe('a\\x1b[31mb\\x07c\\x7fd\\x9be');
    expect(report.escapeForTerminal('line\nbreak\ttab')).toBe('line\\x0abreak\\x09tab');
  });

  it('leaves printable text, including non-ASCII, unchanged', () => {
    expect(report.escapeForTerminal('plain text - é - 日本語 - ~')).toBe('plain text - é - 日本語 - ~');
  });

  it('prints a title holding ESC, BEL, DEL and a C1 control as visible escapes, never raw', () => {
    const title = 'Evil\x1b]0;owned\x07 title\x7f with \x9b31m';
    const result = completeResult();
    const root = [finding('introduced', 'root', 'lib-e', { title })];
    const trees = [completeTree('root', root), result.trees[1] as never];
    const text = report.renderReport(
      report.buildRecord({ complete: true, reasons: [], totals: sumTotals(trees), trees }, META)
    );
    expect(text).toContain('\\x1b]0;owned\\x07 title\\x7f with \\x9b31m');
    // Property escapes, not a \x00-\x1f class: no raw control character in the source, no no-control-regex.
    expect(text.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  });

  it('escapes the package name and the id as well as the title', () => {
    const result = completeResult();
    const root = [finding('introduced', 'root', 'lib\x1b-f', { canonical: 'npm:1\x07' })];
    const trees = [completeTree('root', root), result.trees[1] as never];
    const text = report.renderReport(
      report.buildRecord({ complete: true, reasons: [], totals: sumTotals(trees), trees }, META)
    );
    expect(text).toContain('lib\\x1b-f');
    expect(text).toContain('npm:1\\x07');
  });

  it('does not use ANSI colour in the report', () => {
    const text = report.renderReport(report.buildRecord(completeResult(), META));
    expect(text).not.toContain('\x1b');
  });
});

describe('dispositions in the report (K7, DL4, SC-004)', () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    advisory: 'GHSA-aaaa-bbbb-cccc',
    status: 'accepted',
    owner: 'owner-a',
    decidedOn: '2026-10-01',
    expiresOn: '2027-01-01',
    result: 'covers',
    ...overrides
  });

  function reportWith(
    disposition: { verdict: string; entries: Record<string, unknown>[] },
    state?: { state: 'not-supplied' | 'read' | 'unusable'; defect?: string }
  ): string {
    const result = completeResult();
    const root = [finding('pre-existing', 'root', 'lib-d', { disposition })];
    const trees = [completeTree('root', root), result.trees[1] as never];
    const record = report.buildRecord(
      { complete: true, reasons: [], totals: sumTotals(trees), trees },
      state === undefined ? META : { ...META, dispositions: state }
    );
    return report.renderReport(record);
  }

  it('prints each related entry with its status, owner, decision date and expiry', () => {
    const text = reportWith({ verdict: 'covers', entries: [entry()] }, { state: 'read' });
    expect(text).toContain('disposition: covers');
    expect(text).toContain('entry: accepted, owner owner-a, decided 2026-10-01, expires 2027-01-01');
  });

  it('escapes an owner holding a control character: ESC prints as \\x1b', () => {
    const text = reportWith({ verdict: 'covers', entries: [entry({ owner: 'owner\x1b[31m-a' })] }, { state: 'read' });
    expect(text).toContain('owner owner\\x1b[31m-a');
    expect(text).not.toContain('\x1b');
  });

  it('prints an unusable list with its defect, and says nothing of a list that was not supplied', () => {
    const unusable = reportWith({ verdict: 'unknown', entries: [] }, { state: 'unusable', defect: 'malformed' });
    expect(unusable).toMatch(/^Disposition list: unusable \(malformed\)$/m);
    expect(unusable).toContain('disposition: unknown');
    const none = reportWith({ verdict: 'not-recorded', entries: [] });
    expect(none).not.toContain('Disposition list');
    const read = reportWith({ verdict: 'covers', entries: [entry()] }, { state: 'read' });
    expect(read).toMatch(/^Disposition list: read$/m);
  });

  it('never prints an expired or out-of-scope entry as approved or covering (SC-004)', () => {
    const text = reportWith(
      {
        verdict: 'does-not-cover',
        entries: [
          entry({ result: 'expired', expiresOn: '2026-10-01' }),
          entry({ result: 'does-not-cover', mismatch: { reason: 'other-tree' } }),
          entry({ result: 'does-not-cover', mismatch: { reason: 'range-excludes', versions: ['1.0.0', '1.0.1'] } })
        ]
      },
      { state: 'read' }
    );
    const entryLines = text.split('\n').filter((line) => line.includes('entry: '));
    expect(entryLines).toHaveLength(3);
    expect(entryLines[0]).toMatch(/- expired$/);
    expect(entryLines[1]).toMatch(/- does-not-cover \(other-tree\)$/);
    expect(entryLines[2]).toMatch(/- does-not-cover \(range-excludes 1\.0\.0, 1\.0\.1\)$/);
    for (const line of entryLines) expect(line).not.toMatch(/\bcovers\b|approved/);
    expect(text).not.toContain('approved');
  });

  it('prints the same report for a finding with no entries as it does with no list (TA4)', () => {
    const withState = reportWith({ verdict: 'not-recorded', entries: [] }, { state: 'not-supplied' });
    const without = reportWith({ verdict: 'not-recorded', entries: [] });
    expect(withState).toBe(without);
  });
});
