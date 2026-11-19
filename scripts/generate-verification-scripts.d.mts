export type VerificationTierName = 'gates' | 'edit' | 'push' | 'release';

export interface VerificationStepSpec {
  readonly name: string;
  readonly command: string;
  readonly firstTier: VerificationTierName;
  readonly requiresWebviewBuild: boolean;
  readonly category: string;
  readonly precondition?: string;
}

export interface TierAggregateSpec {
  readonly kind: 'tier';
  readonly tier: Exclude<VerificationTierName, 'gates'>;
  readonly extends: string;
  readonly extraSteps: readonly string[];
}

export interface CompositeAggregateSpec {
  readonly kind: 'composite';
  readonly steps: readonly string[];
}

export interface VerificationStepsDocument {
  readonly schemaVersion: 1;
  readonly tiers: readonly VerificationTierName[];
  readonly steps: readonly VerificationStepSpec[];
  readonly aggregates: Readonly<
    Record<string, TierAggregateSpec | CompositeAggregateSpec | undefined>
  >;
}

export interface DriftedAggregate {
  readonly name: string;
  readonly expected: string;
  readonly actual: string | undefined;
}

export interface ManifestParityResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly drifted: readonly DriftedAggregate[];
}

export declare const STEPS_PATH: string;
export declare const PACKAGE_JSON_PATH: string;
export declare const GENERATED_AGGREGATES: readonly string[];

export declare function loadStepList(path?: string): VerificationStepsDocument;
export declare function generateAggregateScripts(
  spec: VerificationStepsDocument
): Record<string, string>;
export declare function validateStepList(
  spec: VerificationStepsDocument,
  manifestScripts?: Readonly<Record<string, string | undefined>>
): string[];
export declare function checkManifestParity(
  spec: VerificationStepsDocument,
  manifestScripts: Readonly<Record<string, string | undefined>>
): ManifestParityResult;
export declare function applyGeneratedScripts(
  packageJsonText: string,
  generated: Readonly<Record<string, string>>
): string;
