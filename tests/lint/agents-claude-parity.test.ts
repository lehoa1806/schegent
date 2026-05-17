// Doc-drift guard for AGENTS.md ↔ CLAUDE.md.
//
// Design: CLAUDE.md is the SINGLE source of truth for hard rules.
// AGENTS.md is a short orientation file that points at CLAUDE.md
// and carries a non-authoritative summary. This test enforces:
//
//   1. CLAUDE.md contains every curated topical anchor below.
//      Adding a new hard rule MUST update CLAUDE.md AND append an
//      anchor here (so the cross-references stay live).
//   2. AGENTS.md explicitly references CLAUDE.md as the authority.
//   3. AGENTS.md has not silently grown its own copy of the full
//      rule set — preventing the older "dual-maintained" failure
//      mode that drove this test's creation.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

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
  'weaken the env scrubbing allowlist',
  'bypass the',
  'serialize workspace root paths',
  'fork the redaction set',
  'cache the `schegent.logging.runtimelog',
  'sanitize, truncate, or otherwise transform',
  're-stringify or re-sanitize',
  'reintroduce a multi-queue registry',
  'cap the dynamic rate-limit backoff',
  'persist a `workflowrun`',
  "append `-c`"
];

function readDoc(name: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, name), 'utf8').toLowerCase();
}

describe('AGENTS.md ↔ CLAUDE.md parity guard', () => {
  it('CLAUDE.md contains every curated hard-rule anchor', () => {
    const claude = readDoc('CLAUDE.md');
    const missing = CLAUDE_RULE_ANCHORS.filter((a) => !claude.includes(a));
    expect(missing, 'anchors not found in CLAUDE.md').toEqual([]);
  });

  it('AGENTS.md points at CLAUDE.md as the authoritative hard-rule source', () => {
    const agents = readDoc('AGENTS.md');
    // Must mention CLAUDE.md and the phrase that signals authority.
    expect(agents).toContain('claude.md');
    expect(agents).toContain('single source of truth');
  });

  it('AGENTS.md remains a short summary (does not duplicate the full rule set)', () => {
    // The full CLAUDE.md hard-rules section has 60+ **Never** bullets.
    // AGENTS.md must stay well below that — at most ~30 bullets — so it
    // cannot silently re-grow into a parallel rule set that drifts.
    const agents = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    const claude = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const count = (s: string) => (s.match(/\*\*Never\*\*/g) ?? []).length;
    const agentsCount = count(agents);
    const claudeCount = count(claude);
    expect(claudeCount, 'CLAUDE.md should carry the full set').toBeGreaterThanOrEqual(20);
    // AGENTS.md may carry a short illustrative summary but must not
    // try to mirror CLAUDE.md verbatim.
    expect(
      agentsCount,
      `AGENTS.md has ${agentsCount} **Never** bullets — keep it short and point readers at CLAUDE.md (${claudeCount} bullets)`
    ).toBeLessThanOrEqual(35);
  });
});
