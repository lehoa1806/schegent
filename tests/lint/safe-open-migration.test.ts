import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FR-R3-053 — a module that writes to or reads from a path under the workspace
 * must go through `openWithinRoot`, not a raw `fs` call on a composed pathname.
 *
 * Why a gate and not a convention: the H-02 escape was not exotic. It was
 * `path.join` + `mkdir -p` + `appendFile`, the obvious way to write a file, in
 * the module whose whole job is the evidence record. Any new sink written the
 * obvious way reintroduces it, and no reviewer catches that reliably.
 *
 * HOW THE REMAINING WORK IS TRACKED
 *
 * `UNMIGRATED` is the honest state of the migration, not an exemption list.
 * Every entry is a module FR-R3-053 names and this cycle did not reach. Two
 * rules keep it from becoming permanent:
 *
 *   - Nothing may be ADDED to it. A new sink either uses the primitive or fails
 *     this gate; the list only shrinks.
 *   - An entry that no longer needs to be there fails the gate too, so a
 *     migration cannot land without striking its own line.
 *
 * That is the difference between a tracked debt and a silent cap. Sampling which
 * modules to check, or exempting by directory, is what let this class of defect
 * live in the audit writer through several reviews.
 */
const SRC = resolve(__dirname, '..', '..', 'src');

/** Raw filesystem calls that resolve a pathname, and therefore follow symlinks. */
const RAW_PATH_CALL =
  /\bfs[a-zA-Z]*\.(appendFile|writeFile|readFile|createWriteStream|createReadStream|mkdir|open)\s*\(/;

/**
 * The other shape, and the one that nearly slipped past this gate:
 * `runtime-log-sink.ts` and `cli-transport-sink.ts` take their filesystem calls
 * as INJECTED function ports (`readonly appendFile?: AppendFn`), so the raw call
 * happens at the wiring site and the direct-call regex above sees nothing. A
 * detector that only found direct calls would have reported both as migrated.
 */
const INJECTED_FS_PORT = /\breadonly\s+\w+\??:\s*(AppendFn|WriteFileFn|MkdirFn|ReadFileFn)\b/;

/**
 * Modules still on a raw filesystem call, which this cycle did not reach. Each
 * is filed as follow-on work; see the item file's "what was not done".
 *
 * ELEVEN of these are NOT in the list FR-R3-053 names. The review enumerated the
 * sinks it had found by reading; this gate enumerates them by measuring, and
 * found the catalog store, the metrics rollup, the history description store,
 * the run checkpoint service, the ownership store and the cold-start audit
 * reader as well. That gap is itself a finding: the migration was scoped from a
 * hand-built list.
 */
const UNMIGRATED: readonly string[] = [
  'audit/raw-transcript-writer.ts',
  'audit/verbose-diagnostic-writer.ts',
  'catalog/catalog-manifest.ts',
  'catalog/version-record.ts',
  'controller/phase-sidecar-reader.ts',
  'lib/catalog-fs-adapter.ts',
  'lib/runtime-log/runtime-log-sink.ts',
  'metrics/metrics-rollup-reader.ts',
  'metrics/metrics-rollup-writer.ts',
  'monitor/cli-transport-sink.ts',
  'services/history/history-description-store.ts',
  'services/phase-log/phase-log-reader.ts',
  'services/phase-log/phase-log-tail-session.ts',
  'services/run-checkpoint-service.ts',
  'services/run-request/local-input-validator.ts',
  'state/ownership-fs.ts',
  'ui/sidebar/audit-tail-coldstart.ts'
];

/**
 * Modules that are not workspace sinks or sources at all, so the primitive does
 * not apply. Kept short and reasoned, because a broad exemption is how a gate
 * stops gating.
 */
const NOT_A_WORKSPACE_SINK: readonly string[] = [
  // The primitive itself.
  'lib/safe-open.ts',
  // Answers "is this contained?" for one-shot operations; the primitive's peer,
  // not a consumer.
  'lib/path-containment.ts',
  // VS Code global-storage and extension-install paths, outside any workspace.
  'extension.ts',
  // Operator-chosen export destination, deliberately outside the workspace.
  'commands/export-audit.ts',
  // Reads the extension's own bundled webview asset, not a workspace path.
  'ui/sidebar/html.ts'
];

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function rawCallers(): readonly string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const body = readFileSync(file, 'utf8');
    if (!RAW_PATH_CALL.test(body) && !INJECTED_FS_PORT.test(body)) continue;
    out.push(relative(SRC, file).split(/[/\\]/).join('/'));
  }
  return out.sort();
}

describe('safe-open migration (FR-R3-053)', () => {
  const callers = rawCallers();

  it('finds raw filesystem callers at all', () => {
    // Without this the regex could stop matching -- after a rename, say -- and
    // every assertion below would pass by finding nothing.
    expect(callers.length).toBeGreaterThan(5);
  });

  it('has no raw path call outside the tracked and reasoned sets', () => {
    const known = new Set([...UNMIGRATED, ...NOT_A_WORKSPACE_SINK]);
    const unexpected = callers.filter((f) => !known.has(f));
    // A new entry here is a new sink built the way the H-02 escape was built.
    // Use `openWithinRoot`, or add a reasoned line to NOT_A_WORKSPACE_SINK.
    expect(unexpected).toEqual([]);
  });

  it('lists nothing in UNMIGRATED that no longer needs to be there', () => {
    const current = new Set(callers);
    const stale = UNMIGRATED.filter((f) => !current.has(f));
    // A migration must strike its own line. Otherwise the list records work as
    // outstanding after it is done, and stops meaning anything.
    expect(stale).toEqual([]);
  });

  it('keeps the audit path migrated', () => {
    // The one FR-R3-053 confirmed exploitable with no race. Named explicitly so
    // a regression here fails as itself and not as a count.
    expect(callers).not.toContain('audit/audit-log-writer.ts');
    expect(callers).not.toContain('audit/schegent-gitignore.ts');
  });
});
