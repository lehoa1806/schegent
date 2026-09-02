// Bug "there is no way to start a pending task" (2026-09-02) — a queue-lifecycle
// command posted without a `queueId` is not a command with a missing field. It
// is a command aimed at the *default* queue, because that is what the host reads
// an absent `queueId` as (`StartQueueCommand`'s own contract says so, and
// `guarded-run-service.ts` supplies the literal).
//
// Feature 092 (T061, FR-034) added `queueId` to `CMD_START_QUEUE` end to end —
// contract, validator, sidebar handler, command, service. No webview caller ever
// sent it. So the whole plumbing existed, was tested, and was unreachable: every
// Start affordance in the UI still meant "the default queue", whichever queue was
// on screen. `queue-command-reachability.test.ts` could not see it, because it
// asks whether a command *has* a call site, never whether that call site says
// which queue it means. `no-implicit-default-queue.test.ts` could not see it
// either: it scans `src/` and `tests/`, and it deliberately permits a value
// fallback at a caller that tried to name its queue and found nothing — which is
// the right carve-out for a boundary, and no help one layer above it where the
// caller never tried.
//
// So the rule is about the *webview* end of the wire, and about a property no
// type can carry: an optional field that is omitted compiles.
//
//   Every non-test `postCommand(CMD_X, …)` in `webview-ui/src`, for every
//   queue-lifecycle command X, names its queue.
//
// The command set is *derived* from `src/contracts/sidebar-ipc.ts` — the
// interfaces extending `CommandBase<typeof CMD_…>` whose payload declares an
// optional `queueId`. A new queue-addressed command enters this rule the moment
// its contract does, rather than when someone remembers to list it here.
//
// `CMD_START` is exempt, by name and with its reason recorded below. It is the
// one member of the derived set whose contract states that omission is a
// *decision*: an unscoped submit lands on the configured default queue, which is
// the same boundary `no-implicit-default-queue.test.ts` names when it permits
// `cmd-start`'s `?? DEFAULT_QUEUE_ID`. Every other member acts on a queue that
// already exists, where "no queue named" can only mean a sibling's state changed.
//
// Comments are stripped before scanning: this repository documents the pre-fix
// form in prose in several places, including in the components this rule now
// governs, and the record of what was removed must not read as a violation of
// its own removal.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');
const IPC_CONTRACT = resolve(REPO_ROOT, 'src', 'contracts', 'sidebar-ipc.ts');

/** The shim that re-exports the constants; naming one there is not a call site. */
const MESSAGES_SHIM = 'webview-ui/src/lib/messages.ts';

/**
 * Commands in the derived set that may be posted without naming a queue, each
 * with the contract sentence that makes omission a decision rather than a slip.
 *
 * An entry for a command that is no longer in the derived set fails the vacuity
 * check below, so this list cannot go stale in the direction that matters.
 */
const UNSCOPED_BY_CONTRACT: ReadonlyMap<string, string> = new Map([
  [
    'CMD_START',
    'StartCommand: "Missing `queueId` resolves to the configured default queue" — ' +
      'the submit boundary, where an operator who names no queue means the default one.'
  ]
]);

/**
 * Commands the derived set must contain. Without them a reshaped contract would
 * empty the derivation and pass every assertion below trivially.
 */
const ANCHORS = ['CMD_START_QUEUE', 'CMD_PAUSE_QUEUE', 'CMD_RESUME_QUEUE'] as const;

interface Dispatch {
  readonly file: string;
  readonly line: number;
  readonly command: string;
  /** The payload argument as written, or null when the call passed none. */
  readonly payload: string | null;
}

/** Blank out comments, preserving newlines so line numbers still line up. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
}

/**
 * The argument list opening at `open`, or null when the source ends first. Depth
 * tracks `()`, `[]` and `{}` only; an unclosed generic can only make a list look
 * like it has more top-level commas, never fewer.
 */
function argumentList(text: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

function splitTopLevel(args: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(args.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(args.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Whether `payload` declares `queueId` as one of its own keys.
 *
 * Depth-0 only, and only inside the outermost object literal: a `queueId` nested
 * in some other field would name a queue to the *host's* reading of that field,
 * not to the command. `{ queueId }` shorthand and `{ queueId: q }` both match.
 */
function namesQueueAtTopLevel(payload: string): boolean {
  const open = payload.indexOf('{');
  if (open === -1) return false;
  const body = argumentList(payload, open);
  if (body === null) return false;
  return splitTopLevel(body).some((entry) => /^(\.\.\.)?queueId\b/.test(entry));
}

function webviewFiles(dir: string, into: string[]): readonly string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      webviewFiles(abs, into);
      continue;
    }
    if (/\.(ts|svelte)$/.test(entry)) into.push(abs);
  }
  return into;
}

/** A test posts to a mock; it is not an operator, and it may assert the old shape. */
function isTestFile(rel: string): boolean {
  return rel.includes('__tests__/') || rel.endsWith('.test.ts');
}

/**
 * Every command whose payload declares an optional `queueId`, read out of the IPC
 * contract rather than copied from it.
 */
function readQueueAddressedCommands(): readonly string[] {
  const code = stripComments(readFileSync(IPC_CONTRACT, 'utf8'));
  const found: string[] = [];
  for (const match of code.matchAll(/extends\s+CommandBase<typeof\s+(CMD_[A-Z0-9_]+)>/g)) {
    const brace = code.indexOf('{', match.index + match[0].length);
    if (brace === -1) continue;
    const body = argumentList(code, brace);
    if (body === null) continue;
    if (/\bqueueId\?:/.test(body)) found.push(match[1]!);
  }
  return found;
}

function dispatchesIn(file: string): readonly Dispatch[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const found: Dispatch[] = [];
  for (const match of code.matchAll(/\bpostCommand\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = argumentList(code, open);
    if (args === null) continue;
    const parts = splitTopLevel(args);
    // `.at` rather than `[0]`: a `postCommand()` with no arguments at all is a
    // shape this scan has to survive, and indexing would type it as present.
    const command = parts.at(0);
    if (command === undefined || !/^CMD_[A-Z0-9_]+$/.test(command)) continue;
    const line = raw.slice(0, match.index).split('\n').length;
    found.push({
      file: relative(REPO_ROOT, file),
      line,
      command,
      payload: parts.at(1) ?? null
    });
  }
  return found;
}

const QUEUE_ADDRESSED = readQueueAddressedCommands();

const DISPATCHES: readonly Dispatch[] = webviewFiles(WEBVIEW_SRC, [])
  .map((file) => ({ file, rel: relative(REPO_ROOT, file) }))
  .filter(({ rel }) => !isTestFile(rel) && rel !== MESSAGES_SHIM)
  .flatMap(({ file }) => dispatchesIn(file));

const GOVERNED = DISPATCHES.filter(
  (site) => QUEUE_ADDRESSED.includes(site.command) && !UNSCOPED_BY_CONTRACT.has(site.command)
);

describe('every webview queue-lifecycle command names its queue', () => {
  it('derived the command set from the IPC contract, so the scan is not vacuous', () => {
    for (const anchor of ANCHORS) {
      expect(
        QUEUE_ADDRESSED,
        `${anchor} declares an optional queueId in src/contracts/sidebar-ipc.ts and must be derived`
      ).toContain(anchor);
    }
    expect(
      GOVERNED.length,
      'no governed postCommand call sites were found in webview-ui/src — the scan is reading nothing'
    ).toBeGreaterThan(0);
  });

  it('carries no exemption for a command outside the derived set', () => {
    const stale = [...UNSCOPED_BY_CONTRACT.keys()].filter(
      (command) => !QUEUE_ADDRESSED.includes(command)
    );
    expect(
      stale,
      'an exemption for a command whose contract no longer declares an optional queueId should be ' +
        'deleted with it; otherwise this list outlives the reason it was written'
    ).toEqual([]);
  });

  it('posts no queue-lifecycle command without a payload', () => {
    const offenders = GOVERNED.filter((site) => site.payload === null).map(
      (site) => `${site.file}:${site.line}  postCommand(${site.command})`
    );
    expect(
      offenders,
      'a bare post is read by the host as the default queue, so this acts on whichever queue is ' +
        'default rather than the one on screen; pass { queueId }'
    ).toEqual([]);
  });

  it('names queueId among the top-level keys of every queue-lifecycle payload', () => {
    const offenders = GOVERNED.filter(
      (site) => site.payload !== null && !namesQueueAtTopLevel(site.payload)
    ).map((site) => `${site.file}:${site.line}  postCommand(${site.command}, ${site.payload})`);
    expect(
      offenders,
      'omitting queueId does not omit a queue — it selects the default one. Write the payload ' +
        'inline with a queueId key, or record an exemption with the contract sentence that makes ' +
        'omission a decision'
    ).toEqual([]);
  });
});
