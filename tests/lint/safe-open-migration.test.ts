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

/**
 * Raw filesystem calls that resolve a pathname, and therefore follow symlinks.
 *
 * FR-R3-078 (feature 153) added `rename`, and the omission it closes is worth
 * recording: this gate was written against the H-02 escape shape — `path.join`
 * + `mkdir -p` + `appendFile` — and `rename` resolves BOTH of its pathnames the
 * same way. `raw-transcript-writer.ts`'s promotion was a `rename` on two names
 * judged a moment earlier, which is `SEC-03` exactly, and this detector would
 * have reported the module as migrated the moment its opens were fixed. A gate
 * that misses the call the item is about is the shape of defect this whole
 * round has been about.
 */
const RAW_PATH_CALL =
  /\bfs[a-zA-Z]*\.(appendFile|writeFile|readFile|createWriteStream|createReadStream|mkdir|open|rename)\s*\(/;

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
  // `audit/raw-transcript-writer.ts` struck 2026-08-25 (FR-R3-078, feature 153) —
  // fully migrated. The entry used to read "the APPEND path is migrated; the
  // promotion/rename and spool-root calls are not", and a partially migrated
  // module is an unmigrated one. All three are now closed: `doWriteEnd` opens
  // through `openWithinRoot` instead of re-resolving a judged pathname,
  // `finalizeRun` promotes descriptor-to-descriptor and then removes the source
  // through the contained-removal helper, and the spool root is created by
  // `ensureAnchorWithinRoot` anchored at its OS-temp parent.
  //
  // Two things this strike does NOT claim. The promotion is no longer atomic —
  // Node exposes no `renameat`, so handle-relative promotion costs `rename`'s
  // atomicity; a crash between copy and removal leaves the pending transcript
  // intact and the next finalize reclaims it. And the spool root is anchored at
  // the OS temp parent rather than beneath the workspace root, because spools
  // are deliberately outside the workspace and relocating unredacted scratch
  // into the tree a run is editing would widen the exposure. Both are recorded
  // at their call sites in the module as well as here.
  //
  // This gate is also the non-vacuity control for the promotion: the adversarial
  // fixture in tests/unit/audit/raw-transcript-writer-containment.test.ts cannot
  // discriminate the check-to-use window (the old shape refused that arrangement
  // too), and a raw `fs.rename` returning to this module fails HERE, by name.
  // `audit/verbose-diagnostic-writer.ts` struck 2026-08-24 — fully migrated. Left
  // as a comment rather than deleted silently: the ledger only shrinks, and
  // recording which line went is how that stays checkable.
  'catalog/catalog-manifest.ts',
  'catalog/version-record.ts',
  'controller/phase-sidecar-reader.ts',
  // `lib/catalog-fs-adapter.ts` struck 2026-08-25 (FR-R3-069, feature 152) —
  // fully migrated: reads and writes go through `openWithinRootByPath`, the
  // store chain is created by `ensureAnchorWithinRoot` beneath the workspace
  // root, and judgments anchor at the workspace rather than at the store.
  'lib/runtime-log/runtime-log-sink.ts',
  'metrics/metrics-rollup-reader.ts',
  'metrics/metrics-rollup-writer.ts',
  'monitor/cli-transport-sink.ts',
  'services/history/history-description-store.ts',
  'services/phase-log/phase-log-reader.ts',
  'services/phase-log/phase-log-tail-session.ts',
  // FR-R3-053 — every WORKSPACE-adjacent path in this module is migrated: the
  // patch, the metadata, the decline marker and the `checkpoints/<runId>` chain
  // all go through the checked walk, which matters because a checkpoint patch can
  // hold an unredacted binary Git diff.
  //
  // One raw call remains, deliberately: `fs.mkdir(this.root)`. In production that
  // root is `context.globalStorageUri.fsPath` — VS Code's per-extension global
  // storage, outside the workspace and a directory the extension is expected to
  // create. It is the walk's TRUST ANCHOR, and the walk never creates its own
  // anchor. Kept on this list rather than moved to a whole-module exemption,
  // because "one reasoned call" is exactly what a ledger should show.
  'services/run-checkpoint-service.ts',
  'services/run-request/local-input-validator.ts',
  // `state/ownership-fs.ts` struck 2026-08-25 (FR-R3-069, feature 152). The
  // 2026-08-24 attempt was reverted because the port's containment root WAS the
  // directory `ensureDir` must create and `openWithinRoot` never creates its
  // own root — measured as every election refusing `io-failed ENOENT`. The fix
  // took both halves that note named: the workspace root threaded through
  // `createDiskOwnershipFs` as the trusted anchor, and the root-creating
  // primitive (`ensureAnchorWithinRoot`) for the store chain itself.
  'ui/sidebar/audit-tail-coldstart.ts'
];

/**
 * FR-R3-078 (feature 153) — modules whose ONLY remaining raw call is the rename
 * half of an atomic publish, and what that costs.
 *
 * Widening `RAW_PATH_CALL` to cover `rename` surfaced three sites the detector
 * had never looked at. None of them is a new sink and none was written since the
 * migration: each is `write temp through the checked walk` → `fs.rename(temp,
 * final)` inside a directory the walk already proved. Two of the three
 * (`lib/catalog-fs-adapter.ts`, `state/ownership-fs.ts`) were STRUCK from
 * `UNMIGRATED` by feature 152, and they were struck honestly — against a
 * detector that could not see a rename. That is a finding about the gate, and it
 * is recorded here rather than repaired by narrowing the regex back.
 *
 * These are listed separately from `UNMIGRATED` because the remaining exposure is
 * a different one. An unmigrated sink resolves a pathname it was handed; these
 * publish a file they created themselves, inside a directory they proved, and the
 * residual window is the same one no Node primitive can close: `rename` cannot be
 * made handle-relative without `renameat`, which needs a native binding. That
 * dependency question is `FR-R3-083`'s, and this list is what it will consume.
 *
 * What is NOT permitted here: a rename of a pathname a caller supplied, or a
 * rename whose destination directory was not walked. `FR-R3-078` had one of
 * those — `raw-transcript-writer.ts`'s promotion — and it was replaced with a
 * descriptor copy rather than added to this list.
 */
const ATOMIC_PUBLISH_RENAME_RESIDUAL: readonly string[] = [
  'audit/audit-log-writer.ts',
  'lib/catalog-fs-adapter.ts',
  'state/ownership-fs.ts'
];

/**
 * Modules that are not workspace sinks or sources at all, so the primitive does
 * not apply. Kept short and reasoned, because a broad exemption is how a gate
 * stops gating.
 */
const NOT_A_WORKSPACE_SINK: readonly string[] = [
  // FR-R3-079 (T1060) — the OUTPUT side was never counted, and the reason it is
  // still not listed is a measurement rather than an omission. The 2026-08-24
  // register noted that `services/run-request/local-input-validator.ts` is on the
  // ledger while its sibling `output-target-validator.ts` is not; re-measured on
  // 2026-08-25, that validator makes no filesystem call at all — existence is
  // asked of an injected probe, and the probe (`services/run-output/run-output-probe.ts`)
  // uses `lstat`, which observes and never opens. Nothing was missed, so nothing
  // is added; the item's "add it if it is not fully migrated" resolves to the
  // other arm, and this comment is where that resolution is recorded so the
  // question is not re-opened from the register alone.
  //
  // The output side's real gap was never a raw call. It was that the containment
  // verdict was LEXICAL and taken once; `services/dispatch-output-guard.ts` is
  // where that is answered, at the point of effect.
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
    // CODE lines only. This gate was written matching raw text, and it then
    // flagged `lib/bounded-read.ts` for a docstring that NAMES the
    // `fs.readFile` call it replaced. That is the third gate in this round to
    // need the same correction (after `no-direct-syslog-fs-writes` and the
    // bounded-reader gate), and the pattern is now unmistakable: a gate that
    // matches comments pressures an author to write a worse comment to satisfy
    // it, and a codebase that explains its own history will keep tripping one.
    const body = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
        );
      })
      .join('\n');
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
    const known = new Set([
      ...UNMIGRATED,
      ...NOT_A_WORKSPACE_SINK,
      ...ATOMIC_PUBLISH_RENAME_RESIDUAL
    ]);
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
    //
    // FR-R3-078 qualified this, and the qualification is the honest reading: the
    // audit writer's APPEND path — the H-02 escape itself — is migrated and must
    // stay migrated, which is what the `UNMIGRATED` assertion below pins. Its
    // archive `rename` is the atomic-publish residual above, listed by name.
    expect(UNMIGRATED).not.toContain('audit/audit-log-writer.ts');
    expect(callers).not.toContain('audit/schegent-gitignore.ts');
    // And the residual is exactly the rename, not a re-opened append path.
    const body = readFileSync(join(SRC, 'audit', 'audit-log-writer.ts'), 'utf8');
    const rawCalls = [...body.matchAll(new RegExp(RAW_PATH_CALL, 'g'))];
    expect(rawCalls.every((match) => match[1] === 'rename')).toBe(true);
  });

  it('keeps the atomic-publish residual list to renames only', () => {
    // The list exists for one call shape. A module that acquired a raw `open` or
    // `mkdir` must not be sheltered by having been on it for a `rename`.
    for (const relPath of ATOMIC_PUBLISH_RENAME_RESIDUAL) {
      const body = readFileSync(join(SRC, ...relPath.split('/')), 'utf8')
        .split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim();
          return (
            !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
          );
        })
        .join('\n');
      const kinds = [...body.matchAll(new RegExp(RAW_PATH_CALL, 'g'))].map((m) => m[1]);
      expect({ relPath, kinds: [...new Set(kinds)] }).toEqual({ relPath, kinds: ['rename'] });
    }
  });
});
