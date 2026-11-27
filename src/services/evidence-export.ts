// FR-R3-085 (PRIV-01) — collect one Run's evidence into an isolated, verified
// bundle whose contents and deliberate omissions are enumerated.
//
// THE MANIFEST IS THE POINT. FR-R3-085 §3 says it plainly: "an export whose
// contents are not enumerated is a leak the exporter cannot audit." An operator
// handing evidence to someone else needs to know what they are handing over —
// including what was deliberately left out, which is why omissions carry reasons
// rather than being silent.
//
// EXPLICIT ELIGIBLE CLASSES ONLY. Eligible workspace evidence classes are decided
// by `evidence-artifact-policy.ts`, in lockstep with `retentionDisclosure()`.
// Disclosed-omitted subtrees (such as F15-B handoff staging under `.schegent/results/`
// and F05 external artifact directories) and unknown paths under `.schegent/` are
// never exported merely because a path carries the Run UUID.
//
// ISOLATED PRIVATE BUNDLE DIRECTORY. Each invocation creates a fresh, owner-only
// (`0700`) child directory inside the operator-chosen parent folder, opens every
// output exclusively (`wx`, `0600`), and verifies exact manifest membership via
// `verifyExport` before returning success. Pre-existing files in the parent
// folder are never overwritten or mixed into the bundle.
//
// THE CHAIN IS EXPORT-SIDE ONLY. Each manifest entry carries the digest of its
// predecessor, so a recipient can detect a modified export. This asserts NOTHING
// about the on-disk log: a local file under the operator's own authority is not
// tamper-proof, and a hash chain on disk does not make it so. FR-R3-085 §5 is
// explicit, and `evidence-retention-disclosure.md` repeats it where an operator
// will read it.
//
// REDACTION FLOOR. The export runs every text artifact through `SanitizedLogger`
// before writing. Redacting MORE than the product's own set is fine; redacting
// less is forbidden by `AGENTS.md`, and the raw transcript — deliberately
// unredacted on disk — is redacted on the way OUT, because an export crosses a
// trust boundary that the local file does not.
import { isRunId } from '../contracts/run-id';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { SanitizedLogger } from '../lib/logger';
import {
  resolveContainedForWrite,
  resolveContainedLink,
  resolveContainedTarget,
  resolveWritableAnchor
} from '../lib/path-containment';
import { ensureDirWithinRoot, openWithinRoot } from '../lib/safe-open';
import { classifyAuditGeneration, type AuditGenerationClass } from '../audit/audit-generation-classify';
import {
  classifyWorkspaceExportDirectory,
  classifyWorkspaceExportFile
} from './evidence-artifact-policy';

/** One file inside the export. */
export interface ManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

/** Link n carries the digest of link n-1; the first carries null. */
export interface ChainLink {
  readonly entryIndex: number;
  readonly digest: string;
  readonly previousDigest: string | null;
}

export interface ExportManifest {
  readonly runId: string;
  readonly createdAt: string;
  /** EXACTLY what the artifact holds. Checked in both directions. */
  readonly contents: readonly ManifestEntry[];
  /** What was left out, and why. Never silent. */
  readonly deliberateOmissions: readonly { readonly path: string; readonly reason: string }[];
  readonly chain: readonly ChainLink[];
  /**
   * FR-R4-F04 (FR-025, E8) — what the audit history in this export is. The audit log is shared across
   * Runs and is exported whole when the Run has evidence of its own; until now nothing a recipient could
   * read said so (the only shared-log text was an omission reason that can never reach a manifest). `null`
   * when no audit file is included. Additive: `verifyExport` never reads it.
   */
  readonly sharedAuditHistory: {
    readonly statement: string;
    readonly files: readonly { readonly path: string; readonly content: AuditGenerationClass }[];
  } | null;
}

/** The sentence that says the audit history is not this Run's alone. Verbatim from data-model §6. */
export const SHARED_AUDIT_STATEMENT =
  "The audit history is shared: it holds every Run's metadata, not only this Run's.";

/** The audit files, among the evidence an export includes. Matches `collect`'s own rule for them. */
const AUDIT_FILE = /(^|\/)audit\.log(\.|$)/;

export type ExportResult =
  | { readonly outcome: 'exported'; readonly directory: string; readonly manifest: ExportManifest }
  | { readonly outcome: 'refused'; readonly reason: ExportRefusal; readonly detail: string };

export type ExportRefusal =
  | 'no-evidence'
  | 'outside-workspace'
  | 'unreadable-source'
  | 'write-failed'
  | 'invalid-run-id';

/**
 * The largest single artifact the export will read into memory.
 *
 * WHY A BOUND AT ALL. Every artifact is already capped by retention — 5 MiB for
 * the audit log before rotation, 5 MiB for a CLI transport generation — but
 * rotated siblings accumulate and the export reads whole files. Without a bound
 * the ceiling on this operation is "however much evidence has piled up", and the
 * failure mode is the extension host exhausting memory during an operator's
 * privacy action, which is the worst moment for it.
 *
 * WHY SKIP-AND-RECORD RATHER THAN REFUSE. Refusing the whole export because one
 * artifact is large hands the operator nothing. Omitting that artifact hands them
 * everything else PLUS a manifest line saying exactly what was left out and why —
 * which is the manifest doing its job. An export whose contents are not
 * enumerated is a leak the exporter cannot audit; one whose omissions are not
 * enumerated is the same defect wearing a different hat.
 */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const MAX_BUNDLE_DIR_ATTEMPTS = 8;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

type CollectOutcome =
  | { readonly ok: true; readonly included: string[]; readonly omitted: { path: string; reason: string }[] }
  | { readonly ok: false; readonly reason: 'outside-workspace' | 'unreadable-source'; readonly detail: string };

/**
 * Collect explicitly eligible evidence files for one Run under `.schegent/`.
 *
 * Only allowlisted per-Run classes plus the shared audit history (carried only
 * when the Run has eligible evidence of its own) are selected. Disclosed-omitted
 * classes and unknown paths are never included. Unreadable eligible directories
 * fail closed with `unreadable-source` rather than silently producing a partial
 * export.
 */
async function collect(workspaceRoot: string, runId: string): Promise<CollectOutcome> {
  const included: string[] = [];
  /**
   * The audit log is SHARED across Runs, so it is only carried when the Run has
   * evidence of its own.
   *
   * Exporting it unconditionally would hand a recipient every Run's metadata in
   * response to a request about one — including for a run id that never existed,
   * where the whole export would be other Runs. That is a leak the manifest
   * would faithfully enumerate and the operator would still not have intended.
   */
  const shared: string[] = [];
  const omitted: { path: string; reason: string }[] = [];

  const schegentRoot = path.join(workspaceRoot, '.schegent');
  try {
    const rootStat = await fsp.lstat(schegentRoot);
    if (rootStat.isSymbolicLink()) {
      return { ok: false, reason: 'outside-workspace', detail: '.schegent: symlink-component' };
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, reason: 'unreadable-source', detail: '.schegent: not-a-directory' };
    }
  } catch (error) {
    if (describe(error) === 'ENOENT') {
      return { ok: true, included: [], omitted: [] };
    }
    return { ok: false, reason: 'unreadable-source', detail: `.schegent: ${describe(error)}` };
  }

  const walk = async (relativeDir: string): Promise<CollectOutcome | null> => {
    const absolute = path.join(workspaceRoot, relativeDir);
    let entries;
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      const code = describe(error);
      if (code === 'ENOENT') return null;
      return { ok: false, reason: 'unreadable-source', detail: `${relativeDir}: ${code}` };
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        const dirDecision = classifyWorkspaceExportDirectory(relative, runId);
        if (dirDecision.kind === 'walk') {
          const failure = await walk(relative);
          if (failure !== null) return failure;
          continue;
        }
        if (dirDecision.kind === 'omit') {
          omitted.push({ path: relative, reason: dirDecision.reason });
          continue;
        }
        if (dirDecision.kind === 'deny-unknown' && relative.includes(runId)) {
          omitted.push({ path: relative, reason: dirDecision.reason });
        }
        continue;
      }

      const fileDecision = classifyWorkspaceExportFile(relative, runId);
      if (fileDecision.kind === 'include-run') {
        included.push(relative);
        continue;
      }
      if (fileDecision.kind === 'include-shared') {
        shared.push(relative);
        continue;
      }
      if (fileDecision.kind === 'omit') {
        omitted.push({ path: relative, reason: fileDecision.reason });
        continue;
      }
      if (fileDecision.kind === 'deny-unknown' && relative.includes(runId)) {
        omitted.push({ path: relative, reason: fileDecision.reason });
      }
    }
    return null;
  };

  const failure = await walk('.schegent');
  if (failure !== null) return failure;

  if (included.length === 0) {
    for (const entry of shared) {
      omitted.push({
        path: entry,
        reason: 'shared across Runs; carried only when the Run has evidence of its own'
      });
    }
    return { ok: true, included, omitted };
  }
  return { ok: true, included: [...shared, ...included], omitted };
}

function compactUtcStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Export one Run's evidence into a fresh, isolated private child directory
 * beneath `destination`, verified against its own manifest before returning.
 *
 * Every source path is resolved through `resolveContainedTarget` before it is
 * read, so a planted symlink cannot make the export reach outside the workspace.
 * Pre-existing files in `destination` are never overwritten or mixed into the
 * bundle.
 */
export async function exportRunEvidence(
  workspaceRoot: string,
  runId: string,
  destination: string,
  now: () => Date = () => new Date(),
  customLogger?: Pick<SanitizedLogger, 'sanitize'>
): Promise<ExportResult> {
  if (!isRunId(runId)) {
    return {
      outcome: 'refused',
      reason: 'invalid-run-id',
      detail: 'run id is not a UUID; refusing rather than matching evidence by substring'
    };
  }
  const baseLogger = new SanitizedLogger();
  const collected = await collect(workspaceRoot, runId);
  if (!collected.ok) {
    return { outcome: 'refused', reason: collected.reason, detail: collected.detail };
  }
  const { included, omitted } = collected;
  if (included.length === 0) {
    return {
      outcome: 'refused',
      reason: 'no-evidence',
      detail: `no evidence found for run ${runId}`
    };
  }

  const contents: ManifestEntry[] = [];
  const chain: ChainLink[] = [];
  let previousDigest: string | null = null;
  const exportTimestamp = now();

  // Create a fresh, owner-only (`0700`) bundle directory beneath the operator's chosen
  // destination parent so unrelated files are never mixed in or overwritten.
  const prepared = await prepareIsolatedDestination(destination, runId, exportTimestamp);
  if (prepared === null) {
    return { outcome: 'refused', reason: 'write-failed', detail: 'the destination could not be prepared' };
  }
  const { directory } = prepared;
  const createdFiles: string[] = [];
  const auditFiles: { path: string; content: AuditGenerationClass }[] = [];

  for (const relative of included) {
    const absolute = path.join(workspaceRoot, relative);
    // Containment before the read, through the shared oracle, and the read acts
    // on the RESOLVED path rather than on the name that was judged. A planted
    // symlink under `.schegent/` must not make the export copy a file from
    // outside the workspace into an artifact an operator is about to hand over.
    const source = await resolveContainedTarget(absolute, [workspaceRoot]);
    if (source.outcome !== 'contained') {
      await rollbackDestination(createdFiles, prepared);
      return {
        outcome: 'refused',
        reason: 'outside-workspace',
        detail: `${relative}: ${source.outcome === 'refused' ? source.reason : source.outcome}`
      };
    }
    let raw: string;
    try {
      const stat = await fsp.stat(source.resolved);
      if (stat.size > MAX_ARTIFACT_BYTES) {
        omitted.push({
          path: relative,
          reason:
            `larger than the ${Math.round(MAX_ARTIFACT_BYTES / (1024 * 1024))} MiB per-artifact ` +
            `export bound (${stat.size} bytes); copy it by hand if it is needed`
        });
        continue;
      }
      raw = await fsp.readFile(source.resolved, 'utf8');
    } catch (error) {
      await rollbackDestination(createdFiles, prepared);
      return { outcome: 'refused', reason: 'unreadable-source', detail: `${relative}: ${describe(error)}` };
    }
    // The redaction floor. The raw transcript is unredacted ON DISK by design;
    // an export crosses a trust boundary the local file does not, so it is
    // redacted on the way out. More redaction than the product's own set is
    // permitted; less is not.
    let redacted: string;
    try {
      const floorRedacted = baseLogger.sanitize(raw);
      redacted = customLogger ? customLogger.sanitize(floorRedacted) : floorRedacted;
    } catch {
      await rollbackDestination(createdFiles, prepared);
      return { outcome: 'refused', reason: 'write-failed', detail: 'redaction-failed' };
    }
    const name = relative.replaceAll('/', '__');
    const target = path.join(directory, name);
    // Classified from the bytes as they are on disk, before redaction: a retired stream row is legacy
    // content whether or not the redactor changed its text (FR-018, E8).
    if (AUDIT_FILE.test(relative)) auditFiles.push({ path: name, content: classifyAuditGeneration(raw) });
    // The destination is the operator's chosen export directory, so IT is the
    // root here — an export writes outside the workspace by design. What must
    // not happen is a write escaping the destination through a pre-planted link.
    const writable = await resolveContainedForWrite(target, [directory]);
    if (writable.outcome !== 'contained') {
      await rollbackDestination(createdFiles, prepared);
      return {
        outcome: 'refused',
        reason: 'outside-workspace',
        detail: `${relative}: ${writable.outcome === 'refused' ? writable.reason : writable.outcome}`
      };
    }
    const wrote = await writeOwnerOnlyExclusive(directory, name, redacted);
    if (!wrote.ok) {
      await rollbackDestination(createdFiles, prepared);
      return { outcome: 'refused', reason: wrote.reason, detail: wrote.detail };
    }
    createdFiles.push(target);
    const digest = sha256(redacted);
    contents.push({ path: path.basename(target), bytes: Buffer.byteLength(redacted), digest });
    chain.push({ entryIndex: chain.length, digest: sha256(`${previousDigest ?? ''}${digest}`), previousDigest });
    previousDigest = chain[chain.length - 1]?.digest ?? null;
  }

  const manifest: ExportManifest = {
    runId,
    createdAt: exportTimestamp.toISOString(),
    contents,
    deliberateOmissions: omitted,
    chain,
    sharedAuditHistory:
      auditFiles.length === 0 ? null : { statement: SHARED_AUDIT_STATEMENT, files: auditFiles }
  };
  const manifestTarget = path.join(directory, 'manifest.json');
  const manifestPath = await resolveContainedForWrite(manifestTarget, [directory]);
  if (manifestPath.outcome !== 'contained') {
    await rollbackDestination(createdFiles, prepared);
    return { outcome: 'refused', reason: 'outside-workspace', detail: 'manifest path not contained' };
  }
  const wroteManifest = await writeOwnerOnlyExclusive(
    directory,
    'manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  if (!wroteManifest.ok) {
    await rollbackDestination(createdFiles, prepared);
    return { outcome: 'refused', reason: wroteManifest.reason, detail: wroteManifest.detail };
  }
  createdFiles.push(manifestTarget);

  // Verify exact membership, digests, and hash chain inside the isolated bundle
  // directory before declaring the export complete.
  try {
    const verdict = await verifyExport(directory);
    if (!verdict.ok) {
      await rollbackDestination(createdFiles, prepared);
      return { outcome: 'refused', reason: 'write-failed', detail: 'export-verification-failed' };
    }
  } catch {
    await rollbackDestination(createdFiles, prepared);
    return { outcome: 'refused', reason: 'write-failed', detail: 'export-verification-failed' };
  }

  return { outcome: 'exported', directory, manifest };
}

/**
 * Undo a failed export: remove each file created inside the isolated bundle
 * directory, then remove the bundle directory and any missing parent directories
 * this export created, deepest first. Pre-existing files in the operator's
 * selected parent folder are never touched.
 */
async function rollbackDestination(
  createdFiles: readonly string[],
  prepared: PreparedDestination
): Promise<void> {
  for (let index = createdFiles.length - 1; index >= 0; index -= 1) {
    const fullPath = createdFiles.at(index);
    if (fullPath === undefined) continue;
    const created = await resolveContainedLink(fullPath, [prepared.directory]);
    if (created.outcome === 'contained') {
      await fsp.rm(created.resolved, { force: true }).catch(() => undefined);
    }
  }
  for (const dir of prepared.createdDirs) {
    const made = await resolveContainedLink(dir, [prepared.anchor]);
    if (made.outcome === 'contained') {
      await fsp.rmdir(made.resolved).catch(() => undefined);
    }
  }
}

/** Put a file's prior bytes back through the checked walk, `0600`. A failed undo is silent. */
export async function restoreOwnerOnly(directory: string, name: string, bytes: Buffer): Promise<void> {
  const opened = await openWithinRoot(directory, [name], { flags: 'w', fileMode: 0o600 });
  if (opened.outcome === 'refused') return;
  try {
    await opened.handle.write(bytes);
  } catch {
    // The export is already refused; the undo has nothing further to report.
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

interface PreparedDestination {
  /** The canonical isolated bundle directory created for this invocation. */
  readonly directory: string;
  /** The deepest existing ancestor, resolved: the root of every directory this export made. */
  readonly anchor: string;
  /** Directories this export created, deepest first (bundle dir first, then any created parents). */
  readonly createdDirs: readonly string[];
}

/**
 * Prepare `destinationParent` (creating any missing parent components `0700`) and allocate a
 * brand-new, empty, owner-only (`0700`) child directory inside it for this invocation.
 * Returns `null` if the parent or isolated child cannot be created safely.
 */
async function prepareIsolatedDestination(
  destinationParent: string,
  runId: string,
  timestamp: Date
): Promise<PreparedDestination | null> {
  const located = await resolveWritableAnchor(path.resolve(destinationParent));
  if (located === null) return null;
  const createdParentDirs: string[] = [];
  if (located.tail.length > 0) {
    const madeParent = await ensureDirWithinRoot(located.anchor, located.tail, 0o700);
    if (madeParent.outcome === 'refused') return null;
    for (let length = located.tail.length; length >= 1; length -= 1) {
      createdParentDirs.push(path.join(located.anchor, ...located.tail.slice(0, length)));
    }
  }
  const parentDir = path.join(located.anchor, ...located.tail);
  const stamp = compactUtcStamp(timestamp);

  for (let attempt = 0; attempt < MAX_BUNDLE_DIR_ATTEMPTS; attempt += 1) {
    const nonce = randomBytes(4).toString('hex');
    const childName = `run-evidence-${runId}-${stamp}-${nonce}`;
    const candidatePath = path.join(parentDir, childName);
    let alreadyExists = false;
    try {
      await fsp.lstat(candidatePath);
      alreadyExists = true;
    } catch (error) {
      if (describe(error) !== 'ENOENT') {
        await removeDirs(createdParentDirs, located.anchor);
        return null;
      }
    }
    if (alreadyExists) continue;

    const madeChild = await ensureDirWithinRoot(parentDir, [childName], 0o700);
    if (madeChild.outcome === 'refused') {
      await removeDirs(createdParentDirs, located.anchor);
      return null;
    }
    try {
      const entries = await fsp.readdir(candidatePath);
      if (entries.length > 0) {
        // Another writer populated this name between lstat and mkdir; try a fresh nonce.
        continue;
      }
    } catch {
      await removeDirs([candidatePath, ...createdParentDirs], located.anchor);
      return null;
    }
    return {
      directory: candidatePath,
      anchor: located.anchor,
      createdDirs: [candidatePath, ...createdParentDirs]
    };
  }

  await removeDirs(createdParentDirs, located.anchor);
  return null;
}

async function removeDirs(dirs: readonly string[], anchor: string): Promise<void> {
  for (const dir of dirs) {
    const made = await resolveContainedLink(dir, [anchor]);
    if (made.outcome === 'contained') {
      await fsp.rmdir(made.resolved).catch(() => undefined);
    }
  }
}

type OwnerOnlyWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ExportRefusal; readonly detail: string };

/** Create one new output `0600` exclusively (`wx`) through the checked walk. */
async function writeOwnerOnlyExclusive(
  directory: string,
  name: string,
  text: string
): Promise<OwnerOnlyWrite> {
  const opened = await openWithinRoot(directory, [name], { flags: 'wx', fileMode: 0o600 });
  if (opened.outcome === 'refused') {
    return {
      ok: false,
      reason: opened.reason === 'io-failed' ? 'write-failed' : 'outside-workspace',
      detail: `${name}: ${opened.reason}`
    };
  }
  try {
    await opened.handle.write(text, null, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: describe(error) };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * Check an export against its own manifest, in BOTH directions.
 *
 * A file present but unlisted is the leak the manifest exists to prevent; a
 * listed file that is absent is a manifest describing an export that was not
 * made. Either is a finding, and they are reported separately.
 */
export async function verifyExport(
  directory: string
): Promise<{ readonly ok: boolean; readonly unlisted: readonly string[]; readonly missing: readonly string[]; readonly altered: readonly string[]; readonly chainBroken: boolean }> {
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8')) as ExportManifest;
  const onDisk = (await fsp.readdir(directory)).filter((name) => name !== 'manifest.json').sort();
  const listed = new Set(manifest.contents.map((entry) => entry.path));

  const unlisted = onDisk.filter((name) => !listed.has(name));
  const missing = manifest.contents.filter((entry) => !onDisk.includes(entry.path)).map((entry) => entry.path);

  const altered: string[] = [];
  for (const entry of manifest.contents) {
    if (!onDisk.includes(entry.path)) continue;
    const body = await fsp.readFile(path.join(directory, entry.path), 'utf8');
    if (sha256(body) !== entry.digest) altered.push(entry.path);
  }

  let chainBroken = manifest.chain.length !== manifest.contents.length;
  let previous: string | null = null;
  if (!chainBroken) {
    for (const [index, link] of manifest.chain.entries()) {
      // `.at()` rather than `[index]`: the manifest was parsed from a file the
      // recipient may have edited, so `contents` can be SHORTER than `chain`. The
      // declared type says otherwise and the type is the thing that is wrong here
      // — a cast over `JSON.parse` cannot make an untrusted file well-formed. A
      // truncated `contents` with an intact `chain` is exactly the tamper this
      // verification exists to catch.
      const entry = manifest.contents.at(index);
      if (
        entry === undefined ||
        link.previousDigest !== previous ||
        link.digest !== sha256(`${previous ?? ''}${entry.digest}`)
      ) {
        chainBroken = true;
        break;
      }
      previous = link.digest;
    }
  }

  return {
    ok: unlisted.length === 0 && missing.length === 0 && altered.length === 0 && !chainBroken,
    unlisted,
    missing,
    altered,
    chainBroken
  };
}

function describe(error: unknown): string {
  // Shape- and length-bounded: an unknown-typed error must not reach an
  // operator-visible line unbounded.
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : 'unknown-error';
}
