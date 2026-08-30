// FR-R3-064 — every route that can reach a backend records the posture.
//
// WHY THIS IS A STRUCTURAL TEST AND NOT FOUR END-TO-END RUNS
//
// The claim is not "these four paths happened to emit when I drove them". It is
// "no path can reach a backend without emitting", and four passing end-to-end
// runs would say nothing about the fifth route somebody adds next quarter. That
// is the failure FR-R3-056's own docstring names: a check placed at one route is
// bypassed by every route that does not go through it.
//
// So the four routes are enumerated BY NAME, and each is resolved through the
// source to the single funnel — `PhaseRunner.run` — where
// `phase-runner-backend-posture.test.ts` proves the emission behaviourally. The
// two halves together are the coverage claim; neither is it alone.
//
// THE ROUTES, AND WHERE EACH JOINS THE FUNNEL
//
//   start        SchegentWorkflowController.startNew   → admitNew    → driveSession
//   resume       SchegentWorkflowController.resumeExisting → admitResume → driveSession
//   auto-drain   AutoDrainCoordinator                  → controller.admitNew /
//                                                        controller.admitResume → driveSession
//   continuation RunDriver.drive's own phase loop       → deps.runner.run (no new drive)
//
// `driveSession` → `sessions.acquire(queueId).driver.drive(...)` → `RunDriver.drive`
// → `deps.runner.run(inputs)` → `PhaseRunner.run`.
//
// WHAT THIS DOES NOT GUARANTEE
//
// It resolves NAMED call expressions in source. A route that reached a backend
// through a dynamically dispatched function, or by constructing its own runner
// outside the registry, would not be seen here — that is what
// `tests/lint/backend-posture-emission-funnel.test.ts` covers by enumerating
// every `BackendRunner.invoke` call site instead. Neither gate is the whole
// argument; the pair is.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const read = (relPath: string): string => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

const parse = (relPath: string): ts.SourceFile =>
  ts.createSourceFile(relPath, read(relPath), ts.ScriptTarget.ES2022, true);

/** Every called name inside one named member, at any depth. */
function calleesOf(relPath: string, memberName: string): Set<string> {
  return memberGraph(relPath).get(memberName) ?? missing(relPath, memberName);
}

function missing(relPath: string, memberName: string): never {
  throw new Error(`${memberName} not found in ${relPath}`);
}

/** member name → the names it calls. Built once per file, then cached. */
const graphCache = new Map<string, Map<string, Set<string>>>();

function memberGraph(relPath: string): Map<string, Set<string>> {
  const cached = graphCache.get(relPath);
  if (cached) return cached;
  const source = parse(relPath);
  const graph = new Map<string, Set<string>>();

  const collect = (node: ts.Node): void => {
    if (
      (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      node.body
    ) {
      const names = new Set<string>();
      const walk = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner)) {
          const target = inner.expression;
          if (ts.isPropertyAccessExpression(target)) names.add(target.name.getText(source));
          else if (ts.isIdentifier(target)) names.add(target.text);
        }
        ts.forEachChild(inner, walk);
      };
      walk(node.body);
      graph.set(node.name.getText(source), names);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  graphCache.set(relPath, graph);
  return graph;
}

/**
 * Does `entry` reach `target`, following calls through other members of the same
 * file?
 *
 * Transitive on purpose. The first draft of this test asserted one hop and was
 * wrong about two of the four routes: `admitResume` reaches `driveSession`
 * through `resumeExistingOnQueue`, and `RunDriver.drive` reaches the funnel
 * through `dispatchObserved`. A one-hop assertion would have had to name those
 * intermediates, which means every future refactor that inserts one more
 * intermediate breaks the test for a reason that has nothing to do with route
 * coverage. Reachability is the property; the hop count is not.
 */
function reaches(relPath: string, entry: string, target: string): boolean {
  const graph = memberGraph(relPath);
  if (!graph.has(entry)) missing(relPath, entry);
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const callees = graph.get(current);
    if (!callees) continue;
    if (callees.has(target)) return true;
    for (const callee of callees) if (graph.has(callee)) queue.push(callee);
  }
  return false;
}

const CONTROLLER = 'src/controller/workflow-controller.ts';
const DRIVER = 'src/services/run-driver.ts';
const AUTO_DRAIN = 'src/services/auto-drain-coordinator.ts';
const PHASE_RUNNER = 'src/controller/phase-runner.ts';
const RECORDER = 'src/controller/backend-posture-recorder.ts';

/**
 * The four routes, named. Each entry states the member that begins the route and
 * the member it must reach on the way to the funnel. A route added without a
 * line here is a route nobody has resolved — which is the finding, not an
 * oversight this test should paper over.
 */
const ROUTES: ReadonlyArray<{
  route: string;
  file: string;
  entry: string;
  mustReach: readonly string[];
}> = [
  { route: 'start', file: CONTROLLER, entry: 'startNew', mustReach: ['admitNew'] },
  { route: 'resume', file: CONTROLLER, entry: 'resumeExisting', mustReach: ['admitResume'] },
  {
    route: 'resume-on-activation',
    file: CONTROLLER,
    entry: 'resumeExistingFromActivation',
    mustReach: ['resumeExisting']
  },
  { route: 'continuation', file: DRIVER, entry: 'drive', mustReach: ['run'] }
];

describe('backend posture — every route reaches the funnel (FR-R3-064)', () => {
  it.each(ROUTES)('route "$route" reaches $mustReach', ({ file, entry, mustReach }) => {
    for (const target of mustReach) {
      expect(
        reaches(file, entry, target),
        `${entry} in ${file} no longer calls ${target}. If this route now reaches a backend by ` +
          'another path, that path needs its own line in ROUTES and its own resolution to ' +
          'PhaseRunner.run — a route nobody resolved is a run whose posture nobody records.'
      ).toBe(true);
    }
  });

  it('route "auto-drain" reaches the controller admission points', () => {
    const text = read(AUTO_DRAIN);
    // The coordinator does not drive; it admits through the controller, which is
    // the property that matters — it inherits the funnel rather than duplicating it.
    expect(text).toContain('this.controller.admitNew(');
    expect(text).toContain('this.controller.admitResume(');
  });

  it('both admission points funnel through driveSession', () => {
    for (const entry of ['admitNew', 'admitResume']) {
      expect(
        reaches(CONTROLLER, entry, 'driveSession'),
        `${entry} no longer reaches driveSession. Every admission must funnel there; a second ` +
          'drive path is a route whose posture nobody records.'
      ).toBe(true);
    }
  });

  it('driveSession dispatches to RunDriver.drive, and drive dispatches phases to the funnel', () => {
    expect(calleesOf(CONTROLLER, 'driveSession').has('drive')).toBe(true);
    // `deps.runner` is the injected PhaseRunner; `.run` is the funnel.
    expect(read(DRIVER)).toContain('await this.deps.runner.run(inputs)');
    expect(read(DRIVER)).toContain('readonly runner: PhaseRunner;');
  });

  it('the funnel emits the posture record before phase-start', () => {
    const text = read(PHASE_RUNNER);
    const emission = text.indexOf('await this.postureRecorder.recordOnce(');
    const phaseStart = text.indexOf("await this.appendAudit(inputs, 'phase-start'");
    expect(emission).toBeGreaterThan(-1);
    expect(phaseStart).toBeGreaterThan(-1);
    expect(
      emission,
      'the posture record must be emitted before phase-start — the posture a phase ran under is ' +
        'context for that phase record, not a footnote after it'
    ).toBeLessThan(phaseStart);
  });

  it('route "consent-retry" re-enters the same drive rather than becoming a fifth route', () => {
    // FR-R3-146 (FR-014) — the consent modal adds a RECOVERY, not a route. The retry
    // it triggers is the same `driveSession` thunk the first attempt used, so it
    // reaches `PhaseRunner.run` the same way and records the posture the same way —
    // including FR-R3-125's compounding warning, which `createBackendRunner` emits on
    // the construction that succeeds. (Behaviourally proved in
    // `tests/unit/runner/backend-runner-factory.test.ts`: the registry caches only on
    // success, so the granted construction is judged and warned afresh.)
    //
    // A retry that built its own runner, or drove by another path, would be exactly
    // the fifth route this file exists to forbid.
    const callees = calleesOf(CONTROLLER, 'admitNew');
    expect(callees.has('recoverOrReport')).toBe(true);
    expect(callees.has('driveSession')).toBe(true);

    const controller = read(CONTROLLER);
    expect(controller).toContain('const drive = (): Promise<void> => this.driveSession(');
    expect(controller).toContain('recoverOrReport(err, this.consent, drive,');

    for (const file of [
      CONTROLLER,
      'src/controller/uncontained-consent-gate.ts',
      'src/activation/uncontained-consent.ts'
    ]) {
      expect(
        read(file).includes('createBackendRunner('),
        `${file} constructs a backend runner. The consent path must recover through the ` +
          'existing drive, not build a runner beside the registry — a construction outside ' +
          'the funnel is a run whose posture nobody records.'
      ).toBe(false);
    }
  });

  it('the funnel is the only place the posture is emitted', () => {
    // A second emission site is how "exactly one per run" quietly becomes "one
    // per site that remembered". If a second site is ever justified, it belongs
    // in this list with its reason.
    const emitters = [RECORDER];
    const searched = [CONTROLLER, DRIVER, AUTO_DRAIN, 'src/extension.ts', PHASE_RUNNER, RECORDER];
    for (const file of searched) {
      const emits = read(file).includes("eventType: 'backend-posture-admitted'");
      expect(
        emits === emitters.includes(file),
        emits
          ? `${file} emits backend-posture-admitted but is not the declared emission site`
          : `${file} is the declared emission site but no longer emits backend-posture-admitted`
      ).toBe(true);
    }
  });
});
