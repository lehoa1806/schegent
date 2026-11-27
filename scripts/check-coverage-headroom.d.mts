export type CoverageMetric = 'statements' | 'branches' | 'functions' | 'lines';

export type CoveragePercentages = Readonly<Record<CoverageMetric, number>>;

/** Where one suite's raw report and floors live, relative to the repository root. */
export type CoverageTarget = {
  readonly report: string;
  readonly config: string;
};

/** The subset of a raw `coverage-final.json` file record the measurement reads. */
export type CoverageFileRecord = {
  readonly s?: Readonly<Record<string, number>>;
  readonly f?: Readonly<Record<string, number>>;
  readonly b?: Readonly<Record<string, readonly number[]>>;
};

export const COVERAGE_TARGETS: Readonly<Record<'webview' | 'host', CoverageTarget>>;
export const HEADROOM: number;
export const TOLERANCE: number;
export const METRICS: readonly CoverageMetric[];
export function measuredPercentages(report: Readonly<Record<string, CoverageFileRecord>>): CoveragePercentages;
export function declaredFloors(source: string): Partial<Record<CoverageMetric, number>> | null;
export function staleFloors(measured: CoveragePercentages, floors: Partial<Record<CoverageMetric, number>>): string[];
