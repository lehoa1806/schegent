import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { resolveGovernanceScope } from './envelope-presence';
import { reviewDateMarkerNames } from './review-dates';

const EXECUTION_REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(EXECUTION_REPO_ROOT, '..');
const SPECS_ROOT = resolve(ENVELOPE_ROOT, 'specs');

const SCOPE = resolveGovernanceScope();
const ENVELOPE_HERE = SCOPE.kind === 'envelope';

const ALLOWED_STATUSES = new Set([
  'Draft',
  'Ready',
  'In Progress',
  'Verification Pending',
  'Deferred',
  'Superseded',
  'Complete'
]);

interface SpecArtifact {
  readonly directory: string;
  readonly specPath: string;
  readonly tasksPath: string;
  readonly body: string;
  readonly status: string;
}

function readArtifacts(): readonly SpecArtifact[] {
  // FR-R3-118 — guarded. `SPECS_ROOT` is `../specs`, which does not exist in a
  // standalone clone.
  if (!ENVELOPE_HERE) return [];
  return readdirSync(SPECS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3}-/.test(entry.name))
    .map((entry) => {
      const directory = resolve(SPECS_ROOT, entry.name);
      const specPath = resolve(directory, 'spec.md');
      const tasksPath = resolve(directory, 'tasks.md');
      // FR-R3-058 — guarded, for the reason FR-R3-063 recorded when it guarded
      // `check-docs.mjs`: an unreadable required file threw ENOENT and killed the
      // whole run, so the one case this loop exists to notice was the one case it
      // could not report. A gate that crashes rather than reports is the same
      // defect as one that passes vacuously.
      let body: string;
      try {
        body = readFileSync(specPath, 'utf8');
      } catch {
        body = '';
      }
      const status = /^\*\*Status\*\*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? '';
      return { directory, specPath, tasksPath, body, status };
    });
}

describe('spec traceability governance', () => {
  const artifacts = readArtifacts();

  // Vacuity control. Every assertion below filters `artifacts` and expects
  // nothing left, so an empty list passes all of them. This gate is unusual in
  // scanning OUTSIDE the execution repo — SPECS_ROOT resolves through
  // `../specs`, into the planning envelope — which makes an empty scan the
  // likely state rather than the unlikely one: a checkout of repo/ alone, or a
  // renamed envelope directory, yields zero artifacts and a fully green suite.
  it.skipIf(!ENVELOPE_HERE)('reads the spec artifacts it governs', () => {
    expect(
      artifacts.length,
      `No NNN-prefixed spec directory was found under ${SPECS_ROOT}. Every assertion ` +
        `below is passing over an empty list — the planning envelope is not where ` +
        `this gate expects it.`
    ).toBeGreaterThan(20);
    // A status line must actually parse out of at least most of them. The regex
    // is anchored and multiline; a template change to the Status heading would
    // leave every status as '' and silently empty the vocabulary check.
    const withStatus = artifacts.filter((artifact) => artifact.status.length > 0);
    expect(
      withStatus.length,
      'No spec yielded a parsed **Status**: line. The status regex no longer matches ' +
        'the template, so the vocabulary assertion is comparing empty strings.'
    ).toBeGreaterThan(artifacts.length / 2);
  });

  it('uses only the authoritative status vocabulary', () => {
    const invalid = artifacts
      .filter((artifact) => !ALLOWED_STATUSES.has(artifact.status))
      .map((artifact) => `${basename(artifact.directory)}: ${artifact.status || '[missing]'}`);
    expect(invalid).toEqual([]);
  });

  it('does not classify specs as Complete while tasks remain unchecked', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Complete' && existsSync(artifact.tasksPath))
      .filter((artifact) => /^- \[ \]/m.test(readFileSync(artifact.tasksPath, 'utf8')))
      .map((artifact) => basename(artifact.directory));
    expect(invalid).toEqual([]);
  });

  /**
   * FR-R3-123 — the third edge of a triangle whose other two are above.
   *
   * The vocabulary rule checks that a status is a WORD THIS PROJECT USES. The rule
   * above it checks that `Complete` is not claimed over unfinished work. Neither
   * asks whether the word is TRUE, and `Draft` is always in the vocabulary — so a
   * shipped, merged, fully-ticked feature labelled `Draft` passed every check here.
   *
   * Measured 2026-08-27, before this rule existed: of 155 spec directories, **58
   * were fully ticked and still said they were not done** — 48 `Draft` and 10
   * `In Progress`.
   *
   * WHY IT IS A TABLE AND NOT A SENTENCE ABOUT `Draft`. The item that filed this
   * asked for "a fully-ticked spec may not say Draft". That leaves the identical
   * defect one word over, and ten specs were already sitting in it. The rule is
   * over (task state x status), in both directions.
   *
   * WHY THE SCAN IS CASE-INSENSITIVE, and this is not a detail: **80 specs mark
   * their tasks `- [X]` with a capital X.** A scan matching only `- [x]` reads every
   * one of them as having no tasks — which the exemption below then excuses — so the
   * gate would pass over more than half of `specs/` while reporting green. That is
   * the vacuity shape this round has spent itself closing, and it would have shipped
   * inside the gate written to close it. Both spellings are pinned by the fixture
   * test at the foot of this file.
   *
   * THE EXEMPTIONS ARE LOAD-BEARING, not convenience:
   *   * `Verification Pending` means done-and-awaiting-verification, so unchecked
   *     tasks AGREE with it — and so does a fully ticked list whose last acceptance
   *     step needs a commit that does not exist yet. (This line used to state how
   *     many specs sat there. It was one when written, is two now, and stating a
   *     count beside a population the gate recomputes is the drift `FR-R3-136`
   *     removed from the census generator. The exemption does not depend on it.)
   *   * `Deferred` and `Superseded` describe dispositions decoupled from how far the
   *     tasks got, and each already carries its own requirement below.
   *   * A spec with no `tasks.md` has no task state to compare. Judging it would mean
   *     inventing one.
   *
   * `Ready` JOINED THE SET ON 2026-09-06 (`FR-R3-170`). It was never an exemption —
   * it is simply absent from the list above, with no reason given, which is how
   * the docblock's own argument about "the identical defect one word over" came
   * to apply to the rule that makes it. `Ready` means specified and not yet
   * started, so a fully-ticked `Ready` spec is the same contradiction as a
   * fully-ticked `Draft`. Measured that day: `181-settings-surface-truth`, 46
   * ticked and 0 unticked, sitting at `Ready`. The other two `Ready` specs carry
   * no checkboxes at all, so `taskState` returns `none` and this rule does not
   * reach them — correctly, as neither claims finished work.
   */
  const STATUSES_CLAIMING_UNFINISHED = new Set(['Draft', 'Ready', 'In Progress']);

  /** Case-insensitive by requirement, not by accident. See the docblock. */
  const TICKED = /^\s*- \[[xX]\]/m;
  const UNTICKED = /^\s*- \[ \]/m;

  function taskState(tasksPath: string): 'none' | 'all-ticked' | 'has-unticked' {
    if (!existsSync(tasksPath)) return 'none';
    const body = readFileSync(tasksPath, 'utf8');
    if (UNTICKED.test(body)) return 'has-unticked';
    return TICKED.test(body) ? 'all-ticked' : 'none';
  }

  it('does not claim a spec is unfinished when every task is ticked', () => {
    const invalid = artifacts
      .filter((artifact) => STATUSES_CLAIMING_UNFINISHED.has(artifact.status))
      .filter((artifact) => taskState(artifact.tasksPath) === 'all-ticked')
      .map((artifact) => `${basename(artifact.directory)}: says '${artifact.status}', every task ticked`);
    expect(
      invalid,
      'These specs say they are unfinished and their task lists say otherwise. One of the ' +
        'two is false. Set the status to what is true — `Complete` if the work shipped, or ' +
        '`Superseded`/`Deferred` with what those require. Do NOT untick a task to silence ' +
        'this: the tick is the evidence, and the status is the claim about it.'
    ).toEqual([]);
  });

  it('scans both checkbox spellings, so a capital [X] is not read as no tasks', () => {
    // FR-R3-123 / FR-005a. 80 specs use `- [X]`. A case-sensitive scan reads them as
    // task-less and the `none` branch exempts them, so this fixture is what stands
    // between the rule above and a no-op over half the tree.
    const dir = mkdtempSync(resolve(tmpdir(), 'schegent-status-truth-'));
    try {
      const upper = resolve(dir, 'upper.md');
      const lower = resolve(dir, 'lower.md');
      const mixed = resolve(dir, 'mixed.md');
      const empty = resolve(dir, 'empty.md');
      writeFileSync(upper, '- [X] T001 done\n- [X] T002 done\n');
      writeFileSync(lower, '- [x] T001 done\n');
      writeFileSync(mixed, '- [X] T001 done\n- [ ] T002 not done\n');
      writeFileSync(empty, '# Tasks\n\nNo checkboxes here.\n');

      expect(taskState(upper), 'a capital [X] must count as ticked').toBe('all-ticked');
      expect(taskState(lower), 'a lowercase [x] must count as ticked').toBe('all-ticked');
      expect(taskState(mixed), 'an unticked box outranks ticked ones').toBe('has-unticked');
      expect(taskState(empty), 'no checkboxes is no task state').toBe('none');
      expect(taskState(resolve(dir, 'absent.md')), 'a missing file is no task state').toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * FR-R3-170 — `Verification Pending` was the one word in the vocabulary that
   * obliged nothing.
   *
   * Until this rule, the status appeared in this file exactly once: as an ABSENCE
   * from `STATUSES_CLAIMING_UNFINISHED`, which exempts it from the rule above.
   * That exemption is right and stays — unticked tasks genuinely do agree with
   * "awaiting verification". What was missing is the other half. Nothing was owed
   * in return, so a spec could rest there indefinitely with no owner, no date, and
   * no statement of what was actually being waited on.
   *
   * Measured 2026-09-06 across the three specs then holding the status: zero
   * occurrences of `backlog owner`, `review date` or `revisit` between them.
   * `014-wake-up` had said it for 25 days about a capability deleted from the
   * product on 2026-08-12 — 68 ticked tasks and nothing left to verify. Both rules
   * above passed over it in silence: not `Complete`, so the first never fired; not
   * in `STATUSES_CLAIMING_UNFINISHED`, so the second did not either.
   *
   * WHY THE DATE IS NOT IN THE SPEC. `dated-review-records.test.ts` resolves its
   * root as `repo/` and scans `repo/docs/**` for review-date markers, failing on
   * any it does not have registered. `specs/` is outside that scan, so a date
   * authored in a spec would be watched by nothing and registered nowhere — a
   * sixth marker home, which is the shape `FR-R3-134` spent a cycle removing. The
   * spec names the record; the record carries the date.
   *
   * WHY THE LINK IS RESOLVED AND NOT MERELY MATCHED. A link checked for shape
   * alone can be broken, or can point at a document no gate watches, and still
   * satisfy the rule — an obligation that obliges nothing, which is this feature's
   * own defect one level down. Rather than import the registry and couple two
   * gates, this asserts the target is a file under `repo/docs/` carrying a
   * review-date marker. The other gate separately fails on any marker under
   * `repo/docs/` that is not registered, so between them the target is registered.
   * (`**Successor**:` below still has the shape-only weakness. Fixing it was out
   * of scope for the item that wrote this, and it is noted so the next reader does
   * not mistake it for a considered difference.)
   */
  const VERIFICATION_PENDING_FIELDS = [
    // Reused, not duplicated: `Deferred` already reads this field name below, and
    // "who owes this" is one question deserving one answer.
    { name: '**Backlog owner**:', pattern: /^\*\*Backlog owner\*\*:\s*\S.+$/m },
    { name: '## Evidence owed', pattern: /^## Evidence owed\s*$/m },
    { name: '**Review record**:', pattern: /^\*\*Review record\*\*:\s*\[[^\]]+\]\([^)]+\)\s*$/m }
  ] as const;

  const DOCS_ROOT = resolve(EXECUTION_REPO_ROOT, 'docs');

  /** True when a document carries a review-date marker, whatever it is named. */
  const isDated = (file: string): boolean =>
    reviewDateMarkerNames(readFileSync(file, 'utf8')).length > 0;

  /** The `**Review record**:` href, resolved against the spec that carries it. */
  function reviewRecordTarget(specPath: string, body: string): string | null {
    const href = /^\*\*Review record\*\*:\s*\[[^\]]+\]\(([^)]+)\)\s*$/m.exec(body)?.[1];
    if (href === undefined) return null;
    return resolve(specPath, '..', href.replace(/#.*$/, ''));
  }

  /** Every obligation a `Verification Pending` body fails to meet, named for a reader. */
  function missingVerificationObligations(specPath: string, body: string): string[] {
    // Annotated `string[]` and not left to inference: `as const` above makes the
    // mapped result a literal union, and the three link diagnoses pushed below are
    // not members of it.
    const missing: string[] = VERIFICATION_PENDING_FIELDS.filter(
      (field) => !field.pattern.test(body)
    ).map((field) => field.name);
    const target = reviewRecordTarget(specPath, body);
    if (target === null) return missing;

    if (!existsSync(target)) {
      missing.push('**Review record**: names a file that does not exist');
    } else if (!target.startsWith(DOCS_ROOT + sep)) {
      missing.push('**Review record**: must point under repo/docs/, the only tree the registry watches');
    } else if (!isDated(target)) {
      missing.push('**Review record**: target carries no review-date marker, so no gate watches its date');
    }
    return missing;
  }

  it('names exactly the obligation a Verification Pending spec is missing', () => {
    // FR-011 — the control that survives the population emptying. Every spec could
    // leave `Verification Pending` tomorrow and the rule below would go vacuously
    // green; this fixture is what still fails if the predicate rots. Same idiom as
    // the checkbox-spelling fixture above.
    const dir = mkdtempSync(resolve(tmpdir(), 'schegent-verification-owed-'));
    try {
      // Any dated record in the watched tree proves the accepting branch. Found
      // rather than named, so this fixture outlives the retirement of whichever
      // record the specs happen to point at today.
      const dated = readdirSync(DOCS_ROOT, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => resolve(entry.parentPath, entry.name))
        .find(isDated);
      expect(dated, 'fixture premise: repo/docs/ holds at least one dated record').toBeDefined();
      const registered = dated!;

      const unwatched = resolve(dir, 'not-in-docs.md');
      writeFileSync(unwatched, '<!-- interactive-verification-review-date: 2026-12-06 -->\n');

      const owner = '**Backlog owner**: the repository operator\n';
      const owed = '## Evidence owed\n\nAn observation only a human at a dev host can make.\n';
      const record = (href: string) => `**Review record**: [register](${href})\n`;
      const at = (name: string, contents: string) => {
        const file = resolve(dir, name);
        writeFileSync(file, contents);
        return file;
      };

      const good = at('good.md', owner + owed + record(registered));
      expect(missingVerificationObligations(good, owner + owed + record(registered))).toEqual([]);

      const noOwner = owed + record(registered);
      expect(missingVerificationObligations(at('a.md', noOwner), noOwner)).toEqual([
        '**Backlog owner**:'
      ]);

      const noEvidence = owner + record(registered);
      expect(missingVerificationObligations(at('b.md', noEvidence), noEvidence)).toEqual([
        '## Evidence owed'
      ]);

      const noRecord = owner + owed;
      expect(missingVerificationObligations(at('c.md', noRecord), noRecord)).toEqual([
        '**Review record**:'
      ]);

      // FR-003a / SC-009 — the three ways a well-shaped link still obliges nothing.
      const broken = owner + owed + record('./no-such-record.md');
      expect(
        missingVerificationObligations(at('d.md', broken), broken),
        'a link matching the shape but resolving to nothing must not satisfy the rule'
      ).toEqual(['**Review record**: names a file that does not exist']);

      const outside = owner + owed + record(unwatched);
      expect(
        missingVerificationObligations(at('e.md', outside), outside),
        'a real file outside repo/docs/ is watched by no registry'
      ).toEqual(['**Review record**: must point under repo/docs/, the only tree the registry watches']);

      // A real document in the watched tree that carries no marker. The registry
      // has no opinion on it — most of `repo/docs/` is undated prose — so location
      // alone cannot be the test. `README.md` is the docs index: it exists for as
      // long as `DOCS_ROOT` does, and a review date on an index would be strange.
      const undated = resolve(DOCS_ROOT, 'README.md');
      expect(existsSync(undated), 'fixture premise: repo/docs/README.md exists').toBe(true);
      const noMarker = owner + owed + record(undated);
      expect(
        missingVerificationObligations(at('f.md', noMarker), noMarker),
        'a real document in the watched tree still owes a date; being findable is not being dated'
      ).toEqual([
        '**Review record**: target carries no review-date marker, so no gate watches its date'
      ]);

      const empty = '';
      expect(missingVerificationObligations(at('g.md', empty), empty)).toEqual([
        '**Backlog owner**:',
        '## Evidence owed',
        '**Review record**:'
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires every Verification Pending spec to name an owner, owed evidence and a dated record', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Verification Pending')
      .map((artifact) => ({
        name: basename(artifact.directory),
        missing: missingVerificationObligations(artifact.specPath, artifact.body)
      }))
      .filter((entry) => entry.missing.length > 0)
      .map((entry) => `${entry.name}: ${entry.missing.join('; ')}`);
    expect(
      invalid,
      "`Verification Pending` means an observation is owed that no gate can make. Say who " +
        'owes it (`**Backlog owner**:`), what would end the wait (`## Evidence owed`), and ' +
        'link the dated record under `repo/docs/` that carries the review date ' +
        '(`**Review record**:`). Without a date the wait has no end, which is the state this ' +
        'rule exists to make impossible. Do NOT move the spec to `Deferred` to escape this — ' +
        '`Deferred` means unstarted and blocked, and a built feature awaiting an observation ' +
        'is neither.'
    ).toEqual([]);
  });

  it('requires every Superseded spec to name a successor link', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Superseded')
      .filter((artifact) => !/^\*\*Successor\*\*:\s*\[[^\]]+\]\([^)]+\)\s*$/m.test(artifact.body))
      .map((artifact) => basename(artifact.directory));
    expect(invalid).toEqual([]);
  });

  it('requires every Deferred spec to carry a rationale and backlog owner', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Deferred')
      .filter(
        (artifact) =>
          !/^## Deferral rationale\s*$/m.test(artifact.body) ||
          !/^\*\*Backlog owner\*\*:\s*\S.+$/m.test(artifact.body)
      )
      .map((artifact) => basename(artifact.directory));
    expect(invalid).toEqual([]);
  });

  it.skipIf(!ENVELOPE_HERE)(
    'does not leave a completed or superseded feature as the AGENTS active plan',
    () => {
    // FR-R3-118 — guarded by the same predicate. `AGENTS.md` is the envelope's,
    // not the execution repository's.
    const agents = readFileSync(resolve(ENVELOPE_ROOT, 'AGENTS.md'), 'utf8');
    const active = /^Active plan:\s*(.+?)\s*$/m.exec(agents)?.[1] ?? '';
    if (/^none\.?$/i.test(active)) return;

    const relativePlan = /\((specs\/[^)]+\/plan\.md)\)/.exec(active)?.[1];
    expect(relativePlan, 'AGENTS.md must point to a feature plan or explicitly say none').toBeTruthy();
    const directory = resolve(ENVELOPE_ROOT, relativePlan!, '..');
    const artifact = artifacts.find((candidate) => candidate.directory === directory);
    expect(artifact, `missing spec for active plan ${relativePlan}`).toBeDefined();
    expect(['Complete', 'Superseded']).not.toContain(artifact!.status);
    }
  );

  // FR-R3-118 — the skip is REPORTED, not silent. Without this, a standalone
  // clone and a broken envelope path look identical from the outside: both are
  // a green suite with fewer tests.
  it('reports why it skipped when no planning envelope is present', () => {
    if (ENVELOPE_HERE) {
      expect(SCOPE.kind).toBe('envelope');
      return;
    }
    // Narrowed by the early return above, so a second `kind` comparison here is
    // dead. Assert on the reason directly.
    expect(SCOPE.kind).toBe('skipped');
    expect(SCOPE.reason).toContain('no planning envelope');
  });
});
