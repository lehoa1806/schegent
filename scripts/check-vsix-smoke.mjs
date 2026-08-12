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
  'extension/dist/webview/chunks/theme.js',
  'extension/dist/webview/dashboard.css',
  'extension/dist/webview/dashboard.html',
  'extension/dist/webview/dashboard.js',
  'extension/dist/webview/index.css',
  'extension/dist/webview/index.html',
  'extension/dist/webview/index.js',
  'extension/dist/webview/index2.css'
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
