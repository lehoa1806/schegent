import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R4-F21 (feature 249; FR-010 to FR-012, R5 to R7) — how an npm audit report becomes findings.
 *
 * `normalizeReport` turns a version-2 report and the lockfile it was taken over into findings that
 * hold only the locations an advisory's range actually affects. This pins contract T1: identity,
 * grouping of paths, which nodes an advisory is attributed to, usage flags, dependents, merging,
 * and the bounds that reject an input instead of truncating it.
 *
 * Every case but the two bounds reads a fixture under `tests/fixtures/advisory-diff/capture/`. The
 * fixture declares its own expectation, and this file reads the declaration rather than restating
 * it. The report shapes in the fixtures are read from npm 11.17.0's source, not from an executed
 * audit. The over-bound inputs are generated here, not stored.
 *
 * Loaded dynamically for the same TS1479 reason `gate-distance.test.ts` records.
 */
async function loadCapture() {
  return import('../../../scripts/advisory-capture.mjs');
}

let capture: Awaited<ReturnType<typeof loadCapture>>;

beforeAll(async () => {
  capture = await loadCapture();
});

interface NormalizeFixture {
  readonly declares: {
    readonly description: string;
    readonly findings?: readonly Record<string, unknown>[];
    readonly rejected?: { readonly reason: string };
  };
  readonly report: unknown;
  readonly lockfile: unknown;
  readonly rootManifest: unknown;
}

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures', 'advisory-diff', 'capture');

function fixture(name: string): NormalizeFixture {
  return JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')) as NormalizeFixture;
}

/** Normalize a fixture, and assert what it declares: findings, or the reason it is rejected. */
function expectDeclared(name: string): readonly Record<string, unknown>[] {
  const fx = fixture(name);
  const result = capture.normalizeReport(fx.report, fx.lockfile, fx.rootManifest);
  if (fx.declares.rejected !== undefined) {
    expect(result.ok, `${name}: ${fx.declares.description}`).toBe(false);
    if (!result.ok) expect(result.reason, name).toBe(fx.declares.rejected.reason);
    return [];
  }
  expect(result.ok, `${name}: ${fx.declares.description}`).toBe(true);
  if (!result.ok) return [];
  expect(result.findings, name).toEqual(fx.declares.findings);
  return result.findings as unknown as readonly Record<string, unknown>[];
}

describe('normalizeReport: which findings a report holds (T1)', () => {
  it('reads an advisory object and a string in one via: the string creates no finding (FR-012)', () => {
    const findings = expectDeclared('normalize-via-object-and-string');
    expect(findings.map((f) => f['package'])).toEqual(['lib-b', 'lib-d']);
    // The string's package is a dependent of the vulnerable one, never a finding of its own.
    expect(findings.find((f) => f['package'] === 'lib-b')?.['dependents']).toEqual(['lib-a']);
  });

  it('takes the GHSA id from the url and the numeric source as its alias (R5)', () => {
    const finding = expectDeclared('normalize-ghsa-and-source').at(0);
    expect(finding?.['ids']).toEqual({ canonical: 'GHSA-gggg-hhhh-iiii', aliases: ['npm:6001'] });
  });

  it('falls back to npm:<source> as the canonical id when the url has no GHSA segment', () => {
    const finding = expectDeclared('normalize-no-ghsa-segment').at(0);
    expect(finding?.['ids']).toEqual({ canonical: 'npm:6002', aliases: [] });
  });

  it('rejects the report as malformed when an advisory carries neither id', () => {
    expectDeclared('normalize-neither-id');
  });

  it('makes one advisory at three nodes one finding with three locations (US1-5)', () => {
    const finding = expectDeclared('normalize-three-nodes').at(0);
    expect(finding?.['locations']).toHaveLength(3);
  });

  it('gives each of two advisories only the nodes its own range matches (R6)', () => {
    const findings = expectDeclared('normalize-two-advisories-two-versions');
    expect(findings).toHaveLength(2);
    for (const finding of findings) expect(finding['locations']).toHaveLength(1);
  });

  it('keeps a node whose range or version cannot be evaluated, noting it', () => {
    for (const name of ['normalize-unparseable-range', 'normalize-unparseable-version']) {
      const finding = expectDeclared(name).at(0);
      expect(finding?.['notes'], name).toEqual(['range-not-evaluated']);
      expect(finding?.['locations'], name).toHaveLength(1);
    }
  });

  it('keeps every node of a package whose advisory range matches none of them', () => {
    const finding = expectDeclared('normalize-range-matches-none').at(0);
    expect(finding?.['notes']).toEqual(['attributed-by-package']);
    expect(finding?.['locations']).toHaveLength(2);
  });

  it('derives direct and production per the lockfile flags and the root declarations (R7)', () => {
    const findings = expectDeclared('normalize-usage-flags');
    const flags = Object.fromEntries(
      findings.map((f) => [f['package'], [f['direct'], f['production']]])
    );
    expect(flags).toEqual({
      'lib-dev': [true, false],
      'lib-devopt': [false, false],
      'lib-nested': [false, true],
      'lib-opt': [true, true],
      'lib-prod': [true, true]
    });
  });

  it('records the transitive closure of effects as sorted dependents (FR-012)', () => {
    const finding = expectDeclared('normalize-effects-chain').at(0);
    expect(finding?.['dependents']).toEqual(['lib-y', 'lib-z']);
  });

  it('merges two advisories in one package whose identifier sets intersect', () => {
    const findings = expectDeclared('normalize-intersecting-ids');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.['notes']).toEqual(['merged-duplicate']);
  });

  it('keeps one advisory in two packages as two findings', () => {
    const findings = expectDeclared('normalize-one-advisory-two-packages');
    expect(findings.map((f) => f['package'])).toEqual(['lib-j', 'lib-k']);
  });

  it('rejects the report as malformed when a node is missing from the lockfile', () => {
    expectDeclared('normalize-missing-lockfile-node');
  });

  it('rejects an audit report version other than 2, and a lockfile version 1, as unsupported', () => {
    for (const name of [
      'normalize-report-version-1',
      'normalize-report-version-3',
      'normalize-lockfile-version-1'
    ]) {
      expectDeclared(name);
    }
  });
});

describe('normalizeReport: bounds reject, and never truncate (D12)', () => {
  const advisory = (index: number) => ({
    source: 100000 + index,
    name: `lib-${String(index)}`,
    dependency: `lib-${String(index)}`,
    title: 'Generated advisory',
    url: `https://example.test/advisories/${String(100000 + index)}`,
    severity: 'low',
    range: '<2.0.0'
  });

  it('rejects 10,001 findings as over-bound, naming the findings bound', () => {
    const count = 10001;
    const packages: Record<string, { version: string }> = {};
    const vulnerabilities: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      const name = `lib-${String(i)}`;
      packages[`node_modules/${name}`] = { version: '1.0.0' };
      vulnerabilities[name] = {
        name,
        severity: 'low',
        via: [advisory(i)],
        effects: [],
        nodes: [`node_modules/${name}`]
      };
    }
    const result = capture.normalizeReport(
      { auditReportVersion: 2, vulnerabilities },
      { lockfileVersion: 3, packages: { '': {}, ...packages } },
      {}
    );
    expect(result).toEqual({ ok: false, reason: 'over-bound', bound: 'findings' });
  });

  it('accepts exactly 10,000 findings: the bound is inclusive', () => {
    const count = 10000;
    const packages: Record<string, { version: string }> = {};
    const vulnerabilities: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      const name = `lib-${String(i)}`;
      packages[`node_modules/${name}`] = { version: '1.0.0' };
      vulnerabilities[name] = {
        name,
        severity: 'low',
        via: [advisory(i)],
        effects: [],
        nodes: [`node_modules/${name}`]
      };
    }
    const result = capture.normalizeReport(
      { auditReportVersion: 2, vulnerabilities },
      { lockfileVersion: 3, packages: { '': {}, ...packages } },
      {}
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.findings).toHaveLength(count);
  });

  it('rejects 1,001 locations in one finding as over-bound, naming locations-per-finding', () => {
    const count = 1001;
    const packages: Record<string, { version: string }> = {};
    const nodes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const location = `node_modules/host-${String(i)}/node_modules/lib-big`;
      packages[location] = { version: '1.0.0' };
      nodes.push(location);
    }
    const result = capture.normalizeReport(
      {
        auditReportVersion: 2,
        vulnerabilities: {
          'lib-big': { name: 'lib-big', severity: 'low', via: [advisory(1)], effects: [], nodes }
        }
      },
      { lockfileVersion: 3, packages: { '': {}, ...packages } },
      {}
    );
    expect(result).toEqual({ ok: false, reason: 'over-bound', bound: 'locations-per-finding' });
  });
});
