import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { resolveGovernanceScope } from './envelope-presence';

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
   *     tasks AGREE with it. One spec is legitimately fully ticked and pending.
   *   * `Deferred` and `Superseded` describe dispositions decoupled from how far the
   *     tasks got, and each already carries its own requirement below.
   *   * A spec with no `tasks.md` has no task state to compare. Judging it would mean
   *     inventing one.
   */
  const STATUSES_CLAIMING_UNFINISHED = new Set(['Draft', 'In Progress']);

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
