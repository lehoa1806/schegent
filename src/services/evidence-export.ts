// FR-R3-085 (PRIV-01) — collect one Run's evidence into a single artifact whose
// contents are enumerated.
//
// THE MANIFEST IS THE POINT. FR-R3-085 §3 says it plainly: "an export whose
// contents are not enumerated is a leak the exporter cannot audit." An operator
// handing evidence to someone else needs to know what they are handing over —
// including what was deliberately left out, which is why omissions carry reasons
// rather than being silent.
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
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { SanitizedLogger } from '../lib/logger';
import { resolveContainedForWrite, resolveContainedTarget } from '../lib/path-containment';

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
}

export type ExportResult =
  | { readonly outcome: 'exported'; readonly directory: string; readonly manifest: ExportManifest }
  | { readonly outcome: 'refused'; readonly reason: ExportRefusal; readonly detail: string };

export type ExportRefusal = 'no-evidence' | 'outside-workspace' | 'write-failed';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Artifacts an export never carries, each with the reason it is omitted. */
const ALWAYS_OMITTED: ReadonlyArray<{ readonly match: RegExp; readonly reason: string }> = [
  {
    match: /(^|\/)\.pending(\/|$)/,
    reason: 'in-flight spool directory: its contents are mid-write and would export a torn file'
  },
  {
    match: /\.lock$/,
    reason: 'lock file: it describes this machine, not the Run'
  }
];

/**
 * Which evidence files exist for a Run, relative to the workspace root.
 *
 * Only files whose name carries the run id, plus the audit log, which is shared
 * and therefore exported whole with that stated in the manifest.
 */
async function collect(
  workspaceRoot: string,
  runId: string
): Promise<{ included: string[]; omitted: { path: string; reason: string }[] }> {
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
  const walk = async (relativeDir: string): Promise<void> => {
    const absolute = path.join(workspaceRoot, relativeDir);
    let entries;
    try {
      entries = await fsp.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        const omission = ALWAYS_OMITTED.find((rule) => rule.match.test(relative));
        if (omission) {
          omitted.push({ path: relative, reason: omission.reason });
          continue;
        }
        await walk(relative);
        continue;
      }
      const omission = ALWAYS_OMITTED.find((rule) => rule.match.test(relative));
      if (omission) {
        omitted.push({ path: relative, reason: omission.reason });
        continue;
      }
      if (/(^|\/)audit\.log(\.|$)/.test(relative)) {
        shared.push(relative);
        continue;
      }
      if (relative.includes(runId)) included.push(relative);
    }
  };
  await walk('.schegent');
  if (included.length === 0) {
    for (const entry of shared) {
      omitted.push({
        path: entry,
        reason: 'shared across Runs; carried only when the Run has evidence of its own'
      });
    }
    return { included, omitted };
  }
  return { included: [...shared, ...included], omitted };
}

/**
 * Export one Run's evidence.
 *
 * Every path is resolved through `segmentsUnderRoot` before it is read or
 * written, so a planted symlink cannot make the export reach outside the
 * workspace — the same containment oracle the rest of the evidence path uses.
 */
export async function exportRunEvidence(
  workspaceRoot: string,
  runId: string,
  destination: string,
  now: () => Date = () => new Date()
): Promise<ExportResult> {
  const logger = new SanitizedLogger();
  const { included, omitted } = await collect(workspaceRoot, runId);
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

  try {
    await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { outcome: 'refused', reason: 'write-failed', detail: describe(error) };
  }

  for (const relative of included) {
    const absolute = path.join(workspaceRoot, relative);
    // Containment before the read, through the shared oracle, and the read acts
    // on the RESOLVED path rather than on the name that was judged. A planted
    // symlink under `.schegent/` must not make the export copy a file from
    // outside the workspace into an artifact an operator is about to hand over.
    const source = await resolveContainedTarget(absolute, [workspaceRoot]);
    if (source.outcome !== 'contained') {
      return {
        outcome: 'refused',
        reason: 'outside-workspace',
        detail: `${relative}: ${source.outcome === 'refused' ? source.reason : source.outcome}`
      };
    }
    let raw: string;
    try {
      raw = await fsp.readFile(source.resolved, 'utf8');
    } catch (error) {
      return { outcome: 'refused', reason: 'write-failed', detail: describe(error) };
    }
    // The redaction floor. The raw transcript is unredacted ON DISK by design;
    // an export crosses a trust boundary the local file does not, so it is
    // redacted on the way out. More redaction than the product's own set is
    // permitted; less is not.
    const redacted = logger.sanitize(raw);
    const target = path.join(destination, relative.replaceAll('/', '__'));
    // The destination is the operator's chosen export directory, so IT is the
    // root here — an export writes outside the workspace by design. What must
    // not happen is a write escaping the destination through a pre-planted link.
    const writable = await resolveContainedForWrite(target, [destination]);
    if (writable.outcome !== 'contained') {
      return {
        outcome: 'refused',
        reason: 'outside-workspace',
        detail: `${relative}: ${writable.outcome === 'refused' ? writable.reason : writable.outcome}`
      };
    }
    try {
      await fsp.writeFile(writable.resolved, redacted, { mode: 0o600 });
    } catch (error) {
      return { outcome: 'refused', reason: 'write-failed', detail: describe(error) };
    }
    const digest = sha256(redacted);
    contents.push({ path: path.basename(target), bytes: Buffer.byteLength(redacted), digest });
    chain.push({ entryIndex: chain.length, digest: sha256(`${previousDigest ?? ''}${digest}`), previousDigest });
    previousDigest = chain[chain.length - 1]?.digest ?? null;
  }

  const manifest: ExportManifest = {
    runId,
    createdAt: now().toISOString(),
    contents,
    deliberateOmissions: omitted,
    chain
  };
  try {
    const manifestPath = await resolveContainedForWrite(
      path.join(destination, 'manifest.json'),
      [destination]
    );
    if (manifestPath.outcome !== 'contained') {
      return { outcome: 'refused', reason: 'outside-workspace', detail: 'manifest path not contained' };
    }
    await fsp.writeFile(manifestPath.resolved, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600
    });
  } catch (error) {
    return { outcome: 'refused', reason: 'write-failed', detail: describe(error) };
  }
  return { outcome: 'exported', directory: destination, manifest };
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

  let chainBroken = false;
  let previous: string | null = null;
  for (const [index, link] of manifest.chain.entries()) {
    const entry = manifest.contents[index];
    if (!entry || link.previousDigest !== previous || link.digest !== sha256(`${previous ?? ''}${entry.digest}`)) {
      chainBroken = true;
      break;
    }
    previous = link.digest;
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
