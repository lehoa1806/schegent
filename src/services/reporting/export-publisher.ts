/**
 * FR-R6-F11 (FR-015, FR-016, FR-018; research R8) — an export's staging files and their publication.
 *
 * Every file operation goes through `ExportFs`, the one effectful seam, so tests inject failures at
 * each step. Each name is a single entry in the anchor, the destination directory's resolved path:
 *
 * - a partial is opened through `openWithinRoot` with `wx` and mode 0o600, so it never follows a
 *   link and never reuses a file;
 * - publication proves both ends contained in the anchor, then either links the partial to the
 *   final name (no overwrite: `EEXIST` never replaces a file) and unlinks the partial, or renames
 *   it over the final name (overwrite);
 * - cleanup proves each of the export's own partial names contained before unlinking it, and
 *   never touches another file.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { resolveContainedLink, type ContainmentFs } from '../../lib/path-containment';
import { openWithinRoot } from '../../lib/safe-open';

/** The mode of every staged file: owner read and write only. */
const PARTIAL_FILE_MODE = 0o600;

export interface ExportFileHandle {
  write(bytes: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ExportFs extends ContainmentFs {
  /** Creates `name` in `anchor`, refusing an existing entry or a link; `null` when refused. */
  open(anchor: string, name: string): Promise<ExportFileHandle | null>;
  /** Whether an entry exists at `target`, without following a link. */
  exists(target: string): Promise<boolean>;
  // Each of the three below takes only paths `containedEntry` proved are entries of the anchor.
  linkContained(existing: string, created: string): Promise<void>;
  renameContained(from: string, to: string): Promise<void>;
  unlinkContained(target: string): Promise<void>;
}

export type PublishOutcome = 'published' | 'exists' | 'failed';

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function writeFully(handle: fsp.FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    offset += bytesWritten;
  }
}

/** The host filesystem. */
export const nodeExportFs: ExportFs = Object.freeze({
  realpath: (target: string) => fsp.realpath(target),
  async open(anchor: string, name: string): Promise<ExportFileHandle | null> {
    const opened = await openWithinRoot(anchor, [name], { flags: 'wx', fileMode: PARTIAL_FILE_MODE });
    if (opened.outcome !== 'opened') return null;
    const { handle } = opened;
    return {
      write: (bytes: Buffer) => writeFully(handle, bytes),
      sync: () => handle.sync(),
      close: () => handle.close()
    };
  },
  async exists(target: string): Promise<boolean> {
    try {
      await fsp.lstat(target);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
  linkContained: (existing: string, created: string) => fsp.link(existing, created),
  renameContained: (from: string, to: string) => fsp.rename(from, to),
  unlinkContained: (target: string) => fsp.unlink(target)
});

/** The export's two hidden staging names in the destination directory. */
export function partialNames(finalName: string, exportId: string): { readonly data: string; readonly manifest: string } {
  return {
    data: `.${finalName}.${exportId}.data.partial`,
    manifest: `.${finalName}.${exportId}.manifest.partial`
  };
}

/** The resolved path of `name` when it is proven contained in `anchor`; otherwise `null`. */
async function containedEntry(filesystem: ExportFs, anchor: string, name: string): Promise<string | null> {
  const verdict = await resolveContainedLink(path.join(anchor, name), [anchor], filesystem);
  if (verdict.outcome !== 'contained') return null;
  return path.dirname(verdict.resolved) === anchor ? verdict.resolved : null;
}

/** Opens a new staging file; `null` when the name leaves the anchor, exists or is refused. */
export async function openPartial(filesystem: ExportFs, anchor: string, name: string): Promise<ExportFileHandle | null> {
  if (path.basename(name) !== name) return null;
  try {
    return await filesystem.open(anchor, name);
  } catch {
    return null;
  }
}

/** Publishes a staged file under its final name. */
export async function publishPartial(
  filesystem: ExportFs,
  anchor: string,
  partialName: string,
  finalName: string,
  overwrite: boolean
): Promise<PublishOutcome> {
  // Both ends contained in the anchor before the link, the rename or the unlink below.
  const from = await containedEntry(filesystem, anchor, partialName);
  const to = await containedEntry(filesystem, anchor, finalName);
  if (from === null || to === null) return 'failed';
  try {
    if (overwrite) {
      await filesystem.renameContained(from, to);
      return 'published';
    }
    await filesystem.linkContained(from, to);
  } catch (error) {
    return errnoOf(error) === 'EEXIST' ? 'exists' : 'failed';
  }
  // Contained above: the partial name, proven inside the anchor, is removed once the link exists.
  await filesystem.unlinkContained(from).catch(() => undefined);
  return 'published';
}

/**
 * Removes the export's own staging files. `true` when none is left; an absent name is clean.
 * Never removes a name that is not proven contained in the anchor.
 */
export async function removePartials(filesystem: ExportFs, anchor: string, names: readonly string[]): Promise<boolean> {
  let clean = true;
  for (const name of names) {
    // Contained: each name is proven a direct entry of the anchor before the unlink.
    const target = await containedEntry(filesystem, anchor, name);
    if (target === null) {
      clean = false;
      continue;
    }
    try {
      await filesystem.unlinkContained(target);
    } catch (error) {
      if (!isMissing(error)) clean = false;
    }
  }
  return clean;
}
