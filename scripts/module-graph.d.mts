// FR-R4-F09 (contracts MG1 to MG3) — the declaration side of `module-graph.mjs`, so
// `typecheck:tests` can see the graph writers and the bundler plugin. The graph type is the data
// model's section 2, in the order a writer emits it.
import type { BuildIdentity } from './build-identity.mjs';

/** The graph file format. A reader refuses any other value. */
export declare const MODULE_GRAPH_VERSION: 1;

/** Where the graph files live, relative to the repository root. */
export declare const MODULE_GRAPH_DIR: string;

export type ModuleClassification =
  | { readonly kind: 'third-party'; readonly installPath: string }
  | {
      readonly kind: 'unmapped';
      readonly reason: 'virtual' | 'outside-repository' | 'no-lock-entry';
      readonly label: string;
    }
  | { readonly kind: 'first-party' };

export type GraphOutput = {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
};

export type GraphPackage = {
  readonly installPath: string;
  readonly modules: number;
  readonly renderedBytes: number;
};

export type GraphUnmapped = {
  readonly label: string;
  readonly reason: 'virtual' | 'outside-repository' | 'no-lock-entry';
};

/** One build half's module graph (`dist/module-graph/host.json` or `webview.json`). */
export type ModuleGraph = {
  readonly moduleGraphVersion: 1;
  readonly half: 'host' | 'webview';
  readonly tree: 'root' | 'webview-ui';
  readonly bundler: 'esbuild' | 'rollup';
  readonly bundlerVersion: string;
  readonly build: BuildIdentity;
  readonly outputs: readonly GraphOutput[];
  readonly excludedOutputs: readonly string[];
  readonly packages: readonly GraphPackage[];
  readonly unmapped: readonly GraphUnmapped[];
  readonly firstPartyModules: number;
};

/** The fields of an esbuild metafile this module reads. */
export type EsbuildMetafile = {
  /** Every input esbuild saw. Not read here: the graph counts only an output's own inputs. */
  readonly inputs?: unknown;
  readonly outputs: Readonly<
    Record<
      string,
      {
        readonly bytes?: number;
        readonly inputs?: Readonly<Record<string, { readonly bytesInOutput?: number }>>;
      }
    >
  >;
};

/** The two shapes of Rollup bundle item `writeBundle` receives, narrowed to what is read. */
export type BundleItem =
  | {
      readonly type: 'chunk';
      readonly fileName: string;
      readonly code: string;
      readonly modules?: Readonly<Record<string, { readonly renderedLength?: number }>>;
    }
  | {
      readonly type: 'asset';
      readonly fileName: string;
      readonly source: string | Uint8Array;
    };

export interface ModuleGraphPluginOptions {
  readonly tree: 'root' | 'webview-ui';
  readonly half: 'host' | 'webview';
  readonly root: string;
  /** A seam for tests. The build uses the real read, so both halves of one build agree. */
  readonly readIdentity?: () => BuildIdentity;
}

export interface ModuleGraphPlugin {
  readonly name: string;
  readonly apply: 'build';
  writeBundle(
    this: { readonly meta?: { readonly rollupVersion?: string } } | void,
    options: { readonly dir?: string },
    bundle: Readonly<Record<string, BundleItem>>
  ): void;
}

/** Classify one module id of a bundler graph (research R6). */
export declare function classifyModule(
  id: string,
  treeRoot: string,
  repoRoot: string,
  lockPackages: Readonly<Record<string, unknown>>
): ModuleClassification;

/** Write `dist/module-graph/host.json` from esbuild's metafile, digesting the bundle after the write. */
export declare function writeHostGraph(
  metafile: EsbuildMetafile,
  identity: BuildIdentity,
  root: string
): ModuleGraph;

/** A build-only Rollup plugin that writes `dist/module-graph/<half>.json` in `writeBundle`. */
export declare function moduleGraphPlugin(options: ModuleGraphPluginOptions): ModuleGraphPlugin;
