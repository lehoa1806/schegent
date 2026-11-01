import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-014 to FR-020, SC-005; contract AR1 to AR7, data-model sections 6 and 7; test T7)
 * -- advisory evidence at release preparation.
 *
 * WHAT IT PINS. A release is prepared against two feature-249 captures, one per tree, and a tracked
 * disposition list. The module judges them and refuses for exactly seven reasons, in a fixed
 * order, naming the tree and the failing value. The boundaries are the point: a capture exactly
 * seven days old is accepted and one millisecond older is not, a capture from the future is
 * refused so clock skew cannot make one fresh, and a lockfile that is not byte-identical to the
 * one HEAD holds is refused whatever the capture's age. An uncovered finding is REPORTED with its
 * verdict and is not a refusal (research R14): a fourth condition would be a new requirement.
 *
 * The module is driven with file contents and an injected clock only. It has no filesystem seam,
 * no spawn seam and no network seam, and the last case reads its own source to prove it.
 * Loaded dynamically for the same TS1479 reason its siblings record.
 */
async function loadAdvisory() {
  return import('../../../scripts/release-advisory.mjs');
}
async function loadDispositions() {
  return import('../../../scripts/advisory-dispositions.mjs');
}

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const ISO = (ms: number) => new Date(ms).toISOString();
const FRESH = ISO(NOW - DAY_MS);
const BLOB = { root: 'a'.repeat(40), 'webview-ui': 'b'.repeat(40) } as const;
const LOCKFILE = { root: 'package-lock.json', 'webview-ui': 'webview-ui/package-lock.json' } as const;

type Tree = 'root' | 'webview-ui';

type Finding = {
  package: string;
  ids: { canonical: string; aliases: string[] };
  severity: string;
  range: string;
  title: string;
  url: string;
  locations: Array<{ location: string; version: string; direct: boolean; production: boolean }>;
  direct: boolean;
  production: boolean;
  dependents: string[];
  notes: string[];
};

function finding(over: Partial<Finding> = {}): Finding {
  return {
    package: 'left-pad',
    ids: { canonical: 'GHSA-aaaa-bbbb-cccc', aliases: [] },
    severity: 'moderate',
    range: '<2.0.0',
    title: 'A title',
    url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    locations: [{ location: 'node_modules/left-pad', version: '1.0.0', direct: true, production: false }],
    direct: true,
    production: false,
    dependents: [],
    notes: [],
    ...over
  };
}

function captureObject(tree: Tree, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    captureVersion: 1,
    tree,
    ecosystem: 'npm',
    commit: 'f'.repeat(40),
    objectFormat: 'sha1',
    manifest: { path: tree === 'root' ? 'package.json' : 'webview-ui/package.json', blob: 'c'.repeat(40) },
    lockfile: { path: LOCKFILE[tree], blob: BLOB[tree] },
    tool: 'npm',
    toolVersion: '11.17.0',
    command: 'npm audit --json',
    registryHost: 'registry.npmjs.org',
    observedAt: FRESH,
    reportFormat: 'npm-audit-report-2',
    outcome: { status: 'succeeded' },
    limitations: ['Advisory data is the registry\'s at observedAt.'],
    findings: [],
    ...over
  };
}

const text = (value: unknown) => JSON.stringify(value);

const EMPTY_LIST = text({ dispositionListVersion: 1, dispositions: [] });

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    advisory: 'GHSA-aaaa-bbbb-cccc',
    ecosystem: 'npm',
    package: 'left-pad',
    tree: 'root',
    range: '<2.0.0',
    status: 'accepted',
    owner: 'maintainer',
    decidedOn: '2026-10-01',
    expiresOn: '2026-12-31',
    rationale: 'Build-only, never bundled.',
    ...over
  };
}

const listOf = (...entries: Array<Record<string, unknown>>) =>
  text({ dispositionListVersion: 1, dispositions: entries });

function inputs(over: Record<string, unknown> = {}) {
  return {
    captures: {
      root: text(captureObject('root')),
      'webview-ui': text(captureObject('webview-ui'))
    } as Record<string, string | undefined>,
    lockBlobs: { ...BLOB },
    dispositionsText: EMPTY_LIST as string | null,
    bundledByTree: null as Record<string, unknown> | null,
    now: NOW,
    ...over
  };
}

/** The same inputs with the root capture replaced. */
const withRoot = (over: Record<string, unknown>) => ({
  captures: { ...inputs().captures, root: text(captureObject('root', over)) }
});

async function evaluate(over: Record<string, unknown> = {}) {
  const { evaluateReleaseAdvisory } = await loadAdvisory();
  return evaluateReleaseAdvisory({ ...inputs(), ...over } as never);
}

describe('the freshness budget', () => {
  it('is seven days', async () => {
    const { RELEASE_ADVISORY_BUDGET_DAYS } = await loadAdvisory();
    expect(RELEASE_ADVISORY_BUDGET_DAYS).toBe(7);
  });

  it('accepts fresh complete captures', async () => {
    const result = await evaluate();
    expect(result.refusal).toBeNull();
    expect(result.captures.map((capture: { completeness: string }) => capture.completeness)).toEqual([
      'complete',
      'complete'
    ]);
  });

  it('accepts a capture exactly seven days old', async () => {
    const result = await evaluate(withRoot({ observedAt: ISO(NOW - 7 * DAY_MS) }));
    expect(result.refusal).toBeNull();
  });

  it.each([
    ['one millisecond', 1],
    ['one second', 1000]
  ])('refuses a capture seven days and %s old as advisory-stale, naming the age and the budget', async (_label, extra) => {
    const result = await evaluate(withRoot({ observedAt: ISO(NOW - 7 * DAY_MS - extra) }));
    expect(result.refusal?.reason).toBe('advisory-stale');
    expect(result.refusal?.tree).toBe('root');
    expect(result.refusal?.message).toContain('root');
    expect(result.refusal?.message).toContain('7 days');
    expect(result.refusal?.message).toContain(String(7 * DAY_MS + extra));
    expect(result.refusal?.message).toContain(String(7 * DAY_MS));
  });

  it('refuses a capture observed after now, so clock skew cannot make one fresh', async () => {
    const result = await evaluate(withRoot({ observedAt: ISO(NOW + 1) }));
    expect(result.refusal?.reason).toBe('advisory-observed-after-now');
    expect(result.refusal?.tree).toBe('root');
  });

  it('accepts a capture observed at exactly now', async () => {
    expect((await evaluate(withRoot({ observedAt: ISO(NOW) }))).refusal).toBeNull();
  });
});

describe('completeness (AR2)', () => {
  it('maps a failed capture to unavailable, naming 249\'s reason', async () => {
    const result = await evaluate(
      withRoot({ outcome: { status: 'failed', reason: 'audit-timeout' } })
    );
    expect(result.refusal?.reason).toBe('advisory-unavailable');
    expect(result.refusal?.message).toContain('root');
    expect(result.refusal?.message).toContain('audit-timeout');
    expect(result.captures.at(0)?.completeness).toBe('unavailable');
  });

  it('maps a rejected capture to incomplete, naming 249\'s reason', async () => {
    const result = await evaluate(
      withRoot({ outcome: { status: 'rejected', reason: 'over-bound', bound: 'findings' } })
    );
    expect(result.refusal?.reason).toBe('advisory-incomplete');
    expect(result.refusal?.message).toContain('over-bound');
    expect(result.captures.at(0)?.completeness).toBe('incomplete');
  });

  it.each([
    ['malformed', { findings: 'not a list' }, 'malformed'],
    ['unsupported-format', { captureVersion: 2 }, 'unsupported-format'],
    ['missing-provenance', { toolVersion: '' }, 'missing-provenance']
  ])('maps a capture that fails checkCapture (%s) to incomplete', async (_label, over, reason) => {
    const result = await evaluate(withRoot(over));
    expect(result.refusal?.reason).toBe('advisory-incomplete');
    expect(result.refusal?.message).toContain(reason);
    expect(result.captures.at(0)?.completeness).toBe('incomplete');
  });

  it('maps a file that is not JSON to incomplete', async () => {
    const result = await evaluate({
      captures: { ...inputs().captures, root: 'this is not json' }
    });
    expect(result.refusal?.reason).toBe('advisory-incomplete');
    expect(result.refusal?.message).toContain('malformed');
  });

  it('maps a capture made for the other tree to incomplete', async () => {
    const result = await evaluate({
      captures: { ...inputs().captures, root: text(captureObject('webview-ui')) }
    });
    expect(result.refusal?.reason).toBe('advisory-incomplete');
    expect(result.refusal?.tree).toBe('root');
    expect(result.refusal?.message).toContain('webview-ui');
  });

  it('refuses a tree with no capture as advisory-capture-missing, and counts it incomplete', async () => {
    const result = await evaluate({
      captures: { root: inputs().captures.root, 'webview-ui': undefined }
    });
    expect(result.refusal?.reason).toBe('advisory-capture-missing');
    expect(result.refusal?.tree).toBe('webview-ui');
    expect(result.captures.at(1)?.completeness).toBe('incomplete');
  });

  it('names the tree that is not complete when only one tree is', async () => {
    const result = await evaluate({
      captures: {
        root: inputs().captures.root,
        'webview-ui': text(
          captureObject('webview-ui', { outcome: { status: 'failed', reason: 'no-report' } })
        )
      }
    });
    expect(result.refusal?.reason).toBe('advisory-unavailable');
    expect(result.refusal?.tree).toBe('webview-ui');
    expect(result.captures.map((capture: { completeness: string }) => capture.completeness)).toEqual([
      'complete',
      'unavailable'
    ]);
  });
});

describe('the lockfile must be the one HEAD holds (AR3)', () => {
  it('refuses a blob id that differs, naming both ids', async () => {
    const result = await evaluate({ lockBlobs: { ...BLOB, root: 'd'.repeat(40) } });
    expect(result.refusal?.reason).toBe('advisory-lockfile-mismatch');
    expect(result.refusal?.tree).toBe('root');
    expect(result.refusal?.message).toContain(BLOB.root);
    expect(result.refusal?.message).toContain('d'.repeat(40));
  });

  it('refuses a capture whose lockfile path is not the tree\'s lockfile', async () => {
    const result = await evaluate(
      withRoot({ lockfile: { path: 'webview-ui/package-lock.json', blob: BLOB.root } })
    );
    expect(result.refusal?.reason).toBe('advisory-lockfile-mismatch');
    expect(result.refusal?.message).toContain('webview-ui/package-lock.json');
  });

  it('does not require the capture\'s commit to be HEAD: a capture may be older than HEAD', async () => {
    const result = await evaluate(withRoot({ commit: '0'.repeat(40) }));
    expect(result.refusal).toBeNull();
  });
});

describe('refusal order (AR3)', () => {
  it('reports the first reason that applies within a tree, in the documented order', async () => {
    // Both stale and lockfile-mismatched: the lockfile reason precedes the age reasons.
    const result = await evaluate({
      ...withRoot({ observedAt: ISO(NOW - 30 * DAY_MS) }),
      lockBlobs: { ...BLOB, root: 'e'.repeat(40) }
    });
    expect(result.refusal?.reason).toBe('advisory-lockfile-mismatch');
  });

  it('checks tree by tree: an earlier tree\'s reason precedes a later tree\'s earlier-listed one', async () => {
    const result = await evaluate({
      captures: {
        root: text(captureObject('root', { observedAt: ISO(NOW - 30 * DAY_MS) })),
        'webview-ui': undefined
      }
    });
    expect(result.refusal?.reason).toBe('advisory-stale');
    expect(result.refusal?.tree).toBe('root');
  });

  it('reports exactly one reason', async () => {
    const result = await evaluate({
      captures: { root: undefined, 'webview-ui': undefined },
      dispositionsText: 'not json'
    });
    expect(result.refusal?.reason).toBe('advisory-capture-missing');
    expect(Object.keys(result.refusal ?? {}).sort()).toEqual(['detail', 'message', 'reason', 'tree']);
  });

  it('refuses the disposition list only after every capture passes', async () => {
    const result = await evaluate({ dispositionsText: 'not json' });
    expect(result.refusal?.reason).toBe('dispositions-unusable');
    const capturesFirst = await evaluate({
      ...withRoot({ observedAt: ISO(NOW - 30 * DAY_MS) }),
      dispositionsText: 'not json'
    });
    expect(capturesFirst.refusal?.reason).toBe('advisory-stale');
  });
});

describe('the disposition list (AR6)', () => {
  it.each([
    ['not JSON', 'not json', 'malformed'],
    ['another version', text({ dispositionListVersion: 2, dispositions: [] }), 'unsupported-format'],
    ['unreadable', null, 'unreadable']
  ])('refuses a list that is %s as dispositions-unusable, naming 249\'s defect', async (_label, value, defect) => {
    const result = await evaluate({ dispositionsText: value });
    expect(result.refusal?.reason).toBe('dispositions-unusable');
    expect(result.refusal?.detail).toBe(defect);
    expect(result.refusal?.message).toContain(defect);
  });

  it('accepts the empty version-1 list', async () => {
    const result = await evaluate({ dispositionsText: EMPTY_LIST });
    expect(result.refusal).toBeNull();
    expect(result.dispositions.entries).toBe(0);
  });

  it('refuses an entry with no rationale', async () => {
    const { rationale: _omitted, ...bare } = entry();
    const result = await evaluate({ dispositionsText: listOf(bare) });
    expect(result.refusal?.reason).toBe('dispositions-unusable');
    expect(result.refusal?.detail).toBe('missing-rationale');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 12],
    ['2,001 characters', 'x'.repeat(2001)]
  ])('refuses a rationale that is %s', async (_label, rationale) => {
    const result = await evaluate({ dispositionsText: listOf(entry({ rationale })) });
    expect(result.refusal?.detail).toBe('missing-rationale');
  });

  it('accepts a rationale of exactly 2,000 characters', async () => {
    const result = await evaluate({ dispositionsText: listOf(entry({ rationale: 'x'.repeat(2000) })) });
    expect(result.refusal).toBeNull();
    expect(result.dispositions.entries).toBe(1);
  });

  it('records the digest of the list it read', async () => {
    const { sha256Hex } = await import('../../../scripts/release-digest.mjs');
    const result = await evaluate({ dispositionsText: EMPTY_LIST });
    expect(result.dispositions.sha256).toBe(sha256Hex(EMPTY_LIST));
  });
});

describe('findings: usage and disposition verdicts (AR5, AR6, research R13, R14)', () => {
  const svelteFinding = finding({
    package: 'svelte',
    locations: [{ location: 'node_modules/svelte', version: '5.0.0', direct: true, production: false }]
  });
  const withFinding = (tree: Tree, found: Finding) => ({
    captures: {
      ...inputs().captures,
      [tree]: text(captureObject(tree, { findings: [found] }))
    }
  });
  const bundled = (installPaths: string[], unmapped: string[] = []) => ({
    root: { installPaths: [], unmapped: [] },
    'webview-ui': { installPaths, unmapped }
  });

  it('classifies a finding in a bundled package as shipped', async () => {
    const result = await evaluate({
      ...withFinding('webview-ui', svelteFinding),
      bundledByTree: bundled(['node_modules/svelte'])
    });
    expect(result.findings.at(0)?.usage).toBe('shipped');
  });

  it('classifies a finding in a package no graph bundles as build-only', async () => {
    const result = await evaluate({
      ...withFinding('webview-ui', svelteFinding),
      bundledByTree: bundled(['node_modules/esm-env'])
    });
    expect(result.findings.at(0)?.usage).toBe('build-only');
  });

  it('classifies a finding as unknown when the tree\'s graph is unavailable', async () => {
    const result = await evaluate({ ...withFinding('webview-ui', svelteFinding), bundledByTree: null });
    expect(result.findings.at(0)?.usage).toBe('unknown');
  });

  it('classifies a finding as unknown when its package matches an unmapped module', async () => {
    const viteFinding = finding({
      package: 'vite',
      locations: [{ location: 'node_modules/vite', version: '7.0.0', direct: true, production: false }]
    });
    const result = await evaluate({
      ...withFinding('webview-ui', viteFinding),
      bundledByTree: bundled([], ['vite/preload-helper.js'])
    });
    expect(result.findings.at(0)?.usage).toBe('unknown');
    const ghost = finding({
      package: 'ghost',
      locations: [{ location: 'node_modules/ghost', version: '1.0.0', direct: true, production: false }]
    });
    const viaPath = await evaluate({
      ...withFinding('webview-ui', ghost),
      bundledByTree: bundled([], ['node_modules/ghost'])
    });
    expect(viaPath.findings.at(0)?.usage).toBe('unknown');
  });

  it('reports an uncovered finding with its verdict and does not refuse (R14)', async () => {
    const result = await evaluate(withFinding('root', finding()));
    expect(result.refusal).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings.at(0)?.disposition).toBe('not-recorded');
    expect(result.verdicts['not-recorded']).toBe(1);
  });

  it('shows covers, expired and does-not-cover from the list, evaluated at now', async () => {
    const verdictFor = async (over: Record<string, unknown>) =>
      (
        await evaluate({
          ...withFinding('root', finding()),
          dispositionsText: listOf(entry(over))
        })
      ).findings.at(0)?.disposition;
    expect(await verdictFor({})).toBe('covers');
    expect(await verdictFor({ expiresOn: '2026-11-02' })).toBe('expired');
    expect(await verdictFor({ tree: 'webview-ui' })).toBe('does-not-cover');
    expect(await verdictFor({ range: '>=2.0.0' })).toBe('does-not-cover');
  });

  it('counts each verdict', async () => {
    const result = await evaluate({
      captures: {
        root: text(
          captureObject('root', {
            findings: [
              finding(),
              finding({ package: 'other', ids: { canonical: 'GHSA-zzzz-zzzz-zzzz', aliases: [] } })
            ]
          })
        ),
        'webview-ui': inputs().captures['webview-ui']
      },
      dispositionsText: listOf(entry())
    });
    expect(result.verdicts).toEqual({
      'not-recorded': 1,
      covers: 1,
      expired: 0,
      'does-not-cover': 0
    });
  });

  it('sorts findings by tree, package, then advisory id', async () => {
    const mk = (pkg: string, id: string) =>
      finding({ package: pkg, ids: { canonical: id, aliases: [] } });
    const result = await evaluate({
      captures: {
        root: text(captureObject('root', { findings: [mk('b', 'GHSA-2'), mk('a', 'GHSA-9'), mk('a', 'GHSA-1')] })),
        'webview-ui': text(captureObject('webview-ui', { findings: [mk('a', 'GHSA-0')] }))
      }
    });
    expect(
      result.findings.map(
        (found: { tree: string; package: string; advisory: string }) =>
          `${found.tree} ${found.package} ${found.advisory}`
      )
    ).toEqual(['root a GHSA-1', 'root a GHSA-9', 'root b GHSA-2', 'webview-ui a GHSA-0']);
  });

  it('records the capture file digest, commit, lockfile identity, tool version and count', async () => {
    const { sha256Hex } = await import('../../../scripts/release-digest.mjs');
    const rootText = text(captureObject('root', { findings: [finding()] }));
    const result = await evaluate({ captures: { ...inputs().captures, root: rootText } });
    expect(result.captures.at(0)).toMatchObject({
      tree: 'root',
      sha256: sha256Hex(rootText),
      commit: 'f'.repeat(40),
      lockfile: { path: 'package-lock.json', blob: BLOB.root },
      toolVersion: '11.17.0',
      observedAt: FRESH,
      completeness: 'complete',
      findings: 1
    });
  });
});

describe('dispositionOf, exported by feature 249 (AR6)', () => {
  const found = {
    ids: { canonical: 'GHSA-aaaa-bbbb-cccc', aliases: [] as string[] },
    package: 'left-pad',
    tree: 'root',
    candidate: { locations: [{ location: 'node_modules/left-pad', version: '1.0.0' }] }
  };
  const read = async (...entries: Array<Record<string, unknown>>) => {
    const { parseDispositionList } = await loadDispositions();
    return parseDispositionList(listOf(...entries));
  };

  it('gives not-recorded, covers, expired and does-not-cover', async () => {
    const { dispositionOf } = await loadDispositions();
    const at = Date.parse('2026-11-02T10:00:00Z');
    const verdict = async (...entries: Array<Record<string, unknown>>) =>
      dispositionOf(found as never, await read(...entries), at).verdict;
    expect(await verdict()).toBe('not-recorded');
    expect(await verdict(entry())).toBe('covers');
    expect(await verdict(entry({ expiresOn: '2026-11-02' }))).toBe('expired');
    expect(await verdict(entry({ tree: 'webview-ui' }))).toBe('does-not-cover');
  });
});

describe('what the advisory lines print (RP5)', () => {
  const ESC = String.fromCharCode(27);

  it('prints one line per finding with tree, id, package, severity, usage, verdict and URL', async () => {
    const { renderAdvisoryLines } = await loadAdvisory();
    const result = await evaluate({
      captures: {
        root: text(captureObject('root', { findings: [finding()] })),
        'webview-ui': inputs().captures['webview-ui']
      }
    });
    const lines = renderAdvisoryLines(result);
    const line = lines.find((entry: string) => entry.includes('GHSA-aaaa-bbbb-cccc'));
    expect(line).toBeDefined();
    for (const part of ['root', 'left-pad', 'moderate', 'unknown', 'not-recorded', 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc']) {
      expect(line).toContain(part);
    }
  });

  it('prints no ranking or total by count', async () => {
    const { renderAdvisoryLines } = await loadAdvisory();
    const result = await evaluate({
      captures: {
        root: text(captureObject('root', { findings: [finding()] })),
        'webview-ui': inputs().captures['webview-ui']
      }
    });
    const printed = renderAdvisoryLines(result).join('\n');
    expect(printed).not.toMatch(/\btotal\b|\bmost\b|\btop\b|\branked\b/i);
  });

  it('prints each tree\'s completeness, age and finding count', async () => {
    const { renderAdvisoryLines } = await loadAdvisory();
    const printed = renderAdvisoryLines(await evaluate()).join('\n');
    expect(printed).toContain('root');
    expect(printed).toContain('complete');
    expect(printed).toMatch(/1 days?\b/);
  });

  it('escapes an escape sequence carried by a capture instead of printing it', async () => {
    const { renderAdvisoryLines } = await loadAdvisory();
    const hostile = finding({
      package: `evil${ESC}[31m`,
      url: `https://example.test/${ESC}]0;title`,
      ids: { canonical: `GHSA-${ESC}[2J`, aliases: [] }
    });
    const result = await evaluate({
      captures: {
        root: text(captureObject('root', { findings: [hostile] })),
        'webview-ui': inputs().captures['webview-ui']
      }
    });
    const printed = renderAdvisoryLines(result).join('\n');
    expect(printed).not.toContain(ESC);
    expect(printed).toContain('\\x1b');
  });

  it('escapes free text from the list inside a refusal message too', async () => {
    const { rationale: _omitted, ...bare } = entry({ advisory: `GHSA-${ESC}[2J` });
    const result = await evaluate({ dispositionsText: listOf(bare) });
    expect(result.refusal?.reason).toBe('dispositions-unusable');
    expect(result.refusal?.message).not.toContain(ESC);
    expect(result.refusal?.message).toContain('\\x1b');
  });
});

describe('the module has no way to reach the network or spawn anything (AR7, FR-020)', () => {
  const sourceOf = () =>
    readFileSync(resolve(__dirname, '..', '..', '..', 'scripts', 'release-advisory.mjs'), 'utf8');
  /** Modules and calls through which a script could spawn a process or open a socket. */
  const REACHES_OUT =
    /from ['"]node:(?:child_process|net|tls|http|https|http2|dns|dgram|worker_threads|cluster)['"]|\bfetch\(|\bspawn(?:Sync)?\(|\bexec(?:File)?(?:Sync)?\(|\bwriteFileSync\(/;

  it('imports none of them', () => {
    expect(sourceOf()).not.toMatch(REACHES_OUT);
  });

  it('NON-VACUITY: the same pattern finds each one in a planted line', () => {
    for (const planted of [
      "import { spawnSync } from 'node:child_process';",
      "import https from 'node:https';",
      'const reply = fetch(url);',
      'writeFileSync(path, text);'
    ]) {
      expect(planted).toMatch(REACHES_OUT);
    }
  });

  it('takes file contents, an injected clock and nothing else', async () => {
    const { evaluateReleaseAdvisory } = await loadAdvisory();
    expect(evaluateReleaseAdvisory.length).toBe(1);
    const source = sourceOf();
    expect(source).toMatch(/captures, lockBlobs, dispositionsText, bundledByTree, now/);
  });
});
