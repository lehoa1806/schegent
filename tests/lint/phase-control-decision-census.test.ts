import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-151 (T1625) — every public `PhaseControlService` mutation method must
 * route through the shared `decidePhaseControl` classifier before writing.
 *
 * WHY A SOURCE-TEXT CENSUS AND NOT A BEHAVIOR TEST. Behavior tests
 * (`tests/unit/controller/phase-control-service.test.ts`) can be satisfied
 * by a method that reimplements the same checks inline instead of calling
 * the shared function — that is exactly the "one authoritative rule set"
 * defect this feature closes, and a behavior test alone cannot distinguish
 * "calls the classifier" from "independently arrives at the same answer
 * today, and drifts from it tomorrow." Scanning each method's own body text
 * for the call is the cheap, durable guard against that drift, modeled on
 * the bijection census in `tests/lint/lint-gate-census-complete.test.ts`.
 *
 * WHAT IT DOES CHECK, BEYOND CALL-SITE PRESENCE. Each method's source text
 * is also checked for the shape a call whose result actually gates the
 * write must have: the result's `.eligible` is read (not discarded), and
 * that read happens before the method's own first recognized write call
 * (`store.setRun`, an auditor method, a `queue.*` cascade, or the shared
 * `setPhaseOverride` writer). A call present anywhere in the body — after
 * the write, or with its result never inspected — no longer passes.
 *
 * WHAT IT STILL DELIBERATELY DOES NOT CHECK. `removeTaskPhase`'s call is a
 * pass-through — the classifier's 'delete' branch is permissive by design
 * (Feature 022 FR-008–FR-013) — so this census does not prove every
 * method's *own* eligibility narrowed correctly, only that the shared gate
 * runs and is obeyed; the former is `phase-control-service.test.ts`'s job.
 */
const SERVICE_PATH = resolve(__dirname, '../../src/controller/phase-control-service.ts');

// The full, closed set of public mutation methods on PhaseControlService as
// of this feature (spec.md FR-001; data-model.md PhaseControlOperation).
const MUTATION_METHODS = [
  'pauseActivePhase',
  'resumeActivePhase',
  'restartActivePhase',
  'skipPhase',
  'disablePhase',
  'enablePhase',
  'removeTaskPhase',
  'setPhaseBreakpoint',
  'clearPhaseBreakpoint'
] as const;

/**
 * The source text of one `public async <name>(...): ReturnType { ... }`
 * method body.
 *
 * Two passes are needed, not one: first, find where the body's own opening
 * `{` actually is — a naive "first `{` after the method name" is wrong
 * whenever the return type itself contains an inline object type (e.g.
 * `removeTaskPhase`'s `Promise<MutationResult & { priorPhaseState?: string;
 * runId?: string }>`), so this walks paren/bracket/angle depth from the
 * method name and only accepts a `{` as the body start once all three are
 * back to zero (i.e., the parameter list and any generic return type have
 * fully closed). Second, from that real body start, walk brace depth to the
 * matching close — a regex alone cannot bound a body that itself contains
 * nested `{}` (object literals, arrow functions).
 */
function extractMethodBody(source: string, methodName: string): string {
  const signature = new RegExp(`public async ${methodName}\\s*\\(`);
  const startMatch = signature.exec(source);
  if (!startMatch) {
    throw new Error(
      `could not find "public async ${methodName}(" in phase-control-service.ts — has it been renamed or removed?`
    );
  }

  let parenDepth = 0;
  let angleDepth = 0;
  let bracketDepth = 0;
  let bodyStart = -1;
  for (let i = startMatch.index; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === '<') angleDepth++;
    else if (ch === '>') {
      if (angleDepth > 0) angleDepth--;
    } else if (ch === '{' && parenDepth === 0 && angleDepth === 0 && bracketDepth === 0) {
      bodyStart = i;
      break;
    }
  }
  if (bodyStart === -1) {
    throw new Error(`could not find the body-opening brace for ${methodName} in phase-control-service.ts`);
  }

  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

describe('every PhaseControlService mutation routes through decidePhaseControl (FR-R3-151, T1625)', () => {
  const source = readFileSync(SERVICE_PATH, 'utf8');

  it('imports the shared decision function', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bdecidePhaseControl\b[^}]*\}\s*from\s*['"]\.\/phase-control-decision['"]/
    );
  });

  it('names the closed set of mutation methods this census governs — no method added silently', () => {
    // Vacuity control, mirroring lint-gate-census-complete.test.ts: if this
    // list and the file's actual public-async method count silently
    // diverge, every `it.each` below could still pass while covering less
    // than the real surface.
    const publicMethodNames = [...source.matchAll(/public async (\w+)\s*\(/g)].map((match) => match[1]);
    expect(new Set(publicMethodNames)).toEqual(new Set(MUTATION_METHODS));
  });

  // Vacuity control for `WRITE_CALL_PATTERN` below, mirroring the method
  // census above: the pattern is a hand-named list, not a computed one, so
  // nothing else forces it to grow when `PhaseControlServiceDeps`'/
  // `PhaseControlAuditor`'s mutating surface does. This ties it to those
  // declarations directly instead.
  const READ_ONLY_STORE_METHODS = new Set(['getRun', 'getQueue', 'runCommitClaim']);

  it('the write-call pattern below stays exhaustive of the store/auditor/queue methods this service can call', () => {
    const storeGroup = /store:\s*Pick<\s*WorkspaceStateStore,\s*([^>]+)>/.exec(source)?.[1] ?? '';
    const queueGroup = /queue:\s*Pick<\s*QueueManager,\s*([^>]+)>/.exec(source)?.[1] ?? '';
    const auditorBody = /interface PhaseControlAuditor \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(
      storeGroup !== '' && queueGroup !== '' && auditorBody !== '',
      'could not find the store:/queue: Pick<...> deps types or the PhaseControlAuditor ' +
        'interface in phase-control-service.ts — has PhaseControlServiceDeps changed shape?'
    ).toBe(true);

    const quotedNames = (group: string): string[] =>
      [...group.matchAll(/'(\w+)'/g)].map((match) => match.at(1) ?? '');
    const storeMethods = quotedNames(storeGroup).filter((name) => !READ_ONLY_STORE_METHODS.has(name));
    const queueMethods = quotedNames(queueGroup);
    const auditorMethods = [...auditorBody.matchAll(/^\s*(\w+)\(/gm)].map((match) => match.at(1) ?? '');

    const writePatternSource = WRITE_CALL_PATTERN.source;
    for (const name of [...storeMethods, ...queueMethods, ...auditorMethods]) {
      expect(
        writePatternSource.includes(name),
        `PhaseControlServiceDeps gained or renamed a mutating method ('${name}') that ` +
          'WRITE_CALL_PATTERN does not name, so the before-any-write census below can no ' +
          'longer see calls to it. Add it to the pattern (or, if it is genuinely ' +
          'non-mutating, to READ_ONLY_STORE_METHODS here).'
      ).toBe(true);
    }
  });

  // The write calls a mutation method's own body can reach — `store.updateRun`
  // (FR-R4-F01: every Run write in this service is a field update, reached through
  // the private `patchRun` helper, which is the name a method body shows) and
  // `setWatchdog`, every auditor method, every `queue.*` cascade, and the
  // shared `setPhaseOverride` writer `skipPhase`/`disablePhase` route
  // through — named explicitly rather than matched by a broad `\w+`, so this
  // stays a census of known write shapes instead of quietly widening to
  // match anything call-shaped.
  const WRITE_CALL_PATTERN =
    /\b(?:store\.updateRun|this\.patchRun|store\.setWatchdog|auditor\.appendPhaseControl|auditor\.appendBreakpoint|auditor\.emitTaskPaused|auditor\.emitPhaseJumped|queue\.cascadedPause|queue\.cascadedResume|queue\.setQueuePausedState|this\.setPhaseOverride)\s*\(/g;

  for (const method of MUTATION_METHODS) {
    it(`${method} calls decidePhaseControl, reads its eligible result, and does so before any write`, () => {
      const body = extractMethodBody(source, method);
      const decisionIndex = body.indexOf('decidePhaseControl(');
      expect(
        decisionIndex,
        `${method}() does not reference decidePhaseControl(...) — a public Phase-control ` +
          'mutation must consult the shared classifier before writing (spec.md FR-001, FR-008).'
      ).toBeGreaterThanOrEqual(0);

      // A call whose result is discarded gates nothing — every method here
      // uses the `if (!decision.eligible) return ...` early-exit shape, so
      // '.eligible' must actually be read off the result.
      const eligibleIndex = body.indexOf('.eligible', decisionIndex);
      expect(
        eligibleIndex,
        `${method}() calls decidePhaseControl(...) but never reads '.eligible' off the ` +
          'result — a call whose outcome is discarded cannot gate anything.'
      ).toBeGreaterThan(decisionIndex);

      // And that gate must run before this method's own first write, not
      // merely appear somewhere in the same body.
      WRITE_CALL_PATTERN.lastIndex = 0;
      const firstWrite = WRITE_CALL_PATTERN.exec(body);
      if (firstWrite) {
        expect(
          eligibleIndex,
          `${method}() reaches a write (${firstWrite[0]}...) before checking ` +
            "decidePhaseControl's '.eligible' result — the gate must run before any write."
        ).toBeLessThan(firstWrite.index);
      }
    });
  }
});
