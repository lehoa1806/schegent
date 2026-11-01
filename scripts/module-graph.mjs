// FR-R4-F09 (FR-007, FR-010; contracts MG1 to MG3; research R5, R6) — what each bundler put in the
// shipped files, written down at build time.
//
// The SBOM used to be derived from the lockfiles alone, so it could say which packages were
// installed to build the extension but not which of them reached the archive. `svelte` is bundled
// into the webview and the SBOM listed it as excluded tooling (FR-008). The only honest source for
// "bundled" is the bundler itself, so each build half writes one graph file under
// `dist/module-graph/`: esbuild's metafile for the host, and a build-only Rollup `writeBundle`
// plugin for the webview. Both count only modules with bytes in the final output (`bytesInOutput`
// and `renderedLength`), so a module tree-shaking removed is not "bundled".
//
// WHY NO NAME LIST. A hand-kept list of bundled packages is the defect FR-007 forbids: it goes
// stale silently. Membership comes from the graph alone, and `classifyModule` maps a module to its
// lockfile entry by install path, with no rule about any package's name. A module the mapping
// cannot place is recorded as unmapped under a label that names no path, never dropped (FR-010).
//
// Every path in a graph is POSIX and repository-relative. A graph travels into the SBOM and the
// release record, so an absolute or home path in one would travel with it; the tests search the
// written files for both.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readBuildIdentity } from './build-identity.mjs';
import { sha256Hex } from './release-digest.mjs';

/** The graph file format. A reader refuses any other value. */
export const MODULE_GRAPH_VERSION = 1;

/** Where the graph files live, relative to the repository root. Outside `emptyOutDir`'s target. */
export const MODULE_GRAPH_DIR = 'dist/module-graph';

const HOST_OUTPUT = 'dist/extension.js';
const NODE_MODULES = 'node_modules';
const OUTSIDE_REPOSITORY = 'outside-repository';

const toPosix = (path) => path.split(sep).join('/');

/** True when `relativePath`, from `relative(from, to)`, leaves `from`. */
const escapes = (relativePath) =>
  relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);

/** A bundler id without its query suffix (`Component.svelte?svelte&type=style`). */
const withoutQuery = (id) => {
  const at = id.indexOf('?');
  return at === -1 ? id : id.slice(0, at);
};

/**
 * The label of a virtual id: the id with its NUL prefix dropped. A virtual id can wrap a real
 * path (a CommonJS proxy does), and a label must not carry one out, so a path inside the
 * repository is reduced to its repository-relative form and a path outside it to the literal
 * `outside-repository`.
 */
function virtualLabel(id, repoRoot) {
  const stripped = withoutQuery(id.replaceAll('\0', ''));
  if (!isAbsolute(stripped)) return id.replaceAll('\0', '');
  const fromRepo = relative(repoRoot, resolve(stripped));
  return escapes(fromRepo) ? OUTSIDE_REPOSITORY : toPosix(fromRepo);
}

/**
 * Classify one module id of a bundler graph (research R6).
 *
 * Order matters: a virtual id first, then an id outside the repository (so no path to a place
 * outside it is ever computed), then the install path of a `node_modules` package, then
 * first-party. The install path runs up to and including the package directory after the LAST
 * `node_modules/` segment (`@scope/name` takes two segments) and is looked up as a key of the
 * tree's lockfile `packages`.
 *
 * @param {string} id A Rollup module id (absolute), or an esbuild input path (relative to the
 *   repository root).
 * @param {string} treeRoot Absolute root of the tree whose lockfile is `lockPackages`.
 * @param {string} repoRoot Absolute repository root.
 * @param {Readonly<Record<string, unknown>>} lockPackages The tree lockfile's `packages` object.
 * @returns {{ kind: 'third-party', installPath: string }
 *   | { kind: 'unmapped', reason: 'virtual' | 'outside-repository' | 'no-lock-entry', label: string }
 *   | { kind: 'first-party' }}
 */
export function classifyModule(id, treeRoot, repoRoot, lockPackages) {
  if (id.startsWith('\0')) {
    return { kind: 'unmapped', reason: 'virtual', label: virtualLabel(id, repoRoot) };
  }

  const clean = withoutQuery(id);
  const absolute = isAbsolute(clean) ? resolve(clean) : resolve(repoRoot, clean);
  if (escapes(relative(repoRoot, absolute))) {
    return { kind: 'unmapped', reason: 'outside-repository', label: OUTSIDE_REPOSITORY };
  }

  const segments = toPosix(relative(treeRoot, absolute)).split('/');
  const lastNodeModules = segments.lastIndexOf(NODE_MODULES);
  if (lastNodeModules === -1) return { kind: 'first-party' };

  const first = segments.at(lastNodeModules + 1) ?? '';
  const nameSegments = first.startsWith('@') ? 2 : 1;
  const installPath = segments.slice(0, lastNodeModules + 1 + nameSegments).join('/');
  if (Object.hasOwn(lockPackages, installPath)) return { kind: 'third-party', installPath };
  return { kind: 'unmapped', reason: 'no-lock-entry', label: installPath };
}

/** The `packages` object of the lockfile at `treeRoot`, or `{}` when there is none. */
function readLockPackages(treeRoot) {
  try {
    const lock = JSON.parse(readFileSync(join(treeRoot, 'package-lock.json'), 'utf8'));
    return lock.packages ?? {};
  } catch {
    return {};
  }
}

/**
 * Aggregate classified modules into the graph's `packages`, `unmapped` and first-party count.
 * Only modules with bytes in the output are counted.
 *
 * @param {ReadonlyArray<{ id: string, bytes: number }>} modules
 */
function summarize(modules, treeRoot, repoRoot, lockPackages) {
  const packages = new Map();
  const unmapped = new Map();
  let firstPartyModules = 0;

  for (const { id, bytes } of modules) {
    if (!(bytes > 0)) continue;
    const found = classifyModule(id, treeRoot, repoRoot, lockPackages);
    if (found.kind === 'first-party') {
      firstPartyModules += 1;
    } else if (found.kind === 'third-party') {
      const entry = packages.get(found.installPath) ?? {
        installPath: found.installPath,
        modules: 0,
        renderedBytes: 0
      };
      packages.set(found.installPath, {
        ...entry,
        modules: entry.modules + 1,
        renderedBytes: entry.renderedBytes + bytes
      });
    } else {
      unmapped.set(`${found.reason}\0${found.label}`, { label: found.label, reason: found.reason });
    }
  }

  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    packages: [...packages.values()].sort((a, b) => byText(a.installPath, b.installPath)),
    unmapped: [...unmapped.values()].sort(
      (a, b) => byText(a.label, b.label) || byText(a.reason, b.reason)
    ),
    firstPartyModules
  };
}

/** One graph in the field order the data model documents. */
function assembleGraph({ half, tree, bundler, bundlerVersion, build, outputs, excludedOutputs, summary }) {
  return {
    moduleGraphVersion: MODULE_GRAPH_VERSION,
    half,
    tree,
    bundler,
    bundlerVersion,
    build,
    outputs: [...outputs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    excludedOutputs: [...excludedOutputs].sort(),
    packages: summary.packages,
    unmapped: summary.unmapped,
    firstPartyModules: summary.firstPartyModules
  };
}

function writeGraph(root, half, graph) {
  const directory = join(root, MODULE_GRAPH_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${half}.json`), `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
}

/** The installed esbuild's version, read from this tree rather than assumed. */
function esbuildVersion() {
  return createRequire(import.meta.url)('esbuild/package.json').version;
}

/**
 * Write `dist/module-graph/host.json` from esbuild's metafile (contract MG1). Called by the
 * build's `onEnd` hook once the bundle is on disk, so the output is digested AFTER the write.
 *
 * Counted: the inputs of `metafile.outputs['dist/extension.js']` with `bytesInOutput > 0`. Every
 * other output (today only the source map of a non-production build, which `.vscodeignore` keeps
 * out of the package) is listed under `excludedOutputs`, so its absence from `outputs` is a
 * recorded decision.
 *
 * @param {{ outputs: Record<string, { inputs?: Record<string, { bytesInOutput?: number }> }> }} metafile
 * @param {{ commit: string, dirty: boolean | 'unknown', mode: string }} identity
 * @param {string} root Absolute repository root.
 */
export function writeHostGraph(metafile, identity, root) {
  const output = metafile.outputs?.[HOST_OUTPUT];
  if (!output) throw new Error(`module-graph: the esbuild metafile has no output ${HOST_OUTPUT}`);

  let bundle;
  try {
    bundle = readFileSync(join(root, HOST_OUTPUT));
  } catch {
    throw new Error(`module-graph: ${HOST_OUTPUT} was not written, so it cannot be digested`);
  }

  const modules = Object.entries(output.inputs ?? {}).map(([id, input]) => ({
    id,
    bytes: input.bytesInOutput ?? 0
  }));
  const graph = assembleGraph({
    half: 'host',
    tree: 'root',
    bundler: 'esbuild',
    bundlerVersion: esbuildVersion(),
    build: { ...identity },
    outputs: [{ file: HOST_OUTPUT, sha256: sha256Hex(bundle), bytes: bundle.length }],
    excludedOutputs: Object.keys(metafile.outputs).filter((file) => file !== HOST_OUTPUT),
    summary: summarize(modules, root, root, readLockPackages(root))
  });
  writeGraph(root, 'host', graph);
  return graph;
}

/** The bytes a Rollup bundle item will have on disk: a chunk's code or an asset's source. */
function bytesOf(item) {
  if (item.type === 'chunk') return Buffer.from(item.code, 'utf8');
  return typeof item.source === 'string' ? Buffer.from(item.source, 'utf8') : Buffer.from(item.source);
}

/**
 * A build-only Rollup plugin that writes `dist/module-graph/<half>.json` after the bundle is
 * written (contract MG2). `writeBundle` rather than `generateBundle`, because it sees the final
 * code of each chunk and asset after Vite's last transforms.
 *
 * `apply: 'build'` keeps it out of dev serving and out of the test runner. `readIdentity` is a
 * seam for tests; the build uses the real one, so both halves of one build agree.
 *
 * @param {{ tree: 'root' | 'webview-ui', half: 'host' | 'webview', root: string,
 *   readIdentity?: () => { commit: string, dirty: boolean | 'unknown', mode: string } }} options
 */
export function moduleGraphPlugin({ tree, half, root, readIdentity = readBuildIdentity }) {
  return {
    name: 'schegent-module-graph',
    apply: 'build',
    writeBundle(options, bundle) {
      if (typeof options.dir !== 'string') {
        throw new Error('module-graph: the build has no output directory to record');
      }
      const treeRoot = tree === 'root' ? root : join(root, tree);
      const outputDir = resolve(options.dir);

      const outputs = [];
      const modules = [];
      for (const item of Object.values(bundle)) {
        const file = relative(root, join(outputDir, item.fileName));
        if (escapes(file)) {
          throw new Error(`module-graph: ${item.fileName} was emitted outside the repository`);
        }
        const bytes = bytesOf(item);
        outputs.push({ file: toPosix(file), sha256: sha256Hex(bytes), bytes: bytes.length });
        if (item.type === 'chunk') {
          for (const [id, rendered] of Object.entries(item.modules ?? {})) {
            modules.push({ id, bytes: rendered.renderedLength ?? 0 });
          }
        }
      }

      const graph = assembleGraph({
        half,
        tree,
        bundler: 'rollup',
        bundlerVersion: this?.meta?.rollupVersion ?? 'unknown',
        build: { ...readIdentity() },
        outputs,
        excludedOutputs: [],
        summary: summarize(modules, treeRoot, root, readLockPackages(treeRoot))
      });
      writeGraph(root, half, graph);
    }
  };
}
