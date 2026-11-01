#!/usr/bin/env node
// FR-R3-120 (FR-013), reworked by FR-R4-F09 (FR-007 to FR-012) -- the SBOM, generated from the
// bundlers' module graphs and the lockfiles, with no dependency.
//
// WHY THERE IS NO GENERATOR LIBRARY. `repo/package.json` declares no `dependencies` key at all --
// not an empty one, absent. The extension ships zero declared runtime dependencies, which is the
// strongest thing this document says. Pulling in a CycloneDX generator to enumerate that would add
// the only supply-chain surface the SBOM exists to describe, so the script is written out instead.
//
// WHAT CHANGED, AND WHY. The first version marked a package `excluded` whenever its lock entry said
// `dev`. `svelte` is a `devDependency` of the webview tree that the webview build BUNDLES, so the
// one document a recipient is handed listed shipping third-party code as tooling that does not
// ship (FR-008). Membership now comes from the module graphs the two builds write
// (`module-graph.mjs`): a package is `bundled` when a graph shows bytes of it in a shipped file,
// whatever the lock's `dev` flag says, and no package name appears anywhere in this file (FR-007).
// A module the graph cannot map to a lock entry is listed as unknown provenance, never dropped
// (FR-010). The shipped files are listed with their SHA-256, so the archive check can prove the
// SBOM in a VSIX came from the code beside it (FR-012).
//
// WHAT IT ASSERTS, and the limit is in the document itself: it reports what the two graphs and the
// two lockfiles record at generation time. It has not opened the VSIX, and it does not claim to;
// `check-vsix-smoke.mjs` compares the two.
//
// The module is pure up to `writeSbom`, and does its work only when started (`invokedAsScript`),
// so the smoke, the release driver and the tests import its functions without writing a file.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedAsScript } from './invoked-as-script.mjs';
import { MODULE_GRAPH_DIR, MODULE_GRAPH_VERSION } from './module-graph.mjs';
import { sha256Hex } from './release-digest.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Where the SBOM is written, beside `package.json`, and packaged inside the VSIX. */
export const SBOM_BASENAME = 'schegent-sbom.cdx.json';

/**
 * The two trees, with the build half whose graph describes each. `name` is the value the
 * `schegent:tree` property has always carried.
 */
const TREES = Object.freeze([
  { tree: 'root', half: 'host', name: 'host', dir: '' },
  { tree: 'webview-ui', half: 'webview', name: 'webview', dir: 'webview-ui' }
]);
const HALF_OF_TREE = Object.freeze(Object.fromEntries(TREES.map(({ tree, half }) => [tree, half])));
const NAME_OF_TREE = Object.freeze(Object.fromEntries(TREES.map(({ tree, name }) => [tree, name])));

/** Files an operating system writes into any directory. They are not build output. */
const OS_NOISE = new Set(['.DS_Store']);

/** Higher wins when one component is seen in several trees (FR-009). */
const CLASSIFICATION_RANK = Object.freeze({ 'build-only': 1, bundled: 2, 'declared-runtime': 3 });
const SHIPPING = new Set(['declared-runtime', 'bundled', 'unknown-provenance']);

/** A CycloneDX package URL for an npm component. */
function purlFor(name, version) {
  // Scoped names carry a `/` that must survive as a namespace separator; every
  // other character is percent-encoded by `encodeURIComponent`.
  const encoded = name
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function licensesFor(entry) {
  const raw = entry.license;
  if (typeof raw === 'string' && raw.length > 0) return [{ license: { id: raw } }];
  if (Array.isArray(raw)) {
    const ids = raw.filter((value) => typeof value === 'string' && value.length > 0);
    if (ids.length > 0) return ids.map((id) => ({ license: { id } }));
  }
  return undefined;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The text of a graph as the build wrote it. Its digest is the one the SBOM records. */
const graphText = (graph) => `${JSON.stringify(graph, null, 2)}\n`;

/**
 * Library components, merged by `name@version` across the trees in the order they are given
 * (data-model section 3). The classification with the highest rank wins, so a package that ships
 * from either tree is `bundled`/`required` whichever tree is read first.
 */
function collectLibraries({ graphs, locks, manifests }) {
  const merged = new Map();
  for (const tree of Object.keys(locks)) {
    const half = HALF_OF_TREE[tree];
    const graph = graphs[half];
    const bundledPaths = new Set(graph.packages.map((entry) => entry.installPath));
    const declared = new Set(Object.keys(manifests[tree]?.dependencies ?? {}));

    for (const [location, entry] of Object.entries(locks[tree].packages ?? {})) {
      // '' is the root package of that lockfile, described by metadata instead.
      if (location === '') continue;
      const name = entry.name ?? location.split('node_modules/').pop();
      const version = entry.version;
      if (typeof name !== 'string' || typeof version !== 'string') continue;

      const inGraph = bundledPaths.has(location);
      const classification = declared.has(name)
        ? 'declared-runtime'
        : inGraph
          ? 'bundled'
          : 'build-only';
      const key = `${name}@${version}`;
      const seen = merged.get(key) ?? {
        name,
        version,
        classification,
        trees: [],
        foundBy: [],
        licenses: licensesFor(entry)
      };
      if (CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[seen.classification]) {
        seen.classification = classification;
      }
      if (!seen.trees.includes(NAME_OF_TREE[tree])) seen.trees.push(NAME_OF_TREE[tree]);
      if (inGraph && !seen.foundBy.includes(half)) seen.foundBy.push(half);
      seen.licenses ??= licensesFor(entry);
      merged.set(key, seen);
    }
  }
  return [...merged.values()].map((entry) => ({
    type: 'library',
    name: entry.name,
    version: entry.version,
    purl: purlFor(entry.name, entry.version),
    scope: entry.classification === 'build-only' ? 'excluded' : 'required',
    properties: [
      ...entry.trees.map((value) => ({ name: 'schegent:tree', value })),
      { name: 'schegent:classification', value: entry.classification },
      ...entry.foundBy.map((half) => ({ name: 'schegent:foundBy', value: `module-graph:${half}` }))
    ],
    ...(entry.licenses ? { licenses: entry.licenses } : {})
  }));
}

/** Modules a graph could not map to a lock entry: shipped, provenance not established (FR-010). */
function collectUnknowns({ graphs, locks }) {
  const merged = new Map();
  for (const tree of Object.keys(locks)) {
    const half = HALF_OF_TREE[tree];
    for (const { label, reason } of graphs[half].unmapped) {
      const key = `${reason}\0${label}`;
      const seen = merged.get(key) ?? { label, reason, trees: [], foundBy: [] };
      if (!seen.trees.includes(NAME_OF_TREE[tree])) seen.trees.push(NAME_OF_TREE[tree]);
      if (!seen.foundBy.includes(half)) seen.foundBy.push(half);
      merged.set(key, seen);
    }
  }
  return [...merged.values()].map((entry) => ({
    type: 'library',
    name: entry.label,
    scope: 'required',
    properties: [
      ...entry.trees.map((value) => ({ name: 'schegent:tree', value })),
      { name: 'schegent:classification', value: 'unknown-provenance' },
      { name: 'schegent:provenance', value: 'unknown' },
      { name: 'schegent:unmappedReason', value: entry.reason },
      ...entry.foundBy.map((half) => ({ name: 'schegent:foundBy', value: `module-graph:${half}` }))
    ]
  }));
}

/** Shipped files, one per graph output, with the digest the bundler recorded. */
function collectFiles(graphs) {
  const files = [];
  for (const { half } of TREES) {
    for (const output of graphs[half].outputs) {
      const { file, sha256 } = output;
      files.push({
        type: 'file',
        name: file,
        scope: 'required',
        hashes: [{ alg: 'SHA-256', content: sha256 }],
        properties: [
          { name: 'schegent:classification', value: 'shipped-file' },
          { name: 'schegent:foundBy', value: `module-graph:${half}` }
        ]
      });
    }
  }
  return files.sort((a, b) => byText(a.name, b.name));
}

const classificationOf = (component) =>
  component.properties?.find((entry) => entry.name === 'schegent:classification')?.value;

/**
 * The CycloneDX document, built from the module graphs, the lockfiles and the manifests of both
 * trees. Pure: it reads nothing and writes nothing.
 *
 * `locks`, `manifests` and the trees they key are merged in the order their keys were inserted, so
 * a test can read the trees in both orders. `graphDigests` carries the digest of each graph FILE
 * as `readSbomInputs` read it; without it the digest is taken of the graph's own serialization.
 *
 * @param {{ graphs: { host: object, webview: object }, locks: object, manifests: object,
 *   now: string, graphDigests?: { host: string, webview: string } }} input
 */
export function buildSbom({ graphs, locks, manifests, now, graphDigests }) {
  const pkg = manifests.root;
  const runtimeDependencies = Object.keys(pkg.dependencies ?? {});
  const libraries = [
    ...collectLibraries({ graphs, locks, manifests }),
    ...collectUnknowns({ graphs, locks })
  ].sort((a, b) =>
    a.name === b.name
      ? (a.version ?? '').localeCompare(b.version ?? '')
      : a.name.localeCompare(b.name)
  );
  const components = [...libraries, ...collectFiles(graphs)];
  const count = (classification) =>
    libraries.filter((component) => classificationOf(component) === classification).length;

  const { build } = graphs.host;
  const digestOf = (half) => graphDigests?.[half] ?? sha256Hex(graphText(graphs[half]));

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: now,
      component: {
        type: 'application',
        name: pkg.name,
        version: pkg.version,
        purl: purlFor(pkg.name, pkg.version),
        ...(typeof pkg.license === 'string' ? { licenses: [{ license: { id: pkg.license } }] } : {})
      },
      properties: [
        // The headline, stated rather than left to be inferred from an absence. The declared
        // count and the bundled count are separate properties (FR-011).
        { name: 'schegent:runtimeDependencyCount', value: String(runtimeDependencies.length) },
        {
          name: 'schegent:runtimeDependencies',
          value: runtimeDependencies.length === 0 ? '(none declared)' : runtimeDependencies.join(', ')
        },
        { name: 'schegent:bundledComponentCount', value: String(count('bundled')) },
        { name: 'schegent:unknownProvenanceCount', value: String(count('unknown-provenance')) },
        // The build these files came from. `mode` is the host half's; the webview half is always
        // minified by `vite build` and records its own.
        { name: 'schegent:build.commit', value: build.commit },
        { name: 'schegent:build.dirty', value: String(build.dirty) },
        { name: 'schegent:build.mode', value: build.mode },
        { name: 'schegent:moduleGraphSha256.host', value: digestOf('host') },
        { name: 'schegent:moduleGraphSha256.webview', value: digestOf('webview') },
        // FR-042 -- what this document observed, and what it did not.
        {
          name: 'schegent:asserts',
          value:
            'What the bundler module graphs of both build halves (host and webview) recorded at ' +
            'generation time, joined with the two lockfiles. A component is bundled when a ' +
            'module graph shows bytes of it in a shipped file. Components marked scope=excluded ' +
            'are not in the shipped code, and that is all excluded means. The shipped files are ' +
            'listed with their SHA-256.'
        },
        {
          name: 'schegent:doesNotAssert',
          value:
            'Whether any component is exploitable; licenses beyond the lock license field; the ' +
            'bytes of the packaged archive, which a separate check compares with the files ' +
            'listed here; or any signature.'
        }
      ]
    },
    components
  };
}

/** The SBOM's shipping library components as `name@version classification`, sorted. */
export function bundledComponents(sbom) {
  return sbom.components
    .filter(
      (component) => component.type === 'library' && SHIPPING.has(classificationOf(component))
    )
    .map((component) => `${component.name}@${component.version ?? ''} ${classificationOf(component)}`)
    .sort(byText);
}

const readJson = (root, relativePath) =>
  JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));

/** Every file under `dir`, as a POSIX path relative to `root`. */
function filesUnder(root, dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(join(root, dir));
  return found;
}

/**
 * Read the module graphs, the lockfiles and the manifests, and refuse any graph that does not
 * describe the `dist/` beside it. Every refusal ends with the remedy, which is always the same.
 *
 * @param {string} root Absolute repository root.
 */
export function readSbomInputs(root) {
  const refuse = (what) => {
    throw new Error(`${what}; run \`npm run build\``);
  };

  const graphs = {};
  const graphDigests = {};
  for (const { tree, half } of TREES) {
    const path = `${MODULE_GRAPH_DIR}/${half}.json`;
    let text;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      return refuse(`the module graph ${path} is absent`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse(`the module graph ${path} is not valid JSON`);
    }
    if (parsed?.moduleGraphVersion !== MODULE_GRAPH_VERSION) {
      return refuse(
        `the module graph ${path} has moduleGraphVersion ${String(parsed?.moduleGraphVersion)}, ` +
          `not ${MODULE_GRAPH_VERSION}`
      );
    }
    if (parsed.half !== half || parsed.tree !== tree) {
      return refuse(
        `the module graph ${path} is not the ${half} graph of the ${tree} tree ` +
          `(its half is ${String(parsed.half)} and its tree ${String(parsed.tree)})`
      );
    }
    for (const field of ['outputs', 'excludedOutputs', 'packages', 'unmapped']) {
      if (!Array.isArray(parsed[field])) return refuse(`the module graph ${path} has no ${field} list`);
    }
    if (typeof parsed.build?.commit !== 'string') {
      return refuse(`the module graph ${path} has no build identity`);
    }
    graphs[half] = parsed;
    graphDigests[half] = sha256Hex(text);
  }

  const claimed = new Set();
  for (const { half } of TREES) {
    for (const output of graphs[half].outputs) {
      const { file, sha256 } = output;
      let bytes;
      try {
        bytes = readFileSync(join(root, file));
      } catch {
        return refuse(`${file} is listed by the ${half} module graph but is not in dist/`);
      }
      if (sha256Hex(bytes) !== sha256) {
        return refuse(
          `${file} differs from the build the ${half} module graph describes (its SHA-256 changed)`
        );
      }
      claimed.add(file);
    }
    for (const file of graphs[half].excludedOutputs) claimed.add(file);
  }
  for (const file of filesUnder(root, 'dist')) {
    if (file.startsWith(`${MODULE_GRAPH_DIR}/`) || OS_NOISE.has(basename(file))) continue;
    if (!claimed.has(file)) {
      const half = file.startsWith('dist/webview/') ? 'webview' : 'host';
      return refuse(`${file} is under the ${half} output path and is in neither list of its module graph`);
    }
  }

  const { host, webview } = graphs;
  if (host.build.commit !== webview.build.commit || host.build.dirty !== webview.build.dirty) {
    return refuse(
      'the halves were built from different trees ' +
        `(host ${host.build.commit} dirty ${String(host.build.dirty)}, ` +
        `webview ${webview.build.commit} dirty ${String(webview.build.dirty)})`
    );
  }

  return {
    graphs,
    graphDigests,
    locks: Object.fromEntries(
      TREES.map(({ tree, dir }) => [tree, readJson(root, join(dir, 'package-lock.json'))])
    ),
    manifests: Object.fromEntries(
      TREES.map(({ tree, dir }) => [tree, readJson(root, join(dir, 'package.json'))])
    )
  };
}

/** The counts the headline carries, as numbers. */
function countsOf(sbom) {
  const value = (name) =>
    Number(sbom.metadata.properties.find((entry) => entry.name === name)?.value ?? 0);
  return {
    components: sbom.components.length,
    declaredRuntime: value('schegent:runtimeDependencyCount'),
    bundled: value('schegent:bundledComponentCount'),
    unknownProvenance: value('schegent:unknownProvenanceCount')
  };
}

/**
 * Read the inputs, build the SBOM and write `schegent-sbom.cdx.json` at the repository root.
 * Refuses, with the remedy, when a graph is absent or does not match `dist/`.
 *
 * @param {string} root Absolute repository root.
 * @param {{ now?: string }} [options]
 */
export function writeSbom(root, { now = new Date().toISOString() } = {}) {
  const sbom = buildSbom({ ...readSbomInputs(root), now });
  const path = resolve(root, SBOM_BASENAME);
  writeFileSync(path, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  return { path, sbom, counts: countsOf(sbom) };
}

/**
 * The one line the SBOM writer prints: the component count, and the declared runtime, bundled and
 * unknown-provenance counts. The smoke prints the same line, so a recorded smoke run shows them.
 *
 * @param {{ components: number, declaredRuntime: number, bundled: number, unknownProvenance: number }} counts
 */
export function formatSbomCountsLine(counts) {
  return (
    `SBOM: ${SBOM_BASENAME} -- ${counts.components} component(s) from ${TREES.length} lockfile(s) ` +
    `and ${TREES.length} module graph(s); ${counts.declaredRuntime} declared runtime ` +
    `dependenc${counts.declaredRuntime === 1 ? 'y' : 'ies'}, ${counts.bundled} bundled, ` +
    `${counts.unknownProvenance} unknown provenance.`
  );
}

if (invokedAsScript(import.meta.url)) {
  try {
    console.log(formatSbomCountsLine(writeSbom(REPO_ROOT).counts));
  } catch (error) {
    console.error(`SBOM: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
