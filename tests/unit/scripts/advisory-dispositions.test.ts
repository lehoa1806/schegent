import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-020 to FR-022, SC-004, DL1 to DL4) — each finding shows what a
 * disposition list says about it, and the list never moves a finding.
 *
 * `parseDispositionList` reads the narrow version-1 contract this feature asks the dispositions
 * owner to adopt, and `applyDispositions` attaches to each classified finding a verdict and every
 * related entry with its own coverage result. This pins contract T6: a valid entry covers, an
 * expired or out-of-scope one never reads as approved, a list that cannot be used makes every verdict
 * unknown and says why, and, above all, nothing a list says changes a class, a total, a reason or
 * the completeness of the comparison.
 *
 * Each list case reads a fixture under `tests/fixtures/advisory-diff/dispositions/` that declares its
 * own expectation. The over-bound lists are generated here, not stored.
 *
 * Loaded dynamically for the same TS1479 reason `gate-distance.test.ts` records.
 */
async function loadDispositions() {
  return import('../../../scripts/advisory-dispositions.mjs');
}
async function loadReport() {
  return import('../../../scripts/advisory-report.mjs');
}

let dispositions: Awaited<ReturnType<typeof loadDispositions>>;
let report: Awaited<ReturnType<typeof loadReport>>;

beforeAll(async () => {
  dispositions = await loadDispositions();
  report = await loadReport();
});

const EVALUATED_AT = '2026-10-30T09:30:00.000Z';
const MIB = 1024 * 1024;

interface DispositionFixture {
  readonly declares: {
    readonly description: string;
    readonly state: 'read' | 'unusable';
    readonly defect?: string;
    readonly verdict?: string;
    readonly entries?: readonly Record<string, unknown>[];
  };
  readonly list?: unknown;
  readonly text?: string;
}

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures', 'advisory-diff', 'dispositions');

function fixture(name: string): DispositionFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as DispositionFixture;
}

/** The text a list file would hold. */
function textOf(fx: DispositionFixture): string {
  return fx.text ?? JSON.stringify(fx.list);
}

function side(versions: readonly string[]) {
  return {
    locations: versions.map((version, index) => ({
      location: index === 0 ? 'node_modules/lib-a' : `node_modules/host-${String(index)}/node_modules/lib-a`,
      version,
      direct: index === 0,
      production: true
    })),
    direct: true,
    production: true
  };
}

/** A classified finding: lib-a, pre-existing, installed at 1.0.0 and 1.0.1 on the candidate. */
function finding(overrides: Record<string, unknown> = {}) {
  return {
    class: 'pre-existing',
    tree: 'root',
    package: 'lib-a',
    ids: { canonical: 'GHSA-ab12-cd34-ef56', aliases: ['npm:5555'] },
    severity: { base: 'moderate', candidate: 'moderate' },
    base: side(['1.0.0']),
    candidate: side(['1.0.0', '1.0.1']),
    reasons: [],
    notes: [],
    title: 'Fixture disposition advisory',
    dependents: [],
    disposition: { verdict: 'not-recorded', entries: [] },
    ...overrides
  };
}

function resultOf(findings: readonly ReturnType<typeof finding>[]) {
  const totals = {
    introduced: findings.filter((f) => f.class === 'introduced').length,
    worsened: 0,
    uncertain: 0,
    'pre-existing': findings.filter((f) => f.class === 'pre-existing').length,
    resolved: findings.filter((f) => f.class === 'resolved').length,
    'not-determined': 0
  };
  const provenance = {
    commit: '2'.repeat(40),
    objectFormat: 'sha1',
    manifest: { path: 'package.json', blob: 'a1'.repeat(20) },
    lockfile: { path: 'package-lock.json', blob: 'a2'.repeat(20) },
    tool: 'npm',
    toolVersion: '11.17.0',
    command: 'npm audit',
    registryHost: 'registry.example.test',
    observedAt: '2026-10-30T09:00:00.000Z',
    reportFormat: 'npm-audit-report-2',
    outcome: { status: 'succeeded' },
    limitations: ['Advisory data is the registry\'s at observedAt.']
  };
  return {
    complete: true,
    reasons: [],
    totals,
    trees: [{ tree: 'root', complete: true, reasons: [], base: provenance, candidate: provenance, totals, findings }]
  };
}

const META = {
  candidate: { commit: '2'.repeat(40) },
  base: { commit: '1'.repeat(40), rule: 'merge-base', target: 'develop' },
  evaluatedAt: EVALUATED_AT
} as const;

function rootFindings(result: ReturnType<typeof resultOf>) {
  return result.trees[0]?.findings ?? [];
}

/** The first root finding, or the failure that says the result holds none. */
function firstRootFinding(result: ReturnType<typeof resultOf>) {
  const found = rootFindings(result).at(0);
  if (found === undefined) throw new Error('the result holds no root finding');
  return found;
}

/** Parse a fixture's list and apply it to a result holding one lib-a finding. */
function applyFixture(name: string) {
  const fx = fixture(name);
  const list = dispositions.parseDispositionList(textOf(fx));
  const result = resultOf([finding()]);
  const applied = dispositions.applyDispositions(result, list, EVALUATED_AT);
  return { fx, list, applied };
}

const READ_FIXTURES = [
  'valid-accepted',
  'expired-before-evaluation',
  'expiry-today',
  'expiry-tomorrow',
  'other-tree',
  'range-excludes',
  'range-excludes-one-version',
  'alias-match',
  'unrelated-entries',
  'several-entries',
  'owner-with-escape'
] as const;

const UNUSABLE_FIXTURES = [
  'unsupported-version',
  'malformed-shape',
  'malformed-missing-field',
  'malformed-not-json',
  'invalid-range',
  'invalid-date',
  'invalid-status'
] as const;

describe('no list is named (DL1, US4-1)', () => {
  it('gives every finding not-recorded and no entries, and changes nothing else', () => {
    const result = resultOf([finding(), finding({ package: 'lib-b', ids: { canonical: 'GHSA-ab12-cd34-ef99', aliases: [] } })]);
    const applied = dispositions.applyDispositions(result, { state: 'not-supplied' }, EVALUATED_AT);
    expect(applied).toEqual(result);
    for (const f of rootFindings(applied as ReturnType<typeof resultOf>)) {
      expect(f.disposition).toEqual({ verdict: 'not-recorded', entries: [] });
    }
  });
});

describe('a readable list gives each finding a verdict and every related entry (FR-020, FR-021)', () => {
  for (const name of READ_FIXTURES) {
    it(`${name}: reads as declared`, () => {
      const { fx, list, applied } = applyFixture(name);
      expect(list.state, fx.declares.description).toBe('read');
      const found = firstRootFinding(applied as ReturnType<typeof resultOf>);
      expect(found.disposition.verdict, fx.declares.description).toBe(fx.declares.verdict);
      expect(found.disposition.entries, fx.declares.description).toHaveLength(fx.declares.entries?.length ?? -1);
      (fx.declares.entries ?? []).forEach((declared, index) => {
        expect(found.disposition.entries[index], `${name} entry ${String(index)}`).toMatchObject(declared);
      });
    });
  }

  it('a valid accepted entry covers, and the class, totals and completeness are unchanged (US4-4)', () => {
    const introduced = resultOf([finding({ class: 'introduced', base: null, severity: { base: null, candidate: 'moderate' } })]);
    const list = dispositions.parseDispositionList(textOf(fixture('valid-accepted')));
    const applied = dispositions.applyDispositions(introduced, list, EVALUATED_AT) as ReturnType<typeof resultOf>;
    const found = firstRootFinding(applied);
    expect(found.disposition.verdict).toBe('covers');
    // A covered finding is still listed in its own class, and still counted there.
    expect(found.class).toBe('introduced');
    expect(applied.totals).toEqual(introduced.totals);
    expect(applied.complete).toBe(true);
  });

  it('an expired entry is expired and never shown as covering (US4-2, SC-004)', () => {
    const { applied } = applyFixture('expired-before-evaluation');
    const found = firstRootFinding(applied as ReturnType<typeof resultOf>);
    expect(found.disposition.verdict).toBe('expired');
    expect(found.disposition.entries.some((entry) => entry['result'] === 'covers')).toBe(false);
  });

  it('an expiry date ends at 00:00:00Z that day: an entry expiring today has expired, one expiring tomorrow has not', () => {
    expect(rootFindings(applyFixture('expiry-today').applied as ReturnType<typeof resultOf>)[0]?.disposition.verdict).toBe('expired');
    expect(rootFindings(applyFixture('expiry-tomorrow').applied as ReturnType<typeof resultOf>)[0]?.disposition.verdict).toBe('covers');
  });

  it('another tree, and a range that excludes an installed version, each do not cover, with the mismatch named (US4-3, SC-004)', () => {
    for (const name of ['other-tree', 'range-excludes', 'range-excludes-one-version']) {
      const found = firstRootFinding(applyFixture(name).applied as ReturnType<typeof resultOf>);
      expect(found.disposition.verdict, name).toBe('does-not-cover');
      expect(found.disposition.entries.at(0)?.['mismatch'], name).toBeDefined();
    }
  });

  it('tests the base side\'s versions when the finding is no longer present on the candidate', () => {
    const base = finding({ class: 'resolved', candidate: null, severity: { base: 'moderate', candidate: null } });
    const list = dispositions.parseDispositionList(textOf(fixture('valid-accepted')));
    const applied = dispositions.applyDispositions(resultOf([base]), list, EVALUATED_AT);
    expect(rootFindings(applied as ReturnType<typeof resultOf>)[0]?.disposition.verdict).toBe('covers');
  });

  it('keeps an owner holding a control character verbatim, for the report to escape', () => {
    const { applied } = applyFixture('owner-with-escape');
    const found = firstRootFinding(applied as ReturnType<typeof resultOf>);
    expect(found.disposition.entries.at(0)?.['owner']).toBe('owner\u001b[31m-a');
  });

  it('lists related entries in a fixed order, so the record is deterministic', () => {
    const first = applyFixture('several-entries').applied;
    const second = applyFixture('several-entries').applied;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('a list that cannot be used makes every verdict unknown, and names its defect (DL1, US4-5)', () => {
  for (const name of UNUSABLE_FIXTURES) {
    it(`${name}: is unusable, as declared`, () => {
      const { fx, list, applied } = applyFixture(name);
      expect(list, fx.declares.description).toEqual({ state: 'unusable', defect: fx.declares.defect });
      for (const found of rootFindings(applied as ReturnType<typeof resultOf>)) {
        expect(found.disposition, name).toEqual({ verdict: 'unknown', entries: [] });
      }
    });
  }

  it('is unusable, over-bound, when the list holds 10,001 entries, and usable at 10,000', () => {
    const entry = (fixture('valid-accepted').list as { dispositions: unknown[] }).dispositions[0];
    const text = (count: number) =>
      JSON.stringify({ dispositionListVersion: 1, dispositions: Array.from({ length: count }, () => entry) });
    expect(dispositions.parseDispositionList(text(10001))).toEqual({ state: 'unusable', defect: 'over-bound' });
    expect(dispositions.parseDispositionList(text(10000)).state).toBe('read');
  });

  it('is unusable, over-bound, when the text is over 8 MiB', () => {
    expect(dispositions.parseDispositionList('x'.repeat(8 * MIB + 1))).toEqual({ state: 'unusable', defect: 'over-bound' });
  });

  it('takes the unreadable defect from the caller, for a path that is missing or cannot be read', () => {
    const applied = dispositions.applyDispositions(resultOf([finding()]), { state: 'unusable', defect: 'unreadable' }, EVALUATED_AT);
    expect(rootFindings(applied as ReturnType<typeof resultOf>)[0]?.disposition).toEqual({ verdict: 'unknown', entries: [] });
  });
});

describe('a disposition never changes the comparison (FR-022, US4-5, DL4)', () => {
  const stripDispositions = (record: unknown): unknown => {
    const copy = JSON.parse(JSON.stringify(record)) as {
      dispositions?: unknown;
      trees: { findings: { disposition?: unknown }[] }[];
    };
    delete copy.dispositions;
    for (const tree of copy.trees) for (const f of tree.findings) delete f.disposition;
    return copy;
  };

  // lib-a, which the fixture lists cover, is introduced: a disposition that moved it would change its class.
  const mixed = () =>
    resultOf([
      finding({ class: 'introduced', base: null, severity: { base: null, candidate: 'moderate' } }),
      finding({ package: 'lib-n', ids: { canonical: 'GHSA-ab12-cd34-ef77', aliases: [] }, severity: { base: 'high', candidate: 'high' } })
    ]);

  it('gives a record equal to the no-list record once the disposition fields are removed, for every list', () => {
    const noList = report.serializeRecord(stripDispositions(report.buildRecord(mixed(), META)) as never);
    for (const name of [...READ_FIXTURES, ...UNUSABLE_FIXTURES]) {
      const fx = fixture(name);
      const list = dispositions.parseDispositionList(textOf(fx));
      const applied = dispositions.applyDispositions(mixed(), list, EVALUATED_AT);
      const record = report.buildRecord(applied, {
        ...META,
        dispositions: list.state === 'read' ? { state: 'read' } : { state: 'unusable', defect: list.defect }
      });
      expect(report.serializeRecord(stripDispositions(record) as never), name).toBe(noList);
    }
  });

  it('keeps every class, total, reason and the completeness exactly as they were', () => {
    for (const name of [...READ_FIXTURES, ...UNUSABLE_FIXTURES]) {
      const before = mixed();
      const list = dispositions.parseDispositionList(textOf(fixture(name)));
      const after = dispositions.applyDispositions(before, list, EVALUATED_AT) as ReturnType<typeof resultOf>;
      expect(after.complete, name).toBe(before.complete);
      expect(after.reasons, name).toEqual(before.reasons);
      expect(after.totals, name).toEqual(before.totals);
      expect(rootFindings(after).map((f) => f.class), name).toEqual(rootFindings(before).map((f) => f.class));
    }
  });

  it('does not mutate the result it is given', () => {
    const before = mixed();
    const snapshot = JSON.stringify(before);
    dispositions.applyDispositions(before, dispositions.parseDispositionList(textOf(fixture('valid-accepted'))), EVALUATED_AT);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
