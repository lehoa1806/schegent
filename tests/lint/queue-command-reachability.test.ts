// Feature 095 (T035, SC-001, SC-005, FR-014) — a registered command with no
// call site is a feature that shipped without a way to use it.
//
// Feature 092 reinstated seven multi-queue mutation commands: handler,
// validator, refusal codes, audit events, tests. Five of the seven had no
// webview call site at all, and nothing in the suite could say so — every check
// asked whether a command *worked*, none asked whether anything could *reach*
// it. The gap survived a full implement-analyze-verify cycle because a command
// with no caller passes every test written about it.
//
// Three assertions, each closing a different way the gap reopens:
//
// A1 — every mutating queue command has a non-test webview call site. The set is
//      *derived* from `MUTATING_COMMAND_REASONS`, not listed here, so this is
//      SC-005 as written ("the count of queue commands registered without a
//      webview call site is zero") rather than a restatement of it.
// A2 — only `webview-ui/src/lib/queue-control-ipc.ts` posts the five this
//      feature added, so the call site stays single and countable — the
//      discipline the `no-inline-*-ipc` tests already apply to four other IPC
//      families.
// A3 — the derived set is pinned. An eighth queue command fails here until it is
//      named, and fails A1 until it has a control. FR-014 says this feature adds
//      no command; A3 is what checks that rather than trusting it.
//
// Known bound: A1's set is name-shaped — `/QUEUE/` plus `CMD_MOVE_TASK`, which
// is the one queue command whose name says neither. A future queue command
// named like neither (a hypothetical `CMD_SPLIT_TASK`) is outside the derivation
// and outside the pin, and review is what catches it. Widening the filter to
// every mutating command would put unrelated families under a queue rule and
// make this test churn on their changes, which is how a lint stops being read.
//
// Comments are stripped before scanning. A constant named in prose is not a call
// site — three files discuss these commands in doc comments, and counting those
// as reachability would let the original gap pass this very test.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');
const COMMAND_METADATA = resolve(REPO_ROOT, 'src', 'contracts', 'sidebar-command-metadata.ts');

/**
 * SC-001's "seven queue operations", as feature 092 reinstated them — five
 * remain after feature 097 removed the schedule pair.
 */
const PINNED_FAMILY: readonly string[] = [
  'CMD_CREATE_QUEUE',
  'CMD_RENAME_QUEUE',
  'CMD_DELETE_QUEUE',
  'CMD_SAVE_QUEUE_SETTINGS',
  'CMD_MOVE_TASK'
];

/**
 * Every mutating queue command, family or not. Pinned so a new one is a visible
 * edit here; derived below so a new one cannot merely be *absent* from a list
 * and thereby exempt from A1.
 */
const PINNED_QUEUE_SURFACE: readonly string[] = [
  'CMD_REMOVE_QUEUE_ITEM',
  'CMD_RETRY_QUEUE_ITEM',
  'CMD_MOVE_QUEUE_ITEM_UP',
  'CMD_MOVE_QUEUE_ITEM_DOWN',
  'CMD_PAUSE_QUEUE',
  'CMD_RESUME_QUEUE',
  'CMD_START_QUEUE',
  'CMD_CREATE_QUEUE',
  'CMD_RENAME_QUEUE',
  'CMD_DELETE_QUEUE',
  'CMD_SAVE_QUEUE_SETTINGS',
  'CMD_MOVE_TASK'
];

/**
 * The three feature 095 added a control for that are still live — feature 097
 * removed the two it added for the queue schedule. The other two already had
 * call sites when this feature started — `CMD_CREATE_QUEUE` in
 * `QueuesTier.svelte` and `CMD_RENAME_QUEUE` in `QueueDetailTier.svelte` —
 * and relocating working code into the helper to make the rule uniform would
 * be a diff with no requirement behind it. They are exempt from A2, never
 * from A1.
 */
const SINGLE_CALL_SITE_COMMANDS: readonly string[] = [
  'CMD_DELETE_QUEUE',
  'CMD_SAVE_QUEUE_SETTINGS',
  'CMD_MOVE_TASK'
];

const MESSAGES_SHIM = 'webview-ui/src/lib/messages.ts';
const QUEUE_CONTROL_IPC = 'webview-ui/src/lib/queue-control-ipc.ts';

interface WebviewFile {
  readonly rel: string;
  /** Comments removed — see the header. */
  readonly code: string;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function collectWebviewFiles(dir: string, into: WebviewFile[]): WebviewFile[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      collectWebviewFiles(abs, into);
      continue;
    }
    if (!/\.(ts|svelte)$/.test(entry)) continue;
    into.push({ rel: relative(REPO_ROOT, abs), code: stripComments(readFileSync(abs, 'utf8')) });
  }
  return into;
}

/** A test file proves nothing about reachability: it is not an operator. */
function isTestFile(rel: string): boolean {
  return rel.includes('__tests__/') || rel.endsWith('.test.ts');
}

/** Whole-word, so `CMD_DELETE_QUEUE_ITEM` never satisfies `CMD_DELETE_QUEUE`. */
function references(code: string, constant: string): boolean {
  return new RegExp(`\\b${constant}\\b`).test(code);
}

/**
 * The keys of `MUTATING_COMMAND_REASONS`, filtered to the queue surface. Read
 * from the contract rather than copied out of it: a command registered as
 * mutating enters this set the moment it is registered.
 */
function readMutatingQueueCommands(): readonly string[] {
  const text = readFileSync(COMMAND_METADATA, 'utf8');
  const start = text.indexOf('MUTATING_COMMAND_REASONS');
  const body = start === -1 ? '' : stripComments(text.slice(start));
  const keys = Array.from(body.matchAll(/\[(CMD_[A-Z0-9_]+)\]:/g)).map((match) => match[1]!);
  return keys.filter((key) => key.includes('QUEUE') || key === 'CMD_MOVE_TASK');
}

const WEBVIEW_FILES = collectWebviewFiles(WEBVIEW_SRC, []);
const PRODUCTION_FILES = WEBVIEW_FILES.filter((file) => !isTestFile(file.rel));
const QUEUE_SURFACE = readMutatingQueueCommands();

describe('Feature 095 T035 — every queue command is reachable from the webview', () => {
  // A1 — SC-005.
  for (const constant of PINNED_QUEUE_SURFACE) {
    it(`${constant} has at least one non-test webview call site`, () => {
      const callSites = PRODUCTION_FILES.filter(
        (file) => file.rel !== MESSAGES_SHIM && references(file.code, constant)
      ).map((file) => file.rel);

      expect(
        callSites,
        `${constant} is a mutating queue command that nothing in the webview posts. ` +
          'A command an operator cannot reach is not delivered (SC-005).'
      ).not.toEqual([]);
    });
  }

  // A2 — single call site for the five this feature wired.
  for (const constant of SINGLE_CALL_SITE_COMMANDS) {
    it(`${constant} is posted only from queue-control-ipc.ts`, () => {
      const offenders = PRODUCTION_FILES.filter(
        (file) =>
          file.rel !== MESSAGES_SHIM &&
          file.rel !== QUEUE_CONTROL_IPC &&
          references(file.code, constant)
      ).map((file) => file.rel);

      expect(
        offenders,
        `${constant} must be posted through ${QUEUE_CONTROL_IPC}. Inline posts found in:\n${offenders.join('\n')}`
      ).toEqual([]);
    });
  }

  // A3 — FR-014.
  it('pins the mutating queue-command surface so a new one cannot arrive unnoticed', () => {
    expect(
      [...QUEUE_SURFACE].sort(),
      'src/contracts/sidebar-command-metadata.ts registers a different set of mutating queue ' +
        'commands than this test pins. A new one needs an entry here and a control before it ' +
        'ships (FR-014); a removed one needs its entry dropped.'
    ).toEqual([...PINNED_QUEUE_SURFACE].sort());
  });

  it('keeps the five reinstated commands inside that surface', () => {
    const missing = PINNED_FAMILY.filter((command) => !QUEUE_SURFACE.includes(command));

    expect(
      missing,
      `Renamed or unregistered since feature 092: ${missing.join(', ')}. ` +
        'SC-001 counts these five; a rename that skips this pin makes the count meaningless.'
    ).toEqual([]);
  });

  // A4 — the helper is not itself orphaned.
  it('is imported by at least one component, so the helper is not the new dead layer', () => {
    // A1 to A3 would all pass with `queue-control-ipc.ts` imported by nothing:
    // the module is a production file, so it satisfies its own call-site check.
    // That is the original defect moved one level up — five commands reachable
    // only from a module no view mounts. Component mounting itself is
    // `svelte-surface-reachability.test.ts`'s job; this only asks that some
    // component reaches the helper.
    const importers = PRODUCTION_FILES.filter(
      (file) => file.rel.endsWith('.svelte') && /queue-control-ipc/.test(file.code)
    ).map((file) => file.rel);

    expect(
      importers,
      'Nothing imports queue-control-ipc.ts. Five queue commands would be reachable only from ' +
        'a module no view mounts, which is the gap this feature closed.'
    ).not.toEqual([]);
  });

  it('derives the surface from the contract rather than trusting the pin alone', () => {
    // Guards the derivation itself: a parse that silently returns nothing would
    // make A3 fail with a message about the *surface* when the real fault is
    // that `MUTATING_COMMAND_REASONS` could not be read at all.
    expect(
      QUEUE_SURFACE.length,
      'No mutating queue commands could be parsed out of src/contracts/sidebar-command-metadata.ts. ' +
        'The map was renamed or reshaped, and this test is no longer reading it.'
    ).toBeGreaterThan(0);
  });
});
