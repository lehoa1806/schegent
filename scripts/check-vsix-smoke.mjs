#!/usr/bin/env node
import { inflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, join, relative, resolve, sep } from 'node:path';

export const MAX_VSIX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_VSIX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;

const EXAMPLES_DIR = fileURLToPath(new URL('../examples', import.meta.url));
const EXAMPLES_PREFIX = 'extension/examples/';

/**
 * Feature 098 (T063, FR-041, SC-014) — the sample documents, enumerated rather
 * than named.
 *
 * They used to be three literal entries, and that list went stale twice: 096's
 * `model-catalog.yaml` shipped unpinned, and REL-03 above records the clean-build
 * failure it caused. Naming them was never the point — with the built-in Phase
 * and Pipeline layers gone, `examples/` IS the process catalog, so what this
 * check has to say is "everything the operator can import reached the package",
 * and only the directory knows what that is.
 *
 * Modelling what vsce packages, not what the directory holds: `.vscodeignore`
 * drops `**\/.DS_Store` and touches no other part of `examples/`, so that one
 * exclusion is the whole difference. Recursive, because a subdirectory would
 * ship too.
 */
function packagedExampleEntries(dir = EXAMPLES_DIR) {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...packagedExampleEntries(full));
      continue;
    }
    if (entry.name === '.DS_Store') continue;
    entries.push(EXAMPLES_PREFIX + relative(EXAMPLES_DIR, full).split(sep).join('/'));
  }
  return entries.sort();
}

export const ALLOWED_VSIX_ENTRIES = Object.freeze([
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/LICENSE.md',
  'extension/RELEASE.md',
  'extension/SECURITY.md',
  'extension/package.json',
  'extension/readme.md',
  'extension/assets/banner.png',
  'extension/assets/logo.png',
  'extension/assets/sidebar-icon.svg',
  'extension/dist/extension.js',
  // Feature 106 (T590, FR-007 to FR-010) — generated webview output is no
  // longer pinned. Twenty-five literal entries lived here: 15 code-split chunks
  // and 10 numbered stylesheets. They went stale five times, three of them in
  // six days, because a build-assigned name is not something a reviewer can
  // decide about. `docs/operations/vsix-allowlist-derivation.md` carries the
  // measurement and the history.
  //
  // What is enforced now, in place of the list:
  //   * `chunks/<name>.js` — exactly one segment below this directory, `.js`
  //     only. A `.map`, a dotfile, a nested directory, or any other extension
  //     falls through to "unexpected" and is named.
  //   * `index<N>.css` at this level — N an integer >= 2, contiguous from 2. The
  //     bundler numbers collisions sequentially, so a gap is a file that went
  //     missing rather than a legitimate emission.
  //   * every authored `import('*.svelte')` outside tests has an emitted chunk,
  //     with the route map naming the six that are route surfaces.
  //
  // The first two are shape constraints, not directory globs, and that is what
  // preserves the property this list was really guarding: the *absence* of
  // everything not listed — source maps above all, plus fixtures, dotfiles, and
  // dependency trees. The third is the review property the pin was carrying by
  // hand, stated as an assertion.
  //
  // The rule that used to live here — "each chunk must name a module that exists
  // under `webview-ui/src/`" — is gone, and must not come back. A shared chunk's
  // name is assigned by the bundler from something no reviewer can look up:
  // `chunks/empty-catalog-guidance.js` holds a trust banner, has three
  // importers, and matches no source module. It is the entry that made this list
  // unrepairable by hand — the archive check demanded it, and the grounding test
  // rejected it, so no edit satisfied both.
  //
  // `index.css` and `dashboard.css` are named from their source files rather than
  // numbered, so they stay pinned, as do both HTML entry points and their entry
  // scripts.
  'extension/dist/webview/dashboard.css',
  'extension/dist/webview/dashboard.html',
  'extension/dist/webview/dashboard.js',
  'extension/dist/webview/index.css',
  'extension/dist/webview/index.html',
  'extension/dist/webview/index.js',
  // Operator-facing sample documents, shipped so a fresh install has something
  // to import without network access. These are read as data, never executed at
  // package time, and they are the only non-code payload outside `assets/`.
  //
  // Feature 096 added the Model Catalog sample beside the two pipelines and did
  // not pin it, so `package:smoke` failed closed on a clean build — the same
  // structural reason REL-03 records above, one category over. `.vscodeignore`
  // excludes no part of `examples/`, so anything dropped in that directory
  // ships, and this archive check was the only thing comparing the two. It runs
  // last, behind `test:visual`.
  //
  // Feature 098 (T063) replaced the three literal entries with the enumeration
  // above. A sample added to `examples/` is now pinned by existing, and the
  // check fails when the package is missing one — which is the direction that
  // matters once `examples/` is the only source of process content there is.
  ...packagedExampleEntries()
]);

function findEndOfCentralDirectory(buf, vsixPath) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error(`${vsixPath}: ${STAGE_POLICY} ZIP end-of-central-directory not found`);
}

function listEntries(buf, vsixPath) {
  const eocd = findEndOfCentralDirectory(buf, vsixPath);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`${vsixPath}: ${STAGE_POLICY} invalid central-directory header at ${offset}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    assert(!entries.has(name), `${vsixPath}: ${STAGE_POLICY} duplicate ZIP entry ${name}`);
    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buf, entry, vsixPath) {
  const offset = entry.localHeaderOffset;
  if (buf.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`${vsixPath}: ${STAGE_POLICY} invalid local-file header for ${entry.name}`);
  }
  const fileNameLength = buf.readUInt16LE(offset + 26);
  const extraLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`${vsixPath}: ${STAGE_POLICY} unsupported compression method ${entry.method} for ${entry.name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Feature 106 (T589b, FR-006a, SC-022) — every failure names the stage it came
 * from. `vsce` failing is not a packaged-content violation, and reading one as
 * the other sends a reviewer to the wrong file.
 */
export const STAGE_POLICY = '[policy]';
export const STAGE_PACKAGING = '[packaging]';

/**
 * Feature 106 (T589a, FR-005) — path safety is a separate class, checked first
 * and thrown on its own.
 *
 * A traversal entry is a security matter. The aggregated report below is a list
 * a reviewer skims, and burying `../outside` in it among eight naming
 * differences is how it gets skimmed past.
 */
function assertSafeEntryPaths(actual, vsixPath) {
  const unsafe = actual.filter(
    (name) => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')
  );
  assert(
    unsafe.length === 0,
    `${vsixPath}: ${STAGE_POLICY} ${unsafe.length} unsafe archive path${unsafe.length === 1 ? '' : 's'}\n` +
      unsafe.map((name) => `  unsafe ZIP entry path ${name}`).join('\n')
  );
}

/**
 * Feature 106 (T589a, FR-004, FR-006, SC-003) — one report, every difference.
 *
 * The check used to throw on the first difference it found. Measured against the
 * tree at `e577bf1` that meant reporting one of nine, so bringing the gate green
 * by hand was build-package-read-edit, nine times over — which is the habit the
 * pin's own comment warned this file would teach. `docs/operations/vsix-allowlist-derivation.md`
 * has the measurement.
 *
 * Classes are kept contiguous and each difference keeps its own line, atom
 * intact, so a test can still match `unexpected packaged file <name>` as one
 * string.
 */
const DIFFERENCE_CLASSES = Object.freeze([
  'unexpected',
  'missing',
  'numbering',
  'correspondence',
  'count'
]);

function reportDifferences(differences, vsixPath) {
  if (differences.length === 0) return;
  const summary = DIFFERENCE_CLASSES.map((kind) => ({
    kind,
    lines: differences.filter((difference) => difference.kind === kind).map((d) => d.line)
  })).filter((group) => group.lines.length > 0);
  throw new Error(
    `${vsixPath}: ${STAGE_POLICY} ${differences.length} ` +
      `difference${differences.length === 1 ? '' : 's'} between the package and the allowlist ` +
      `(${summary.map((group) => `${group.lines.length} ${group.kind}`).join(', ')})\n` +
      summary.flatMap((group) => group.lines.map((line) => `  ${line}`)).join('\n')
  );
}

/**
 * Feature 106 (T590, FR-007 to FR-009) — the two shapes that replaced 25 pins.
 *
 * Both are deliberately narrow. `chunks/` is not a directory glob: one segment,
 * one extension, no dotfiles, so a `.js.map` emitted by a changed sourcemap
 * setting is still an unexpected packaged file and is still named. That absence
 * is the whole review property the pinned list was carrying.
 */
const WEBVIEW_PREFIX = 'extension/dist/webview/';
const CHUNK_PREFIX = `${WEBVIEW_PREFIX}chunks/`;
const NUMBERED_STYLESHEET = /^index([1-9][0-9]*)\.css$/;
const FIRST_STYLESHEET_NUMBER = 2;

export function chunkBasename(name) {
  if (!name.startsWith(CHUNK_PREFIX)) return null;
  const rest = name.slice(CHUNK_PREFIX.length);
  if (rest.includes('/')) return null;
  if (rest.startsWith('.')) return null;
  if (!rest.endsWith('.js')) return null;
  return rest.slice(0, -'.js'.length);
}

export function stylesheetNumber(name) {
  if (!name.startsWith(WEBVIEW_PREFIX)) return null;
  const match = NUMBERED_STYLESHEET.exec(name.slice(WEBVIEW_PREFIX.length));
  if (match === null) return null;
  const number = Number(match[1]);
  return number >= FIRST_STYLESHEET_NUMBER ? number : null;
}

/**
 * Feature 106 (T590a, FR-009a, SC-021) — a gap is a missing file, not a shape.
 *
 * The bundler numbers extracted stylesheets sequentially from 2, so `index2` and
 * `index4` with no `index3` is not a build that emitted two stylesheets — it is a
 * build that emitted three and lost one. Admitting the set as-is would turn the
 * one thing the numbering can tell us into noise.
 */
function stylesheetNumberingDifferences(numbers) {
  if (numbers.length === 0) return [];
  const emitted = new Set(numbers);
  const last = FIRST_STYLESHEET_NUMBER + numbers.length - 1;
  const absent = [];
  for (let number = FIRST_STYLESHEET_NUMBER; number <= last; number += 1) {
    if (!emitted.has(number)) absent.push(`index${number}.css`);
  }
  if (absent.length === 0) return [];
  return [
    {
      kind: 'numbering',
      line:
        `stylesheet numbering has a gap: ${numbers.length} emitted, so ` +
        `index${FIRST_STYLESHEET_NUMBER}.css through index${last}.css were expected, ` +
        `absent ${absent.join(', ')}`
    }
  ];
}

const WEBVIEW_SRC = fileURLToPath(new URL('../webview-ui/src', import.meta.url));
const ROUTE_LOADER_SOURCE = join(WEBVIEW_SRC, 'dashboard', 'route-loader.ts');

/**
 * Runtime `import('./Thing.svelte')` only. A `typeof import(...)` is a type
 * position and emits no chunk, so counting it would demand a chunk the build
 * never produces — `OperationsSurface.svelte` writes both forms for the same two
 * components.
 */
const DYNAMIC_SVELTE_IMPORT = /(typeof\s+)?import\(\s*['"]([^'"]+\.svelte)['"]\s*\)/g;
const ROUTE_LOADER_ENTRY =
  /(\w+)\s*:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+\.svelte)['"]\s*\)/g;

export function parseDynamicSvelteImports(source) {
  const specifiers = [];
  for (const match of source.matchAll(DYNAMIC_SVELTE_IMPORT)) {
    if (match[1] !== undefined) continue;
    specifiers.push(match[2]);
  }
  return specifiers;
}

export function parseRouteLoaderEntries(source) {
  return [...source.matchAll(ROUTE_LOADER_ENTRY)].map((match) => ({
    route: match[1],
    specifier: match[2]
  }));
}

function isAuthoredSource(name) {
  if (!name.endsWith('.svelte') && !name.endsWith('.ts')) return false;
  return !name.includes('.test.') && !name.includes('.spec.');
}

function authoredSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      authoredSourceFiles(full, out);
      continue;
    }
    if (isAuthoredSource(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Feature 106 (T591, FR-014) — the review property, read from the source tree.
 *
 * Every authored code-split boundary must have an emitted chunk. One direction
 * only: an authored boundary implies a chunk, never the reverse, because the
 * reverse is the pinned list this feature removed. The route map is read for
 * naming alone — `Record<LazyRoute, …>` already makes a missing route a compile
 * error, so asserting the route set here would be a second route list.
 */
function scanAuthoredBoundaries() {
  const byPath = new Map();
  for (const file of authoredSourceFiles(WEBVIEW_SRC)) {
    for (const specifier of parseDynamicSvelteImports(readFileSync(file, 'utf8'))) {
      const path = resolve(join(file, '..'), specifier);
      if (!byPath.has(path)) {
        byPath.set(path, { component: basename(path, '.svelte'), path, route: null });
      }
    }
  }
  const routes = parseRouteLoaderEntries(readFileSync(ROUTE_LOADER_SOURCE, 'utf8'));
  for (const { route, specifier } of routes) {
    const boundary = byPath.get(resolve(join(ROUTE_LOADER_SOURCE, '..'), specifier));
    if (boundary) boundary.route = route;
  }
  return {
    boundaries: [...byPath.values()].sort((a, b) => a.component.localeCompare(b.component)),
    routes
  };
}

let authoredBoundariesCache;

export function readAuthoredBoundaries() {
  authoredBoundariesCache ??= scanAuthoredBoundaries();
  return authoredBoundariesCache;
}

/**
 * Feature 106 (T591a, FR-015, FR-016, FR-017, SC-008) — the gate refuses an
 * empty subject.
 *
 * A filter over an empty list passes, which is how the assertion this replaces
 * would have gone quiet the moment the derivation landed. Each of the three
 * inputs — the boundary scan, the route map, and the emitted chunk set — fails
 * closed when it yields nothing, and a basename claimed by two different source
 * files fails as ambiguous rather than being satisfied by whichever chunk won.
 */
function correspondenceDifferences(emitted, authored) {
  const unestablished = (line) => [{ kind: 'correspondence', line: `could not establish the correspondence: ${line}` }];
  if (authored.boundaries.length === 0) {
    return unestablished('the boundary scan found no dynamic component import under webview-ui/src');
  }
  if (authored.routes.length === 0) {
    return unestablished('the route map yielded no route');
  }
  if (emitted.size === 0) {
    return unestablished('the package holds no webview chunk, so no boundary can be matched');
  }

  const paths = new Map();
  for (const boundary of authored.boundaries) {
    const seen = paths.get(boundary.component) ?? [];
    paths.set(boundary.component, [...seen, boundary.path]);
  }
  const differences = [];
  for (const [component, sources] of paths) {
    if (sources.length === 1) continue;
    differences.push({
      kind: 'correspondence',
      line:
        `ambiguous boundary ${component}: ${sources.length} source files claim that chunk name ` +
        `(${sources.map((path) => relative(WEBVIEW_SRC, path).split(sep).join('/')).join(', ')})`
    });
  }
  for (const boundary of authored.boundaries) {
    if (emitted.has(boundary.component)) continue;
    differences.push({
      kind: 'correspondence',
      line: boundary.route
        ? `no emitted chunk for route ${boundary.route} (${boundary.component})`
        : `no emitted chunk for authored boundary ${boundary.component}`
    });
  }
  return differences;
}

export function assertAllowedEntryNames(names, vsixPath = 'VSIX', authored = readAuthoredBoundaries()) {
  const actual = [...names].sort();
  assertSafeEntryPaths(actual, vsixPath);

  const allowed = new Set(ALLOWED_VSIX_ENTRIES);
  const present = new Set(actual);
  const differences = [];
  const chunks = new Set();
  const stylesheets = [];
  let derived = 0;

  for (const name of actual) {
    if (allowed.has(name)) continue;
    const chunk = chunkBasename(name);
    if (chunk !== null) {
      chunks.add(chunk);
      derived += 1;
      continue;
    }
    const stylesheet = stylesheetNumber(name);
    if (stylesheet !== null) {
      stylesheets.push(stylesheet);
      derived += 1;
      continue;
    }
    differences.push({ kind: 'unexpected', line: `unexpected packaged file ${name}` });
  }
  for (const required of ALLOWED_VSIX_ENTRIES) {
    if (present.has(required)) continue;
    differences.push({ kind: 'missing', line: `missing required packaged file ${required}` });
  }
  differences.push(...stylesheetNumberingDifferences(stylesheets));
  differences.push(...correspondenceDifferences(chunks, authored));

  const expected = ALLOWED_VSIX_ENTRIES.length + derived;
  if (actual.length !== expected) {
    differences.push({
      kind: 'count',
      line:
        `expected exactly ${expected} files, found ${actual.length}` +
        (differences.length === 0 ? ' — a duplicate archive entry' : ' — implied by the lines above')
    });
  }
  reportDifferences(differences, vsixPath);
}

export function inspectVsix(vsixPath) {
  const zip = readFileSync(vsixPath);
  assert(
    zip.length <= MAX_VSIX_COMPRESSED_BYTES,
    `${vsixPath}: ${STAGE_POLICY} compressed size ${zip.length} exceeds ${MAX_VSIX_COMPRESSED_BYTES}`
  );
  const entries = listEntries(zip, vsixPath);
  const names = [...entries.keys()].sort();
  assertAllowedEntryNames(names, vsixPath);

  const uncompressedBytes = [...entries.values()].reduce(
    (sum, entry) => sum + entry.uncompressedSize,
    0
  );
  assert(
    uncompressedBytes <= MAX_VSIX_UNCOMPRESSED_BYTES,
    `${vsixPath}: ${STAGE_POLICY} uncompressed size ${uncompressedBytes} exceeds ${MAX_VSIX_UNCOMPRESSED_BYTES}`
  );

  const pkgEntry = entries.get('extension/package.json');
  const pkg = JSON.parse(readEntry(zip, pkgEntry, vsixPath).toString('utf8'));
  assert(pkg.name === 'schegent', `${vsixPath}: ${STAGE_POLICY} package.json name is not schegent`);
  assert(
    pkg.main === './dist/extension.js',
    `${vsixPath}: ${STAGE_POLICY} package.json main does not point at dist`
  );
  assert(
    Array.isArray(pkg.activationEvents) && pkg.activationEvents.includes('workspaceContains:.specify/'),
    `${vsixPath}: ${STAGE_POLICY} package.json missing workspaceContains activation event`
  );

  console.log(
    `${vsixPath}: VSIX policy passed (${names.length} files, ` +
      `${zip.length} compressed bytes, ${uncompressedBytes} uncompressed bytes)`
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  inspectVsix(process.argv[2] ?? 'schegent-smoke.vsix');
}
