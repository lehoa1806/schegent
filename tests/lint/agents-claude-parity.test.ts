// Doc-drift guard for AGENTS.md ↔ CLAUDE.md.
//
// Design: CLAUDE.md is the SINGLE source of truth for hard rules.
// AGENTS.md is a short orientation file that points at CLAUDE.md
// and carries a non-authoritative summary. This test enforces:
//
//   1. CLAUDE.md contains every curated topical anchor below.
//      Adding a new hard rule MUST update CLAUDE.md AND append an
//      anchor here (so the cross-references stay live).
//   2. Each AGENTS.md explicitly references CLAUDE.md as the authority.
//   3. The envelope AGENTS.md has not silently grown its own copy of
//      the full rule set — preventing the older "dual-maintained"
//      failure mode that drove this test's creation.
//   4. The SPECKIT active-plan pointer is identical in both envelope
//      files, and names a plan that exists.
//
// THERE ARE TWO AGENTS.md FILES, and this test used to guard only one
// of them — the wrong one. `repo/AGENTS.md` is a ~950-byte orientation
// stub that delegates to `../CLAUDE.md` and carries zero **Never**
// bullets by construction. The workspace-root `AGENTS.md` is the 22 KB
// envelope file that carries the summary rule set. Rule 3 was written
// for the second and was reading the first, so it asserted `0 <= 35`
// forever while the file it meant to bound reached 33 bullets unwatched.
// Rule 4 did not exist at all, which is why the active-plan pointer
// drifted fourteen features (081 → 095) before anyone noticed: the
// vendored /speckit-plan skill updates the marker pair in CLAUDE.md
// only, and nothing compared the two. Forking the vendored skill to add
// a second write target would be re-applied on every spec-kit upgrade;
// comparing the two blocks here costs nothing and cannot be upgraded
// away.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// The envelope holds CLAUDE.md and the substantive AGENTS.md; repo/ holds a
// short orientation AGENTS.md of its own. Both AGENTS files are guarded, by
// different rules, because they have different jobs.
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, '..');

// Topical anchors — each phrase MUST appear at least once in
// CLAUDE.md. Use lowercased substring matching. Keep phrases short,
// unambiguous, and tied to a single invariant.
const CLAUDE_RULE_ANCHORS: ReadonlyArray<string> = [
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
  'write a pipeline layer',
  // Feature 083 — Workflow graph hard-rule anchors.
  'give a workflow condition a string form',
  'convert a workflow connection endpoint to index addressing',
  "store a workflow's inputs or outputs",
  'write a workflow layer',
  // Feature 086 — Workflow package exchange hard-rule anchors. Each phrase is
  // one 086 amended into an existing rule rather than adding a bullet, so the
  // anchor names the amended clause: the ordered-writes rule now spans three
  // layers, the no-compensating-delete rule now covers every partial prefix,
  // and the preflight carve-out now reaches the Workflow graph validator.
  "write a package's catalog layers under one intent",
  'compensate a failed package write with a delete',
  'extends one level up to `validateworkflowgraph`',
  // Feature 093 — per-queue Run execution. Four new rules, four new anchors.
  // The first two are the store seam (address a Run by queue; write the map
  // whole), the third the checkpoint attribution rule, and the fourth the
  // deleted drain gate whose absence is the feature's acceptance signal.
  'reach a run record without naming a queue',
  "write one queue's run entry with a partial-map write",
  'take or offer a recovery checkpoint',
  'reintroduce drain step 4b'
];

const CLAUDE_MD = path.join(WORKSPACE_ROOT, 'CLAUDE.md');
/** The 22 KB envelope orientation file — the one that carries a summary rule set. */
const ENVELOPE_AGENTS_MD = path.join(WORKSPACE_ROOT, 'AGENTS.md');
/** The ~950-byte execution-repo stub that delegates upward. */
const REPO_AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');

/**
 * Ceiling on the envelope summary's **Never** bullets. It stood at 33 against
 * CLAUDE.md's 58 when this bound was first pointed at the right file, so the
 * headroom is deliberate: adding a rule to both files is normal and must not
 * fail the build. Breaching 40 means the summary is becoming a mirror, which
 * is the dual-maintained rule set this guard exists to prevent.
 */
const ENVELOPE_AGENTS_MAX_NEVER = 40;

const SPECKIT_BLOCK = /<!--\s*SPECKIT START\s*-->\s*\n([\s\S]*?)\n\s*<!--\s*SPECKIT END\s*-->/;

const read = (file: string): string => fs.readFileSync(file, 'utf8');
const countNever = (s: string): number => (s.match(/\*\*Never\*\*/g) ?? []).length;

/** The text between the SPECKIT markers, or null when the pair is absent. */
function speckitBlock(file: string): string | null {
  const match = SPECKIT_BLOCK.exec(read(file));
  return match ? match[1].trim() : null;
}

// The envelope is absent when repo/ is cloned on its own, which is a supported
// way to work in this repository — so the suite skips rather than fails.
const envelopePresent = fs.existsSync(CLAUDE_MD) && fs.existsSync(ENVELOPE_AGENTS_MD);

describe.skipIf(!envelopePresent)('AGENTS.md ↔ CLAUDE.md parity guard', () => {
  it('CLAUDE.md contains every curated hard-rule anchor', () => {
    const claude = read(CLAUDE_MD).toLowerCase();
    const missing = CLAUDE_RULE_ANCHORS.filter((a) => !claude.includes(a));
    expect(missing, 'anchors not found in CLAUDE.md').toEqual([]);
  });

  it('both AGENTS.md files point at CLAUDE.md as the authoritative hard-rule source', () => {
    for (const file of [ENVELOPE_AGENTS_MD, REPO_AGENTS_MD]) {
      const agents = read(file).toLowerCase();
      expect(agents, `${file} should name CLAUDE.md`).toContain('claude.md');
      expect(agents, `${file} should disclaim authority`).toContain('single source of truth');
    }
  });

  it('the envelope AGENTS.md remains a summary and does not mirror the full rule set', () => {
    // This is the assertion that was reading repo/AGENTS.md — a stub with zero
    // **Never** bullets — and so could never fail. It belongs to the envelope
    // file, which is the only one that carries a summary able to drift.
    const envelopeCount = countNever(read(ENVELOPE_AGENTS_MD));
    const claudeCount = countNever(read(CLAUDE_MD));

    expect(claudeCount, 'CLAUDE.md should carry the full set').toBeGreaterThanOrEqual(20);
    expect(
      envelopeCount,
      `AGENTS.md has ${envelopeCount} **Never** bullets — keep it a summary and point readers at CLAUDE.md (${claudeCount} bullets)`
    ).toBeLessThanOrEqual(ENVELOPE_AGENTS_MAX_NEVER);
    expect(
      envelopeCount,
      'AGENTS.md must stay strictly shorter than CLAUDE.md, not equal to it'
    ).toBeLessThan(claudeCount);
  });

  it('repo/AGENTS.md stays a short delegating stub', () => {
    // Its whole job is to send a reader up to ../CLAUDE.md. Growing bullets
    // here would be the same dual-maintenance defect one directory down.
    expect(
      countNever(read(REPO_AGENTS_MD)),
      'repo/AGENTS.md should delegate, not restate rules'
    ).toBe(0);
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

  it('the active plan named by the SPECKIT pointer exists', () => {
    // A pointer at a deleted or renamed spec directory fails the same way a
    // stale one does: the reader follows it and learns nothing.
    const block = speckitBlock(CLAUDE_MD) ?? '';
    const target = /\]\((specs\/[A-Za-z0-9._/-]+\.md)\)/.exec(block);

    expect(target, `no specs/… link found in the SPECKIT block: ${block}`).not.toBeNull();
    const planPath = path.join(WORKSPACE_ROOT, target![1]);
    expect(fs.existsSync(planPath), `active plan does not exist: ${target![1]}`).toBe(true);
  });
});
