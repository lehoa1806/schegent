// Feature 029 T023 — detectAuditFooter: scan an `assistant-text` body
// for the `=== SCHEGENT AUDIT LOG ===` open marker and the matching
// `=== END SCHEGENT AUDIT LOG ===` close marker. Returns the matched
// block + status + prefix/suffix text. See research.md Decision 3.

import { describe, expect, it } from 'vitest';
import { detectAuditFooter } from '../detect-audit-footer';

const OPEN = '=== SCHEGENT AUDIT LOG ===';
const CLOSE = '=== END SCHEGENT AUDIT LOG ===';

describe('Feature 029 T023 — detectAuditFooter', () => {
  it('returns matched=true with status CLEAR when [SCHEGENT_STATUS: CLEAR] is present', () => {
    const text = `prefix\n${OPEN}\n[SCHEGENT_STATUS: CLEAR]\nsummary\n${CLOSE}\nsuffix`;
    const d = detectAuditFooter(text);
    expect(d.matched).toBe(true);
    if (d.matched) {
      expect(d.status).toBe('CLEAR');
      expect(d.blockText).toContain('[SCHEGENT_STATUS: CLEAR]');
      expect(d.prefixText).toBe('prefix\n');
      expect(d.suffixText).toBe('\nsuffix');
    }
  });

  it('returns status FAILED when [SCHEGENT_STATUS: FAILED] is present', () => {
    const text = `${OPEN}\n[SCHEGENT_STATUS: FAILED]\nthings broke\n${CLOSE}`;
    const d = detectAuditFooter(text);
    expect(d.matched).toBe(true);
    if (d.matched) {
      expect(d.status).toBe('FAILED');
    }
  });

  it('returns status UNKNOWN when no [SCHEGENT_STATUS: ...] line is present', () => {
    const text = `${OPEN}\nno status line here\n${CLOSE}`;
    const d = detectAuditFooter(text);
    expect(d.matched).toBe(true);
    if (d.matched) {
      expect(d.status).toBe('UNKNOWN');
    }
  });

  it('returns matched=false when neither marker is present', () => {
    const d = detectAuditFooter('plain assistant text\nwith no markers');
    expect(d.matched).toBe(false);
  });

  it('returns matched=true with truncated block when open marker is present but close is missing', () => {
    const text = `prefix\n${OPEN}\n[SCHEGENT_STATUS: CLEAR]\nincomplete trailing data...`;
    const d = detectAuditFooter(text);
    expect(d.matched).toBe(true);
    if (d.matched) {
      expect(d.status).toBe('CLEAR');
      expect(d.blockText).toContain('incomplete trailing data');
      expect(d.suffixText).toBe('');
    }
  });

  it('ignores everything before the open marker as prefix', () => {
    const text = `chatter\nmore chatter\n${OPEN}\n[SCHEGENT_STATUS: CLEAR]\n${CLOSE}`;
    const d = detectAuditFooter(text);
    if (d.matched) {
      expect(d.prefixText.trim()).toBe('chatter\nmore chatter');
    }
  });

  it('captures multi-line block content correctly', () => {
    const blockLines = [OPEN, '[SCHEGENT_STATUS: CLEAR]', 'task: ok', 'phase: implement', CLOSE].join('\n');
    const d = detectAuditFooter(blockLines);
    if (d.matched) {
      expect(d.blockText).toContain('task: ok');
      expect(d.blockText).toContain('phase: implement');
    }
  });

  it('does not match a partial marker', () => {
    const text = `==== SCHEGENT AUDIT LOG ====\nfake`;
    const d = detectAuditFooter(text);
    expect(d.matched).toBe(false);
  });
});
