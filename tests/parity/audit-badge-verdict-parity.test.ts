// FR-R3-203 (SC-001) — the activity feed's audit-card badge and the host's verdict,
// asked about the same text. The webview detector and the host's stdout parser
// each read the audit block's close marker and the termination token; for years
// they read different strings and the badge contradicted the run's outcome. This
// test runs both on one corpus and requires the badge to read CLEAR exactly when
// the host calls the text clean.
//
// The detector is loaded by dynamic import and a typed cast, as
// `phase-control-surface-classifier-parity.test.ts` loads its webview module: the
// webview tree is not part of the host's type graph. The specifier is computed,
// not a literal: the host's `tsc` includes this file, and a literal would pull the
// detector's extensionless webview imports into a Node16 program that rejects them.
import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  AUDIT_LOG_CLOSE_MARKER,
  AUDIT_LOG_OPEN_MARKER,
  TERMINATION_TOKEN
} from '../../src/contracts/phase-output-contract';
import { parseAuditLogBlock } from '../../src/parser/audit-log-parser';
import { parseInvocation } from '../../src/parser/stdout-parser';

type Detection = { matched: false } | { matched: true; status: 'CLEAR' | 'UNKNOWN' };
type Detector = (text: string) => Detection;

const DETECTOR_MODULE = resolve(
  __dirname,
  '..',
  '..',
  'webview-ui',
  'src',
  'lib',
  'activity-feed',
  'detect-audit-footer.ts'
);

let detectAuditFooter: Detector;

function auditBlock(notes = 'ok'): string {
  return [
    AUDIT_LOG_OPEN_MARKER,
    'phase: speckit-plan',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    `notes: ${notes}`,
    AUDIT_LOG_CLOSE_MARKER
  ].join('\n');
}

interface CorpusRow {
  readonly id: string;
  readonly text: string;
}

const BLOCK = auditBlock();
const HEAD_OF_BLOCK = BLOCK.slice(0, -AUDIT_LOG_CLOSE_MARKER.length);

const CORPUS: readonly CorpusRow[] = [
  { id: 'row 1: token after the block', text: `${BLOCK}\n${TERMINATION_TOKEN}` },
  { id: 'row 2: DONE after the block', text: `${BLOCK}\n[SCHEGENT_STATUS: DONE]` },
  { id: 'row 3: lower-case token after the block', text: `${BLOCK}\n[SCHEGENT_STATUS: clear]` },
  {
    id: 'row 4: token inside the block, nothing after',
    text: [
      AUDIT_LOG_OPEN_MARKER,
      TERMINATION_TOKEN,
      'phase: speckit-plan',
      'files_created: []',
      'files_modified: []',
      'files_deleted: []',
      'commands_executed: []',
      'network_calls: ["none"]',
      'ruleset_switches: ["none"]',
      'notes: ok',
      AUDIT_LOG_CLOSE_MARKER
    ].join('\n')
  },
  { id: 'row 5: token before the block, nothing after', text: `${TERMINATION_TOKEN}\n${BLOCK}` },
  { id: 'row 6: remaining issues after the block', text: `${BLOCK}\nRemaining issues:\n- one` },
  {
    id: 'row 7: token on the close-marker line',
    text: `${HEAD_OF_BLOCK}${AUDIT_LOG_CLOSE_MARKER} ${TERMINATION_TOKEN}`
  },
  { id: 'fenced block, token after the fence', text: `\`\`\`\n${BLOCK}\n\`\`\`\n${TERMINATION_TOKEN}` },
  { id: 'token split across two lines', text: `${BLOCK}\n[SCHEGENT_STATUS:\nCLEAR]` },
  {
    id: 'two blocks, token after the second',
    text: `${auditBlock('first')}\nbetween\n${auditBlock('second')}\n${TERMINATION_TOKEN}`
  }
];

function hostKind(text: string): string {
  const audit = parseAuditLogBlock(text);
  const result = parseInvocation({
    stdout: text,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region
  });
  return result.kind;
}

function badgeOf(text: string): 'CLEAR' | 'UNKNOWN' {
  const detection = detectAuditFooter(text);
  if (!detection.matched) throw new Error('the detector did not match a corpus text');
  return detection.status;
}

describe('FR-R3-203 — the audit card badge and the host verdict agree', () => {
  beforeAll(async () => {
    const mod = (await import(/* @vite-ignore */ DETECTOR_MODULE)) as {
      detectAuditFooter: Detector;
    };
    detectAuditFooter = mod.detectAuditFooter;
  });

  for (const row of CORPUS) {
    it(`${row.id}: the badge is CLEAR exactly when the host's kind is clean`, () => {
      const kind = hostKind(row.text);
      expect(badgeOf(row.text), `host kind was '${kind}'`).toBe(kind === 'clean' ? 'CLEAR' : 'UNKNOWN');
    });
  }

  it('the corpus holds at least one clean and one non-clean text, so agreement is not vacuous', () => {
    const kinds = CORPUS.map((row) => hostKind(row.text));
    expect(kinds).toContain('clean');
    expect(kinds.some((kind) => kind !== 'clean')).toBe(true);
  });
});
