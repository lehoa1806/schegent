// Feature 249 (FR-R4-F21) — the declaration side of `advisory-capture.mjs`, so `typecheck:tests`
// can see the capture function and the seams it is pure over without the script becoming
// TypeScript. Same arrangement as `gate-distance.d.mts`.
//
// The capture and finding shapes are imported from the model rather than restated, for the reason
// the model's declaration gives.
import type {
  BoundName,
  CaptureFile,
  CaptureFinding,
  RejectedReason,
  TreeName
} from './advisory-model.mjs';

/** What the audit child produced. The CLI binds it to `npm audit` with the capture's argv. */
export interface AuditResult {
  readonly stdout: string;
  /** `null` when the child did not exit normally. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnError: boolean;
  /** True when the output exceeded the report bound, so it was not read. */
  readonly overflow: boolean;
}

/**
 * The seams `captureTree` is pure over (contract P2), plus `writeFile`, which puts the commit's two
 * files into the temporary directory.
 */
export interface CaptureSeams {
  /** `git rev-parse <args>`: the trimmed output, or `null` when git cannot resolve it. */
  readonly gitRevParse: (args: readonly string[]) => string | null;
  /** `git cat-file -s <spec>`: the size in bytes, or `null` when the object is absent. */
  readonly gitCatFileSize: (spec: string) => number | null;
  /** `git cat-file blob <spec>`: the content as UTF-8 text. */
  readonly gitCatFileBlob: (spec: string) => string;
  /** Write `content` to `<dir>/<name>`. */
  readonly writeFile: (dir: string, name: string, content: string) => void;
  /** `npm --version` run in `dir`, or `null` when npm cannot be started. */
  readonly npmVersion: (dir: string) => string | null;
  /** `npm config get registry` run in `dir`, or `null` when there is none. */
  readonly npmRegistry: (dir: string) => string | null;
  /** Run `npm <argv>` in `dir` with the audit timeout and the report bound. */
  readonly runAudit: (dir: string, argv: readonly string[]) => AuditResult;
  /** A fresh directory, mode 0700, outside the repository. */
  readonly makeTempDir: () => string;
  readonly removeDir: (dir: string) => void;
  readonly now: () => Date;
}

export type NormalizeResult =
  | { readonly ok: true; readonly findings: readonly CaptureFinding[] }
  | {
      readonly ok: false;
      readonly reason: Exclude<RejectedReason, 'tree-missing'>;
      readonly bound?: BoundName;
    };

/** The two sentences every capture carries. */
export declare const CAPTURE_LIMITATIONS: readonly string[];

/**
 * Turn an npm audit report (version 2) and its lockfile into findings, or the reason the report is
 * rejected. Truncates nothing.
 */
export declare function normalizeReport(
  report: unknown,
  lockfile: unknown,
  rootManifest: unknown
): NormalizeResult;

/**
 * Audit one tree at one commit and return the capture, whatever the audit did. Throws only when the
 * commit does not resolve or the tree is not in scope.
 */
export declare function captureTree(
  subject: { readonly tree: TreeName; readonly commit: string },
  seams: CaptureSeams
): CaptureFile;
