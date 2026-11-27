import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FR-R3-180 (feature 217, FR-016, SC-005) — `npm run gate:distance`.
 *
 * The question this answers used to take a `git rev-list` incantation against a sha copied out of
 * `.gate-attestation.json` by hand, which is what the review that filed FR-R3-180 had to do to learn
 * the record was 142 commits behind. The command reports; it never enforces. Enforcement is
 * `require-local-gate.mjs`, and a reporting command that exits non-zero is one that ends up wired
 * into a gate by accident — so every case below exits 0, and the test says so case by case.
 *
 * The reader is pure over three seams (the record's text, the tree state, a commit count), so every
 * case is exercised without the real record, without git and without a gate run. One spawn at the
 * end runs the real CLI against whatever this checkout holds; its exit code is 0 whatever that is.
 *
 * Loaded dynamically for the same TS1479 reason `gate-attestation.test.ts` records.
 */
async function loadDistance() {
  return import('../../../scripts/gate-distance.mjs');
}
async function loadGate() {
  return import('../../../scripts/gate-attestation.mjs');
}

let distance: Awaited<ReturnType<typeof loadDistance>>;
let gate: Awaited<ReturnType<typeof loadGate>>;

beforeAll(async () => {
  distance = await loadDistance();
  gate = await loadGate();
});

const RECORDED = 'a'.repeat(40);
const CURRENT = 'b'.repeat(40);

/** The record `record-gate-run.mjs` writes on a green run, 14m 08s long. */
function recordText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: gate.ATTESTATION_VERSION,
    command: gate.GATE_COMMAND,
    commandExecutable: 'npm',
    commandArgv: [...gate.GATE_COMMAND_SPEC.args],
    head: RECORDED,
    treeClean: true,
    exitCode: 0,
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v24.0.0',
    startedAt: '2026-08-14T09:08:23Z',
    recordedAt: '2026-08-14T09:22:31Z',
    ...overrides
  });
}

type Counts = Readonly<Record<string, number | null>>;

/** Seams for one case. `counts` maps a `rev-list` range to its answer; an unlisted range throws. */
function seams(options: {
  text: string | null | (() => never);
  head?: string;
  treeClean?: boolean;
  counts?: Counts;
  treeState?: () => never;
}) {
  const ranges: string[] = [];
  const { text } = options;
  return {
    ranges,
    deps: {
      readRecordText: typeof text === 'function' ? text : () => text,
      readTreeState:
        options.treeState ?? (() => ({ head: options.head ?? CURRENT, treeClean: options.treeClean ?? true })),
      countCommits: (range: string) => {
        ranges.push(range);
        const counts = options.counts ?? {};
        if (!(range in counts)) throw new Error(`unexpected rev-list range ${range}`);
        return counts[range] ?? null;
      }
    }
  };
}

const behindRange = `${RECORDED}..HEAD`;
const aheadRange = `HEAD..${RECORDED}`;

describe('gate:distance — the recorded case (FR-016, SC-005)', () => {
  it('prints the four aligned lines the contract specifies, and exits 0', () => {
    const { deps, ranges } = seams({
      text: recordText(),
      counts: { [behindRange]: 144, [aheadRange]: 0 }
    });
    const report = distance.reportGateDistance(deps);
    expect(report.lines).toEqual([
      'gate attestation: aaaaaaa (npm run gate, exit 0)',
      'recorded:         2026-08-14T09:22:31Z, 14m 08s',
      'HEAD:             bbbbbbb',
      'distance:         144 commits behind'
    ]);
    expect(report.exitCode).toBe(0);
    // The contract's own definition of the number, not a re-derivation of it.
    expect(ranges[0]).toBe(behindRange);
  });

  it('reads 0 commits behind at the recorded commit, and names no remedy', () => {
    const { deps } = seams({
      text: recordText(),
      head: RECORDED,
      counts: { [behindRange]: 0, [aheadRange]: 0 }
    });
    const report = distance.reportGateDistance(deps);
    expect(report.lines.at(-1)).toBe('distance:         0 commits behind');
    expect(report.lines.some((line) => line.startsWith('remedy:'))).toBe(false);
    expect(report.exitCode).toBe(0);
  });

  it('says "1 commit", not "1 commits"', () => {
    const { deps } = seams({ text: recordText(), counts: { [behindRange]: 1, [aheadRange]: 0 } });
    expect(distance.reportGateDistance(deps).lines.at(-1)).toBe('distance:         1 commit behind');
  });

  it('shows a red record as red rather than hiding it behind a distance', () => {
    const { deps } = seams({
      text: recordText({ exitCode: 1 }),
      counts: { [behindRange]: 2, [aheadRange]: 0 }
    });
    expect(distance.reportGateDistance(deps).lines[0]).toBe('gate attestation: aaaaaaa (npm run gate, exit 1)');
  });

  it('marks a dirty tree on the HEAD line, because distance 0 then does not describe it', () => {
    const { deps } = seams({
      text: recordText(),
      head: RECORDED,
      treeClean: false,
      counts: { [behindRange]: 0, [aheadRange]: 0 }
    });
    expect(distance.reportGateDistance(deps).lines[2]).toBe('HEAD:             aaaaaaa (uncommitted changes)');
  });

  it('never prints 0 behind for a record HEAD does not contain, and names the remedy', () => {
    // `rev-list --count <head>..HEAD` is 0 when HEAD is an ANCESTOR of the record — a checkout
    // moved back past it. Reported alone, that 0 would read as "the record describes HEAD".
    const { deps } = seams({ text: recordText(), counts: { [behindRange]: 0, [aheadRange]: 2 } });
    const report = distance.reportGateDistance(deps);
    expect(report.lines.slice(-2)).toEqual([
      'distance:         0 commits behind, 2 ahead - the recorded commit is not an ancestor of HEAD',
      'remedy:           npm run gate:record'
    ]);
    expect(report.exitCode).toBe(0);
  });

  it('renders an unknown duration rather than a wrong one', () => {
    const { deps } = seams({
      text: recordText({ startedAt: 'not a time' }),
      counts: { [behindRange]: 3, [aheadRange]: 0 }
    });
    expect(distance.reportGateDistance(deps).lines[1]).toBe(
      'recorded:         2026-08-14T09:22:31Z, duration unknown'
    );
  });
});

describe('gate:distance — every failure names its remedy and exits 0 (contract §Exit code)', () => {
  it('the absent record', () => {
    const { deps } = seams({ text: null });
    const report = distance.reportGateDistance(deps);
    expect(report.lines).toEqual(['gate attestation: none recorded', 'remedy:           npm run gate:record']);
    expect(report.exitCode).toBe(0);
  });

  it('the unusable record — a version this reader does not read (stale-version)', () => {
    const { deps } = seams({ text: recordText({ version: gate.ATTESTATION_VERSION - 1 }) });
    const report = distance.reportGateDistance(deps);
    expect(report.lines).toEqual([
      `gate attestation: unusable (stale-version: recorded version ${gate.ATTESTATION_VERSION - 1}, ` +
        `current ${gate.ATTESTATION_VERSION})`,
      'remedy:           npm run gate:record'
    ]);
    expect(report.exitCode).toBe(0);
  });

  it('the unusable record — a file that is not a record (unreadable), whose remedy is to look first', () => {
    // `decideRelease` splits these two remedies on purpose (FR-R3-135): a superseded record needs a
    // gate run, a corrupt one needs looking at. The reader matches the release path's refusals.
    for (const text of ['{"version": 2, "head": "aaa', '[]', 'null', JSON.stringify({ version: 'two' })]) {
      const { deps } = seams({ text });
      const report = distance.reportGateDistance(deps);
      expect(report.lines[0]).toMatch(/^gate attestation: unusable \(unreadable: /);
      expect(report.lines[1]).toBe(`remedy:           inspect ${gate.ATTESTATION_PATH}, then npm run gate:record`);
      expect(report.exitCode).toBe(0);
    }
  });

  it('the unusable record — a file that exists and cannot be read', () => {
    const { deps } = seams({
      text: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
    });
    const report = distance.reportGateDistance(deps);
    expect(report.lines[0]).toBe('gate attestation: unusable (unreadable: the file could not be read, EACCES)');
    expect(report.lines[1]).toMatch(/^remedy: {11}inspect /);
    expect(report.exitCode).toBe(0);
  });

  it('a head that is not a commit id never reaches git', () => {
    // The record is a file anyone with the checkout can edit, and its `head` becomes a `git`
    // argument. A value beginning `-` would be read as an option, so the shape is checked first.
    const { deps, ranges } = seams({ text: recordText({ head: '--output=/tmp/x' }) });
    const report = distance.reportGateDistance(deps);
    expect(report.lines[0]).toBe('gate attestation: unusable (unreadable: head is not a commit id)');
    expect(ranges).toEqual([]);
    expect(report.exitCode).toBe(0);
  });

  it('the unreachable commit — a rebased or pruned record', () => {
    const { deps } = seams({ text: recordText(), counts: { [behindRange]: null } });
    const report = distance.reportGateDistance(deps);
    expect(report.lines).toEqual([
      'gate attestation: aaaaaaa (npm run gate, exit 0)',
      'HEAD:             bbbbbbb',
      'distance:         unknown - recorded commit is not in this repository',
      'remedy:           npm run gate:record'
    ]);
    expect(report.exitCode).toBe(0);
  });

  it('git unable to report HEAD is reported, not thrown', () => {
    const { deps } = seams({
      text: recordText(),
      treeState: () => {
        throw new Error('git: not found');
      }
    });
    const report = distance.reportGateDistance(deps);
    expect(report.lines.slice(-2)).toEqual([
      'HEAD:             unknown - git could not report it',
      'distance:         unknown'
    ]);
    expect(report.exitCode).toBe(0);
  });
});

describe('gate:distance — one source of truth, one command', () => {
  const SCRIPT = 'scripts/gate-distance.mjs';

  it('takes the path, version, root and tree state from gate-attestation.mjs rather than re-deriving them', () => {
    const source = readFileSync(resolve(gate.REPO_ROOT, SCRIPT), 'utf8');
    const imported = /import\s*\{([^}]*)\}\s*from\s*'\.\/gate-attestation\.mjs'/.exec(source)?.[1] ?? '';
    for (const name of ['ATTESTATION_PATH', 'ATTESTATION_VERSION', 'REPO_ROOT', 'readTreeState']) {
      expect(imported, `${SCRIPT} must import ${name} from gate-attestation.mjs`).toMatch(
        new RegExp(`\\b${name}\\b`)
      );
    }
    // A second spelling of the record's location is the split the shared module exists to prevent.
    expect(source).not.toMatch(/['"`]\.gate-attestation\.json['"`]/);
  });

  it('is the npm script the contract names, beside gate and gate:record', () => {
    const manifest = JSON.parse(readFileSync(resolve(gate.REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['gate:distance']).toBe('node scripts/gate-distance.mjs');
    expect(manifest.scripts['gate']).toBeDefined();
    expect(manifest.scripts['gate:record']).toBeDefined();
  });

  it('exits 0 against whatever this checkout holds, and runs no gate', () => {
    // Hermetic in its exit code by design: every state the record can be in exits 0. What it
    // prints depends on this machine's record, so only the first label is asserted.
    const result = spawnSync(process.execPath, [resolve(gate.REPO_ROOT, SCRIPT)], {
      cwd: gate.REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000
    });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toMatch(/^gate attestation: /);
  });
});
