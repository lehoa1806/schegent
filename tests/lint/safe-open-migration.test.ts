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
 *
 * WHAT THIS LEDGER CANNOT CLOSE (FR-R3-080, T1078)
 *
 * The walk `lstat`s each component and then opens the leaf with `O_NOFOLLOW`.
 * That closes the no-race hole — a path that IS a link, or that goes through
 * one, is refused. It does not close the window between one component's `lstat`
 * and the next syscall: an adversary who wins that interval can still swap a
 * component the walk has already passed.
 *
 * Closing it needs a handle-relative walk — `openat` against each directory's
 * descriptor — and Node exposes no `openat`; `/proc/self/fd` is Linux-only. So
 * it needs a native binding, which is a dependency decision and not this item's
 * to take. `FR-R3-083` asks the same question for Windows and for the Job
 * Object, and this ledger consumes whatever that decision reaches. Until then
 * the residual is stated here rather than implied by a list of struck entries,
 * and `package.json` gains nothing.
 *
 * The `ATOMIC_PUBLISH_RENAME_RESIDUAL` list below is the same residual in its
 * sharpest form: `rename` cannot be made handle-relative at all without
 * `renameat`, so those three sites cannot be struck by any amount of care in
 * this repository.
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
  // `controller/phase-sidecar-reader.ts` struck 2026-08-25 (FR-R3-080, T1067) —
  // the read goes through the checked walk. It already opened with `O_NOFOLLOW`,
  // which the module's own comment correctly described as closing the window on
  // the FINAL component; what it said nothing about was the components ABOVE it,
  // where a link redirects the open before the kernel ever looks at the leaf.
  // The walk covers both and keeps the `O_NOFOLLOW` leaf open, so the fstat and
  // descriptor-read discipline that comment describes is unchanged. A link at
  // any depth now reports `path-symlink-redirect`, which the leaf-only ELOOP
  // branch used to report for the leaf alone.
  // `lib/catalog-fs-adapter.ts` struck 2026-08-25 (FR-R3-069, feature 152) —
  // fully migrated: reads and writes go through `openWithinRootByPath`, the
  // store chain is created by `ensureAnchorWithinRoot` beneath the workspace
  // root, and judgments anchor at the workspace rather than at the store.
  // FR-R3-080 (T1064, feature 153) — the SEC-07 APPEND window is closed and the
  // entry stays, because the module is not fully migrated and a partially
  // migrated module is an unmigrated one.
  //
  // What changed: the append used to prove the target once and then write to the
  // PATHNAME on every line — the module's own comment said the residual out
  // loud ("a target replaced mid-run with no accompanying settings change keeps
  // its cached verdict until the next clear") and named paying `realpath` per
  // line as the only way to shrink it. It now holds the DESCRIPTOR the walk
  // produced, so the window is gone rather than narrowed, and the walk costs one
  // open per target rather than one resolution per line. The roots are still read
  // fresh on every append, so a narrowing is not inherited.
  //
  // What remains: rotation's `rename`/`unlink` and the `stat`/`readdir` reads go
  // through injected function ports, which is what this gate's `INJECTED_FS_PORT`
  // arm sees. Each destructive step proves its own path with the link form first,
  // so they are check-then-act on a pathname — the same class, on the once-per-
  // rollover half rather than the once-per-line half. Closing them means either a
  // handle-relative rename (`FR-R3-083`'s dependency question) or removing the
  // injected ports, which are this module's only test seam.
  'lib/runtime-log/runtime-log-sink.ts',
  'metrics/metrics-rollup-reader.ts',
  'metrics/metrics-rollup-writer.ts',
  // FR-R3-080 (T1065, feature 153) — the SEC-07 APPEND window is closed and the
  // entry stays, for the same reason its twin `lib/runtime-log/runtime-log-sink.ts`
  // does. The append holds the descriptor the walk produced instead of writing to
  // a pathname a verdict once approved, and the configured root is re-read per
  // record so a change of scope is not inherited.
  //
  // What keeps it here: rotation's rename/unlink still act on pathnames behind
  // their own link-form verdicts, and the `appendFile` port survives as the
  // failure-injection seam for the warn-once-per-cause tests (EACCES, ENOSPC,
  // ENOENT-parent cannot be induced reliably on a real filesystem). Production
  // supplies no such port — but an injected write port is a pathname write by
  // another name, and pretending otherwise is what a ledger exists to prevent.
  'monitor/cli-transport-sink.ts',
  // `services/history/history-description-store.ts` struck 2026-08-25
  // (FR-R3-080, feature 153) — the SEC-06 check-then-act write is migrated. The
  // `containedPathFor` verdict that used to precede it is gone from the write
  // path rather than kept in front of the walk: leaving it would have made it
  // the deciding check again, one resolution earlier than the effect. Both
  // properties it enforced survive — "under `.schegent/history/`" is structural
  // (segments derived from a ref this module minted from a `SAFE_RUN_ID`), and
  // "inside the workspace" is what the walk answers at the point of effect. The
  // read and remove paths keep the verdict, because their refs arrive from
  // persisted state an operator can edit.
  // `services/phase-log/phase-log-reader.ts` struck 2026-08-25 (FR-R3-080,
  // T1070) — the bounded tail now reads from a descriptor the walk produced. The
  // FR-R3-052 bound is untouched; only where the descriptor comes from changed.
  // `services/phase-log/phase-log-tail-session.ts` struck 2026-08-25 (FR-R3-080,
  // T1071) — same change, plus the trusted root the session needed to do it. The
  // root is REQUIRED on the session's deps rather than optional: a tail with no
  // root would open by pathname, which is the state being left. The registry
  // already held it, since it composes the file path from it.
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
  //
  // FR-R3-080 (T1077, 2026-08-25) re-decided this rather than inheriting it, and
  // the decision is unchanged. `ensureAnchorWithinRoot` — the primitive
  // FR-R3-069 added, and the one that resolved the same question for the raw
  // transcript writer's spool root under FR-R3-078 — anchors at a HIGHER trusted
  // root and walks the components below it. Global storage has no such higher
  // root: its parent is VS Code's own extension-storage directory, which this
  // extension neither owns nor may create, so anchoring there would assert a
  // trust relationship that does not exist. The entry therefore stays, with its
  // reason, which is what the item asks for when the anchor is not creatable
  // beneath something trusted.
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
 * FR-R3-080 (T1068, T1069) — modules the detector matches by NAME, not by call.
 *
 * `catalog/catalog-manifest.ts` and `catalog/version-record.ts` were on
 * `UNMIGRATED` because they contain `fs.readFile(...)`. They do — but `fs` there
 * is a PARAMETER of type `CatalogFsPort`, whose `readFile` takes path SEGMENTS
 * and whose adapter (`lib/catalog-fs-adapter.ts`) was migrated to the checked
 * walk by feature 152. Neither module imports node's filesystem at all.
 *
 * So the entries were never work; they were a false positive the ledger had been
 * carrying as debt. Striking them for a migration that never needed to happen
 * would be a false claim, so they are recorded here instead, and the assertion
 * below is what makes the claim checkable: a module on this list that acquires a
 * real `node:fs` import fails the gate.
 */
const READS_THROUGH_MIGRATED_PORT: readonly string[] = [
  'catalog/catalog-manifest.ts',
  'catalog/version-record.ts'
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
      ...ATOMIC_PUBLISH_RENAME_RESIDUAL,
      ...READS_THROUGH_MIGRATED_PORT
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

  it('keeps the port-reading list free of any real filesystem import', () => {
    // What makes a `fs.readFile(...)` in these modules safe is that `fs` is a
    // `CatalogFsPort` parameter and not node's. The moment one imports the real
    // thing, that reasoning stops holding and this fails.
    for (const relPath of READS_THROUGH_MIGRATED_PORT) {
      const body = readFileSync(join(SRC, ...relPath.split('/')), 'utf8');
      expect({ relPath, importsNodeFs: /from '(node:)?fs(\/promises)?'/.test(body) }).toEqual({
        relPath,
        importsNodeFs: false
      });
    }
  });

  it('keeps the injected fs ports out of production wiring (FR-R3-080, T1066)', () => {
    // The `INJECTED_FS_PORT` arm above catches a sink that TAKES a filesystem
    // function. It cannot see whether anything SUPPLIES one — and a raw call
    // that moves from the sink to its composition root has not been migrated,
    // it has been relocated. Measured 2026-08-25: neither production wiring site
    // passes one, so the ports are a test seam and nothing more.
    //
    // This assertion is what keeps that true. A production site that starts
    // supplying `appendFile`/`mkdir`/`writeFile`/`readFile` fails here, by name.
    const wiring = [
      'activation/backend-wiring.ts',
      'monitor/cli-transport-sink.ts',
      'extension.ts'
    ];
    const supplied: string[] = [];
    for (const relPath of wiring) {
      const body = readFileSync(join(SRC, ...relPath.split('/')), 'utf8')
        .split(/\r?\n/)
        .filter((line) => {
          const trimmed = line.trim();
          return (
            !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
          );
        })
        .join('\n');
      if (/\b(appendFile|mkdir|writeFile|readFile)\s*:\s*(fs[a-zA-Z]*\.|\()/.test(body)) {
        supplied.push(relPath);
      }
    }
    expect(supplied).toEqual([]);
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
