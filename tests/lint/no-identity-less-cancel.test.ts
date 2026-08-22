import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCAN_ROOT = resolve(REPO_ROOT, 'webview-ui', 'src');

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

function listFilesReferencingCancel(): readonly string[] {
  let out: string;
  try {
    out = filesMatching(SCAN_ROOT, "postCommand(CMD_CANCEL", { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) return [];
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function findOffenders(absFile: string): readonly Offender[] {
  const text = readFileSync(absFile, 'utf8');
  const lines = text.split('\n');
  const offenders: Offender[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Match exactly `postCommand(CMD_CANCEL` (not CMD_CANCEL_*).
    // Ensure the call site carries a `taskId` field; if not, flag it.
    if (/postCommand\(CMD_CANCEL\b/.test(line) && !/taskId/.test(line)) {
      offenders.push({
        file: absFile.startsWith(REPO_ROOT + '/') ? absFile.slice(REPO_ROOT.length + 1) : absFile,
        line: i + 1,
        snippet: line.trim()
      });
    }
  }
  return offenders;
}

describe('Feature 017 BUG-001 — every CMD_CANCEL dispatch carries a taskId', () => {
  it('rejects identity-less postCommand(CMD_CANCEL) invocations in webview-ui/src/', () => {
    const matchedFiles = listFilesReferencingCancel();
    const allOffenders = matchedFiles.flatMap(findOffenders);
    expect(
      allOffenders,
      `Offending postCommand(CMD_CANCEL) calls without taskId payload:\n${allOffenders
        .map((o) => `  ${o.file}:${o.line} — ${o.snippet}`)
        .join('\n')}`
    ).toEqual([]);
  });

  // Vacuity control. `allOffenders` is built by flat-mapping over the scan, so
  // an empty scan yields an empty offender list and a green test — identical to
  // "every cancel dispatch carries a taskId". The webview does dispatch cancels;
  // if the scan stops finding them, the pattern or the scan root has drifted,
  // not the code.
  it('finds the cancel dispatch sites it inspects', () => {
    expect(
      listFilesReferencingCancel().length,
      'No file under webview-ui/src/ was found referencing postCommand(CMD_CANCEL. ' +
        'Either the dispatch was renamed or SCAN_ROOT has moved — in both cases the ' +
        'assertion above is passing over an empty set.'
    ).toBeGreaterThan(0);
  });
});
