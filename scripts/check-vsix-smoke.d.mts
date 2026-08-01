export const MAX_VSIX_COMPRESSED_BYTES: number;
export const MAX_VSIX_UNCOMPRESSED_BYTES: number;
export const ALLOWED_VSIX_ENTRIES: readonly string[];
export function assertAllowedEntryNames(
  names: Iterable<string>,
  vsixPath?: string
): void;
export function inspectVsix(vsixPath: string): void;
