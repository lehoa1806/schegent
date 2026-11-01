// FR-R4-F09 (contract DP1; TA5) -- the declaration side of `manifest-lock-parity.mjs`, so
// `typecheck:tests` can see the pure comparison and its result (data-model section 11).

export type ParityTree = 'root' | 'webview-ui';
export type ParityField = 'dependencies' | 'devDependencies';
export type ParityKind = 'missing-from-lock' | 'extra-in-lock' | 'range-differs';

/** One place a manifest and its lock root disagree. The ranges are as written. */
export interface ParityDisagreement {
  readonly tree: ParityTree;
  readonly field: ParityField;
  readonly package: string;
  readonly kind: ParityKind;
  /** Present unless the kind is `extra-in-lock`. */
  readonly manifestRange?: string;
  /** Present unless the kind is `missing-from-lock`. */
  readonly lockRange?: string;
}

export interface ParityInput {
  readonly tree: ParityTree;
  /** A parsed `package.json`. */
  readonly manifest: Readonly<Record<string, unknown>>;
  /** A parsed `package-lock.json`. */
  readonly lock: Readonly<Record<string, unknown>>;
}

/** Every disagreement, sorted by field then package. An empty list means parity. */
export declare function manifestLockParity(input: ParityInput): ParityDisagreement[];
