// Feature 029 T027 — pure detector for the SCHEGENT AUDIT LOG footer
// emitted at the end of a phase run. Returns the matched block plus
// status (CLEAR / FAILED / UNKNOWN) plus the prefix/suffix text so the
// renderer can render `prefix → AuditCompletionCard → suffix`. See
// research.md Decision 3.

import type { AuditFooterDetection, AuditFooterStatus } from './types';

const OPEN_MARKER = '=== SCHEGENT AUDIT LOG ===';
const CLOSE_MARKER = '=== END SCHEGENT AUDIT LOG ===';
const STATUS_RE = /\[SCHEGENT_STATUS:\s*([A-Z_]+)\s*\]/;

function normalizeStatus(raw: string): AuditFooterStatus {
  if (raw === 'CLEAR') return 'CLEAR';
  if (raw === 'FAILED') return 'FAILED';
  return 'UNKNOWN';
}

// Match the marker only when it appears at start-of-line and is not
// padded by an extra `=` on either side. `indexOf` alone would match
// `==== SCHEGENT AUDIT LOG ====` because the 3-equals marker is a
// substring of the 4-equals one.
function findMarkerLineStart(text: string, marker: string, fromIdx: number): number {
  let cursor = fromIdx;
  while (cursor <= text.length - marker.length) {
    const idx = text.indexOf(marker, cursor);
    if (idx === -1) return -1;
    const charBefore = idx === 0 ? '\n' : text[idx - 1];
    const charAfter = idx + marker.length >= text.length ? '\n' : text[idx + marker.length];
    if ((charBefore === '\n' || charBefore === '\r') && charAfter !== '=') {
      return idx;
    }
    cursor = idx + 1;
  }
  return -1;
}

export function detectAuditFooter(text: string): AuditFooterDetection {
  if (text.length === 0) return { matched: false };
  const openIdx = findMarkerLineStart(text, OPEN_MARKER, 0);
  if (openIdx === -1) return { matched: false };
  const closeIdx = findMarkerLineStart(text, CLOSE_MARKER, openIdx + OPEN_MARKER.length);
  const prefixText = text.slice(0, openIdx);
  let blockText: string;
  let suffixText: string;
  if (closeIdx === -1) {
    // Streaming / truncated — open marker present but no close.
    blockText = text.slice(openIdx);
    suffixText = '';
  } else {
    const endOfClose = closeIdx + CLOSE_MARKER.length;
    blockText = text.slice(openIdx, endOfClose);
    suffixText = text.slice(endOfClose);
  }
  const m = STATUS_RE.exec(blockText);
  const status = m === null ? 'UNKNOWN' : normalizeStatus(m[1]);
  return {
    matched: true,
    status,
    blockText,
    prefixText,
    suffixText
  };
}
