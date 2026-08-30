// Feature 063 — T046. Lint regression that enforces FR-016: every
// invocation of a destructive IPC command from the webview must be
// wrapped by `useConfirm(actionKey)` so the operator-facing confirmation
// flow gates the destructive side effect.
//
// The 13 destructive commands are the ones that mutate persisted queue,
// run, workspace, or catalog state in a user-visible way. Each has an
// `ActionKey` entry in `webview-ui/src/lib/action-copy.ts`, but the table is a
// superset: it also carries keys for destructive decisions that are not commands
// of their own (the output overwrite confirmed inside a run launch, and
// `workspace.reset`, whose command was deleted while its host-side prompt in
// `src/commands/reset.ts` stayed). `workspace.reset` is the lone
// non-suppressible action.
//
// For each call site that hands a destructive command constant to a sender —
// `<sender>(CMD_DESTRUCTIVE, ...)` — under `webview-ui/src/**/*.{svelte,ts}`
// (excluding `__tests__/`), the test walks outward through enclosing function
// bodies via brace matching.
// A call is considered gated if any ancestor block contains a literal
// `useConfirm(` token. That covers both the same-function pattern
// (`async function onClick() { const ok = await useConfirm(...); ...; postCommand(...) }`)
// and the deferred-callback pattern
// (`function onClick() { useConfirm(...).then((ok) => { if (ok) postCommand(...) }); }`).
//
// LEGACY_FILES is empty. It held orphaned components that still carried
// ungated destructive calls but were reachable from no live UI surface,
// parked behind a cleanup spec that has since run: FR-R3-140 deleted its
// last entry, `QueueGlobalActions.svelte`, with the rest of the
// unreachable webview surface. The active code path had already moved to
// Dashboard.svelte + QueueControls.svelte post-053. See
// ../../docs/architecture/webview-dead-surface-removal.md.
//
// Two assertions used to police the entries: one that each still existed
// on disk, one that each still had an ungated call site left to excuse.
// Both were deleted with the entry they guarded rather than left
// iterating an empty set, which is green forever and proves nothing. An
// empty allowlist needs no self-cleaning. A repopulated one needs both
// blocks back, and an entry added without them should not pass review.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

// The 13 commands that the action-copy table gates. Adding a new
// destructive command means adding it here AND to ACTION_COPY (the
// pinned-key unit test at `webview-ui/src/lib/__tests__/action-copy.test.ts`
// keeps the latter honest).
//
// `CMD_CLEAR_FAILED` and `CMD_RESET` were the 14th and 15th until the lifecycle
// round-check of 2026-08-30 (finding D) deleted both from the IPC contract. They
// are gone from here rather than parked in an exemption because a command that
// does not exist cannot have an ungated call site — which is why the exemption
// list below went with them.
const DESTRUCTIVE_COMMANDS: readonly string[] = [
  'CMD_CLEAR_ALL',
  'CMD_CLEAR_COMPLETED',
  'CMD_REMOVE_QUEUE_ITEM',
  'CMD_CANCEL',
  'CMD_PAUSE_QUEUE',
  'CMD_RESUME_QUEUE',
  'CMD_RETRY_PHASE_NOW',
  'CMD_RESTART_CANCELED_TASK',
  'CMD_MODIFY_TASK',
  'CMD_RERUN_FROM_HISTORY',
  // Feature 095 (T011, FR-003) — deleting a queue drops its pending Tasks with
  // no undo. Both posts of its two-phase flow live in one function body in
  // `webview-ui/src/lib/queue-control-ipc.ts` alongside the `useConfirm(` call,
  // which is what lets this scan see the gate; see that file's comment.
  'CMD_DELETE_QUEUE',
  // Feature 100 (T509a, FR-049) — removing a definition from the active catalog.
  // Destructive in the sense this gate exists for: the operator loses something
  // they hold inside the product. Every version survives in the store and
  // publishing again restores it, which is why the prompt says so.
  'CMD_DEACTIVATE_DEFINITION',
  // Feature 100 (T509a, FR-050) — throwing away unpublished work. The one
  // lifecycle operation that destroys content with no version record behind it,
  // and the only way a draft-only definition leaves the catalog entirely.
  'CMD_DISCARD_DEFINITION_DRAFT'
];

// Empty since FR-R3-140. The exemption stays declared because the filter
// below still consults it and a future orphan may earn one, but nothing
// is exempt today: every ungated destructive call site under
// `webview-ui/src` is a failure of the scan below, with no escape hatch
// already open for it.
const LEGACY_FILES: ReadonlySet<string> = new Set<string>();

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly command: string;
  readonly guarded: boolean;
}

function relativize(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

function listFiles(): readonly string[] {
  const out = filesUnder(SCAN_ROOT, {
    extensions: ['.svelte', '.ts'],
    skipDirectories: ['__tests__']
  }).join('\n');
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Restrict brace counting to JavaScript code. For .ts files the whole
// file is JS; for .svelte files we only consider the contents of the
// first `<script>` block (the brace semantics in the template differ).
function getScriptRange(
  source: string,
  filePath: string
): { start: number; end: number } | null {
  if (!filePath.endsWith('.svelte')) {
    return { start: 0, end: source.length };
  }
  const openMatch = /<script[^>]*>/.exec(source);
  if (!openMatch) return null;
  const openEnd = openMatch.index + openMatch[0].length;
  const closeIdx = source.indexOf('</script>', openEnd);
  if (closeIdx < 0) return null;
  return { start: openEnd, end: closeIdx };
}

// Find the innermost { ... } block containing `charIndex`. Walks
// backward by brace depth, then forward to find the matching close.
function findEnclosingBlock(
  source: string,
  charIndex: number,
  range: { start: number; end: number }
): { start: number; end: number } | null {
  let depth = 0;
  let openBrace = -1;
  for (let i = charIndex; i >= range.start; i--) {
    const ch = source[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) {
        openBrace = i;
        break;
      }
      depth--;
    }
  }
  if (openBrace < 0) return null;
  depth = 1;
  let closeBrace = range.end;
  for (let i = openBrace + 1; i < range.end; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  return { start: openBrace, end: closeBrace + 1 };
}

// True when any enclosing block (up to the script-range root) contains
// a `useConfirm(` token. Walking outward — rather than only checking
// the innermost — covers the `useConfirm(...).then(cb)` pattern where
// `useConfirm` lives in the parent scope and `postCommand` lives in
// the callback body.
function hasUseConfirmInAncestors(
  source: string,
  charIndex: number,
  range: { start: number; end: number }
): boolean {
  let pos = charIndex;
  for (let depth = 0; depth < 16; depth++) {
    const block = findEnclosingBlock(source, pos, range);
    if (!block) break;
    const blockText = source.slice(block.start, block.end);
    if (blockText.includes('useConfirm(')) return true;
    pos = block.start - 1;
    if (pos < range.start) break;
  }
  return false;
}

function scanFile(filePath: string): readonly CallSite[] {
  const source = readFileSync(filePath, 'utf8');
  const rel = relativize(filePath);
  const range = getScriptRange(source, filePath);
  if (!range) return [];
  const sites: CallSite[] = [];
  for (const cmd of DESTRUCTIVE_COMMANDS) {
    // The command constant in first-argument position of ANY call, not of
    // `postCommand` specifically.
    //
    // Feature 100 (T509a) — `webview-ui/src/lib/catalog-lifecycle.ts` posts
    // through a local `dispatch` wrapper that carries the correlate/ack/timeout
    // dance for all six lifecycle commands, so a pattern keyed to the literal
    // `postCommand(` would have seen neither of the two new destructive commands
    // and would have passed by finding nothing. The rule was never about that
    // one function's name: it is that a destructive command handed to a sender
    // must have a `useConfirm(` in an enclosing scope.
    //
    // The `(` anchor is what keeps this narrow — a constant in an import list,
    // a `typeof CMD_X` union member, or a `case CMD_X:` arm is not preceded by
    // one. A `\b` word boundary after the name prevents `CMD_RESET` from
    // matching `CMD_RESET_QUEUE` (no such constant exists today, but the
    // boundary is cheap insurance).
    const re = new RegExp(`\\(\\s*${cmd}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m.index < range.start || m.index >= range.end) continue;
      const before = source.slice(0, m.index);
      const line = before.split('\n').length;
      const guarded = hasUseConfirmInAncestors(source, m.index, range);
      sites.push({ file: rel, line, command: cmd, guarded });
    }
  }
  return sites;
}

describe('Feature 063 T046 — destructive command sites must be useConfirm-gated', () => {
  const files = listFiles();
  const allSites: readonly CallSite[] = files.flatMap((f) => scanFile(f));

  it('discovers at least one destructive command call site (sanity)', () => {
    expect(allSites.length).toBeGreaterThan(0);
  });

  // This used to read "discovers each of the 15", and accepted matches from
  // legacy files so it would keep holding for commands no live component wired
  // up. FR-R3-140 deleted the legacy files, and with them the last webview
  // sender of three commands the host still accepted, so the check grew a
  // `NO_WEBVIEW_SENDER` exemption map naming those three rather than weakening.
  //
  // The map is gone again, and this is the state it was written to reach. Its
  // three entries left one at a time and for different reasons, which is the
  // point: `CMD_RETRY_PHASE_NOW` earned a new dispatcher (finding C of the
  // lifecycle round-check of 2026-08-30), and `CMD_CLEAR_FAILED` and `CMD_RESET`
  // were deleted from the contract entirely (finding D). Nothing the host still
  // accepts is unreachable from the webview, so nothing needs excusing, and the
  // list's own instruction was to delete it rather than leave two assertions
  // iterating an empty set.
  //
  // A repopulated list needs both of those assertions back — that every entry
  // really has no sender, and that the list is non-empty so the first one
  // iterates something — and an entry added without them should not pass review.
  const sentCommands = new Set(allSites.map((s) => s.command));

  it('discovers every destructive command, because every one has a webview sender', () => {
    const missing = DESTRUCTIVE_COMMANDS.filter((cmd) => !sentCommands.has(cmd));
    expect(
      missing,
      `Destructive commands handed to no sender anywhere in webview source. Either a ` +
        `sender was removed — wire it back, or delete the command from the contract as ` +
        `finding D did — or the scan is broken:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('every destructive command sent from live code is gated by useConfirm in an enclosing scope (FR-016)', () => {
    const offenders = allSites.filter((s) => !s.guarded && !LEGACY_FILES.has(s.file));
    const rendered = offenders
      .map(
        (o) =>
          `  - ${o.file}:${o.line} — ${o.command} is sent without a useConfirm gate`
      )
      .join('\n');
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Destructive command call sites missing useConfirm gate:\n${rendered}`
    ).toEqual([]);
  });

  // Feature 082 (US7, T055) — catalog removals used to be invisible to the scan
  // above. A removal was an *omission* from a whole-array save command, so no
  // destructive command name appeared at the call site at all; what was
  // destructive was the declared mutation intent, and the gate was applied to the
  // sites that constructed a `{ kind: 'remove' | 'reset' }` shape instead.
  //
  // Feature 100 (T509a) retires that scan rather than extending it. A removal is
  // now `CMD_DEACTIVATE_DEFINITION` — a command of its own, posted from one place
  // — so the sender scan above sees it directly. Keeping the intent scan as well
  // would pin a second, weaker rule to a shape that no longer sends anything: the
  // `{ kind: 'remove' }` objects the Builder still builds are read by the
  // translation helpers and never reach the host, so requiring a confirmation
  // beside them would demand a prompt at the site that no longer asks (the prompt
  // moved into `deactivateDefinition`, beside the post it authorises).
  //
  // What remains is the other half of the claim, which the sender scan cannot
  // make: that each action key is actually reached.
  //
  // This began as a two-key check over the catalog lifecycle alone. The
  // lifecycle round-check of 2026-08-30 (finding E) widened it to every key,
  // because the narrow version could not have caught what happened: FR-R3-140
  // deleted `PhaseTracker.svelte`, the only component that passed
  // `run.retry-phase-now` to `useConfirm`, and no gate said anything — the copy
  // stayed in the table, typed and tested, describing a prompt nothing could
  // raise. The key list is read from `action-copy.ts` rather than restated here,
  // so a key added to the union is a key this check immediately demands a
  // consumer for.
  const ACTION_COPY_SOURCE = readFileSync(
    resolve(SCAN_ROOT, 'lib', 'action-copy.ts'),
    'utf8'
  );

  function declaredActionKeys(): readonly string[] {
    const union = /export type ActionKey =([\s\S]*?);/.exec(ACTION_COPY_SOURCE);
    if (!union) return [];
    return [...union[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  // Keys whose prompt is deliberately raised somewhere other than a webview
  // `useConfirm` call. Same bar as any exemption in this file: a sentence saying
  // where the confirmation went, not a name parked on a list.
  const CONFIRMED_ELSEWHERE: ReadonlyMap<string, string> = new Map([
    [
      'workspace.reset',
      'The webview sender (CMD_RESET) was deleted by the lifecycle round-check of ' +
        '2026-08-30 (finding D). Reset survives as the palette command schegent.reset, ' +
        'which raises its own host-side prompt — RESET_CONFIRMATION_MESSAGE in ' +
        'src/commands/reset.ts — so the decision is still confirmed, just not here. The ' +
        'key stays declared because it is the sole member of NEVER_SUPPRESSIBLE in ' +
        'use-confirm.ts, and an empty set would make that rule untested.'
    ]
  ]);

  const MIN_ELSEWHERE_REASON_LENGTH = 40;

  it('declares a non-empty ActionKey union that this file can read', () => {
    // The regex above returning nothing would make the two checks below pass
    // vacuously, which is the failure mode a source-parsing lint has.
    expect(declaredActionKeys().length).toBeGreaterThan(10);
  });

  it('passes every declared action key to useConfirm in live code', () => {
    const sources = files.map((filePath) => readFileSync(filePath, 'utf8'));
    const missing = declaredActionKeys().filter((key) => {
      if (CONFIRMED_ELSEWHERE.has(key)) return false;
      const re = new RegExp(`useConfirm\\(\\s*'${key.replace(/\./g, '\\.')}'`);
      return !sources.some((source) => re.test(source));
    });
    expect(
      missing,
      `Action keys declared in ACTION_COPY but never passed to useConfirm. Either the ` +
        `component that raised the prompt was deleted — rebuild the dispatcher, as ` +
        `finding C did for run.retry-phase-now — or the key is dead and should be ` +
        `removed from the union:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('every CONFIRMED_ELSEWHERE key is still declared and still has no webview consumer', () => {
    const declared = new Set(declaredActionKeys());
    const sources = files.map((filePath) => readFileSync(filePath, 'utf8'));
    for (const [key, reason] of CONFIRMED_ELSEWHERE) {
      expect(declared, `${key} is excused but no longer declared in ActionKey`).toContain(key);
      expect(
        reason.trim().length,
        `${key} needs a reason saying where its confirmation moved to`
      ).toBeGreaterThan(MIN_ELSEWHERE_REASON_LENGTH);
      const re = new RegExp(`useConfirm\\(\\s*'${key.replace(/\./g, '\\.')}'`);
      expect(
        sources.some((source) => re.test(source)),
        `${key} is excused as confirmed elsewhere, but a webview useConfirm call now ` +
          `raises it. Remove it from CONFIRMED_ELSEWHERE.`
      ).toBe(false);
    }
  });

  it('registers no confirmation action for the exchange commands (FR-018, FR-044b)', () => {
    const exchangeCommands = ['CMD_EXPORT_PROCESS_YAML', 'CMD_PREFLIGHT_PROCESS_YAML'];
    for (const command of exchangeCommands) {
      expect(
        DESTRUCTIVE_COMMANDS,
        `${command} must not be gated by the shared destructive-confirmation flow`
      ).not.toContain(command);
    }

    // The other half of the same claim: no `ActionKey` describes an exchange, so
    // there is no copy for a confirmation that should never be asked for.
    const actionCopy = readFileSync(
      resolve(REPO_ROOT, 'webview-ui', 'src', 'lib', 'action-copy.ts'),
      'utf8'
    );
    const declaredKeys = [...actionCopy.matchAll(/^ {2}'([a-z]+\.[a-z-]+)':/gm)].map(
      (match) => match[1]!
    );
    expect(declaredKeys.length).toBeGreaterThan(0);
    const exchangeKeys = declaredKeys.filter((key) =>
      /export|import|yaml|document/.test(key)
    );
    expect(
      exchangeKeys,
      `Exchange actions must not register a confirmation action:\n${exchangeKeys.join('\n')}`
    ).toEqual([]);
  });
});
