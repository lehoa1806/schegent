// FR-R3-154 (T1646) — the lifecycle refusal vocabulary is derived from the
// hosts that emit it, not from the spec's names for it.
//
// This test exists because its sibling, `queue-refusal-vocabulary.test.ts`,
// records what happens without it. `REFUSAL_TEXT` in `queue-control-ipc.ts` was
// first written from the refusals as the spec *named* them — `default-queue`,
// `in-flight-task`, `unknown-queue`, `connected-run-child`,
// `invalid-expression`, `out-of-range` — and not one of those six was a code
// any host site produced. Nothing failed: `refusalText` falls through to the
// raw code by design, so a wrong key is an error nowhere. It is prose the
// operator never sees, replaced by prose no operator can act on.
//
// `LIFECYCLE_REFUSAL_TEXT` in `lifecycle-control-ipc.ts` is the same shape with
// the same fall-through, written at the same distance from the emitting sites,
// so it is exposed to exactly the same defect. Two directions, because each
// catches a different half:
//
//   A1 — every derived code has an entry. A host refusal with no sentence is a
//        raw kebab-case code in the UI, which is the defect above in its next
//        form.
//   A2 — every entry is a derived code (or the one the webview synthesises).
//        This is the direction that would have caught the original: the six
//        invented keys were all *additions*, and A1 alone passes happily while
//        they sit there.
//
// Derivation is by slice, not by whole-file scan, wherever a file answers for
// more commands than these five. `decidePhaseControl` classifies eight
// operations and only three are posted by controls in this vocabulary; pulling
// in all eight would put skip, disable, enable and the breakpoint pair under a
// rule about controls that do not dispatch them, and the test would churn on
// changes it has no opinion about.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

const read = (...parts: string[]): string => readFileSync(resolve(REPO_ROOT, ...parts), 'utf8');

/** Every `'kebab-code'` appearing as a `reason:` in the given source slice. */
function reasonsIn(body: string): readonly string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\breason:\s*'([a-z][a-z0-9-]*)'/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/** Every `reject('kebab-code')` in the given source slice. */
function rejectsIn(body: string): readonly string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/\breject\('([a-z][a-z0-9-]*)'\)/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * One `case 'name': { ... }` arm of a switch, brace-matched from its opening
 * brace. `decidePhaseControl`'s arms each end in a `return`, so a slice that
 * over-reaches would show up as an extra derived code and fail A2 loudly
 * rather than silently widening the set.
 */
function switchArm(source: string, caseLabel: string): string {
  const start = source.indexOf(`case '${caseLabel}': {`);
  expect(start, `switch arm not found: ${caseLabel}`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced switch arm: ${caseLabel}`);
}

/**
 * The body of one method, from its signature to the next member at the same
 * indent — the same slicer `queue-refusal-vocabulary.test.ts` uses, for the
 * same reason: `PhaseControlService` answers refusals for a dozen operations
 * and only three are dispatched by this vocabulary.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `method not found: ${signature}`).toBeGreaterThan(-1);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:public|private|protected|\/\*\*)/);
  return end === -1 ? rest : rest.slice(0, end);
}

const soleRunResolver = read('src', 'controller', 'sole-run-resolver.ts');
const decision = read('src', 'controller', 'phase-control-decision.ts');
const service = read('src', 'controller', 'phase-control-service.ts');
const manualRetry = read('src', 'controller', 'manual-retry-override.ts');
const guardedRunService = read('src', 'services', 'guarded-run-service.ts');
const commandOutcome = read('src', 'contracts', 'command-outcome.ts');
const routerConstants = read('src', 'ui', 'sidebar', 'commands', 'constants.ts');
const handlerHelpers = read('src', 'ui', 'sidebar', 'commands', 'handler-helpers.ts');
const phaseControlCommands = read('src', 'commands', 'phase-control-commands.ts');
const retryPhaseNow = read('src', 'commands', 'retry-phase-now.ts');
const startQueue = read('src', 'commands', 'start-queue.ts');
const lifecycleIpc = read('webview-ui', 'src', 'lib', 'lifecycle-control-ipc.ts');

/**
 * Every reason the five lifecycle commands can put on an ACK, derived.
 *
 * Grouped by the layer that answers it, in the order a request passes through
 * them, because that order is the argument for the set being complete: a
 * refusal has to come from the primacy gate, the trust gate, the queue
 * resolver, the eligibility classifier, the service, or the command's own
 * catch. There is no seventh place.
 */
function derivedReasons(): readonly string[] {
  const found = new Set<string>();

  // 1. The router's primacy gate, ahead of every handler.
  for (const match of routerConstants.matchAll(/SECONDARY_REJECT = '([a-z][a-z0-9-]*)'/g)) {
    found.add(match[1]!);
  }

  // 2. The transport reasons the ACK layer synthesises — the trust refusal
  //    that returns `undefined`, an unrecognized result shape, a rejection the
  //    host declined to explain, and the route's own catch when dispatching
  //    the command threw. All four are declared as `*_REASON` constants, two
  //    files apart because the first three are decisions about a *result* and
  //    the fourth is a decision about the *dispatch*.
  for (const source of [commandOutcome, handlerHelpers]) {
    for (const match of source.matchAll(/_REASON = '([a-z][a-z0-9-]*)'/g)) {
      found.add(match[1]!);
    }
  }

  // 3. Queue addressing — `resolveControlTarget` forwards `resolveSoleRun`'s
  //    refusal verbatim, so the whole module is the slice.
  for (const reason of reasonsIn(soleRunResolver)) found.add(reason);

  // 4. Eligibility — only the three arms these controls dispatch.
  for (const operation of ['pause', 'resume', 'restart']) {
    for (const reason of rejectsIn(switchArm(decision, operation))) found.add(reason);
  }

  // 5. The service's own pre-decision guards, for the same three.
  for (const signature of [
    'public async pauseActivePhase(queueId: string): Promise<MutationResult> {',
    'public async resumeActivePhase(',
    'public async restartActivePhase(queueId: string): Promise<MutationResult> {'
  ]) {
    for (const reason of reasonsIn(methodBody(service, signature))) found.add(reason);
  }

  // 6. Retry now — the whole module answers for this one command only.
  for (const reason of reasonsIn(manualRetry)) found.add(reason);

  // 7. Start Queue's intent outcomes. These are not `reason:` literals: the
  //    command passes the service's own outcome word through as the reason
  //    (`refused(result.outcome)`), so they are derived from that union's
  //    declaration. `applied` is the acceptance and `noop` is renamed on the
  //    way out, so neither is a reason — see `start-queue.ts` for why `noop`
  //    gets a name of its own.
  const union = guardedRunService.match(
    /outcome: ('applied'(?:\s*\|\s*'[a-z][a-z0-9-]*')+)/
  );
  expect(union, 'applyStartQueueIntent outcome union not found').not.toBeNull();
  for (const match of union![1]!.matchAll(/'([a-z][a-z0-9-]*)'/g)) {
    const outcome = match[1]!;
    if (outcome !== 'applied' && outcome !== 'noop') found.add(outcome);
  }

  // 8. Each command's own refusal and failure codes — the `not-primary-window`
  //    guard, the renamed no-op, and the five `catch` blocks.
  for (const source of [phaseControlCommands, retryPhaseNow, startQueue]) {
    for (const match of source.matchAll(
      /\b(?:refused|failed|noOp)\('([a-z][a-z0-9-]*)'\)/g
    )) {
      found.add(match[1]!);
    }
    // `FAILURE_REASON`'s three values are keyed by action, not passed inline.
    for (const match of source.matchAll(/^\s*(?:pause|resume|restart): '([a-z][a-z0-9-]*)'/gm)) {
      found.add(match[1]!);
    }
  }

  return [...found].sort();
}

/** The keys `LIFECYCLE_REFUSAL_TEXT` actually carries. */
function tableKeys(): readonly string[] {
  const start = lifecycleIpc.indexOf('LIFECYCLE_REFUSAL_TEXT');
  expect(start, 'LIFECYCLE_REFUSAL_TEXT not found').toBeGreaterThan(-1);
  const end = lifecycleIpc.indexOf('});', start);
  expect(end, 'unterminated LIFECYCLE_REFUSAL_TEXT').toBeGreaterThan(-1);
  const body = lifecycleIpc.slice(start, end);
  const found = new Set<string>();
  // Quoted keys plus the one bare identifier key (`timeout`).
  for (const match of body.matchAll(/^\s*'([a-z][a-z0-9-]*)':/gm)) found.add(match[1]!);
  for (const match of body.matchAll(/^\s*([a-z][a-z0-9]*):\s*'/gm)) found.add(match[1]!);
  return [...found].sort();
}

/** Codes the webview answers for itself, with no host emitter. */
const WEBVIEW_SYNTHESISED: readonly string[] = ['timeout'];

describe('FR-R3-154 (T1646) — lifecycle refusal vocabulary matches the hosts that emit it', () => {
  it('derives a non-trivial set of reasons (guard against a broken slicer)', () => {
    // Without this, a slicer that silently matched nothing would make both
    // directions below vacuously true — the failure mode a derivation test is
    // most exposed to, because an empty set satisfies every subset assertion.
    const derived = derivedReasons();
    expect(derived.length).toBeGreaterThanOrEqual(20);
    // Spot-check one code from each layer, so a slice that stops matching is
    // reported by name rather than as a count.
    expect(derived).toContain('secondary-window-readonly'); // primacy gate
    expect(derived).toContain('workspace-not-trusted'); // trust gate
    expect(derived).toContain('ambiguous-run-target'); // queue resolver
    expect(derived).toContain('run-already-paused'); // eligibility classifier
    expect(derived).toContain('no-run-in-flight'); // service guard
    expect(derived).toContain('not-pending-retry'); // retry override
    expect(derived).toContain('rejected-horizon'); // start intent
    expect(derived).toContain('pause-phase-failed'); // command catch
  });

  it('A1 — every reason a host can answer has a sentence', () => {
    const missing = derivedReasons().filter((reason) => !tableKeys().includes(reason));
    expect(
      missing,
      `these reasons would reach the operator as raw codes: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('A2 — every sentence is for a reason a host can answer', () => {
    const derived = derivedReasons();
    const invented = tableKeys().filter(
      (key) => !derived.includes(key) && !WEBVIEW_SYNTHESISED.includes(key)
    );
    expect(
      invented,
      `these keys match no emitting site and are dead prose: ${invented.join(', ')}`
    ).toEqual([]);
  });

  it('names its own synthesised codes rather than exempting a pattern', () => {
    // A pattern-based exemption ("anything ending in -timeout") is how a
    // vocabulary drifts back: the next invented key finds a hole to sit in.
    for (const code of WEBVIEW_SYNTHESISED) {
      expect(tableKeys()).toContain(code);
      expect(derivedReasons()).not.toContain(code);
    }
  });
});
