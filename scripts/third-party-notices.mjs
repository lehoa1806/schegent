#!/usr/bin/env node
// FR-R5-F21 (FR-023 to FR-026, SC-007; contract third-party-notices) -- the notices for the
// third-party code bundled into the extension's shipped files, with the license text each package
// ships.
//
// MEMBERSHIP IS THE SBOM'S. A package is listed when the SBOM classifies it as shipping
// (`bundled` or `declared-runtime`), which it does from the bundlers' module graphs; a build-only
// package is not listed, whatever its license. So the notices and the SBOM cannot disagree about
// what ships, and, as in `generate-sbom.mjs`, no package name appears anywhere in this file.
//
// VIRTUAL MODULES. A bundler can inject code that has no file in any package (a module preload
// helper, say). The graph records it as `unmapped` with reason `virtual` and a label such as
// `<package>/helper.js`. When the label's first segment (two for a scoped name) names a package in
// the same tree's lockfile, the code is that package's and is attributed to it; otherwise it is a
// problem, because shipped code whose license nobody can name is the thing this step exists to stop.
//
// WHAT IT DOES NOT CLAIM. It copies the license text each package ships; it does not judge whether
// those licenses are compatible with each other or with this project's, and it says nothing about
// packages that do not ship.
//
// The module is pure up to `writeNotices`, and does its work only when started (`invokedAsScript`),
// so the smoke, the release driver and the tests import its functions without writing a file.
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSbom, readSbomInputs } from './generate-sbom.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The file name the notices are written under, at the repository root and in the archive. */
export const NOTICES_BASENAME = 'THIRD-PARTY-NOTICES.md';

/** The trees, as `generate-sbom.mjs` keys them, with the directory each is installed under. */
const TREES = Object.freeze([
  { tree: 'root', half: 'host', dir: '' },
  { tree: 'webview-ui', half: 'webview', dir: 'webview-ui' }
]);
const TREE_OF_HALF = Object.freeze(Object.fromEntries(TREES.map((entry) => [entry.half, entry])));
const HALVES = Object.freeze(TREES.map(({ half }) => half));

/** The SBOM classifications whose code is in a shipped file. */
const SHIPPED = new Set(['bundled', 'declared-runtime']);
const VIRTUAL = 'virtual';
const FOUND_BY_PREFIX = 'module-graph:';

/** A package's license file and its notice file, by the contract's name rule. */
const LICENSE_FILE = /^(LICEN[CS]E|COPYING)(\.|$)/i;
const NOTICE_FILE = /^NOTICE(\.|$)/i;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A problem that stops the notices being written. Every one is reported. */
export class NoticesError extends Error {
  /** @param {ReadonlyArray<{ subject: string, reason: string }>} problems */
  constructor(problems) {
    super(problems.map(({ subject, reason }) => `notices: ${subject}: ${reason}`).join('\n'));
    this.name = 'NoticesError';
    this.problems = problems;
  }
}

const propertyValues = (component, name) =>
  (component.properties ?? []).filter((entry) => entry.name === name).map((entry) => entry.value);

/** The license of a lock entry or component as one SPDX expression, or undefined. */
function licenseOfLockEntry(entry) {
  const raw = entry.license;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((value) => typeof value === 'string' && value.length > 0);
  return ids.length > 0 ? ids.join(' OR ') : undefined;
}

function licenseOfComponent(component) {
  const ids = (component.licenses ?? []).map((entry) => entry.license?.id).filter(Boolean);
  return ids.length > 0 ? ids.join(' OR ') : undefined;
}

const nameOfLocation = (location, entry) => entry.name ?? location.split('node_modules/').pop();

/** The halves whose graph shows bytes of the component, falling back to the trees it is locked in. */
function halvesOf(component) {
  const found = propertyValues(component, 'schegent:foundBy')
    .filter((value) => value.startsWith(FOUND_BY_PREFIX))
    .map((value) => value.slice(FOUND_BY_PREFIX.length));
  const halves = found.length > 0 ? found : propertyValues(component, 'schegent:tree');
  return HALVES.filter((half) => halves.includes(half));
}

/**
 * The install directory of `name@version` in a half's tree: the lock location the graph bundled,
 * else any lock location holding that version. Relative to the repository root.
 */
function installDirOf({ half, name, version, graphs, locks }) {
  const { tree, dir } = TREE_OF_HALF[half];
  const bundledPaths = new Set((graphs[half]?.packages ?? []).map((entry) => entry.installPath));
  const matches = Object.entries(locks[tree]?.packages ?? {})
    .filter(([location, entry]) => location !== '' && entry.version === version)
    .filter(([location, entry]) => nameOfLocation(location, entry) === name)
    .map(([location]) => location);
  const location = matches.find((candidate) => bundledPaths.has(candidate)) ?? matches.at(0);
  if (location === undefined) return undefined;
  return dir === '' ? location : `${dir}/${location}`;
}

/** The license text a package ships: its first license file, then every notice file. */
function licenseTextOf(dirs, readPackageFiles) {
  for (const dir of dirs) {
    const files = readPackageFiles(dir);
    if (files === null) continue;
    const names = [...files.names].sort(byText);
    const licenses = names.filter((name) => LICENSE_FILE.test(name)).slice(0, 1);
    const notices = names.filter((name) => NOTICE_FILE.test(name));
    const text = [...licenses, ...notices].map((name) => files.read(name)).join('\n');
    // A license file with no text in it names no license (review S6).
    if (text.trim() !== '') return text;
  }
  return undefined;
}

/** The package a virtual label names: its first path segment, or two for a scoped name. */
function packageSegmentOf(label) {
  const segments = label.split('/');
  const count = label.startsWith('@') ? 2 : 1;
  if (segments.length <= count) return undefined;
  return segments.slice(0, count).join('/');
}

/** Attribute each unmapped module to a locked package, or report it. */
function attributeUnmapped({ graphs, locks, entries, problems }) {
  const unattributed = new Set();
  for (const half of HALVES) {
    const { tree, dir } = TREE_OF_HALF[half];
    for (const { label, reason } of graphs[half]?.unmapped ?? []) {
      const segment = reason === VIRTUAL ? packageSegmentOf(label) : undefined;
      const location = segment === undefined ? undefined : `node_modules/${segment}`;
      const entry = location === undefined ? undefined : locks[tree]?.packages?.[location];
      if (entry === undefined || typeof entry.version !== 'string') {
        unattributed.add(label);
        continue;
      }
      const name = nameOfLocation(location, entry);
      const key = `${name}@${entry.version}`;
      const notice = entries.get(key) ?? {
        name,
        version: entry.version,
        license: licenseOfLockEntry(entry),
        halves: new Set(),
        dirs: [],
        includes: new Set()
      };
      notice.halves.add(half);
      const installDir = dir === '' ? location : `${dir}/${location}`;
      if (!notice.dirs.includes(installDir)) notice.dirs.push(installDir);
      notice.includes.add(label);
      entries.set(key, notice);
    }
  }
  for (const label of [...unattributed].sort(byText)) {
    problems.push({ subject: label, reason: 'unattributed-module' });
  }
}

/**
 * The notices for every shipping package, sorted by name, and every problem found. Pure apart from
 * `readPackageFiles`, which returns a package directory's top-level files or null when it is absent.
 *
 * @param {{ sbom: object, graphs: { host: object, webview: object }, locks: object,
 *   readPackageFiles: (dir: string) => ({ names: string[], read: (name: string) => string } | null) }} input
 */
export function collectNotices({ sbom, graphs, locks, readPackageFiles }) {
  const entries = new Map();
  const libraries = sbom.components.filter((component) => component.type === 'library');
  for (const component of libraries) {
    const [classification] = propertyValues(component, 'schegent:classification');
    if (!SHIPPED.has(classification) || typeof component.version !== 'string') continue;
    const { name, version } = component;
    const halves = halvesOf(component);
    const dirs = halves
      .map((half) => installDirOf({ half, name, version, graphs, locks }))
      .filter((dir) => dir !== undefined);
    entries.set(`${name}@${version}`, {
      name,
      version,
      license: licenseOfComponent(component),
      halves: new Set(halves),
      dirs,
      includes: new Set()
    });
  }

  const unattributedProblems = [];
  attributeUnmapped({ graphs, locks, entries, problems: unattributedProblems });

  const packageProblems = [];
  const notices = [];
  const sorted = [...entries.values()].sort(
    (a, b) => byText(a.name, b.name) || byText(a.version, b.version)
  );
  for (const entry of sorted) {
    const subject = `${entry.name}@${entry.version}`;
    const text = licenseTextOf(entry.dirs, readPackageFiles);
    if (entry.license === undefined) packageProblems.push({ subject, reason: 'no-license-id' });
    if (text === undefined) packageProblems.push({ subject, reason: 'no-license-text' });
    if (entry.license === undefined || text === undefined) continue;
    notices.push({
      name: entry.name,
      version: entry.version,
      license: entry.license,
      trees: HALVES.filter((half) => entry.halves.has(half)),
      includes: [...entry.includes].sort(byText),
      text
    });
  }
  return { notices, problems: [...packageProblems, ...unattributedProblems] };
}

/** A fence longer than any backtick run in the text, so the text cannot close it. */
function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The notices file. Pure.
 *
 * @param {{ notices: ReadonlyArray<{ name: string, version: string, license: string,
 *   trees: readonly string[], includes: readonly string[], text: string }>, now: string,
 *   build: { commit: string, dirty: boolean } }} input
 */
export function renderNotices({ notices, now, build }) {
  const buildId = build.dirty ? `${build.commit} (dirty)` : build.commit;
  const header = [
    '# Third-party notices',
    '',
    `Generated ${now} from the module graphs at build ${buildId}. Lists the third-party code ` +
      "bundled into this extension's shipped files, with the license text each package ships. " +
      'Build-only packages are not listed.',
    ''
  ].join('\n');
  const sections = notices.map((notice) => {
    const fence = fenceFor(notice.text);
    const body = notice.text.endsWith('\n') ? notice.text : `${notice.text}\n`;
    const bullets = [
      `- License: ${notice.license}`,
      `- Bundled in: ${notice.trees.join(', ')}`,
      ...(notice.includes.length > 0 ? [`- Includes: ${notice.includes.join(', ')}`] : [])
    ];
    return [`## ${notice.name} ${notice.version}`, '', ...bullets, '', `${fence}text`, `${body}${fence}`, ''].join(
      '\n'
    );
  });
  return [header, ...sections].join('\n');
}

/** True when `dir` is an install directory: it has a `node_modules` segment and no `.` or `..` one. */
function isInstallDir(dir) {
  const segments = dir.split('/');
  return segments.includes('node_modules') && !segments.some((segment) => segment === '.' || segment === '..');
}

/** True when `path` is a regular file, not a symbolic link; false for a broken link too. */
function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A reader over the package directories under `root`. A directory that is not an install directory
 * reads as absent, and only regular files are listed, so a symbolic link never brings a file from
 * outside the package into the notices (review S4, S5).
 */
export function packageFileReader(root) {
  return (dir) => {
    if (!isInstallDir(dir)) return null;
    const absolute = join(root, dir);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return null;
    const names = readdirSync(absolute).filter((name) => isRegularFile(join(absolute, name)));
    return { names, read: (name) => readFileSync(join(absolute, name), 'utf8') };
  };
}

/**
 * Read the inputs, build the SBOM, collect the notices and write `THIRD-PARTY-NOTICES.md` at the
 * repository root. Throws the SBOM reader's error ("run `npm run build`") when a graph is absent or
 * stale, and a `NoticesError` listing every problem when any package cannot be noticed; in both
 * cases nothing is written.
 *
 * @param {string} root Absolute repository root.
 * @param {{ now?: string }} [options]
 */
export function writeNotices(root, { now = new Date().toISOString() } = {}) {
  const inputs = readSbomInputs(root);
  const sbom = buildSbom({ ...inputs, now });
  const { notices, problems } = collectNotices({
    sbom,
    graphs: inputs.graphs,
    locks: inputs.locks,
    readPackageFiles: packageFileReader(root)
  });
  if (problems.length > 0) throw new NoticesError(problems);
  const path = resolve(root, NOTICES_BASENAME);
  writeFileSync(path, renderNotices({ notices, now, build: inputs.graphs.host.build }), 'utf8');
  const attributed = notices.reduce((sum, notice) => sum + notice.includes.length, 0);
  return { path, packages: notices.length, attributed };
}

/** The one line the notices step prints. */
export function formatNoticesLine({ packages, attributed }) {
  return `notices: ${NOTICES_BASENAME} -- ${packages} package(s), ${attributed} attributed virtual module(s)`;
}

if (invokedAsScript(import.meta.url)) {
  try {
    console.log(formatNoticesLine(writeNotices(REPO_ROOT)));
  } catch (error) {
    console.error(
      error instanceof NoticesError
        ? error.message
        : `notices: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
