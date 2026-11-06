// FR-R5-F21 (FR-023 to FR-026; contract third-party-notices) -- the declaration side of
// `third-party-notices.mjs`, so `typecheck:tests`, the smoke and the release driver can see it.
import type { ModuleGraph } from './module-graph.mjs';
import type { LockFile, Sbom } from './generate-sbom.mjs';

/** The file name the notices are written under, at the repository root and in the archive. */
export declare const NOTICES_BASENAME: string;

export type NoticesProblem = {
  /** `name@version` for a package, the graph's label for an unmapped module. */
  readonly subject: string;
  readonly reason: 'no-license-id' | 'no-license-text' | 'unattributed-module';
};

export type Notice = {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** The build halves whose shipped files hold the package's code, `host` before `webview`. */
  readonly trees: readonly string[];
  /** The virtual modules attributed to the package, sorted. */
  readonly includes: readonly string[];
  readonly text: string;
};

/** A package directory's top-level files, or null when the directory is absent. */
export type PackageFileReader = (
  dir: string
) => { readonly names: readonly string[]; read(name: string): string } | null;

/**
 * The reader over the package directories under `root`: a directory with no `node_modules` segment,
 * or with a `.` or `..` one, reads as absent, and only regular files (never a symbolic link) are listed.
 */
export declare function packageFileReader(root: string): PackageFileReader;

/** Every problem, carried so a caller can list them all. */
export declare class NoticesError extends Error {
  constructor(problems: readonly NoticesProblem[]);
  readonly problems: readonly NoticesProblem[];
}

/** The notices for every shipping package, sorted by name, and every problem found. */
export declare function collectNotices(input: {
  readonly sbom: Sbom;
  readonly graphs: { readonly host: ModuleGraph; readonly webview: ModuleGraph };
  readonly locks: Readonly<Record<string, LockFile>>;
  readonly readPackageFiles: PackageFileReader;
}): { readonly notices: readonly Notice[]; readonly problems: readonly NoticesProblem[] };

/** The notices file. Pure. */
export declare function renderNotices(input: {
  readonly notices: readonly Notice[];
  readonly now: string;
  readonly build: { readonly commit: string; readonly dirty: boolean };
}): string;

/**
 * Write `THIRD-PARTY-NOTICES.md` at `root`. Throws the SBOM reader's error when a graph is absent
 * or stale, and a `NoticesError` when any package cannot be noticed; nothing is written then.
 */
export declare function writeNotices(
  root: string,
  options?: { readonly now?: string }
): { readonly path: string; readonly packages: number; readonly attributed: number };

/** The one line the notices step prints. */
export declare function formatNoticesLine(result: {
  readonly packages: number;
  readonly attributed: number;
}): string;
