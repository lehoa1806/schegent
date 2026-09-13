import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
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
    // This rule and the `all-ticked` rule below are the two directions of one table, so they must
    // agree about what a task is. Until 2026-09-14 they did not: this one carried its own inline
    // `/^- \[ \]/m`, narrower than the shared `UNTICKED` even for list items — it lacked the `\s*`,
    // so an indented task was invisible here and visible there.
    //
    // Measured effect of the repair today: none. The census finds no unticked box in the table or
    // no-space dialects anywhere in the tree, and no indented one either, so no spec changes
    // verdict. That is stated rather than left implied, because the next reader to find a change
    // that fixes nothing observable will otherwise be right to delete it. What is being fixed is
    // the rule's definition, not its current output: nothing prevents the next table-dialect spec
    // from leaving a box open, and before this it would have been read as having no tasks at all.
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Complete' && existsSync(artifact.tasksPath))
      .filter((artifact) => UNTICKED.test(readFileSync(artifact.tasksPath, 'utf8')))
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
   *
   * ── CORRECTION, 2026-09-14 (feature 214) ──────────────────────────────────
   * The four sentences immediately above are kept verbatim and are WRONG. They are
   * not stale — they were false on the day they were written, and the way they
   * became false is worth more than the space they cost, which is why FR-027 says
   * annotate rather than delete.
   *
   * `187-admission-failure-notice` was one of the "other two `Ready` specs". It does
   * not carry "no checkboxes at all": it carries 29, all ticked, written as bolded
   * leading table cells (`| **[x] T001** |`). Its implementation had shipped and was
   * wired. It is precisely the contradiction this rule exists to catch, and it sat
   * one line below a sentence certifying that it could not exist.
   *
   * The dating is not ambiguous. `187/tasks.md` has exactly one commit — `c51dcfc`,
   * 2026-09-02 — and it already carried all 29 ticks. The sentence above landed in
   * `82bb92a8` on 2026-09-06, four days later. Nothing overtook it.
   *
   * HOW IT HAPPENED, because the mechanism is the point: the author scanned with
   * `TICKED` as it then stood, saw no match, and recorded the regex's blind spot as
   * a property of the file. That is the exact failure mode diagnosed two paragraphs
   * up, about the case dialect — "a scan matching only `- [x]` reads every one of
   * them as having no tasks — which the exemption below then excuses". It was closed
   * for `[X]` and committed one dialect over, in the next paragraph, using the
   * instrument's own blind spot as the evidence that the exemption was sound.
   *
   * The lesson is in `TICKED`'s docblock now: a measurement cannot certify its own
   * coverage, so the dialect set was enumerated across the whole tree rather than
   * inferred from what the pattern happened to find.
   * ──────────────────────────────────────────────────────────────────────────
   */
  const STATUSES_CLAIMING_UNFINISHED = new Set(['Draft', 'Ready', 'In Progress']);

  /**
   * Case-insensitive by requirement, not by accident. See the docblock.
   *
   * THREE DIALECTS, because the tree writes three (feature 214, measured 2026-09-14 over every
   * `tasks.md` under `specs/`). Every checkbox-shaped construct at the head of a line reduces to:
   *
   *   `- [x]` / `- [X]` / `- [ ]`   7906   Markdown list
   *   `| **[x]` / `| **[X]`           60   leading table cell, bolded
   *   `-[x]`                          26   list item missing the space after the dash
   *
   * and nothing else. The set is closed and was enumerated by hand, which is the condition
   * feature 213's Clarification Q4 places on widening a gate — extend where the uncovered set can
   * be listed, decline anything needing a heuristic over prose.
   *
   * THE `^`-ANCHOR IS LOAD-BEARING, not tidiness. Two occurrences in the tree quote the notation
   * inside a sentence (``marked `[X]` ``), and five specs describe this very rule in prose
   * (``  `Complete` may not be claimed while a `- [ ]` remains ``). A pattern that matched brackets
   * anywhere would read those sentences as tasks and invent an unticked box in five `Complete`
   * specs. That false positive was actually produced by the first, cruder measurement taken while
   * investigating this — it briefly looked like a second, opposite defect — so the anchor is here
   * to keep a known mistake from being re-made in code.
   */
  const TICKED = /^\s*(?:-[ ]?|\|\s*\*\*)\[[xX]\]/m;
  const UNTICKED = /^\s*(?:-[ ]?|\|\s*\*\*)\[ \]/m;

  /**
   * `'none'` used to mean three different things, and the exemptions below were written for only
   * one of them. A `tasks.md` that exists but carries no checkbox this file recognises is NOT the
   * same as no `tasks.md`: the first is a file whose completion is unknowable, the second has no
   * task state to be wrong about. Collapsing them is what let `187` sit at `Ready` with 29 of 29
   * tasks ticked while this gate reported green. They get separate values so the register below
   * can govern one without excusing the other.
   */
  function taskState(tasksPath: string): 'none' | 'unreadable' | 'all-ticked' | 'has-unticked' {
    if (!existsSync(tasksPath)) return 'none';
    const body = readFileSync(tasksPath, 'utf8');
    if (UNTICKED.test(body)) return 'has-unticked';
    return TICKED.test(body) ? 'all-ticked' : 'unreadable';
  }

  /**
   * Directories whose `tasks.md` deliberately carries no checkbox in any dialect, each with what
   * it carries instead. Seeded 2026-09-14 from a census of the whole tree, not from whatever the
   * first run happened to print — a register populated by copying an error message just launders
   * the current state into permission.
   *
   * Adding an entry is a decision someone makes on purpose. That is the whole point: before this
   * map, the same specs were exempt silently and for free, and the hole could grow without anyone
   * choosing to grow it.
   */
  const TASKS_WITHOUT_CHECKBOXES = new Map<string, string>([
    ['180-builder-tab-order', 'tasks.md is a set of narrative headings, no checkbox column'],
    ['182-settings-tab-coverage', 'tasks.md is a coverage table with no checkbox column'],
    ['183-backend-naming', 'tasks.md is a set of narrative headings, no checkbox column'],
    ['184-pipeline-canvas', 'tasks.md is a set of narrative headings, no checkbox column'],
  ]);

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

  it('does not silently exempt a tasks.md it cannot read', () => {
    // The rule above can only fire on a spec whose task state this file can determine. Before
    // 2026-09-14 a `tasks.md` written in an unrecognised dialect returned `none` and dropped out
    // of every rule keyed on task state — indistinguishable from having no `tasks.md` at all, and
    // exempt for the same reason, which was a reason that did not apply to it.
    //
    // So this is the rule that keeps the rule above honest. Widening the patterns fixed the
    // dialects the tree writes today; this fixes the shape of the hole, so the next dialect nobody
    // anticipated fails loudly instead of joining a silent exemption.
    const unreadable = artifacts
      .filter((artifact) => taskState(artifact.tasksPath) === 'unreadable')
      .map((artifact) => basename(artifact.directory))
      .filter((directory) => !TASKS_WITHOUT_CHECKBOXES.has(directory));
    expect(
      unreadable,
      'These specs have a tasks.md carrying no checkbox this gate recognises, so their ' +
        'completion is unknowable and every task-state rule above skips them. There are two ' +
        'exits and both are deliberate: write the tasks as checkboxes in one of the three ' +
        'dialects TICKED documents, or add the directory to TASKS_WITHOUT_CHECKBOXES with a ' +
        'reason saying what the file carries instead. Do NOT widen TICKED to make this pass ' +
        'unless you have first enumerated the new dialect across specs/ — a pattern guessed ' +
        'from one file is how the blind spot this rule closes was created.'
    ).toEqual([]);
  });

  it('reads every checkbox dialect the tree writes, and reads prose as prose', () => {
    // FR-R3-123 / FR-005a, extended by feature 214. Two separate no-op risks are pinned here.
    //
    // Too narrow: 80 specs mark tasks `- [X]`, 5 mix in `-[x]`, and `187` writes all 29 of its
    // tasks as table cells. Any of those unread means the rules above skip the spec entirely.
    //
    // Too wide: 5 specs describe this rule in prose and 2 quote the notation mid-sentence. A
    // pattern matching brackets anywhere reads those as tasks, and the `Complete` rule then
    // reports an unticked box in specs that have none. The last two cases are that control, and
    // they are not hypothetical — the false positive was produced for real during this
    // feature's investigation before the anchor was made explicit.
    const dir = mkdtempSync(resolve(tmpdir(), 'schegent-status-truth-'));
    try {
      const upper = resolve(dir, 'upper.md');
      const lower = resolve(dir, 'lower.md');
      const mixed = resolve(dir, 'mixed.md');
      const nospace = resolve(dir, 'nospace.md');
      const table = resolve(dir, 'table.md');
      const tableMixed = resolve(dir, 'table-mixed.md');
      const prose = resolve(dir, 'prose.md');
      const empty = resolve(dir, 'empty.md');
      writeFileSync(upper, '- [X] T001 done\n- [X] T002 done\n');
      writeFileSync(lower, '- [x] T001 done\n');
      writeFileSync(mixed, '- [X] T001 done\n- [ ] T002 not done\n');
      writeFileSync(nospace, '-[x] T001 done\n-[X] T002 done\n');
      writeFileSync(table, '| **[x] T001** | did the thing |\n| **[X] T002** | did it again |\n');
      writeFileSync(tableMixed, '| **[x] T001** | done |\n| **[ ] T002** | not done |\n');
      writeFileSync(
        prose,
        '# Notes\n\n' +
          'The gate says `Complete` may not be claimed while a `- [ ]` remains, and a\n' +
          'fully-ticked spec may not still say `Draft`. Tasks are marked `[X]` when done.\n'
      );
      writeFileSync(empty, '# Tasks\n\nNo checkboxes here.\n');

      expect(taskState(upper), 'a capital [X] must count as ticked').toBe('all-ticked');
      expect(taskState(lower), 'a lowercase [x] must count as ticked').toBe('all-ticked');
      expect(taskState(mixed), 'an unticked box outranks ticked ones').toBe('has-unticked');
      expect(taskState(nospace), 'a list item without the space after the dash is still a task').toBe(
        'all-ticked'
      );
      expect(taskState(table), 'a bolded leading table cell is still a task').toBe('all-ticked');
      expect(taskState(tableMixed), 'an unticked table cell outranks ticked ones').toBe(
        'has-unticked'
      );
      expect(
        taskState(prose),
        'a sentence quoting the notation is prose, not a task list — matching it would invent ' +
          'an unticked task in every spec that documents this rule'
      ).toBe('unreadable');
      expect(taskState(empty), 'a file with no checkbox is unreadable, not task-free').toBe(
        'unreadable'
      );
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

  // THE TWO RULES BELOW WERE THE LAST TWO THAT ASSERTED WITHOUT SAYING WHY.
  //
  // `FR-R3-170` made `Verification Pending` oblige an owner, owed evidence and a
  // RESOLVED link to a dated record, and it wrote down two things it was leaving:
  // that `**Successor**:` still matched link SHAPE without resolving anything, and
  // that neither of these rules had a failure message or a control. Both gaps are
  // the same gap one word over — the argument its docblock makes about `Ready`.
  //
  // WHAT A BARE `toEqual([])` COSTS. A reader who trips it is shown a spec
  // directory name and nothing else: not which field is missing, not what the
  // field is for, not what to write. Every other rule in this file spends a
  // sentence on that, because the failure message is the only part of a gate most
  // people ever read.
  //
  // WHY A FIXTURE AND NOT A FLOOR. Three specs are `Superseded` and two are
  // `Deferred` today, so neither rule is vacuous this morning. But both filter a
  // list and expect nothing left, so both go green the day the population empties,
  // and a floor of three would fail the day a supersession is legitimately
  // retired — punishing the correct action. The fixtures below hold the predicate
  // to its meaning on inputs the repository does not have to keep supplying.
  //
  // NOT BUILT: successor CYCLES. `A -> B -> A` resolves at every hop and sends the
  // reader nowhere. Following the chain means reading the successor's own status
  // and body, and the chain can leave the `Superseded` population in one step, so
  // it is a different rule rather than a stronger clause of this one. All three
  // supersessions today point at `Complete` specs. Named here so the next reader
  // finds it decided rather than missed.

  /** The `**Successor**:` href, resolved against the spec that carries it. */
  function successorTarget(specPath: string, body: string): string | null {
    const href = /^\*\*Successor\*\*:\s*\[[^\]]+\]\(([^)]+)\)\s*$/m.exec(body)?.[1];
    if (href === undefined) return null;
    return resolve(specPath, '..', href.replace(/#.*$/, ''));
  }

  /** Every obligation a `Superseded` body fails to meet, named for a reader. */
  function missingSuccession(specPath: string, body: string): string[] {
    const target = successorTarget(specPath, body);
    if (target === null) return ['**Successor**:'];
    if (!existsSync(target)) return ['**Successor**: names a file that does not exist'];
    if (target === specPath) return ['**Successor**: points at the spec that carries it'];
    if (basename(target) !== 'spec.md') {
      return ['**Successor**: must name another feature’s spec.md, not some other document'];
    }
    return [];
  }

  const DEFERRAL_FIELDS = [
    { name: '## Deferral rationale', pattern: /^## Deferral rationale\s*$/m },
    // The same field `Verification Pending` reads above, deliberately. "Who owes
    // this" is one question and it deserves one answer, whichever status asks it.
    { name: '**Backlog owner**:', pattern: /^\*\*Backlog owner\*\*:\s*\S.+$/m }
  ] as const;

  /** Every obligation a `Deferred` body fails to meet, named for a reader. */
  function missingDeferral(body: string): string[] {
    return DEFERRAL_FIELDS.filter((field) => !field.pattern.test(body)).map((field) => field.name);
  }

  it('names exactly the obligation a Superseded spec is missing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'schegent-succession-'));
    try {
      // The carrier exists on disk so the self-reference case below reaches the
      // self check rather than tripping the existence check first.
      const carrier = resolve(dir, 'spec.md');
      writeFileSync(carrier, '# the superseded spec\n');
      mkdirSync(resolve(dir, 'successor'));
      writeFileSync(resolve(dir, 'successor', 'spec.md'), '# a real successor\n');
      writeFileSync(resolve(dir, 'notes.md'), '# a real document that is not a spec\n');
      const line = (href: string) => `**Successor**: [next](${href})\n`;

      const good = line('./successor/spec.md');
      expect(missingSuccession(carrier, good)).toEqual([]);

      expect(missingSuccession(carrier, '# no successor line at all\n')).toEqual([
        '**Successor**:'
      ]);

      // The three ways a well-shaped link still sends the reader nowhere. Before
      // this rule resolved anything, all three passed.
      expect(
        missingSuccession(carrier, line('../078-webview-decomposition/spec.md')),
        'a link matching the shape but resolving to nothing must not satisfy the rule'
      ).toEqual(['**Successor**: names a file that does not exist']);

      expect(
        missingSuccession(carrier, line('./spec.md')),
        'a spec cannot be its own successor: that is a supersession with no destination'
      ).toEqual(['**Successor**: points at the spec that carries it']);

      expect(
        missingSuccession(carrier, line('./notes.md')),
        'superseded work is continued by another FEATURE, so the target is a spec.md'
      ).toEqual(['**Successor**: must name another feature’s spec.md, not some other document']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names exactly the obligation a Deferred spec is missing', () => {
    const rationale = '## Deferral rationale\n\nBlocked on hardware nobody here has.\n';
    const owner = '**Backlog owner**: the repository operator\n';

    expect(missingDeferral(rationale + owner)).toEqual([]);
    expect(missingDeferral(owner)).toEqual(['## Deferral rationale']);
    expect(missingDeferral(rationale)).toEqual(['**Backlog owner**:']);
    expect(missingDeferral('')).toEqual(['## Deferral rationale', '**Backlog owner**:']);

    // A field name with nothing after it is the silence the field exists to break,
    // and it is the cheapest way to satisfy a gate that only looks for the label.
    expect(
      missingDeferral(`${rationale}**Backlog owner**:\n`),
      'an owner field with no owner after it is not an owner'
    ).toEqual(['**Backlog owner**:']);
  });

  it('requires every Superseded spec to name a successor that resolves', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Superseded')
      .map((artifact) => ({
        name: basename(artifact.directory),
        missing: missingSuccession(artifact.specPath, artifact.body)
      }))
      .filter((entry) => entry.missing.length > 0)
      .map((entry) => `${entry.name}: ${entry.missing.join('; ')}`);
    expect(
      invalid,
      '`Superseded` means this work continues somewhere else, so the spec must say WHERE with a ' +
        '`**Successor**:` link that resolves to another feature’s `spec.md`. A link that merely ' +
        'looks like a link leaves the reader at a dead end holding a status word that promised ' +
        'them a destination. Do NOT retire the spec instead — a superseded spec is the record of ' +
        'why the successor exists, and deleting it is how that reason gets lost.'
    ).toEqual([]);
  });

  it('requires every Deferred spec to carry a rationale and backlog owner', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Deferred')
      .map((artifact) => ({
        name: basename(artifact.directory),
        missing: missingDeferral(artifact.body)
      }))
      .filter((entry) => entry.missing.length > 0)
      .map((entry) => `${entry.name}: ${entry.missing.join('; ')}`);
    expect(
      invalid,
      '`Deferred` means understood, unstarted and blocked. Say what blocks it (`## Deferral ' +
        'rationale`) and who carries it until it unblocks (`**Backlog owner**:`). Without both, ' +
        '`Deferred` is indistinguishable from abandoned, and nobody can tell whether the ' +
        'blocking condition still holds. Do NOT use `Deferred` for work that is built and ' +
        'awaiting an observation — that is `Verification Pending`, and it obliges a dated record.'
    ).toEqual([]);
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
