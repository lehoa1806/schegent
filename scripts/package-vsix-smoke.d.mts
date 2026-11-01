// FR-R4-F09 (contract RP6; TA5) -- the declaration side of `package-vsix-smoke.mjs`, so
// `typecheck:tests` can see `smokePackage` and its seams. Same arrangement as
// `check-vsix-smoke.d.mts`. The module runs its CLI body only when started, so importing it for
// this declaration packages nothing.

/**
 * Every step of the smoke, injected. `assertSbomMatchesArchive` may return a value (the real one
 * returns the SBOM it read); the smoke ignores it.
 */
export interface SmokePackageDeps {
  readonly assertFresh: () => void;
  readonly writeSbom: () => void;
  readonly makeTempDir: () => Promise<string>;
  readonly runVsce: (outPath: string) => Promise<void>;
  readonly readFile: (path: string) => Buffer;
  readonly inspectVsixBytes: (bytes: Buffer, label: string) => void;
  readonly assertSbomMatchesArchive: (bytes: Buffer, label: string) => unknown;
  readonly removeDir: (path: string) => Promise<void>;
}

/**
 * Package into a temporary directory and inspect the result: freshness, the SBOM, `vsce`, the
 * archive inspection, the SBOM-to-archive comparison, then the removal. A refusal at any step
 * stops every later one, and the directory is removed after a refusal at `vsce` or later.
 */
export declare function smokePackage(deps: SmokePackageDeps): Promise<void>;
