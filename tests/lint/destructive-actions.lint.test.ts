// Feature 063 — T046. Lint regression that enforces FR-016: every
// invocation of a destructive IPC command from the webview must be
// wrapped by `useConfirm(actionKey)` so the operator-facing confirmation
// flow gates the destructive side effect.
//
// The 15 destructive commands are the ones that mutate persisted queue,
// run, workspace, or catalog state in a user-visible way. Each has an
// `ActionKey` entry in `webview-ui/src/lib/action-copy.ts`, but the table is a
// superset: it also carries keys for destructive decisions that are not commands
// of their own (the output overwrite confirmed inside a run launch).
// `workspace.reset` is the lone non-suppressible action.
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
// LEGACY_FILES allows orphaned components that still carry ungated
// destructive calls but are no longer reachable from any live UI
// surface; their deletion is parked behind a follow-up cleanup spec
// (the active code path moved to Dashboard.svelte + QueueControls.svelte
// post-053). The lint test asserts each entry still exists on disk so
// the allowlist can never silently rot once the file is removed.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

// The 15 commands that the action-copy table gates. Adding a new
// destructive command means adding it here AND to ACTION_COPY (the
// pinned-key unit test at `webview-ui/src/lib/__tests__/action-copy.test.ts`
// keeps the latter honest).
const DESTRUCTIVE_COMMANDS: readonly string[] = [
  'CMD_CLEAR_ALL',
  'CMD_CLEAR_COMPLETED',
  'CMD_CLEAR_FAILED',
  'CMD_REMOVE_QUEUE_ITEM',
  'CMD_CANCEL',
  'CMD_PAUSE_QUEUE',
  'CMD_RESUME_QUEUE',
  'CMD_RETRY_PHASE_NOW',
  'CMD_RESTART_CANCELED_TASK',
  'CMD_MODIFY_TASK',
  'CMD_RERUN_FROM_HISTORY',
  'CMD_RESET',
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

// Dead-code components that still carry ungated destructive call sites
// but are no longer reachable from any live UI surface. The follow-up
// cleanup spec will delete them; until then, the allowlist prevents
// noise while still pinning real regressions in live code.
const LEGACY_FILES: ReadonlySet<string> = new Set<string>([
  // Replaced post-053 by `QueueControls.svelte` + `Dashboard.svelte`
  // handler bodies. Its only consumer (`QueueList.svelte`) is itself
  // orphaned (no Dashboard import).
  'webview-ui/src/components/QueueGlobalActions.svelte'
]);

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

  it('discovers each of the 15 destructive commands at least once in webview source', () => {
    // We accept matches from either live or legacy files so the sanity
    // check stays meaningful even when a destructive command has been
    // subsumed by another (e.g., `CMD_CLEAR_FAILED` is no longer wired
    // up from any live component — `CMD_CLEAR_ALL` covers it — but the
    // constant must still be handed to a sender somewhere in the webview tree).
    const seen = new Set(allSites.map((s) => s.command));
    const missing = DESTRUCTIVE_COMMANDS.filter((cmd) => !seen.has(cmd));
    expect(
      missing,
      `Destructive commands handed to no sender anywhere in webview source:\n${missing.join('\n')}`
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

  it('every entry in LEGACY_FILES still exists on disk (allowlist is not stale)', () => {
    for (const rel of LEGACY_FILES) {
      const abs = resolve(REPO_ROOT, rel);
      expect(existsSync(abs), `legacy allowlist entry no longer exists on disk: ${rel}`).toBe(true);
    }
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
  // make: that each catalog action key is actually reached. Four keys collapsed to
  // two here — one `remove` key per definition kind became one kind-agnostic
  // deactivate, and `catalog.reset-workflows` has no successor because emptying a
  // layer in one write is not an operation the store provides any more.
  const CATALOG_LIFECYCLE_ACTION_KEYS: readonly string[] = [
    'catalog.deactivate-definition',
    'catalog.discard-draft'
  ];

  it('passes each catalog lifecycle action key to useConfirm in live code', () => {
    const sources = files.map((filePath) => readFileSync(filePath, 'utf8'));
    const missing = CATALOG_LIFECYCLE_ACTION_KEYS.filter((key) => {
      const re = new RegExp(`useConfirm\\(\\s*'${key.replace('.', '\\.')}'`);
      return !sources.some((source) => re.test(source));
    });
    expect(
      missing,
      `Action keys declared in ACTION_COPY but never passed to useConfirm:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  // Feature 084 (T063, QS-40) — the exchange feature deliberately adds nothing
  // here. FR-018 and FR-044b: the shared gate exists for actions that remove or
  // replace something the operator holds INSIDE the product. Export writes a
  // file the operator names in the host's own save dialog, where overwrite
  // consent already lives; import only appends, and confirming the plan is the
  // consent. Registering either here would ask twice for one decision and would
  // teach the gate to fire on non-destructive actions.
  //
  // Pinned as a list rather than a count so a swap — one command out, one in —
  // is as visible as an addition.
  it('leaves the destructive-command list at the pinned 15 (FR-018, FR-044b, QS-40)', () => {
    expect(DESTRUCTIVE_COMMANDS).toEqual([
      'CMD_CLEAR_ALL',
      'CMD_CLEAR_COMPLETED',
      'CMD_CLEAR_FAILED',
      'CMD_REMOVE_QUEUE_ITEM',
      'CMD_CANCEL',
      'CMD_PAUSE_QUEUE',
      'CMD_RESUME_QUEUE',
      'CMD_RETRY_PHASE_NOW',
      'CMD_RESTART_CANCELED_TASK',
      'CMD_MODIFY_TASK',
      'CMD_RERUN_FROM_HISTORY',
      'CMD_RESET',
      // Feature 095 (T011, FR-003) — the thirteenth. Deleting a queue drops
      // its pending Tasks with no undo, which is the queue-scoped analogue of
      // `CMD_CLEAR_ALL`; the gate is the same one, not a second flow.
      'CMD_DELETE_QUEUE',
      // Feature 100 (T509a) — the fourteenth and fifteenth, and the first two
      // whose gate lives inside the sender rather than at the call site
      // (FR-049, FR-050). Four catalog `ActionKey` entries became two in the
      // same change, so this list grew by two while the key list shrank by two;
      // pinning both is what makes that trade visible instead of arithmetic.
      'CMD_DEACTIVATE_DEFINITION',
      'CMD_DISCARD_DEFINITION_DRAFT'
    ]);
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

  it('every LEGACY_FILES entry has at least one ungated destructive call site (otherwise it should leave the allowlist)', () => {
    const offendersByFile = new Map<string, number>();
    for (const site of allSites) {
      if (!site.guarded && LEGACY_FILES.has(site.file)) {
        offendersByFile.set(site.file, (offendersByFile.get(site.file) ?? 0) + 1);
      }
    }
    const stale: string[] = [];
    for (const rel of LEGACY_FILES) {
      if (!offendersByFile.has(rel)) stale.push(rel);
    }
    expect(
      stale,
      `Stale legacy allowlist entries (no ungated destructive call site found):\n${stale.join('\n')}`
    ).toEqual([]);
  });
});
