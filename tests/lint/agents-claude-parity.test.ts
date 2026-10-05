// Doc-drift guard for the hard rules and their pointer files.
//
// Design: the envelope's `docs/hard-rules.md` is the SINGLE source of truth for
// hard rules. `AGENTS.md`, `CLAUDE.md` and `repo/AGENTS.md` are pointers to it
// and carry no copy of the rule set. This test enforces:
//
//   1. docs/hard-rules.md contains every curated topical anchor below.
//      Adding a new hard rule MUST update docs/hard-rules.md AND append an
//      anchor here (so the cross-references stay live).
//   2. Every pointer file explicitly names the file it delegates to.
//   3. No pointer file has grown its own copy of the rule set —
//      preventing the "dual-maintained" failure mode that drove this
//      test's creation.
//   4. The SPECKIT active-plan pointer is identical in both envelope
//      files, and names a plan that exists.
//
// THE RULES LEFT AGENTS.md on 2026-09-05, and this test's third pointer file is
// what the move cost. The rule set was 826 of AGENTS.md's 1,058 lines, so the
// file a contributor opens for the workspace model was mostly a rule set, and a
// rule edit and an orientation edit touched the same file. Moving it out is why
// AGENTS.md now appears in POINTERS rather than as the authority: it delegates
// like the other two, and rule 3 holds it to zero rule bullets like the other
// two. Nothing about the rules changed in the move — same 67, same order, same
// ordinals — so the anchor list below is untouched by it.
//
// THE DIRECTION OF AUTHORITY WAS INVERTED on 2026-08-19. It used to run
// CLAUDE.md → AGENTS.md: CLAUDE.md held the 62 **Never** bullets and both
// AGENTS.md files delegated up to it, with the envelope AGENTS.md carrying a
// 33-bullet summary that this test bounded to keep it from becoming a mirror.
// A summary that restates rules is a second thing to maintain, and rule 3
// existed only because it was one — so the rules moved wholesale into
// AGENTS.md and both other files became pointers with no rule text at all.
// Rule 3 now asserts the absence rather than bounding the size, which is the
// stronger form of the same invariant: there is no permitted headroom for a
// pointer file to drift into a rule set, because zero copies are allowed.
//
// Rule 4 predates the inversion and is unchanged by it. It exists because the
// active-plan pointer drifted fourteen features (081 → 095) unnoticed: the
// vendored /speckit-plan skill updates the marker pair in CLAUDE.md only, and
// nothing compared the two. Forking the vendored skill to add a second write
// target would be re-applied on every spec-kit upgrade; comparing the two
// blocks here costs nothing and cannot be upgraded away. Note this means the
// skill still writes the *pointer* file, not the authoritative one, so the
// AGENTS.md block is the hand-maintained half.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The envelope holds CLAUDE.md, AGENTS.md and docs/hard-rules.md; repo/ holds a
// short orientation AGENTS.md of its own. Since 2026-09-05 both AGENTS files are
// guarded by the same pointer rules — they still have different jobs, but
// neither of those jobs is holding a rule any more.
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');

// Topical anchors — each phrase MUST appear at least once in
// docs/hard-rules.md. Use lowercased substring matching. Keep phrases short,
// unambiguous, and tied to a single invariant.
const HARD_RULE_ANCHORS: ReadonlyArray<string> = [
  'weaken the redaction set',
  'route untrusted strings to the ui',
  'weaken csp for webviews',
  'skip lock release',
  'drop unknown audit event types',
  'introduce the literal `"running"`',
  'bypass the v2 → v3 state migration',
  'mutate or retarget an in-flight',
  'implement task or phase deletion',
  'roll back the queue removal',
  'add inline `postcommand',
  'register a new mutating ipc command',
  "import 'vscode'",
  'cache the `schegent.logging.verbose`',
  'evaluate operator-authored `retrycondition`',
  'widen the **code-resident** fatal-signature',
  'cache the operator-additive',
  'cache the `schegent.claude.autocompactpctoverride`',
  // The Wake-up withdrawal removed two hard rules and their anchors here:
  // the detached-runner env scrubbing allowlist and the session-log writer's
  // no-transform sink discipline. Both guarded surfaces that no longer exist.
  'bypass the',
  'serialize workspace root paths',
  'fork the redaction set',
  'cache the `schegent.logging.runtimelog',
  're-stringify or re-sanitize',
  // Feature 092 re-pointed this anchor rather than dropping it. The rule it
  // names was rewritten, not deleted: "never reintroduce a multi-queue
  // registry without a migration and a scheduler design" became "never raise
  // `MAX_QUEUES` without" the same two halves, because 092 supplied both and
  // the registry is multi-entry today. Anchoring on the retired wording would
  // fail the build for a rule that is still there, under its new name.
  'raise `max_queues`',
  'cap the dynamic rate-limit backoff',
  'persist a `workflowrun`',
  "append `-c`",
  'awaiting `useconfirm',
  // Feature 065 — new hard-rule anchors.
  'auto-promote a queue in `idle-pending`',
  // Feature 092 — the idle-pending gate is now parameterised by queue rather
  // than copied per queue, so the "one enforcement site" half earned a rule of
  // its own and an anchor of its own.
  'add a second idle-pending enforcement site',
  'persist `scheduledstartat` without also persisting',
  'emit a schedule-related audit event',
  'emit the literal `\'running\'` as a `queuelifecycle`',
  // Feature 082 — Pipeline contract hard-rule anchors.
  'resolve a pipeline binding',
  // Feature 100 re-pointed two anchors into one, on the 092 precedent above.
  // `write a pipeline layer` (082) and `write a workflow layer` (083) named two
  // copies of one rule — each whole-array layer save required its own
  // `expectedRevision` and its own single declared intent. The lifecycle retired
  // all three saves and the intent algebra with them, and the rule they shared
  // was rewritten once, for the two layer writes that remain. One rule takes one
  // anchor. Its second half is anchored separately: the ordering against the
  // trust gate is what feature 100 added to the rule, and it is the half a
  // reordering would break silently.
  'write a catalog layer without a matching',
  'never let the trust gate run before the staleness check',
  // Feature 083 — Workflow graph hard-rule anchors.
  'give a workflow condition a string form',
  'convert a workflow connection endpoint to index addressing',
  "store a workflow's inputs or outputs",
  // Feature 086 — Workflow package exchange hard-rule anchors. Each phrase is
  // one 086 amended into an existing rule rather than adding a bullet, so the
  // anchor names the amended clause: the ordered-writes rule now spans three
  // layers, the no-compensating-delete rule now covers every partial prefix,
  // and the preflight carve-out now reaches the Workflow graph validator.
  // Feature 100 re-pointed this one too: the per-layer `import-package` intent
  // went with the intent algebra, so the rule now forbids the merge itself —
  // "as one layer" rather than "under one intent". The ordered-writes property
  // it guards is unchanged.
  "write a package's catalog layers as one layer",
  'compensate a failed package write with a delete',
  'extends one level up to `validateworkflowgraph`',
  // Feature 093 — per-queue Run execution. Four new rules, four new anchors.
  // The first two are the store seam (address a Run by queue; write the map
  // whole), the third the checkpoint attribution rule, and the fourth the
  // deleted drain gate whose absence is the feature's acceptance signal.
  'reach a run record without naming a queue',
  "write one queue's run entry with a partial-map write",
  'take or offer a recovery checkpoint',
  'reintroduce drain step 4b',
  // The compaction-window work added rule 20 and no anchor, which is the
  // omission this list's header forbids. Anchored now. Note what the gap
  // showed: this check asks only whether the phrase is present, so it stayed
  // green while the rule's *index* citation was wrong and stayed wrong for 45
  // rows. Presence and position are different invariants —
  // `agents-rule-index.test.ts` owns the second one.
  'give a host-spawned child an idle bound',
  // Feature 217 (FR-R3-179) — one rule, two invariants, so two anchors: an
  // evidence open declares its mode, and a mode is narrowed in one routine.
  'open an evidence path without declaring its mode',
  'narrow a mode anywhere but `repo/src/lib/narrow-mode.ts`'
];

/** The authoritative file — the only one that carries the rule set. */
const HARD_RULES_MD = path.join(WORKSPACE_ROOT, 'docs', 'hard-rules.md');
/** Envelope orientation file. Keeps the SPECKIT marker pair; no rule text. */
const ENVELOPE_AGENTS_MD = path.join(WORKSPACE_ROOT, 'AGENTS.md');
/** Pointer file. Keeps the SPECKIT marker pair; carries no rule text. */
const CLAUDE_MD = path.join(WORKSPACE_ROOT, 'CLAUDE.md');
/** Execution-repo pointer file. Delegates up to ../AGENTS.md. */
const REPO_AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');

/**
 * Every file that points at the rule set rather than restating it, with the
 * path each one must name. The envelope AGENTS.md names the authority directly;
 * the other two name AGENTS.md, which is the orientation hop a reader takes
 * before they reach the rules. A pointer that names neither has stopped being a
 * pointer and is on its way to being a second rule set.
 */
const POINTERS: ReadonlyArray<{ readonly file: string; readonly names: string }> = [
  { file: ENVELOPE_AGENTS_MD, names: 'docs/hard-rules.md' },
  { file: CLAUDE_MD, names: 'agents.md' },
  { file: REPO_AGENTS_MD, names: 'agents.md' }
];

/**
 * Floor on the authoritative file's **Never** bullets. It stood at 62 when the
 * rules moved into AGENTS.md and at 67 when they moved out of it into
 * `docs/hard-rules.md`, so a floor of 20 is loose on purpose: this catches the
 * file being emptied or truncated, not ordinary rule churn. The anchor list
 * above is what pins individual rules.
 */
const RULES_MIN_NEVER = 20;

const SPECKIT_BLOCK = /<!--\s*SPECKIT START\s*-->\s*\n([\s\S]*?)\n\s*<!--\s*SPECKIT END\s*-->/;

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const countNever = (s: string): number => (s.match(/\*\*Never\*\*/g) ?? []).length;

/** The text between the SPECKIT markers, or null when the pair is absent. */
function speckitBlock(file: string): string | null {
  const match = SPECKIT_BLOCK.exec(read(file));
  return match ? match[1].trim() : null;
}

// The envelope is absent when repo/ is cloned on its own, which is a supported
// way to work in this repository — so the suite skips rather than fails. The
// rule file joins the predicate because it is now a separate file: present
// envelope, absent rules is a real failure and must not read as a clone.
const envelopePresent =
  fs.existsSync(CLAUDE_MD) && fs.existsSync(ENVELOPE_AGENTS_MD) && fs.existsSync(HARD_RULES_MD);

describe.skipIf(!envelopePresent)('hard-rule authority and pointer parity guard', () => {
  it('docs/hard-rules.md contains every curated hard-rule anchor', () => {
    const rules = read(HARD_RULES_MD).toLowerCase();
    const missing = HARD_RULE_ANCHORS.filter((a) => !rules.includes(a));
    expect(missing, 'anchors not found in docs/hard-rules.md').toEqual([]);
  });

  it('every pointer file names the file it delegates to', () => {
    for (const { file, names } of POINTERS) {
      const pointer = read(file).toLowerCase();
      expect(pointer, `${file} should name ${names}`).toContain(names);
      expect(pointer, `${file} should name the authority`).toContain('single source of truth');
    }
  });

  it('docs/hard-rules.md carries the full rule set', () => {
    const rulesCount = countNever(read(HARD_RULES_MD));
    expect(
      rulesCount,
      `docs/hard-rules.md has ${rulesCount} **Never** bullets — it is the authoritative rule set and must not be emptied or truncated`
    ).toBeGreaterThanOrEqual(RULES_MIN_NEVER);
  });

  it('no pointer file restates the rule set', () => {
    // Zero copies allowed, in any pointer file. A summary that restates
    // rules is a second thing to maintain, and the drift it produces is
    // invisible: both files read as authoritative while they disagree.
    for (const { file } of POINTERS) {
      expect(
        countNever(read(file)),
        `${file} should delegate to docs/hard-rules.md, not restate rules`
      ).toBe(0);
    }
  });

  it('the SPECKIT active-plan pointer is identical in AGENTS.md and CLAUDE.md', () => {
    // The drift this catches: /speckit-plan updates the marker pair in
    // CLAUDE.md only, so AGENTS.md holds whatever plan was current when
    // someone last edited it by hand — 081 while CLAUDE.md read 095.
    const claudeBlock = speckitBlock(CLAUDE_MD);
    const agentsBlock = speckitBlock(ENVELOPE_AGENTS_MD);

    expect(claudeBlock, 'CLAUDE.md is missing its SPECKIT marker pair').not.toBeNull();
    expect(agentsBlock, 'AGENTS.md is missing its SPECKIT marker pair').not.toBeNull();
    expect(
      agentsBlock,
      'AGENTS.md and CLAUDE.md disagree on the active plan — /speckit-plan updates CLAUDE.md only, so AGENTS.md needs the same edit by hand'
    ).toBe(claudeBlock);
  });

  it('the active plan named by the SPECKIT pointer exists, or is explicitly none', () => {
    // A pointer at a deleted or renamed spec directory fails the same way a
    // stale one does: the reader follows it and learns nothing. Read the
    // authoritative file's block — the two are already asserted equal above.
    //
    // FR-R3-119 closeout — `Active plan: none.` is a VALID state and this gate did
    // not know it. `spec-traceability-governance.test.ts` has accepted `none` since
    // it was written, and refuses a pointer at a Complete spec; so between a
    // feature closing and the next one opening, the two gates demanded opposite
    // things and the tree could not satisfy both. Discovered by reaching that state
    // rather than by reading them side by side, which is the same shape FR-R3-116
    // found in prose: two rules about one field, disagreeing, both green until
    // something exercised the case.
    //
    // The vocabulary is now shared: a specs/ link that resolves, or an explicit
    // `none`. Silence is still a failure — the point of the field is that somebody
    // answered.
    const block = speckitBlock(ENVELOPE_AGENTS_MD) ?? '';
    const active = /^Active plan:\s*(.+?)\s*$/m.exec(block)?.[1] ?? '';
    expect(active, `the SPECKIT block names no active plan at all: ${block}`).not.toBe('');
    if (/^none\.?$/i.test(active)) return;

    const target = /\]\((specs\/[A-Za-z0-9._/-]+\.md)\)/.exec(block);
    expect(
      target,
      `no specs/… link and not "none" in the SPECKIT block: ${block}`
    ).not.toBeNull();
    const planPath = path.join(WORKSPACE_ROOT, target![1]);
    expect(fs.existsSync(planPath), `active plan does not exist: ${target![1]}`).toBe(true);
  });
});
