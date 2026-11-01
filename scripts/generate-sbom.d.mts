// FR-R4-F09 (contracts SB1 to SB3; TA5) -- the declaration side of `generate-sbom.mjs`, so
// `typecheck:tests` and the archive and release code can see the pure SBOM functions. Types
// follow the data model's section 3: a component is a library, an unknown-provenance library or a
// shipped file, and carries its classification as a property.
import type { ModuleGraph } from './module-graph.mjs';

/** The two trees, keyed as the graphs, locks and manifests are. */
export type SbomTree = 'root' | 'webview-ui';

export type SbomProperty = { readonly name: string; readonly value: string };

export type SbomComponent = {
  readonly type: 'library' | 'file';
  readonly name: string;
  readonly version?: string;
  readonly purl?: string;
  readonly scope: 'required' | 'excluded';
  readonly licenses?: ReadonlyArray<{ readonly license: { readonly id: string } }>;
  readonly hashes?: ReadonlyArray<{ readonly alg: string; readonly content: string }>;
  readonly properties: readonly SbomProperty[];
};

export type Sbom = {
  readonly bomFormat: 'CycloneDX';
  readonly specVersion: string;
  readonly version: number;
  readonly metadata: {
    readonly timestamp: string;
    readonly component: Readonly<Record<string, unknown>>;
    readonly properties: readonly SbomProperty[];
  };
  readonly components: readonly SbomComponent[];
};

/** A lockfile or manifest, narrowed to what the generator reads. */
export type LockFile = {
  readonly packages?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};
export type Manifest = {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};

export interface SbomInputs {
  readonly graphs: { readonly host: ModuleGraph; readonly webview: ModuleGraph };
  /** The digest of each graph file as it was read. Without it, the graph's own serialization. */
  readonly graphDigests?: { readonly host: string; readonly webview: string };
  readonly locks: Readonly<Record<string, LockFile>>;
  readonly manifests: Readonly<Record<string, Manifest>>;
}

export type SbomCounts = {
  readonly components: number;
  readonly declaredRuntime: number;
  readonly bundled: number;
  readonly unknownProvenance: number;
};

/** The file name the SBOM is written under, at the repository root. */
export declare const SBOM_BASENAME: string;

/** The CycloneDX document. Pure: reads nothing, writes nothing. */
export declare function buildSbom(input: SbomInputs & { readonly now: string }): Sbom;

/**
 * The shipping library components of an SBOM as `name@version classification`, sorted. The release
 * driver compares this list for the SBOM it re-derives with the one read out of the archive.
 */
export declare function bundledComponents(sbom: Sbom): readonly string[];

/**
 * Read the graphs, lockfiles and manifests under `root`. Throws, with a message ending
 * "run `npm run build`", when a graph is absent, malformed, does not match `dist/`, or its half
 * was built from a different tree than the other.
 */
export declare function readSbomInputs(
  root: string
): SbomInputs & { readonly graphDigests: { readonly host: string; readonly webview: string } };

/** Read the inputs, build the SBOM and write it at the repository root. */
export declare function writeSbom(
  root: string,
  options?: { readonly now?: string }
): { readonly path: string; readonly sbom: Sbom; readonly counts: SbomCounts };

/** The one line the SBOM writer prints, naming the declared runtime, bundled and unknown counts. */
export declare function formatSbomCountsLine(counts: SbomCounts): string;
