// FR-R4-F09 (contracts RP1 to RP5; TA5) -- the declaration side of `release-candidate.mjs`, so
// `typecheck:tests` and the CLI shell can see the driver and every seam it is given. Every seam of
// RP2 is here, with the three the tasks added: `ensureDirectory` (the staging directory),
// `repoRoot` (the removal escape check) and the two inspection functions, which default to the
// real ones and are injected by tests so the exact buffer they receive is observable.

/** The npm scripts the driver spawns, in order. `controlFacts` adds their closures. */
export declare const RELEASE_CHILD_SCRIPTS: readonly ['build', 'sbom'];

/** The release freshness budget in days, re-exported from `release-advisory.mjs`. */
export declare const RELEASE_ADVISORY_BUDGET_DAYS: 7;

/** The last line of every outcome, accepted or refused. */
export declare const NOTHING_PUBLISHED: string;

/** A release version: three numbers with optional pre-release and build parts. */
export declare const RELEASE_VERSION_PATTERN: RegExp;

/** `relativePath` under `root`, refused when it leaves `root` or is `root` itself. */
export declare function resolveInsideRoot(root: string, relativePath: string): string;

export type ReleaseTree = 'root' | 'webview-ui';

export interface ReleaseTreeState {
  readonly head: string;
  readonly treeClean: boolean;
}

/** What an archive check returns when the SBOM agrees: the document and the digest of its bytes. */
export interface ArchiveSbom {
  readonly sbom: {
    readonly metadata: { readonly properties: ReadonlyArray<{ readonly name: string; readonly value: string }> };
    readonly components: ReadonlyArray<{
      readonly type: string;
      readonly name: string;
      readonly version?: string;
      readonly properties: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    }>;
  };
  readonly sbomSha256: string;
}

/** Every effect the driver has. Paths are repository-relative POSIX strings. */
export interface ReleaseCandidateDeps {
  /** Absolute repository root, for the removal escape check. */
  readonly repoRoot: string;
  /** Output directory under the root. Default `.release`. */
  readonly releaseDirectory?: string;
  /** Resolved paths of the capture files, one per tree. */
  readonly advisoryCaptures: Readonly<Record<ReleaseTree, string>>;
  readonly readTreeState: () => ReleaseTreeState;
  /** `git rev-parse <spec>`: the blob id HEAD holds for a path. Throws when it cannot say. */
  readonly gitBlob: (spec: string) => string;
  /** The bytes of a file. Throws when it cannot be read. */
  readonly readFile: (path: string) => Buffer;
  readonly removePath: (path: string) => void;
  readonly ensureDirectory: (path: string, mode: number) => void;
  /** `npm run <name>`, inheriting stdio. Returns the exit status. */
  readonly runScript: (name: string) => number;
  /** `vsce package --no-dependencies --out <path>`. Returns the exit status. */
  readonly runVsce: (outPath: string) => number;
  readonly rename: (from: string, to: string) => void;
  /** Create the file, failing when it exists, with the given mode. */
  readonly writeExclusive: (path: string, text: string, mode: number) => void;
  /** UTC milliseconds. */
  readonly now: () => number;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly inspectVsixBytes?: (bytes: Buffer, label: string) => void;
  readonly assertSbomMatchesArchive?: (bytes: Buffer, label: string) => ArchiveSbom;
}

export interface ReleaseCandidateResult {
  /** 0 accepted, 1 refused. A usage error (2) is the CLI's. */
  readonly exitCode: 0 | 1;
  /** `accepted`, or the refusal reason. */
  readonly reason: string;
  /** The record written, or `null` on a refusal. */
  readonly record: Readonly<Record<string, unknown>> | null;
}

/** Prepare a release candidate. Never exits the process and never throws for a refusal. */
export declare function releaseCandidate(deps: ReleaseCandidateDeps): ReleaseCandidateResult;
