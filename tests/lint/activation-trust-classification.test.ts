// FR-R3-136 (T1525g) — every `src/activation/` module carries a trust verdict,
// and the set of modules is counted rather than stated.
//
// WHY THIS GATE EXISTS AT ALL, given T1525a is a one-off classification pass.
// The pass is only as good as its coverage, and its coverage was a number in a
// task list: "the nineteen `src/activation/` wiring modules". The directory held
// twenty-one by the time the pass ran, two of them added by this very feature
// (`guarded-command-registration.ts`, `stage2-producers.ts`). A stated count goes
// stale the first time someone extracts a module, and the failure is silent — the
// new module simply never gets classified, and nobody learns that the audit no
// longer covers the composition root. So the count is derived here from the
// directory listing, and the next extraction fails this test until its author
// says which kind of module they just wrote.
//
// T1523a'S CRITERION, which is what the verdicts are verdicts about. A module
// performs a PRODUCER ACT if it writes to a path the workspace or persisted state
// can influence, spawns a child process, or arms a timer. An operator-confirmed
// modal destination (`showSaveDialog`) is not such a path: the operator named it,
// not the folder.
//
// THE TIMER CLAUSE MEANS A TIMER THAT FIRES AN ACT, and this refinement was
// forced by two real cases rather than invented. `StateProjector.start()` arms a
// tick whose callback calls `scheduleProjection()` — it recomputes a snapshot
// from state already in memory and posts it to the webview. The phase-log tail's
// `fs.watch`/poll watcher is the same shape: it reads a file the operator asked
// to see. Neither writes, spawns, or resumes anything, and suppressing either
// would freeze the state, history, audit and log views that the manifest's
// `untrustedWorkspaces.supported: "limited"` claim promises keep working. A
// classification that matched the clause literally would have broken the feature's
// own compatibility claim in the name of enforcing it.
//
// THE FOUR VERDICTS, and why the vocabulary is closed. `NO PRODUCER ACT` — the
// module constructs, subscribes, or reads, and nothing it does at wiring time
// meets the criterion. `DEFERRED` — it had an act and handed it to
// `stage2-producers.ts` as a thunk. `GATED HERE` — it has an act that cannot be
// handed over (a configuration-change handler, an audit append inside a read
// surface) and checks trust at the act. `THE GATE` — `stage2-producers.ts`
// itself. A fifth word would be a fifth policy nobody reviewed, so the parser
// rejects one.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ACTIVATION_DIR = resolve(REPO_ROOT, 'src', 'activation');

/** The closed vocabulary. Order is longest-first so `THE GATE` cannot shadow. */
const VERDICTS = Object.freeze([
  'NO PRODUCER ACT',
  'DEFERRED',
  'GATED HERE',
  'THE GATE'
] as const);

type Verdict = (typeof VERDICTS)[number];

const MARKER = 'FR-R3-136 (T1525a) — TRUST CLASSIFICATION:';

/**
 * How far into a file the banner may sit. It is at line 1 in every module today;
 * the allowance is for a future licence header, not for burying the verdict
 * under the imports where nobody opening the file would see it.
 */
const BANNER_WINDOW_LINES = 8;

/**
 * The two modules this feature added. Anchors, not an allowlist: they are the
 * proof that the scan sees files the original task text did not know about, so a
 * scan that silently stopped finding modules fails here instead of reporting
 * universal compliance over an empty set.
 */
const ANCHORS = Object.freeze(['guarded-command-registration.ts', 'stage2-producers.ts']);

/**
 * A floor, deliberately well below the current 21. It catches the scan breaking
 * (directory moved, extension filter wrong) without turning every extraction
 * into a two-line edit — the per-module assertion is what enforces coverage.
 */
const MIN_MODULES = 15;

function activationModules(): readonly string[] {
  return readdirSync(ACTIVATION_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

/**
 * Parse a verdict out of a module's text. Returns `null` when there is no
 * banner in the window, and the offending line when the banner is there but its
 * verdict is not one of the four — the two failures need different messages.
 */
function readVerdict(source: string): { verdict: Verdict } | { unrecognized: string | null } {
  const lines = source.split(/\r?\n/).slice(0, BANNER_WINDOW_LINES);
  const banner = lines.find((line) => line.includes(MARKER));
  if (banner === undefined) return { unrecognized: null };
  const after = banner.slice(banner.indexOf(MARKER) + MARKER.length).trim();
  for (const verdict of VERDICTS) {
    if (after.startsWith(verdict)) return { verdict };
  }
  return { unrecognized: banner.trim() };
}

function classify(): ReadonlyMap<string, Verdict> {
  const out = new Map<string, Verdict>();
  const missing: string[] = [];
  const unrecognized: string[] = [];
  for (const name of activationModules()) {
    const source = readFileSync(resolve(ACTIVATION_DIR, name), 'utf8');
    const parsed = readVerdict(source);
    if ('verdict' in parsed) {
      out.set(name, parsed.verdict);
    } else if (parsed.unrecognized === null) {
      missing.push(name);
    } else {
      unrecognized.push(`${name}: ${parsed.unrecognized}`);
    }
  }
  expect(
    missing,
    'These `src/activation/` modules carry no trust classification banner. Add ' +
      `one within the first ${BANNER_WINDOW_LINES} lines:\n` +
      `  // ${MARKER} <${VERDICTS.join(' | ')}>.\n` +
      'followed by the reasoning. T1523a\'s criterion and what each verdict means ' +
      `are in this file's header.\n${missing.join('\n')}`
  ).toEqual([]);
  expect(
    unrecognized,
    'These banners do not open with one of the four recognized verdicts ' +
      `(${VERDICTS.join(', ')}). The vocabulary is closed on purpose — a new word ` +
      `is a new policy, and it belongs in this file's header first:\n${unrecognized.join('\n')}`
  ).toEqual([]);
  return out;
}

function modulesWith(verdict: Verdict): readonly string[] {
  return [...classify()].filter(([, v]) => v === verdict).map(([name]) => name);
}

describe('src/activation trust classification (FR-R3-136 T1525a)', () => {
  it('classifies every module in the directory, counted not stated', () => {
    const modules = activationModules();
    expect(
      modules.length,
      `Found ${modules.length} modules under src/activation/, which is below the ` +
        `floor of ${MIN_MODULES}. The scan is probably broken rather than the ` +
        'directory suddenly small — in which case every assertion below is ' +
        'passing over a set it cannot see.'
    ).toBeGreaterThanOrEqual(MIN_MODULES);
    for (const anchor of ANCHORS) {
      expect(
        modules,
        `${anchor} was added by FR-R3-136 and must appear in the scan. If it was ` +
          'renamed, update ANCHORS; if the scan stopped finding it, fix the scan.'
      ).toContain(anchor);
    }
    // Throws with the per-module detail if any banner is missing or malformed.
    expect(classify().size).toBe(modules.length);
  });

  it('names exactly one gate', () => {
    // FR-R3-136's single-enforcement-site principle, read back off the modules.
    // Two modules claiming `THE GATE` would mean two places an act can be
    // admitted, and the whole argument for putting the producers together is
    // that there is one live trust read to review.
    expect(modulesWith('THE GATE')).toEqual(['stage2-producers.ts']);
  });

  it('makes every deferral name where the act went', () => {
    const offenders: string[] = [];
    for (const name of modulesWith('DEFERRED')) {
      const source = readFileSync(resolve(ACTIVATION_DIR, name), 'utf8');
      if (!source.includes('stage2-producers')) offenders.push(name);
    }
    expect(
      offenders,
      'A module classified DEFERRED gave an act away, and the reader has to be ' +
        'able to follow it. Name `stage2-producers.ts` and say which act moved:' +
        `\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('makes every in-place gate actually read trust', () => {
    const offenders: string[] = [];
    for (const name of [...modulesWith('GATED HERE'), ...modulesWith('THE GATE')]) {
      const source = readFileSync(resolve(ACTIVATION_DIR, name), 'utf8');
      // The thunk form, not `vscode.workspace.isTrusted` directly: FR-005 is
      // that trust is re-read at the act, and a module that reads the global
      // inline cannot be tested against a grant that lands later.
      if (!/isWorkspaceTrusted\(\)/.test(source)) offenders.push(name);
    }
    expect(
      offenders,
      'These modules claim to gate in place but never call `isWorkspaceTrusted()`. ' +
        'Either the gate was removed and the banner is now a false claim, or the ' +
        `verdict should be NO PRODUCER ACT:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  // Non-vacuity, in two directions.
  //
  // The classification assertions are all "no offenders", so a parser that never
  // recognizes a banner and a parser that recognizes everything both look like a
  // clean audit. These two tests pin the parser from both ends: it must reject
  // the three ways a banner can be wrong, and the four verdicts must all be in
  // real use — a vocabulary word no module claims is a word that was never
  // reviewed against code, and `THE GATE` going unused would mean the producers
  // module was deleted while this file still asserted the shape of its absence.
  it('rejects a missing banner, a late banner, and an invented verdict', () => {
    const good = `// ${MARKER} DEFERRED.\n// reason\nimport x from 'y';\n`;
    expect(readVerdict(good)).toEqual({ verdict: 'DEFERRED' });

    expect(readVerdict("import x from 'y';\n")).toEqual({ unrecognized: null });

    const late = `${'\n'.repeat(BANNER_WINDOW_LINES + 1)}// ${MARKER} DEFERRED.\n`;
    expect(readVerdict(late)).toEqual({ unrecognized: null });

    const invented = `// ${MARKER} PROBABLY FINE.\n`;
    expect(readVerdict(invented)).toEqual({ unrecognized: `// ${MARKER} PROBABLY FINE.` });
  });

  it('uses all four verdicts', () => {
    const used = new Set(classify().values());
    for (const verdict of VERDICTS) {
      expect(
        used,
        `No module claims ${verdict}. Either the vocabulary has a dead word — ` +
          'remove it from VERDICTS and from this file\'s header — or a module that ' +
          'used to claim it was deleted or reclassified without review.'
      ).toContain(verdict);
    }
  });
});
