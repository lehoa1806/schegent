#!/usr/bin/env node
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const MAX_VSIX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_VSIX_UNCOMPRESSED_BYTES = 5 * 1024 * 1024;

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
  // Vite code-split chunks and their extracted stylesheets. Names are
  // build-assigned, so a new lazily-loaded surface or a change in CSS
  // emission order shows up here as a smoke-test failure — that is the
  // point: packaged content is pinned, not pattern-matched. Each chunk below
  // must name a module that exists under `webview-ui/src/`; an entry that
  // resolves to nothing is the signal the pin was updated without being
  // checked. What the pin is really guarding is the *absence* of everything
  // not listed — source maps above all, plus fixtures, dotfiles, and
  // dependency trees — so widening it is a review step, not a rebuild step.
  //
  // Feature 098 (REL-03) resynced this block against an actual `vsce package`
  // after it had gone stale enough to fail on a clean build. Three chunks
  // (`HistorySection`, `PhaseProgression`, `QueueItem`) and three stylesheets
  // (`index12`–`index14.css`) were listed but no longer emitted — the
  // components had been inlined into their parents — and two chunks plus the
  // two shipped example pipelines were emitted but not listed. A stale pin
  // fails closed, which is the safe direction, but it also trains a reader to
  // regenerate the list rather than review it. Regenerating is the *last*
  // step: confirm each addition names a real module or a file the extension
  // is meant to ship, and confirm each removal is genuinely no longer built.
  'extension/dist/webview/chunks/HistoryDashboard.js',
  'extension/dist/webview/chunks/MetricsDashboard.js',
  'extension/dist/webview/chunks/PipelineBuilder.js',
  'extension/dist/webview/chunks/QueueDetailTier.js',
  'extension/dist/webview/chunks/RunDetailTier.js',
  'extension/dist/webview/chunks/RunsSurface.js',
  'extension/dist/webview/chunks/SettingsSurface.js',
  'extension/dist/webview/chunks/SystemTab.js',
  'extension/dist/webview/chunks/WorkflowRun.js',
  'extension/dist/webview/chunks/format-duration.js',
  'extension/dist/webview/chunks/format.js',
  'extension/dist/webview/chunks/i18n.js',
  'extension/dist/webview/chunks/resolve-pipeline-name.js',
  'extension/dist/webview/chunks/theme.js',
  'extension/dist/webview/chunks/tick-store.js',
  'extension/dist/webview/dashboard.css',
  'extension/dist/webview/dashboard.html',
  'extension/dist/webview/dashboard.js',
  'extension/dist/webview/index.css',
  'extension/dist/webview/index.html',
  'extension/dist/webview/index.js',
  'extension/dist/webview/index2.css',
  'extension/dist/webview/index3.css',
  'extension/dist/webview/index4.css',
  'extension/dist/webview/index5.css',
  'extension/dist/webview/index6.css',
  'extension/dist/webview/index7.css',
  'extension/dist/webview/index8.css',
  'extension/dist/webview/index9.css',
  'extension/dist/webview/index10.css',
  'extension/dist/webview/index11.css',
  // Operator-facing sample documents, shipped so a fresh install has something
  // to import without network access. These are read as data, never executed at
  // package time, and they are the only non-code payload outside `assets/`.
  //
  // Feature 096 added the Model Catalog sample beside the two pipelines and did
  // not pin it, so `package:smoke` failed closed on a clean build — the same
  // structural reason REL-03 records above, one category over. `.vscodeignore`
  // excludes no part of `examples/`, so anything dropped in that directory
  // ships, and this archive check was the only thing comparing the two. It runs
  // last, behind `test:visual`. `vsix-allowlist-grounding.test.ts` now checks
  // the `examples/` direction both ways without a build, so the next sample
  // added here fails in `npm run test` rather than at packaging time.
  'extension/examples/model-catalog.yaml',
  'extension/examples/speckit-bugfix.pipeline.yaml',
  'extension/examples/speckit-new-feature.pipeline.yaml'
]);

function findEndOfCentralDirectory(buf, vsixPath) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error(`${vsixPath}: ZIP end-of-central-directory not found`);
}

function listEntries(buf, vsixPath) {
  const eocd = findEndOfCentralDirectory(buf, vsixPath);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`${vsixPath}: invalid central-directory header at ${offset}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    assert(!entries.has(name), `${vsixPath}: duplicate ZIP entry ${name}`);
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
    throw new Error(`${vsixPath}: invalid local-file header for ${entry.name}`);
  }
  const fileNameLength = buf.readUInt16LE(offset + 26);
  const extraLength = buf.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRawSync(compressed);
  throw new Error(`${vsixPath}: unsupported compression method ${entry.method} for ${entry.name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertAllowedEntryNames(names, vsixPath = 'VSIX') {
  const actual = [...names].sort();
  const allowed = new Set(ALLOWED_VSIX_ENTRIES);
  for (const name of actual) {
    assert(
      !name.startsWith('/') &&
        !name.includes('\\') &&
        !name.split('/').includes('..'),
      `${vsixPath}: unsafe ZIP entry path ${name}`
    );
    assert(allowed.has(name), `${vsixPath}: unexpected packaged file ${name}`);
  }
  for (const required of ALLOWED_VSIX_ENTRIES) {
    assert(actual.includes(required), `${vsixPath}: missing required packaged file ${required}`);
  }
  assert(
    actual.length === ALLOWED_VSIX_ENTRIES.length,
    `${vsixPath}: expected exactly ${ALLOWED_VSIX_ENTRIES.length} files, found ${actual.length}`
  );
}

export function inspectVsix(vsixPath) {
  const zip = readFileSync(vsixPath);
  assert(
    zip.length <= MAX_VSIX_COMPRESSED_BYTES,
    `${vsixPath}: compressed size ${zip.length} exceeds ${MAX_VSIX_COMPRESSED_BYTES}`
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
    `${vsixPath}: uncompressed size ${uncompressedBytes} exceeds ${MAX_VSIX_UNCOMPRESSED_BYTES}`
  );

  const pkgEntry = entries.get('extension/package.json');
  const pkg = JSON.parse(readEntry(zip, pkgEntry, vsixPath).toString('utf8'));
  assert(pkg.name === 'schegent', `${vsixPath}: package.json name is not schegent`);
  assert(pkg.main === './dist/extension.js', `${vsixPath}: package.json main does not point at dist`);
  assert(
    Array.isArray(pkg.activationEvents) && pkg.activationEvents.includes('workspaceContains:.specify/'),
    `${vsixPath}: package.json missing workspaceContains activation event`
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
