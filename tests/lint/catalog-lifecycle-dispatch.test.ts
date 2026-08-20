// Feature 100 (FR-R3-016) T509d — one dispatch surface for the six lifecycle
// commands.
//
// This replaces `no-inline-save-phases.test.ts` (deleted) and the retired three
// quarters of `no-inline-save-catalog.test.ts`, which pinned `CMD_SAVE_PHASES`,
// `CMD_SAVE_PIPELINES`, and `CMD_SAVE_WORKFLOWS` each to its own helper. Those
// three commands are gone; the property they protected is not, and it now has
// more to protect.
//
// What the old gate was for: a component that posted a whole-array save inline
// would send it without the `expectedRevision` the helper attaches, so the layer
// it raced would be overwritten rather than reported as stale, and without the
// correlation/pending/timeout handling the helper owns. All of that still holds,
// and two things are added:
//
//   1. The two destructive commands are confirm-gated inside the sender itself
//      (FR-049, FR-050). A second sender would be a second way to remove a
//      definition with no prompt in front of it. `destructive-actions.lint.test.ts`
//      enforces the gate; this file enforces that there is only one place for it
//      to be missing from.
//   2. `expectedDraftVersion` is the concurrency token on four of the six. A
//      component sending one inline would have to reconstruct that token, and a
//      token reconstructed in two places is a token that will disagree with itself.
//
// The scan is for the constant in first-argument position — `<sender>(CMD_X` —
// not for the bare name. That is deliberate: `save-phases.ts` explains in prose
// why `CMD_PUBLISH_PACKAGE` is the successor to the command it used to send, and
// naming a command in a comment is not sending it. Anchoring on the `(` keeps the
// rule about dispatch rather than about vocabulary.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

/** The only webview module permitted to send a lifecycle command. */
const DISPATCH_MODULE = 'webview-ui/src/lib/catalog-lifecycle.ts';

/**
 * All six, including the four that are not destructive.
 *
 * The single-sender rule is not a destructiveness rule — a publish sent inline
 * would skip the same revision token and the same ack handling as a deactivate.
 * `destructive-actions.lint.test.ts` covers the two that additionally need a
 * prompt; the overlap between the two files is intentional and they fail for
 * different reasons.
 */
const LIFECYCLE_COMMANDS: readonly string[] = [
  'CMD_SAVE_DEFINITION_DRAFT',
  'CMD_PUBLISH_DEFINITION',
  'CMD_RESTORE_DEFINITION_VERSION',
  'CMD_DEACTIVATE_DEFINITION',
  'CMD_DISCARD_DEFINITION_DRAFT',
  'CMD_PUBLISH_PACKAGE'
];

function relativize(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

function listFiles(): readonly string[] {
  const out = execSync(`find "${SCAN_ROOT}" \\( -name '*.svelte' -o -name '*.ts' \\)`, {
    encoding: 'utf8'
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const FILES = listFiles();
const SOURCES: ReadonlyMap<string, string> = new Map(
  FILES.map((abs) => [relativize(abs), readFileSync(abs, 'utf8')])
);

/** Files that hand `command` to a call as its first argument. */
function sendersOf(command: string): readonly string[] {
  const re = new RegExp(`\\(\\s*${command}\\b`);
  return [...SOURCES.entries()].filter(([, source]) => re.test(source)).map(([rel]) => rel);
}

describe('Feature 100 T509d — the six lifecycle commands have one dispatch surface', () => {
  it('finds the dispatch module on disk (sanity — an empty scan must not pass)', () => {
    expect([...SOURCES.keys()]).toContain(DISPATCH_MODULE);
  });

  for (const command of LIFECYCLE_COMMANDS) {
    it(`only ${DISPATCH_MODULE} sends ${command}`, () => {
      const senders = sendersOf(command);
      // Asserted before the offender filter so a renamed constant — which would
      // match nothing and therefore offend nothing — fails here instead of
      // passing silently.
      expect(senders, `${command} must be sent from ${DISPATCH_MODULE}`).toContain(
        DISPATCH_MODULE
      );
      const offenders = senders.filter((rel) => rel !== DISPATCH_MODULE);
      expect(
        offenders,
        `Files sending ${command} outside the dispatch surface:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }

  it('no component sends a lifecycle command inline', () => {
    const offenders = LIFECYCLE_COMMANDS.flatMap((command) =>
      sendersOf(command)
        .filter((rel) => rel.startsWith('webview-ui/src/components/'))
        .map((rel) => `  - ${rel} sends ${command}`)
    );
    expect(
      offenders,
      `Components must dispatch through the lifecycle helpers, not the commands:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the dispatch module sends every lifecycle command and no other command', () => {
    // The complement of the per-command checks: the surface is complete, so a
    // seventh lifecycle command cannot be added with a private sender beside it.
    const source = SOURCES.get(DISPATCH_MODULE) ?? '';
    const sent = [...source.matchAll(/\(\s*(CMD_[A-Z_]+)\b/g)].map((match) => match[1]!);
    expect([...new Set(sent)].sort()).toEqual([...LIFECYCLE_COMMANDS].sort());
  });
});
