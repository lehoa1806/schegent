// FR-R3-086 — the adapter's literal and the plan's table must mean the same
// thing by "unbounded".
//
// WHY BOTH EXIST. Four gates read each adapter's SOURCE TEXT to prove the
// permission posture — a posture proven from source cannot be quietly changed by
// a table somewhere else, which is what makes the FR-R3-031/032 disclosure
// trustworthy. So the default argv stays as an unconditional `const` literal at
// each adapter. The plan needs the same value to answer "what does the default
// set produce?".
//
// That is two authorities on one fact, which FR-R3-066 exists to remove. Neither
// can be derived from the other without losing the property the other provides,
// so the remedy available here is the second-best one: make them CHECK against
// each other. A drift in either direction fails.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/contracts/backend-kinds';
import { unboundedArgs } from '../../src/services/capability-enforcement-plan';

const REPO_ROOT = resolve(__dirname, '..', '..');

const ADAPTER: Readonly<Record<BackendRunnerKind, string>> = {
  claude: 'src/runner/claude-cli.ts',
  codex: 'src/runner/codex-cli.ts',
  agy: 'src/runner/agy-cli.ts'
};

const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/** The `UNBOUNDED_PERMISSION_ARGS` literal an adapter declares. */
function declaredLiteral(source: string): readonly string[] | null {
  const match = /const UNBOUNDED_PERMISSION_ARGS = \[([^\]]*)\];/.exec(source);
  if (match === null) return null;
  return [...(match[1] as string).matchAll(/'([^']*)'/g)].map((entry) => entry[1] as string);
}

describe('FR-R3-086 — the adapter literal and the plan agree on "unbounded"', () => {
  it('every adapter declares the literal as an unconditional module-scope const', () => {
    // The shape `backend-permission-posture.test.ts` can judge. If an adapter
    // stopped declaring it, that gate would go red too — but it would report a
    // missing posture rather than a drift, so both messages are worth having.
    for (const kind of SUPPORTED_BACKENDS) {
      expect(declaredLiteral(read(ADAPTER[kind])), `${kind} must declare the literal`).not.toBeNull();
    }
  });

  it('the literal each adapter declares equals what the plan calls unbounded', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      expect(
        declaredLiteral(read(ADAPTER[kind])),
        `${ADAPTER[kind]} and capability-enforcement-plan.ts disagree about ${kind}'s default argv. ` +
          `They are two authorities on one fact and must be changed together.`
      ).toEqual([...unboundedArgs(kind)]);
    }
  });

  it('every adapter passes its literal to the plan rather than a fresh array', () => {
    // A second inline literal at the call site would satisfy the equality above
    // while leaving the declared const dead — the drift this gate exists to stop,
    // wearing the shape of compliance.
    for (const kind of SUPPORTED_BACKENDS) {
      const source = read(ADAPTER[kind]);
      expect(source, `${ADAPTER[kind]} must pass UNBOUNDED_PERMISSION_ARGS`).toContain(
        'UNBOUNDED_PERMISSION_ARGS)'
      );
      const callSites = [...source.matchAll(/capabilityArgs\([^)]*\)/g)].map((match) => match[0]);
      expect(callSites.length).toBeGreaterThan(0);
      for (const call of callSites) {
        expect(call, `${ADAPTER[kind]}: capabilityArgs must not take an inline array`).not.toMatch(
          /\[\s*'/
        );
      }
    }
  });

  it('NON-VACUITY: a drifted literal is detected', () => {
    const drifted = "const UNBOUNDED_PERMISSION_ARGS = ['--some-other-flag'];";
    expect(declaredLiteral(drifted)).toEqual(['--some-other-flag']);
    expect(declaredLiteral(drifted)).not.toEqual([...unboundedArgs('claude')]);
    // ...and the extractor is not simply returning null for everything.
    expect(declaredLiteral(read(ADAPTER.claude))).toEqual(['--dangerously-skip-permissions']);
  });
});
