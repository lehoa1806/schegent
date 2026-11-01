// FR-R4-F09 (research R9) — the declaration side of `release-digest.mjs`, so `typecheck:tests` can
// see the single digest producer without the script becoming TypeScript. It declares a function
// and nothing else, so the module the controls page names stays one export wide.

/** The SHA-256 of `bytes` as 64 lowercase hex characters. A string is hashed as UTF-8. */
export declare function sha256Hex(bytes: Uint8Array | string): string;
