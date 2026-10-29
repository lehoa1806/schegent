// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract A2; research R6) — the reader that turns the audit chain into the
// census's compact log (pass 1, I/O half).
//
// It never writes, truncates, renames or unlinks anything (hard rule 9) and it never throws: an
// absent `.schegent/` is an empty log, and every failure is one unreadable segment, warned with a
// refusal reason or an error code and never a path or a message (hard rule 22). The chain is
// `.schegent` content a cloned workspace can plant, so each file is opened through `openWithinRoot`
// read-only and streamed through `LineFramer`, which bounds the one line held at a time; every
// segment is read, because the rotation size has a minimum and no maximum (research R6).
//
// ROTATION. The chain is listed once, every listed file is opened before any is read, and the chain
// is listed again. A name that appears only in the second listing means the log rotated between the
// first listing and the opens; it is one unreadable segment, placed after the archives and before the
// live log. Once a file is open a rename does not change what its handle reads.
//
// Nothing is read from outside `.schegent/`: no failure record, session tree or transcript (FR-007).
// ---------------------------------------------------------------------------

import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  AUDIT_CUTS_BASENAME,
  AUDIT_LOG_BASENAME,
  collectChainFiles,
  isAuditCutRecord,
  type ChainFiles
} from '../../audit/audit-chain';
import { DEFAULT_MAX_LINE_UNITS, LineFramer, type FramedOutput } from '../../lib/line-framer';
import type { SanitizedLogger } from '../../lib/logger';
import { openWithinRoot } from '../../lib/safe-open';
import { parseAuditLogLineDetailed } from '../../parser/audit-log-parser';
import { createCensusLogBuilder, type CensusLogBuilder } from './census-log';
import type { CensusLog } from './census-model';

/** The longest line read, in UTF-16 units. A line at or over it is one unparseable line. */
export const CENSUS_MAX_LINE_UNITS = DEFAULT_MAX_LINE_UNITS;

/** How the chain's files are listed. Production passes `collectChainFiles`; a test passes its own. */
export type ChainLister = (auditDir: string) => ChainFiles | null;

const AUDIT_DIR = '.schegent';
const READ_CHUNK_BYTES = 64 * 1024;
const ERROR_CODE_UNKNOWN = 'unknown';

type Slot = { readonly name: string; readonly handle: FileHandle | null };

function errorCode(err: unknown): string {
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : ERROR_CODE_UNKNOWN;
}

/** Open one chain file read-only. A refusal or a failure is `null`, already warned. */
async function openChainFile(
  workspaceRoot: string,
  name: string,
  logger: SanitizedLogger
): Promise<FileHandle | null> {
  try {
    const opened = await openWithinRoot(workspaceRoot, [AUDIT_DIR, name], { flags: 'r' });
    if (opened.outcome === 'refused') {
      logger.warn('failed-row census: open refused', { reason: opened.reason });
      return null;
    }
    return opened.handle;
  } catch (err) {
    logger.warn('failed-row census: open failed', { code: errorCode(err) });
    return null;
  }
}

/** Feed one framed batch to the builder. A line at the limit was cut there, so it is not a record. */
function consume(builder: CensusLogBuilder, output: FramedOutput, isCutFile: boolean): void {
  for (const line of output.lines) {
    if (line.length >= CENSUS_MAX_LINE_UNITS) {
      builder.unparseable();
      continue;
    }
    if (!isCutFile) {
      builder.line(parseAuditLogLineDetailed(line));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      builder.cutFileLine(false);
      continue;
    }
    builder.cutFileLine(isAuditCutRecord(parsed));
  }
}

/** Stream one open file to its end through the framer. A read error is one unreadable segment. */
async function readOpenFile(
  handle: FileHandle,
  isCutFile: boolean,
  builder: CensusLogBuilder,
  logger: SanitizedLogger
): Promise<void> {
  const framer = new LineFramer(CENSUS_MAX_LINE_UNITS);
  const decoder = new StringDecoder('utf8');
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let position = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      consume(builder, framer.append(decoder.write(chunk.subarray(0, bytesRead))), isCutFile);
    }
    consume(builder, framer.append(decoder.end()), isCutFile);
    consume(builder, framer.flush(), isCutFile);
    if (!isCutFile) builder.segmentRead();
  } catch (err) {
    logger.warn('failed-row census: read failed', { code: errorCode(err) });
    builder.unreadableSegment();
  }
}

/**
 * The compact log of the whole audit chain under `workspaceRoot`, cut file first, then archives, then
 * the live log. Never rejects. `listChain` is a test seam; production leaves it at its default.
 */
export async function readCensusLog(
  workspaceRoot: string,
  logger: SanitizedLogger,
  listChain: ChainLister = collectChainFiles
): Promise<CensusLog> {
  const builder = createCensusLogBuilder();
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    builder.unreadableSegment();
    return builder.finish();
  }
  const auditDir = path.join(workspaceRoot, AUDIT_DIR);

  let first: ChainFiles | null;
  try {
    first = listChain(auditDir);
  } catch (err) {
    logger.warn('failed-row census: chain listing failed', { code: errorCode(err) });
    builder.unreadableSegment();
    return builder.finish();
  }
  if (first === null) return builder.finish();
  builder.unrecognizedNames(first.unrecognized.length);

  const slots: Slot[] = [];
  try {
    for (const name of first.ordered) {
      slots.push({ name, handle: await openChainFile(workspaceRoot, name, logger) });
    }

    // The log rotated between the first listing and the opens when a name appears only now.
    let late = 0;
    try {
      const second = listChain(auditDir);
      const known = new Set(first.ordered);
      late = second === null ? 0 : second.ordered.filter((name) => !known.has(name)).length;
    } catch (err) {
      logger.warn('failed-row census: second chain listing failed', { code: errorCode(err) });
      late = 1;
    }
    const flushLate = (): void => {
      for (; late > 0; late -= 1) builder.unreadableSegment();
    };

    for (const slot of slots) {
      if (slot.name === AUDIT_LOG_BASENAME) flushLate();
      if (slot.handle === null) {
        builder.unreadableSegment();
        continue;
      }
      await readOpenFile(slot.handle, slot.name === AUDIT_CUTS_BASENAME, builder, logger);
    }
    flushLate();
  } finally {
    for (const slot of slots) await slot.handle?.close().catch(() => undefined);
  }
  return builder.finish();
}
