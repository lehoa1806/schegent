// FR-R4-F02 (spec 240, US3; contract S1 G4; FR-027, FR-028; hard rule 67) — usage keys are read off
// a payload in exactly two places.
//
// At `5d700407` three readers each read the usage keys their own way: the spend bound's tally read
// the FLAT keys, the metrics rollup read the flat cost key, and only the audit projection knew the
// writer nests usage under `metrics`. The three agreed on nothing the real writer produces, and a
// bound read zero. `readPhaseEndUsage` (`src/services/usage-reader.ts`) is the one validated
// reader; the audit projection (`src/audit/audit-payload.ts`) is the writer's own normalisation and
// the only other place that may name these keys on a payload.
//
// The search term is the key NAMES, never a value (hard rule 67). A file counts when its code reads
// one of the five keys off a `payload` directly (`payload.totalCostUsd`, `payload['inputTokens']`),
// or reads a computed key (`payload[field]`) in a file that lists at least two of the key names
// (comments are stripped first, so a file that merely documents the vocabulary, or that names the
// keys on a record of its own, does not count). Every file the scan finds has a role.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const USAGE_KEYS = [
  'totalCostUsd',
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
] as const;

const KEY_ALTERNATION = USAGE_KEYS.join('|');
/** `payload.totalCostUsd`, `e.payload?.inputTokens`, `payload['outputTokens']`. */
const READS_A_KEY_DIRECTLY = new RegExp(
  `\\bpayload\\s*(?:\\?\\.|\\.)\\s*(?:${KEY_ALTERNATION})\\b|` +
    `\\bpayload\\s*\\[\\s*['"](?:${KEY_ALTERNATION})['"]\\s*\\]`
);
/** `payload[field]`: a computed read, which is a usage read only in a file that lists the keys. */
const READS_A_COMPUTED_KEY = /\bpayload\s*\[\s*[A-Za-z_$][\w$]*\s*\]/;
const QUOTED_KEY = new RegExp(`['"](?:${KEY_ALTERNATION})['"]`, 'g');

function readsUsageOffAPayload(code: string): boolean {
  if (READS_A_KEY_DIRECTLY.test(code)) return true;
  const listedKeys = new Set(code.match(QUOTED_KEY) ?? []);
  return listedKeys.size >= 2 && READS_A_COMPUTED_KEY.test(code);
}

/**
 * The files that may name a usage key and read a payload, each with its role. A file the scan
 * finds that is not here is a second reader, and it fails this test until it goes through
 * `readPhaseEndUsage` instead.
 */
const ROLES: Readonly<Record<string, string>> = {
  'src/services/usage-reader.ts': 'reader',
  'src/audit/audit-payload.ts': 'projection'
};

/**
 * The vacuity controls (`scanning-gates-prove-they-scanned`). The audit projection is the file the
 * scan must always hit, because it names all five keys and reads a payload; if the scan cannot
 * find it, the scan is not looking at the tree it claims to.
 */
const PROJECTION_ANCHOR = 'src/audit/audit-payload.ts';
const READER_ANCHOR = 'src/services/usage-reader.ts';

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

function collectSourceFiles(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'generated') continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (path.extname(entry.name) !== '.ts') continue;
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

function usageReaders(): string[] {
  const root = process.cwd();
  return collectSourceFiles(path.resolve(root, 'src'), [])
    .filter((file) => {
      return readsUsageOffAPayload(stripComments(fs.readFileSync(file, 'utf8')));
    })
    .map((file) => path.relative(root, file))
    .sort();
}

describe('FR-R4-F02 (contract S1 G4) — usage keys are read off a payload only by the reader and the projection', () => {
  const readers = usageReaders();

  it('control: the scan hits the audit projection, which names the keys and reads a payload', () => {
    expect(readers).toContain(PROJECTION_ANCHOR);
  });

  it('the validated reader exists and is among the files the scan finds', () => {
    expect(fs.existsSync(path.resolve(process.cwd(), READER_ANCHOR))).toBe(true);
    expect(readers).toContain(READER_ANCHOR);
  });

  it('no other source file names a usage key and reads a payload', () => {
    const others = readers.filter((file) => !(file in ROLES));
    expect(
      others,
      `these files read usage off a payload without going through readPhaseEndUsage: ` +
        `${others.join(', ')}. Use \`readPhaseEndUsage\` from src/services/usage-reader.ts, which ` +
        'reads nested metrics first and keeps absent apart from zero.'
    ).toEqual([]);
  });

  it('every classified file still matches, so the list describes something', () => {
    for (const file of Object.keys(ROLES)) {
      expect(readers, `${file} no longer names a usage key and reads a payload`).toContain(file);
    }
  });
});
