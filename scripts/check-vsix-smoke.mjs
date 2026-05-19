#!/usr/bin/env node
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

const vsixPath = process.argv[2] ?? 'schegent-smoke.vsix';
const zip = readFileSync(vsixPath);

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error(`${vsixPath}: ZIP end-of-central-directory not found`);
}

function listEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`${vsixPath}: invalid central-directory header at ${offset}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.set(name, { name, method, compressedSize, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buf, entry) {
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

const entries = listEntries(zip);
const names = [...entries.keys()].sort();
for (const required of [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/dist/extension.js',
  'extension/dist/wakeup-runner.js',
  'extension/dist/webview/index.html',
  'extension/dist/webview/dashboard.html',
  'extension/resources/sidebar-icon.svg'
]) {
  assert(entries.has(required), `${vsixPath}: missing required packaged file ${required}`);
}

for (const forbidden of [
  'extension/src/',
  'extension/tests/',
  'extension/scripts/',
  'extension/webview-ui/src/',
  'extension/node_modules/'
]) {
  assert(
    !names.some((name) => name.startsWith(forbidden)),
    `${vsixPath}: packaged artifact unexpectedly includes ${forbidden}`
  );
}

const pkgEntry = entries.get('extension/package.json');
const pkg = JSON.parse(readEntry(zip, pkgEntry).toString('utf8'));
assert(pkg.name === 'schegent', `${vsixPath}: package.json name is not schegent`);
assert(pkg.main === './dist/extension.js', `${vsixPath}: package.json main does not point at dist`);
assert(
  Array.isArray(pkg.activationEvents) && pkg.activationEvents.includes('workspaceContains:.specify/'),
  `${vsixPath}: package.json missing workspaceContains activation event`
);

console.log(`${vsixPath}: VSIX smoke inspection passed (${names.length} files)`);
