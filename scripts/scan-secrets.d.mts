// FR-R4-F10 (tasks T017) -- the declaration side of `scan-secrets.mjs`, so `typecheck:tests` can see
// the one export a test imports: the ignore matcher. The module's work happens only when Node is
// started on it, so this declares the matcher and nothing else.

/**
 * True when `file` (a repository-relative path) matches one of the `.secretlintignore` patterns:
 * `dir/**`, `*.ext`, or a literal path.
 */
export declare function isIgnored(file: string, patterns: ReadonlyArray<string>): boolean;
