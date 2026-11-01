// FR-R4-F10 (contract SS1) -- the declaration side of `secret-scan-staged.mjs`, so `typecheck:tests`
// can see the staged scan's pure functions without the script becoming TypeScript. It declares the
// module's exports and nothing else.

/** The causes a staged scan can refuse with (data-model section 3). */
export type RefusalCause =
  | 'unknown-argument'
  | 'git-failed'
  | 'unmerged-path'
  | 'config-missing'
  | 'config-unparseable'
  | 'ignore-missing'
  | 'blob-unreadable'
  | 'path-escape'
  | 'engine-failed'
  | 'temp-failed';

/** A named reason the staged scan cannot answer. */
export declare class StagedRefusal extends Error {
  readonly cause: RefusalCause;
  readonly detail: string;
  constructor(cause: RefusalCause, detail: string);
}

/** One staged change, as `git diff-index --cached --raw -z --no-renames` reports it. */
export interface StagedEntry {
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldBlob: string;
  readonly blob: string;
  readonly path: string;
}

/** What `classifyStaged` skipped, by cause. */
export interface StagedSkipped {
  ignored: number;
  deleted: number;
  gitlink: number;
  unchanged: number;
}

/** The scope decision: the entries whose content is read, and the counted skips. */
export interface StagedScope {
  scan: StagedEntry[];
  skipped: StagedSkipped;
}

/** Everything the scan needs from the index. */
export interface StagedSubject {
  base: 'HEAD' | 'empty-tree';
  config: { rules: unknown[] } & Record<string, unknown>;
  ignorePatterns: string[];
  scan: StagedEntry[];
  skipped: StagedSkipped;
  blobs: Map<string, Buffer>;
}

/** Parse the NUL-separated raw diff-index output. Throws `StagedRefusal` on anything else. */
export declare function parseRawDiffIndex(buffer: Buffer): StagedEntry[];

/** Decide what is read and count what is not. Throws `unmerged-path` on an unmerged entry. */
export declare function classifyStaged(
  entries: ReadonlyArray<StagedEntry>,
  ignorePatterns: ReadonlyArray<string>,
  isIgnored: (file: string, patterns: ReadonlyArray<string>) => boolean
): StagedScope;

/** Parse one `git cat-file --batch` output into blobs by id. Throws `blob-unreadable`. */
export declare function parseCatFileBatch(buffer: Buffer, ids: ReadonlyArray<string>): Map<string, Buffer>;

/** Write files under a private directory; returns the absolute paths. Throws `path-escape`. */
export declare function materialize(
  dir: string,
  files: ReadonlyArray<{ readonly path: string; readonly content: Uint8Array }>
): string[];

/** Gather the base, staged configuration, classified scope and scanned blobs. Reads git only. */
export declare function collectStagedSubject(
  root: string,
  isIgnored: (file: string, patterns: ReadonlyArray<string>) => boolean
): StagedSubject;

/** Materialize the subject's blobs, run `run` over them, and remove the directory on every exit. */
export declare function withStagedFiles<T>(
  subject: Pick<StagedSubject, 'scan' | 'blobs'>,
  run: (dir: string, paths: string[]) => Promise<T>
): Promise<T>;
