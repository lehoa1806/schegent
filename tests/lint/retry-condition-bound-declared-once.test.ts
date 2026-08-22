// Feature 111 (T695, T700 — FR-005, FR-018, FR-028, SC-001, SC-002, SC-015) —
// the `retryCondition` length bound is declared once, and the scheduled-start
// coordinator stays read-only.
//
// Two rules in one file because they are the two ways this feature can decay, and
// both decay silently.
//
// **One declaration.** The failure this forbids is the one T23 in
// `docs/security/threat-model.md` describes: "a module that declares its own `= 64`
// agrees with the catalog only by coincidence, and the day that catalog widens its
// id length, the private copy starts truncating identifiers the catalog itself
// accepts — silently, in exactly the reporting paths an operator would use to
// diagnose the problem." Before this feature the projection did exactly that with
// `INSTRUCTION_MAX`, bounding `retryCondition` at 8192 against three routes that
// bounded it at nothing. The fix is one constant in `contracts/`, and this pins it.
//
// The DSL module is the interesting case and the reason the constant is passed as an
// argument rather than imported: `src/lib/retry-condition.ts` imports nothing, is
// byte-mirrored into `webview-ui/src/lib/`, and has its importer list pinned at
// three by `retry-condition-stays-inert.test.ts`. So the scan below must find zero
// numeric bounds in either copy — not a re-declaration, and not an import either.
//
// **The coordinator stays read-only.** `.schegent/` is this feature's activation
// proxy, and the arm path already guarantees the directory exists — transitively,
// through the audit writer's `fs.mkdir(dir, { recursive: true })`. The tempting
// "completion" of the activation work is to have `ScheduledStartCoordinator` ensure
// the directory itself. That would undo FR-R3-002 (T284), which deliberately made
// this class schedule timers and never persist. `scheduled-start-activation-proxy`
// pins the guarantee; this pins the posture that makes the guarantee indirect.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { filesUnder as scanFilesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The one file allowed to put a number on this field. */
const DECLARATION = 'src/contracts/process-definitions.ts';

/** Both trees, because the mirror is a second place a bound could appear. */
const SCANNED_ROOTS: readonly string[] = ['src', 'webview-ui/src'];

function filesUnder(relative: string): readonly string[] {
  const abs = resolve(REPO_ROOT, relative);
  const out = scanFilesUnder(abs, { extensions: ['.ts', '.svelte'] }).join('\n');
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(REPO_ROOT.length + 1));
}

const ALL_FILES = SCANNED_ROOTS.flatMap((root) => filesUnder(root));

describe('the retryCondition bound is declared exactly once (111, FR-005)', () => {
  it('scans both trees, and finds enough files that an empty scan cannot pass', () => {
    expect(ALL_FILES.length).toBeGreaterThan(200);
    expect(ALL_FILES).toContain(DECLARATION);
    expect(ALL_FILES).toContain('src/lib/retry-condition.ts');
    expect(ALL_FILES).toContain('webview-ui/src/lib/retry-condition.ts');
  });

  it('exactly one file declares the constant', () => {
    const declarers = ALL_FILES.filter((rel) =>
      /export const PHASE_RETRY_CONDITION_MAX_LEN\s*=/.test(
        readFileSync(resolve(REPO_ROOT, rel), 'utf8')
      )
    );
    expect(declarers).toEqual([DECLARATION]);
  });

  it('the declared value is 512', () => {
    // Not a style rule: the boundary tests in three suites assert against 512 by
    // name, and the docs state it. If the number moves, it moves here and they all
    // move with it — this asserts the docs and the constant agree.
    const source = readFileSync(resolve(REPO_ROOT, DECLARATION), 'utf8');
    expect(source).toContain('export const PHASE_RETRY_CONDITION_MAX_LEN = 512;');
  });

  it('no other module puts a numeric bound on retryCondition', () => {
    // Catches the two shapes that actually occur: a local constant named for the
    // field, and a literal or foreign constant handed to a truncation helper on a
    // `retryCondition` argument. `INSTRUCTION_MAX` in the projection was the
    // second shape, which is why it is spelled out rather than left to a
    // name-based rule.
    //
    // The numeric comparison excludes `> 0`, because that is a presence test and
    // not a bound — `pipeline-config.ts:163` and `phase.ts:105` both ask whether a
    // condition was written at all, which is the question they should be asking.
    // A real second bound compares against a positive number, and a comparison
    // against `PHASE_RETRY_CONDITION_MAX_LEN` is not a numeric literal at all, so
    // the correct call sites fall outside this pattern by construction.
    const OFFENDING = [
      /const\s+RETRY_CONDITION_[A-Z_]*(MAX|LEN|LIMIT)[A-Z_]*\s*=\s*\d/,
      /retryCondition[^\n]*,\s*(INSTRUCTION_MAX|DESCRIPTION_MAX|SKILL_MAX|MODEL_MAX|MESSAGE_MAX)\b/,
      /retryCondition[^\n]*\.slice\(\s*0\s*,\s*\d+\s*\)/,
      /retryCondition[^\n]*\.length\s*>=?\s*(?!0\b)\d+/
    ];
    const offenders: string[] = [];
    for (const rel of ALL_FILES) {
      if (rel === DECLARATION) continue;
      const source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      for (const pattern of OFFENDING) {
        if (pattern.test(source)) offenders.push(`${rel} :: ${pattern}`);
      }
    }
    expect(
      offenders,
      `A second bound on retryCondition. Import PHASE_RETRY_CONDITION_MAX_LEN from contracts/process-definitions instead:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('neither copy of the DSL module holds or imports the bound', () => {
    // The parameter exists so this stays true. An import here would fail the parity
    // mirror or the inert lint, but by then the design has already been lost.
    //
    // Naming the constant in prose is not holding it: the docstring says where the
    // bound lives and why it arrives as an argument, and that sentence is the only
    // place a reader learns the parameter is not an oversight. So what is forbidden
    // is a declaration or an import — the two shapes that would make this module
    // own the number — not the mention.
    for (const rel of ['src/lib/retry-condition.ts', 'webview-ui/src/lib/retry-condition.ts']) {
      const source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      const lines = source.split('\n');
      expect(source, `${rel} must not declare the constant`).not.toMatch(
        /\bPHASE_RETRY_CONDITION_MAX_LEN\s*[:=]/
      );
      expect(
        lines.filter((line) => /^import\b/.test(line)),
        `${rel} must import nothing`
      ).toEqual([]);
      // Belt and braces: an inline `require`, a dynamic `import(...)`, or a
      // re-export would each dodge the line-anchored check above.
      expect(
        lines.filter((line) => /\b(require\(|import\(|export\s+\{)/.test(line)),
        `${rel} must not reach outside itself by any route`
      ).toEqual([]);
    }
  });

  it('both runner parse sites pass the bound', () => {
    // Without these the optional parameter is dead code and the DSL guard never
    // runs in production. The validators refuse first on both authoring routes, so
    // the runner is where a body that predates the bound is caught.
    const SITES: readonly string[] = [
      'src/controller/phase.ts',
      'src/controller/phase-retry-evaluator.ts'
    ];
    for (const rel of SITES) {
      const source = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      expect(source, `${rel} must pass the bound to validate()`).toMatch(
        /\(\s*(source|expression)\s*,\s*PHASE_RETRY_CONDITION_MAX_LEN\s*\)/
      );
    }
  });
});

describe('the scheduled-start coordinator stays read-only (111, FR-018, SC-015)', () => {
  const COORDINATOR = 'src/services/scheduled-start-coordinator.ts';

  it('imports no filesystem module', () => {
    const source = readFileSync(resolve(REPO_ROOT, COORDINATOR), 'utf8');
    const imports = source.split('\n').filter((line) => /^import\b/.test(line));
    expect(imports.length, 'the file must have imports, or this asserts nothing').toBeGreaterThan(0);
    const fsImports = imports.filter((line) => /'node:fs|'fs'|'node:fs\/promises'/.test(line));
    expect(
      fsImports,
      `FR-R3-002 (T284) made this class schedule timers and never persist. \`.schegent/\` is guaranteed by the audit writer on the arm path, which \`tests/integration/scheduled-start-activation-proxy.test.ts\` pins:\n${fsImports.join('\n')}`
    ).toEqual([]);
  });

  it('never calls the gitignore ensure directly', () => {
    const source = readFileSync(resolve(REPO_ROOT, COORDINATOR), 'utf8');
    expect(source).not.toContain('ensureSchegentGitignore');
    expect(source).not.toContain('mkdir');
  });
});
