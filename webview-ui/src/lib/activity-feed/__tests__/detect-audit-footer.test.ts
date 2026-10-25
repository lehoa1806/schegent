// Feature 029 T023, rewritten for FR-R3-203 — detectAuditFooter reads the audit
// block and the badge the way the host does: the markers and the token rule come
// from the contract module, the last complete open/close pair is the block, and
// the badge is CLEAR exactly when a line of the region from the close marker to
// the end passes the host's rule. Every fixture is built from the contract
// module's exports, never from literals, so the test cannot drift from the
// strings the prompt prints.

import { describe, expect, it } from 'vitest';
import {
  AUDIT_LOG_CLOSE_MARKER,
  AUDIT_LOG_OPEN_MARKER,
  TERMINATION_TOKEN
} from '../../../../../src/contracts/phase-output-contract';
import { detectAuditFooter } from '../detect-audit-footer';
import type { AuditFooterMatch } from '../types';

const OPEN = AUDIT_LOG_OPEN_MARKER;
const CLOSE = AUDIT_LOG_CLOSE_MARKER;
const TOKEN = TERMINATION_TOKEN;

// The prompt's full block: open marker, the field lines, close marker.
function auditBlock(notes = 'ok'): string {
  return [
    OPEN,
    'phase: speckit-plan',
    'files_created: []',
    'files_modified: []',
    'files_deleted: []',
    'commands_executed: []',
    'network_calls: ["none"]',
    'ruleset_switches: ["none"]',
    `notes: ${notes}`,
    CLOSE
  ].join('\n');
}

// A match whose three slices rebuild the input exactly (contract D-5).
function matchOf(text: string): AuditFooterMatch {
  const detection = detectAuditFooter(text);
  if (!detection.matched) throw new Error('expected the detector to match');
  expect(detection.prefixText + detection.blockText + detection.suffixText).toBe(text);
  return detection;
}

describe('detectAuditFooter — the Observed rows', () => {
  it('row 1: the token after the block reads CLEAR and renders after the card', () => {
    const block = auditBlock();
    const d = matchOf(`${block}\n${TOKEN}`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText).toBe(block);
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe(`\n${TOKEN}`);
  });

  it('row 2: a DONE token after the block reads CLEAR', () => {
    const d = matchOf(`${auditBlock()}\n[SCHEGENT_STATUS: DONE]`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe('\n[SCHEGENT_STATUS: DONE]');
  });

  it('row 3: a lower-case token after the block reads CLEAR', () => {
    const d = matchOf(`${auditBlock()}\n[SCHEGENT_STATUS: clear]`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe('\n[SCHEGENT_STATUS: clear]');
  });

  it('row 4: a token inside the block with nothing after it reads UNKNOWN', () => {
    const text = [OPEN, TOKEN, 'phase: speckit-plan', 'notes: ok', CLOSE].join('\n');
    const d = matchOf(text);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText).toBe(text);
    expect(d.suffixText).toBe('');
  });

  it('row 5: a token before the block with nothing after it reads UNKNOWN', () => {
    const block = auditBlock();
    const d = matchOf(`${TOKEN}\n${block}`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.prefixText).toBe(`${TOKEN}\n`);
    expect(d.blockText).toBe(block);
    expect(d.suffixText).toBe('');
  });

  it('row 6: a "Remaining issues:" list after the block reads UNKNOWN and renders after the card', () => {
    const block = auditBlock();
    const d = matchOf(`${block}\nRemaining issues:\n- one`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText).toBe(block);
    expect(d.suffixText).toBe('\nRemaining issues:\n- one');
  });

  it('row 7: the token on the close-marker line reads CLEAR', () => {
    const head = auditBlock().slice(0, -CLOSE.length);
    const d = matchOf(`${head}${CLOSE} ${TOKEN}`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe(` ${TOKEN}`);
  });
});

describe('detectAuditFooter — shapes beyond the Observed rows', () => {
  it('case 8: a fenced block with the token after the closing fence reads CLEAR', () => {
    const block = auditBlock();
    const d = matchOf(`\`\`\`\n${block}\n\`\`\`\n${TOKEN}`);
    expect(d.status).toBe('CLEAR');
    expect(d.prefixText).toBe('```\n');
    expect(d.blockText).toBe(block);
    expect(d.suffixText).toBe(`\n\`\`\`\n${TOKEN}`);
  });

  it('case 9: the token in the region followed by more text reads CLEAR', () => {
    const d = matchOf(`${auditBlock()}\n${TOKEN}\nmore text`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe(`\n${TOKEN}\nmore text`);
  });

  it('case 10: an open marker with no close and a token after it reads UNKNOWN', () => {
    const text = `${OPEN}\nphase: speckit-plan\n${TOKEN}`;
    const d = matchOf(text);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText).toBe(text);
    expect(d.suffixText).toBe('');
  });

  it('case 11: an open marker with no close and no token reads UNKNOWN', () => {
    const text = `${OPEN}\nphase: speckit-plan\nnotes: still writing`;
    const d = matchOf(text);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText).toBe(text);
    expect(d.suffixText).toBe('');
  });

  it('case 12: with two complete blocks, the last is the block and the first is prefix', () => {
    const first = auditBlock('first');
    const second = auditBlock('second');
    const d = matchOf(`${first}\nbetween\n${second}\n${TOKEN}`);
    expect(d.status).toBe('CLEAR');
    expect(d.prefixText).toBe(`${first}\nbetween\n`);
    expect(d.blockText).toBe(second);
    expect(d.suffixText).toBe(`\n${TOKEN}`);
  });

  it('case 13: a later open marker with no close stays in the suffix of the last complete block', () => {
    const block = auditBlock();
    const d = matchOf(`${block}\n${TOKEN}\n${OPEN}\nphase: partial`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText).toBe(block);
    expect(d.suffixText).toBe(`\n${TOKEN}\n${OPEN}\nphase: partial`);
  });

  it('case 14: a token split across two lines reads UNKNOWN, as the host reads it', () => {
    const d = matchOf(`${auditBlock()}\n[SCHEGENT_STATUS:\nCLEAR]`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe('\n[SCHEGENT_STATUS:\nCLEAR]');
  });

  it('case 15: does not match a padded marker', () => {
    const d = detectAuditFooter(`==== SCHEGENT AUDIT LOG ====\nfake`);
    expect(d.matched).toBe(false);
  });

  it('case 16: any other status word reads UNKNOWN and the line renders after the card', () => {
    const d = matchOf(`${auditBlock()}\n[SCHEGENT_STATUS: BLOCKED]`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe('\n[SCHEGENT_STATUS: BLOCKED]');
  });

  it('case 17: a space before the closing bracket reads UNKNOWN', () => {
    const d = matchOf(`${auditBlock()}\n[SCHEGENT_STATUS: CLEAR ]`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe('\n[SCHEGENT_STATUS: CLEAR ]');
  });

  it('case 18: a decorated token in the region reads CLEAR', () => {
    const d = matchOf(`${auditBlock()}\n**${TOKEN}**`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText.endsWith(CLOSE)).toBe(true);
    expect(d.suffixText).toBe(`\n**${TOKEN}**`);
  });

  it('case 19: a stray close marker after the token ends the block at the first close marker', () => {
    const block = auditBlock();
    const d = matchOf(`${block}\n${TOKEN}\n${CLOSE}`);
    expect(d.status).toBe('CLEAR');
    expect(d.blockText).toBe(block);
    expect(d.suffixText).toBe(`\n${TOKEN}\n${CLOSE}`);
  });
});

describe('detectAuditFooter — cases carried over from feature 029', () => {
  it('reads CLEAR with prefix and suffix around the block when the token follows it', () => {
    const block = auditBlock();
    const d = matchOf(`prefix\n${block}\n${TOKEN}\nsuffix`);
    expect(d.status).toBe('CLEAR');
    expect(d.prefixText).toBe('prefix\n');
    expect(d.blockText).toBe(block);
    expect(d.suffixText).toBe(`\n${TOKEN}\nsuffix`);
  });

  it('reads UNKNOWN when no status line is present', () => {
    const d = matchOf(`${OPEN}\nno status line here\n${CLOSE}`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.suffixText).toBe('');
  });

  it('returns matched=false when neither marker is present', () => {
    const d = detectAuditFooter('plain assistant text\nwith no markers');
    expect(d.matched).toBe(false);
    expect(detectAuditFooter('').matched).toBe(false);
  });

  it('keeps a streaming block truncated and UNKNOWN until the close marker arrives', () => {
    const d = matchOf(`prefix\n${OPEN}\n${TOKEN}\nincomplete trailing data...`);
    expect(d.status).toBe('UNKNOWN');
    expect(d.blockText).toContain('incomplete trailing data');
    expect(d.suffixText).toBe('');
  });

  it('ignores everything before the open marker as prefix', () => {
    const d = matchOf(`chatter\nmore chatter\n${OPEN}\n${TOKEN}\n${CLOSE}`);
    expect(d.prefixText.trim()).toBe('chatter\nmore chatter');
    expect(d.suffixText).toBe('');
  });

  it('captures multi-line block content correctly', () => {
    const d = matchOf([OPEN, TOKEN, 'task: ok', 'phase: implement', CLOSE].join('\n'));
    expect(d.blockText).toContain('task: ok');
    expect(d.blockText).toContain('phase: implement');
    expect(d.suffixText).toBe('');
  });
});
