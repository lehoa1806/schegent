export const MAX_VSIX_COMPRESSED_BYTES: number;
export const MAX_VSIX_UNCOMPRESSED_BYTES: number;
export const ALLOWED_VSIX_ENTRIES: readonly string[];

/** Feature 106 (T589b) — the stage tags every failure message carries. */
export const STAGE_POLICY: string;
export const STAGE_PACKAGING: string;

/** An authored code-split boundary, and the route that names it when it is one. */
export type AuthoredBoundary = {
  component: string;
  path: string;
  route: string | null;
};

export type RouteLoaderEntry = {
  route: string;
  specifier: string;
};

export type AuthoredBoundaries = {
  boundaries: readonly AuthoredBoundary[];
  routes: readonly RouteLoaderEntry[];
};

/** Basename of an admitted `chunks/<name>.js` entry, or `null` when the shape does not hold. */
export function chunkBasename(name: string): string | null;
/** N of an admitted `index<N>.css` entry, or `null` when the shape does not hold. */
export function stylesheetNumber(name: string): number | null;

export function parseDynamicSvelteImports(source: string): readonly string[];
export function parseRouteLoaderEntries(source: string): readonly RouteLoaderEntry[];
export function readAuthoredBoundaries(): AuthoredBoundaries;

export function assertAllowedEntryNames(
  names: Iterable<string>,
  vsixPath?: string,
  authored?: AuthoredBoundaries
): void;
export function inspectVsix(vsixPath: string): void;
