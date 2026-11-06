// FR-R5-F21 (FR-015 to FR-017) -- the declaration side of `security-audit.mjs`, so `typecheck:tests`
// can see the classification the unit test pins. The module runs its CLI body only when started.
import type { CaptureOutcome } from './advisory-model.mjs';

/** What one npm audit child produced. */
export interface AuditInput {
  readonly stdout: string;
  readonly spawnError?: boolean;
  readonly timedOut?: boolean;
  readonly overflow?: boolean;
}

/** Advisory counts by severity, from the report's metadata. */
export interface SeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly moderate: number;
  readonly low: number;
  readonly info: number;
}

/** Why a tree is incomplete: the capture's failed or rejected reason, or one of this script's. */
export type IncompleteReason =
  | Exclude<CaptureOutcome, { readonly status: 'succeeded' }>['reason']
  | 'no-dependencies'
  | 'report-inconsistent';

export type TreeResult =
  | {
      readonly status: 'incomplete';
      readonly reason: IncompleteReason;
      readonly counts?: undefined;
      readonly dependencies?: undefined;
    }
  | {
      readonly status: 'clean' | 'findings';
      readonly reason?: undefined;
      readonly counts: SeverityCounts;
      readonly dependencies: number;
    };

/** The argv every tree is audited with: a copy of `AUDIT_ARGV`. */
export declare function auditArgv(): string[];

/** Classify one audit against the tree's parsed lockfile. Incomplete is never clean. */
export declare function classifyAudit(audit: AuditInput, lockfile: unknown): TreeResult;

/** One tree's output line, in the contract's format. */
export declare function formatLine(tree: string, result: TreeResult): string;

/** Audit one tree in place; `runAudit` replaces the npm child in tests. */
export declare function auditTree(
  dir: string,
  seams?: { readonly runAudit?: (dir: string) => AuditInput }
): TreeResult;

/** The trees named by `--dir`, or the default two; `null` on a usage error. */
export declare function parseArgs(
  argv: readonly string[]
): { readonly name: string; readonly dir: string }[] | null;
