// FR-R4-F04 (FR-034, FR-035, B3, B6, B9; data-model §8) — the reads that fill a diagnostics bundle for ONE Run.
//
// WHAT THIS DOES AND DOES NOT DO. `probeBundle` takes sizes (a `stat`, never an open) so the plan can be shown
// before any content is read. `collectBundle` then reads only the items the plan includes, each through the
// checked walk (`openWithinRoot`), each bounded, each for the selected Run only, and each passed through the
// host's redaction set and a path scrub before it can reach a bundle. It decides nothing about WHICH items:
// that is `bundle-plan.ts`.
//
// ONE RUN, ENFORCED AT THE READ (B9). A shared file (the audit log, the runtime log) is filtered to the lines
// that name this Run: audit rows by their `runId`, runtime-log lines by the JSON context a Run-path line now
// carries (contract C). A file that is per Run by name (failure records, the transcript, the transport, the
// diagnostic tree) is selected by that name. Nothing is included on a guess of "the same time".
//
// REDACTION AND PATHS (B6). Every `content` goes through `SanitizedLogger.sanitize` (the one redaction set;
// this module holds no pattern of its own), then the workspace root is removed so a path reads relative, then
// any remaining absolute path becomes `[path]`: the same two steps `record-text.ts` applies to a failure
// summary. A bundle is shared, so what it carries must not name the operator's machine.
//
// BOUNDED. A file is read from its newest end, at most `SCAN_TAIL_BYTES`, and an item is cut from the FRONT
// to its share (B5): the newest content is what a diagnosis needs, and what is cut is recorded by the writer.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { countsOnlyAuditExport } from '../../commands/export-audit';
import { AUDIT_CUTS_BASENAME, collectChainFiles } from '../../audit/audit-chain';
import { parseRecordName } from '../../contracts/validators/failure-record';
import { FAILURE_RECORD_DIR } from '../../contracts/failure-record';
import { openWithinRoot } from '../../lib/safe-open';
import type { BuildIdentity } from '../../lib/build-identity';
import { removeWorkspaceRoot, replaceAbsolutePaths } from '../failure-record/record-text';
import {
  BUNDLE_ITEM_SHARES,
  type BundleItemId,
  type BundlePlan,
  type BundleProbe
} from './bundle-plan';

const MIB = 1024 * 1024;
/** The most one file is read, from its newest end: the runtime log and the audit generations are bounded by their own rotation. */
const SCAN_TAIL_BYTES = 16 * MIB;
/** A runtime-log context is searched for from at most this many ` {` positions in a line. */
const CONTEXT_PARSE_ATTEMPTS = 3;

/** What collection needs from the host, each read injected so a test supplies them and a command does not reach for globals. */
export interface BundleSources {
  readonly workspaceRoot: string;
  /** `SanitizedLogger.sanitize`: the host's one redaction set. */
  readonly sanitize: (text: string) => string;
  readonly sanitizeRecord: <T extends Record<string, unknown>>(record: T) => T;
  readonly hostVersion: string;
  /**
   * Which build produced the loaded bundle (FR-R4-F09, contract BI4): the commit, whether the tree was dirty and the
   * mode, validated by pattern where it is read, so it holds only constant-shaped values. It is
   * shown beside the version and is NOT passed through `sanitizeRecord`: it names no path and no
   * secret, and the item's text still goes through `sanitize` like every other item.
   */
  readonly hostBuild: BuildIdentity;
  /** The host's settings, already read; secrets are removed here by `sanitizeRecord`. */
  readonly hostSettings: () => Record<string, unknown>;
  /** The Run's projected status record, or `null` when no state knows it. Holds no free text. */
  readonly runStatus: (runId: string) => Record<string, unknown> | null;
  /** The runtime log's location and generation count, or `null` when none is configured. */
  readonly runtimeLog: () => { readonly path: string; readonly maxGenerations: number } | null;
  readonly platform?: NodeJS.Platform;
}

export interface CollectedItem {
  readonly item: BundleItemId;
  readonly runId: string;
  readonly content: string;
  /** UTF-8 bytes of `content`. */
  readonly bytes: number;
  readonly truncated: boolean;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A file's size, or `null` when it is not a regular file we can see. `stat` only: nothing is opened. */
async function sizeOf(target: string): Promise<number | null> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

async function namesIn(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch {
    return [];
  }
}

/** The Run's failure record file names (`parseRecordName` decides what is a record and whose). */
async function failureRecordNames(workspaceRoot: string, runId: string): Promise<string[]> {
  const names = await namesIn(path.join(workspaceRoot, ...FAILURE_RECORD_DIR));
  return names.filter((name) => parseRecordName(name)?.runId === runId);
}

/** The audit log and its archives, oldest first, never the cuts file. */
function auditFileNames(workspaceRoot: string): string[] {
  const files = collectChainFiles(path.join(workspaceRoot, '.schegent'));
  return files === null ? [] : files.ordered.filter((name) => name !== AUDIT_CUTS_BASENAME);
}

/** The diagnostic tree's files under one Run, as segments below the workspace root, in a stable order. */
async function diagnosticFiles(workspaceRoot: string, runId: string): Promise<string[][]> {
  const base = ['.schegent', 'sessions', runId, 'diagnostics'];
  const found: string[][] = [];
  const walk = async (segments: string[]): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(path.join(workspaceRoot, ...segments), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // A link is never followed: `isDirectory`/`isFile` on a Dirent describe the entry itself.
      if (entry.isDirectory()) await walk([...segments, entry.name]);
      else if (entry.isFile()) found.push([...segments, entry.name]);
    }
  };
  await walk(base);
  return found;
}

function runtimeLogFiles(source: { path: string; maxGenerations: number }): Array<{ anchor: string; leaf: string; label: string }> {
  const anchor = path.dirname(source.path);
  const leaf = path.basename(source.path);
  // Oldest generation first, then the live file, so the concatenation reads in time order.
  const generations = Array.from({ length: source.maxGenerations }, (_, index) => source.maxGenerations - index);
  return [...generations.map((n) => ({ anchor, leaf: `${leaf}.${n}`, label: `${leaf}.${n}` })), { anchor, leaf, label: leaf }];
}

// ------------------------------------------------------------------------------------------------
// Probing: sizes only
// ------------------------------------------------------------------------------------------------

/**
 * One probe per item, from sizes and in-memory state alone. A shared file's probe is the file's whole size,
 * an upper bound on what the Run's lines in it will come to; the preview says "found" and the bundle holds
 * the filtered part.
 */
export async function probeBundle(src: BundleSources, runId: string): Promise<BundleProbe[]> {
  const root = src.workspaceRoot;
  const probes: BundleProbe[] = [];
  const add = (item: BundleItemId, available: boolean, bytes: number): void => void probes.push({ item, available, bytes });

  add(
    'host',
    true,
    utf8Bytes(JSON.stringify({ hostVersion: src.hostVersion, build: src.hostBuild, settings: src.hostSettings() }))
  );
  const status = src.runStatus(runId);
  add('run-status', status !== null, status === null ? 0 : utf8Bytes(JSON.stringify(status)));

  let failureBytes = 0;
  let failureFound = false;
  for (const name of await failureRecordNames(root, runId)) {
    const size = await sizeOf(path.join(root, ...FAILURE_RECORD_DIR, name));
    if (size !== null) {
      failureFound = true;
      failureBytes += size;
    }
  }
  add('failure-records', failureFound, failureBytes);

  let auditBytes = 0;
  let auditFound = false;
  for (const name of auditFileNames(root)) {
    const size = await sizeOf(path.join(root, '.schegent', name));
    if (size !== null) {
      auditFound = true;
      auditBytes += size;
    }
  }
  add('audit-rows', auditFound, auditBytes);

  let logBytes = 0;
  let logFound = false;
  const log = src.runtimeLog();
  if (log !== null) {
    for (const file of runtimeLogFiles(log)) {
      const size = await sizeOf(path.join(file.anchor, file.leaf));
      if (size !== null) {
        logFound = true;
        logBytes += size;
      }
    }
  }
  add('runtime-log', logFound, logBytes);

  const transcript = await sizeOf(path.join(root, '.schegent', 'sessions', `raw-${runId}.log`));
  add('raw-transcript', transcript !== null, transcript ?? 0);
  const transport = await sizeOf(path.join(root, '.schegent', 'sessions', runId, 'transport.log'));
  add('transport', transport !== null, transport ?? 0);
  let verboseBytes = 0;
  const verbose = await diagnosticFiles(root, runId);
  for (const segments of verbose) verboseBytes += (await sizeOf(path.join(root, ...segments))) ?? 0;
  add('verbose-diagnostics', verbose.length > 0, verboseBytes);
  return probes;
}

// ------------------------------------------------------------------------------------------------
// Collecting: bounded, contained, one Run, redacted
// ------------------------------------------------------------------------------------------------

/** The newest `maxBytes` of an opened file as text, and whether the front was left unread. */
async function readTail(
  root: string,
  segments: readonly string[]
): Promise<{ readonly text: string; readonly cut: boolean } | null> {
  const opened = await openWithinRoot(root, segments, { flags: 'r' });
  if (opened.outcome === 'refused') return null;
  try {
    const { size } = await opened.handle.stat();
    const length = Math.min(size, SCAN_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await opened.handle.read(buffer, 0, length, size - length);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), cut: size > length };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Keep the newest `maxBytes` of `text`, starting at a line start when one is near, so no half line is left at the cut. */
export function truncateFront(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false };
  const tail = Buffer.from(text, 'utf8').subarray(-Math.max(0, maxBytes)).toString('utf8');
  // A cut inside a multi-byte character leaves a replacement character at the front; drop it.
  const clean = tail.replace(/^�+/, '');
  const firstNewline = clean.indexOf('\n');
  const whole = firstNewline >= 0 && firstNewline < clean.length - 1 ? clean.slice(firstNewline + 1) : clean;
  return { text: whole, truncated: true };
}

/** The `runId` a runtime-log line's JSON context names, or `null` when the line carries no context. */
export function runIdOfLogLine(line: string): string | null {
  let from = line.indexOf(' {');
  for (let attempt = 0; from >= 0 && attempt < CONTEXT_PARSE_ATTEMPTS; attempt += 1) {
    try {
      const context = JSON.parse(line.slice(from + 1)) as unknown;
      if (typeof context === 'object' && context !== null && 'runId' in context) {
        const runId = (context as { runId?: unknown }).runId;
        return typeof runId === 'string' ? runId : null;
      }
      return null;
    } catch {
      from = line.indexOf(' {', from + 1);
    }
  }
  return null;
}

/** One file's lines for this Run, for the shared files. */
function linesWhere(text: string, keep: (line: string) => boolean): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && keep(line))
    .join('\n');
}

function auditRunId(line: string): string | null {
  try {
    const row = JSON.parse(line) as { runId?: unknown };
    return typeof row.runId === 'string' ? row.runId : null;
  } catch {
    return null;
  }
}

/** Read the planned items for one Run: bounded, contained, filtered to the Run, redacted and path-scrubbed. */
export async function collectBundle(src: BundleSources, runId: string, plan: BundlePlan): Promise<CollectedItem[]> {
  const root = src.workspaceRoot;
  const platform = src.platform ?? process.platform;
  const pathContext = { sanitize: src.sanitize, workspaceRoot: root, platform };

  const finalize = (item: BundleItemId, raw: string): CollectedItem => {
    // Redact first, then make paths relative, then cut: a cut taken first could split a secret and leave half of it.
    const clean = replaceAbsolutePaths(removeWorkspaceRoot(src.sanitize(raw), pathContext));
    const cut = truncateFront(clean, BUNDLE_ITEM_SHARES[item]);
    return { item, runId, content: cut.text, bytes: utf8Bytes(cut.text), truncated: cut.truncated };
  };

  const readers: Record<BundleItemId, () => Promise<string>> = {
    host: async () =>
      JSON.stringify(
        { hostVersion: src.hostVersion, build: src.hostBuild, settings: src.sanitizeRecord(src.hostSettings()) },
        null,
        2
      ),
    'run-status': async () => JSON.stringify(src.sanitizeRecord(src.runStatus(runId) ?? {}), null, 2),
    'failure-records': async () => {
      const parts: string[] = [];
      for (const name of await failureRecordNames(root, runId)) {
        const read = await readTail(root, [...FAILURE_RECORD_DIR, name]);
        if (read !== null) parts.push(read.text.trimEnd());
      }
      return parts.join('\n');
    },
    'audit-rows': async () => {
      const filtered: string[] = [];
      for (const name of auditFileNames(root)) {
        const read = await readTail(root, ['.schegent', name]);
        if (read !== null) filtered.push(linesWhere(read.text, (line) => auditRunId(line) === runId));
      }
      // Through the same counts-only allowlist the audit export uses, so a bundle row carries what an export row does.
      return countsOnlyAuditExport(filtered.filter((part) => part.length > 0).join('\n')).text;
    },
    'runtime-log': async () => {
      const log = src.runtimeLog();
      if (log === null) return '';
      const parts: string[] = [];
      for (const file of runtimeLogFiles(log)) {
        const read = await readTail(file.anchor, [file.leaf]);
        if (read !== null) parts.push(linesWhere(read.text, (line) => runIdOfLogLine(line) === runId));
      }
      return parts.filter((part) => part.length > 0).join('\n');
    },
    'raw-transcript': async () => (await readTail(root, ['.schegent', 'sessions', `raw-${runId}.log`]))?.text ?? '',
    transport: async () => (await readTail(root, ['.schegent', 'sessions', runId, 'transport.log']))?.text ?? '',
    'verbose-diagnostics': async () => {
      const parts: string[] = [];
      for (const segments of await diagnosticFiles(root, runId)) {
        const read = await readTail(root, segments);
        // The header names the file by its place below the Run's diagnostic directory, never an absolute path.
        if (read !== null) parts.push(`--- ${segments.slice(4).join('/')}\n${read.text.trimEnd()}`);
      }
      return parts.join('\n');
    }
  };

  const collected: CollectedItem[] = [];
  for (const planned of plan.included) collected.push(finalize(planned.item, await readers[planned.item]()));
  return collected;
}
