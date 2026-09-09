import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveTaskStatusWriterCandidates,
  type CandidateSite
} from './task-status-writer-derivation';

/**
 * FR-R3-153 (T1637), rewritten by feature 200 (FR-R3-161) — every Task status
 * writer in `src/` must route through the shared `decideTaskTransition`
 * classifier before writing.
 *
 * WHAT THIS GATE PROVES. The population is **derived** from source text by
 * `./task-status-writer-derivation`, not listed here. Every site the derivation
 * selects must be either *enrolled* — its enclosing declaration calls
 * `decideTaskTransition(` and reads `.eligible` off the result — or *exempt*,
 * named in `EXEMPTIONS` below with a written reason. A candidate that is
 * neither turns this file red. That is what fail-closed means, and it is the
 * property that distinguishes this gate from the one it replaces.
 *
 * WHAT IT REPLACED, and why. Until feature 200 this file carried a
 * hand-maintained five-name `WRITERS` array and a header that said so: "this
 * file discovers nothing: it checks the writers it lists and is silent about
 * any writer it does not." That header was honest and the gate was still wrong.
 * It had never seen `src/state/queue-state-migrator.ts`'s surplus in-flight
 * demotion, which really does change an existing Task's status without
 * consulting anything — the exact defect the census exists to report, invisible
 * to it for as long as the population was a list someone had to remember to
 * extend. It is exempt below, by name and with its reason, which is a decision
 * a reader can now weigh.
 *
 * The old header also deferred enrolling `QueueManager.cancel`, on the grounds
 * that the classifier had no `cancel` operation to route it through. Research
 * F3/F4 showed that reasoning applied only to a routine no live caller reached;
 * feature 200 deleted `cancel` outright on 2026-09-04 rather than enrolling it,
 * and the deletion is what closes that gap. It is named here only as the record
 * of its removal.
 *
 * WHAT IT DOES NOT PROVE, stated because a gate that overstates itself is how
 * the last one went wrong:
 *
 *   - It is a SOURCE-TEXT gate. It proves the call is present in the enclosing
 *     declaration, not that the decision is honoured. A writer could call the
 *     classifier, read `.eligible`, and ignore it. The behaviour tests in
 *     `tests/integration/task-transition-decision.test.ts` cover that; this
 *     file covers the drift a behaviour test cannot catch, where a writer
 *     reimplements the classifier's checks inline and passes on its own terms.
 *   - Enrolment is checked at DECLARATION granularity, not per write. A
 *     declaration with two writes, one of them behind the classifier, reads as
 *     enrolled. The per-declaration site counts in `EXEMPTIONS` close that hole
 *     for the exempt half; for the enrolled half it is a known limit.
 *   - The derivation is deliberately OVER-INCLUSIVE (contract C4.4). Some
 *     candidates below are not Task status writers at all — they write a
 *     workflow run, whose status vocabulary shares spellings with the Task's.
 *     They are exempt as *non-writers*, which is a different claim from the one
 *     exemption that is a real writer, and each reason says which it is.
 *
 * Contract: specs/200-cancel-removal-transition-table/contracts/
 * task-status-writer-census.md (C1-C8).
 */

const SRC_ROOT = resolve(__dirname, '../../src');
const FIXTURE_ROOT = resolve(__dirname, 'fixtures');

/**
 * The two kinds of exemption. Contract C5.1 requires every reason to make plain
 * which one it is, because only one of them carries risk: a reader who cannot
 * tell a writer the classifier cannot serve from a candidate that was never a
 * writer has no way to know which line to argue with.
 */
type ExemptionKind = 'not-a-writer' | 'writer-the-classifier-cannot-serve';

interface Exemption {
  /** File, relative to `src/`. Paired with the declaration to form the key. */
  readonly file: string;
  /** The enclosing declaration's name. Never a line number (contract C8.5). */
  readonly declaration: string;
  readonly kind: ExemptionKind;
  readonly reason: string;
  /**
   * How many candidate sites this declaration is exempt for. A second write
   * appearing inside an already-exempt declaration is a new decision, not a
   * covered one, so it must turn the gate red and be argued on its own terms.
   */
  readonly sites: number;
}

const EXEMPTIONS: readonly Exemption[] = [
  // FR-R3-161 (T033) — 2026-09-04. `queue-manager.ts#cancel` was exempt here as
  // 'writer-the-classifier-cannot-serve', on the grounds that it was scheduled
  // for deletion in this same feature. T032 deleted it, so the exemption goes
  // with it rather than outliving its subject: an exemption for a declaration
  // that no longer exists is a line no reader can evaluate, and the derivation
  // would never produce the candidate it excuses. The population drops from 10
  // candidates to 9 — 5 enrolled, 4 exempt.
  {
    file: 'queue/queue-manager.ts',
    declaration: 'resumeMatchingRunForQueue',
    kind: 'not-a-writer',
    sites: 1,
    reason:
      'Not a Task status writer. It writes a WORKFLOW RUN — `{ ...matching, status: ... }` over a ' +
      'WorkflowRun, whose status vocabulary shares spellings with the Task\'s. The derivation ' +
      'selects it because a mechanical rule cannot tell the two entities apart (contract C4.4); ' +
      'FR-009\'s third exclusion rules it out semantically.'
  },
  {
    file: 'controller/workflow-controller.ts',
    declaration: 'resumeExistingOnQueue',
    kind: 'not-a-writer',
    sites: 1,
    reason:
      'Not a Task status writer. It writes a WORKFLOW RUN back to `running` when resuming. Same ' +
      'entity confusion as `resumeMatchingRunForQueue`, same reason for the selection.'
  },
  {
    file: 'state/queue-state-migrator.ts',
    declaration: 'liftLegacyRequests',
    kind: 'not-a-writer',
    sites: 1,
    reason:
      'Not a Task status writer. It REBUILDS a record while lifting legacy persisted state, ' +
      'normalizing an unvalidated value into the current shape. There is no source status to ' +
      'transition from, so there is no edge for the classifier to decide.'
  },
  {
    file: 'state/queue-state-migrator.ts',
    declaration: 'migrateV5ToV6',
    kind: 'writer-the-classifier-cannot-serve',
    sites: 1,
    reason:
      'A REAL Task status writer, and the one exemption on this list that a reviewer must ' +
      'actually weigh. It demotes surplus in-flight rows to pending during the multi-queue ' +
      'coalesce. It runs at extension activation as a forward-only state migration, before any ' +
      'queue is live, so the classifier\'s own inputs — whether the addressed queue owns the ' +
      'task, and whether a different task holds the queue\'s execution slot — do not exist yet. ' +
      'Enrolling it is explicitly out of scope (contract C6). This is also the site that ' +
      'justified replacing the hand-maintained list: that list never saw it.'
  }
];

const CANDIDATES: readonly CandidateSite[] = deriveTaskStatusWriterCandidates(SRC_ROOT);

/** `file::declaration`, the key the gate classifies on. */
const keyOf = (site: Pick<CandidateSite, 'file' | 'declaration'>): string =>
  `${site.file}::${site.declaration}`;

/**
 * A candidate is enrolled when its enclosing declaration calls the classifier
 * and then reads `.eligible` off the result. A call whose outcome is discarded
 * cannot gate anything, so the ordering matters.
 */
function isEnrolled(site: CandidateSite): boolean {
  const call = site.enclosingBody.indexOf('decideTaskTransition(');
  if (call < 0) return false;
  return site.enclosingBody.indexOf('.eligible', call) > call;
}

const describeSite = (site: CandidateSite): string =>
  `${site.file}:${site.line} (${site.declaration}) — ${site.literal.replace(/\s+/g, ' ').slice(0, 120)}`;

describe('every Task status writer routes through decideTaskTransition (FR-R3-153; derived by FR-R3-161)', () => {
  it('derives a non-empty population — a gate over nothing proves nothing', () => {
    expect(
      CANDIDATES.length,
      'the derivation selected no sites at all under src/. A stage has regressed; every ' +
        'assertion below would pass vacuously.'
    ).toBeGreaterThan(0);
  });

  it('classifies every candidate as either enrolled or exempt, and fails on anything else', () => {
    const exemptKeys = new Set(EXEMPTIONS.map(keyOf));
    const unclassified = CANDIDATES.filter(
      (site) => !isEnrolled(site) && !exemptKeys.has(keyOf(site))
    );

    expect(
      unclassified.map(describeSite),
      'a site takes an already-existing Task and commits it with a different status without ' +
        'consulting decideTaskTransition, and it is not exempt. Either route it through the ' +
        'classifier, or add it to EXEMPTIONS with a written reason saying which kind of ' +
        'exemption it is (contract C3, C5.1). Leaving it unclassified is the drift this gate exists to report.'
    ).toEqual([]);
  });

  // Feature 195 (T063, FR-025, BUG-001) — 2026-09-08. Five enrolled became
  // six: `QueueManager.attestCompleted`, the writer behind FR-025's attested
  // `failed -> completed` edge. It needed no `EXEMPTIONS` row and no change to
  // the derivation — the mechanical rule selected it and `isEnrolled`
  // classified it, because it routes through `decideTaskTransition` like the
  // other five. This count was the whole of the required edit, which is the
  // gate working as feature 200's FR-009 intended: a new status writer is a
  // failing assertion naming the new site, not an invisible addition.
  it('reports the population as six enrolled and four exempt (contract C5)', () => {
    const enrolled = CANDIDATES.filter(isEnrolled);
    const exempt = CANDIDATES.filter((site) => !isEnrolled(site));

    expect(
      { enrolled: enrolled.length, exempt: exempt.length, total: CANDIDATES.length },
      `derived population changed.\nenrolled:\n  ${enrolled.map(describeSite).join('\n  ')}\n` +
        `exempt:\n  ${exempt.map(describeSite).join('\n  ')}`
    ).toEqual({ enrolled: 6, exempt: 4, total: 10 });
  });

  it('imports decideTaskTransition in every file that has an enrolled candidate', () => {
    const files = new Set(CANDIDATES.filter(isEnrolled).map((site) => site.file));
    for (const file of files) {
      const source = readFileSync(resolve(SRC_ROOT, file), 'utf8');
      expect(
        source,
        `${file} has an enrolled writer but does not import decideTaskTransition — the call the ` +
          'enrolment check found is therefore not the shared classifier.'
      ).toMatch(
        /import\s*\{[^}]*\bdecideTaskTransition\b[^}]*\}\s*from\s*['"][^'"]*task-transition-decision['"]/
      );
    }
  });
});

describe('the EXEMPTIONS table itself (contract C8 invariants 3 and 5, C5.1)', () => {
  it('has no stale entry — every exemption names a site the derivation still selects', () => {
    const candidateKeys = new Set(CANDIDATES.map(keyOf));
    const stale = EXEMPTIONS.filter((entry) => !candidateKeys.has(keyOf(entry)));

    expect(
      stale.map(keyOf),
      'an exemption names a site the derivation no longer selects. The exemption has outlived ' +
        'the thing it excused; delete it, or find out why the derivation stopped seeing the site.'
    ).toEqual([]);
  });

  it('covers exactly the sites it claims — a new write in an exempt declaration is a new decision', () => {
    const actual = new Map<string, number>();
    for (const site of CANDIDATES) {
      actual.set(keyOf(site), (actual.get(keyOf(site)) ?? 0) + 1);
    }
    const drifted = EXEMPTIONS.filter((entry) => actual.get(keyOf(entry)) !== entry.sites).map(
      (entry) => `${keyOf(entry)}: exempt for ${entry.sites}, found ${actual.get(keyOf(entry)) ?? 0}`
    );

    expect(
      drifted,
      'an exempt declaration gained or lost a status write. An exemption covers the writes that ' +
        'were argued for, not any future write that lands in the same function.'
    ).toEqual([]);
  });

  it('gives every exemption a reason that says which of the two kinds it is', () => {
    for (const entry of EXEMPTIONS) {
      expect(entry.reason.length, `${keyOf(entry)} has no reason`).toBeGreaterThan(60);
    }
    // Contract C5.1: the steady state is ONE exempt writer and the rest
    // non-writers, and as of T033 the gate is AT that steady state — `cancel`
    // was the transient second one and went with its method. If this list grows,
    // a real writer has been excused and the change needs argument, not a table
    // entry. Asserted as the list rather than the count so the argument names
    // its subject.
    const writers = EXEMPTIONS.filter((e) => e.kind === 'writer-the-classifier-cannot-serve');
    expect(writers.map((e) => e.declaration).sort()).toEqual(['migrateV5ToV6']);
  });
});

/**
 * Feature 200 (FR-R3-161) T016-T018 — the three exclusions of FR-009, asserted
 * as properties of the derivation rather than trusted as design intent.
 *
 * Each is written so it CANNOT pass vacuously: before asserting that a site is
 * absent from the population, the test asserts that the file is in scope and
 * that the subject still exists. An exclusion test whose subject has been
 * renamed away is a test that passes because there is nothing left to exclude.
 */
describe('the derivation excludes creation, projection and another entity by construction (FR-009)', () => {
  const sourceOf = (file: string): string => readFileSync(resolve(SRC_ROOT, file), 'utf8');
  const filesWithCandidates = new Set(CANDIDATES.map((site) => site.file));

  it('T016 — excludes CREATION: enqueue builds a fresh literal with no leading spread', () => {
    const file = 'queue/queue-manager.ts';
    const source = sourceOf(file);

    // Anti-vacuity: the file is in scope (both stage terms match) and it really
    // does have candidates, so absence below is a decision and not an accident.
    expect(source).toMatch(/\bFeatureRequest\b/);
    expect(source).toMatch(/\brequests\b/);
    expect(filesWithCandidates.has(file)).toBe(true);
    // Anti-vacuity: the subject still exists.
    expect(source, 'enqueue has been renamed or removed — this exclusion has no subject').toMatch(
      /public async enqueue\s*\(/
    );

    expect(
      CANDIDATES.filter((site) => site.declaration === 'enqueue'),
      'enqueue was selected as a candidate. Creating a Task is not writing a status: there is no ' +
        'source status and therefore no edge to decide (FR-009, first exclusion). If enqueue now ' +
        'builds its record by spreading an existing one, that is a real change and not a gate bug.'
    ).toEqual([]);
  });

  it('T017 — excludes PROJECTORS: they build flat literals field by field, with no spread', () => {
    // Three of the four are IN the population — they name both stage terms — so
    // stage 2 is what excludes them, exactly as FR-009's second exclusion
    // claims. The fourth, pipeline-catalog.ts, never names the Task record at
    // all and is excluded one stage earlier; asserted separately so the two
    // different reasons are not blurred into one.
    for (const file of [
      'ui/sidebar/snapshot-composer.ts',
      'ui/sidebar/queue-runtime-composer.ts',
      'ui/sidebar/queue-projector.ts'
    ]) {
      const source = sourceOf(file);
      expect(source, `${file} no longer names FeatureRequest`).toMatch(/\bFeatureRequest\b/);
      expect(source, `${file} no longer names requests`).toMatch(/\brequests\b/);
      expect(
        CANDIDATES.filter((site) => site.file === file).map(describeSite),
        `${file} is a projector: it copies a Task's status onto a view model, which changes ` +
          'nothing about the Task (FR-009, second exclusion). Being selected means it now ' +
          'spreads and rewrites a Task record.'
      ).toEqual([]);
    }

    const catalog = sourceOf('config/pipeline-catalog.ts');
    expect(
      catalog.match(/\bFeatureRequest\b/g),
      'config/pipeline-catalog.ts now names the Task record. It was excluded at stage 1, not ' +
        'stage 2; re-check which exclusion applies before trusting this row.'
    ).toBeNull();
  });

  it('T018 — excludes WORKFLOW-RUN writers at stage 1: they never name the Task record', () => {
    for (const file of [
      'services/run-driver.ts',
      'controller/phase.ts',
      'controller/retry-handler.ts',
      'controller/task-deletion.ts'
    ]) {
      const source = sourceOf(file);
      expect(
        source.match(/\bFeatureRequest\b/g),
        `${file} writes a status onto a WorkflowRun and is excluded because it does not know ` +
          'what a Task is (FR-009, third exclusion; contract C4.2 — the status VALUES it writes ' +
          'are the same spellings a Task uses, which is precisely why the population may never ' +
          'be anchored on a value). It now names FeatureRequest, so that reasoning no longer ' +
          'holds and the file needs a disposition.'
      ).toBeNull();
      expect(CANDIDATES.filter((site) => site.file === file)).toEqual([]);
    }
  });

  it('T019 — anchoring on FeatureRequestStatus instead of FeatureRequest would MISS an enrolled writer', () => {
    // AGENTS.md rule 67, pinned by the case that breaks if the answer changes.
    // `restart-canceled-task.ts` is enrolled and writes its status UNCAST, so a
    // population anchored on the cast — the obvious, tighter-looking term —
    // would not contain the file at all. Contract C4.3.
    const file = 'commands/restart-canceled-task.ts';
    const source = sourceOf(file);

    expect(
      CANDIDATES.some((site) => site.file === file && isEnrolled(site)),
      `${file} is no longer an enrolled candidate — this regression test has lost its subject`
    ).toBe(true);

    expect(
      source.match(/\bFeatureRequestStatus\b/g),
      `${file} now names FeatureRequestStatus. The evidence for anchoring the population on ` +
        'FeatureRequest rather than on the cast was that this enrolled writer does not use the ' +
        'cast. Re-derive that decision before relaxing the term.'
    ).toBeNull();
    expect(source).toMatch(/\bFeatureRequest\b/);
  });
});

/**
 * Feature 200 (FR-R3-161) T012 — the negative control. Spec FR-009a, contract C7.
 *
 * The derivation is a pure function of a root directory precisely so it can be
 * called twice: once over `src/` (the real gate above) and once over this
 * fixture directory (the control). The control's subject is a planted writer
 * that satisfies all three derivation stages and calls no classifier.
 *
 * The second assertion is the one that makes this a control rather than a
 * decoration: the reported list must be NON-EMPTY. A derivation that silently
 * returned nothing — because a stage regressed, or because the fixture was
 * deleted — would satisfy a "no unexpected sites" check while proving nothing.
 */
describe('the derivation reports a planted unenrolled writer (FR-009a, contract C7)', () => {
  it('finds the fixture site, and finds at least one site at all', () => {
    const candidates = deriveTaskStatusWriterCandidates(FIXTURE_ROOT);

    expect(
      candidates.length,
      'the derivation reported no candidate under tests/lint/fixtures/. Either a derivation ' +
        'stage has regressed or the negative-control fixture is missing. A control that passes ' +
        'when its subject is absent is not a control (contract C7).'
    ).toBeGreaterThan(0);

    expect(candidates.map((c) => c.declaration)).toContain('unenrolledTaskStatusWriter');

    const planted = candidates.find((c) => c.declaration === 'unenrolledTaskStatusWriter');
    expect(planted?.file).toContain('unenrolled-task-status-writer.fixture.ts');
    expect(planted?.enclosingBody).not.toContain('decideTaskTransition(');
  });

  it('never lets the fixture reach the real gate — the two roots are disjoint', () => {
    expect(CANDIDATES.some((site) => site.file.includes('fixture'))).toBe(false);
  });
});
