// Feature 063 — T046. Lint regression that enforces FR-016: every
// invocation of a destructive IPC command from the webview must be
// wrapped by `useConfirm(actionKey)` so the operator-facing confirmation
// flow gates the destructive side effect.
//
// The 13 destructive commands are the ones that mutate persisted queue,
// run, or workspace state in a user-visible way. Each has an `ActionKey`
// entry in `webview-ui/src/lib/action-copy.ts`, but the table is a superset:
// it also carries keys for destructive decisions that are not commands of
// their own (the catalog removals, and the output overwrite confirmed inside
// a run launch). `workspace.reset` is the lone non-suppressible action.
//
// For each `postCommand(CMD_DESTRUCTIVE, ...)` call site under
// `webview-ui/src/**/*.{svelte,ts}` (excluding `__tests__/`), the test
// walks outward through enclosing function bodies via brace matching.
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
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

// The 13 commands that the action-copy table gates. Adding a new
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
  'CMD_DELETE_QUEUE'
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
  const out = execSync(
    `find "${SCAN_ROOT}" \\( -name '*.svelte' -o -name '*.ts' \\) -not -path '*/__tests__/*'`,
    { encoding: 'utf8' }
  );
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
    // `postCommand(CMD_X` with optional whitespace before the constant.
    // A `\b` word boundary after the name prevents `CMD_RESET` from
    // matching `CMD_RESET_QUEUE` (no such constant exists today, but
    // the boundary is cheap insurance).
    const re = new RegExp(`postCommand\\(\\s*${cmd}\\b`, 'g');
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

describe('Feature 063 T046 — destructive postCommand sites must be useConfirm-gated', () => {
  const files = listFiles();
  const allSites: readonly CallSite[] = files.flatMap((f) => scanFile(f));

  it('discovers at least one destructive postCommand call site (sanity)', () => {
    expect(allSites.length).toBeGreaterThan(0);
  });

  it('discovers each of the 13 destructive commands at least once in webview source', () => {
    // We accept matches from either live or legacy files so the sanity
    // check stays meaningful even when a destructive command has been
    // subsumed by another (e.g., `CMD_CLEAR_FAILED` is no longer wired
    // up from any live component — `CMD_CLEAR_ALL` covers it — but the
    // constant must still appear somewhere in the webview tree).
    const seen = new Set(allSites.map((s) => s.command));
    const missing = DESTRUCTIVE_COMMANDS.filter((cmd) => !seen.has(cmd));
    expect(
      missing,
      `Destructive commands with no postCommand call site anywhere in webview source:\n${missing.join('\n')}`
    ).toEqual([]);
  });

  it('every destructive postCommand in live code is gated by useConfirm in an enclosing scope (FR-016)', () => {
    const offenders = allSites.filter((s) => !s.guarded && !LEGACY_FILES.has(s.file));
    const rendered = offenders
      .map(
        (o) =>
          `  - ${o.file}:${o.line} — postCommand(${o.command}, ...) is not guarded by useConfirm`
      )
      .join('\n');
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Destructive postCommand call sites missing useConfirm gate:\n${rendered}`
    ).toEqual([]);
  });

  it('every entry in LEGACY_FILES still exists on disk (allowlist is not stale)', () => {
    for (const rel of LEGACY_FILES) {
      const abs = resolve(REPO_ROOT, rel);
      expect(existsSync(abs), `legacy allowlist entry no longer exists on disk: ${rel}`).toBe(true);
    }
  });

  // Feature 082 (US7, T055) — catalog removals never reach `postCommand`
  // directly: they go through the shared `savePipelines` / `savePhases`
  // helpers, so the command-name scan above cannot see them. What is
  // destructive is the declared *mutation intent*, so the same
  // enclosing-scope `useConfirm(` rule is applied to the sites that build a
  // layer-shrinking mutation (FR-023).
  //
  // Feature 083 (US5, T059) — the Workflow Builder joins the same gate. Its
  // `reset` intent is here too: `reset` empties the whole scope layer, so it is
  // strictly more destructive than the single-row `remove` and would otherwise
  // be the one layer-shrinking mutation with no key of its own.
  const CATALOG_REMOVAL_ACTION_KEYS: readonly string[] = [
    'catalog.remove-pipeline',
    'catalog.remove-phase',
    'catalog.remove-workflow',
    'catalog.reset-workflows'
  ];

  // `{ kind: 'remove' | 'reset' }` as *constructed*, not as declared: the
  // `readonly kind:` members of the contract type unions never match.
  const MUTATION_RE = /\{\s*kind:\s*'(remove|reset)'/g;

  const removalSites = files.flatMap((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    const range = getScriptRange(source, filePath);
    if (!range) return [] as CallSite[];
    const sites: CallSite[] = [];
    MUTATION_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MUTATION_RE.exec(source)) !== null) {
      if (match.index < range.start || match.index >= range.end) continue;
      sites.push({
        file: relativize(filePath),
        line: source.slice(0, match.index).split('\n').length,
        command: `mutation:${match[1]}`,
        guarded: hasUseConfirmInAncestors(source, match.index, range)
      });
    }
    return sites;
  });

  it('discovers at least one catalog removal mutation site (sanity)', () => {
    expect(removalSites.length).toBeGreaterThan(0);
  });

  it('every catalog removal mutation is gated by useConfirm in an enclosing scope (FR-023)', () => {
    const offenders = removalSites.filter((site) => !site.guarded);
    const rendered = offenders
      .map((o) => `  - ${o.file}:${o.line} — ${o.command} is not guarded by useConfirm`)
      .join('\n');
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Catalog removal mutations missing useConfirm gate:\n${rendered}`
    ).toEqual([]);
  });

  it('passes each catalog removal action key to useConfirm in live code', () => {
    const sources = files.map((filePath) => readFileSync(filePath, 'utf8'));
    const missing = CATALOG_REMOVAL_ACTION_KEYS.filter((key) => {
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
  it('leaves the destructive-command list at the pinned 13 (FR-018, FR-044b, QS-40)', () => {
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
      'CMD_DELETE_QUEUE'
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
