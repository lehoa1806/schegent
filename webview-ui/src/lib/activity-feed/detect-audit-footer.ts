// Feature 029 T027 — pure detector for the audit log block emitted at the end of
// a phase run. Returns the matched block plus status (CLEAR / UNKNOWN) plus the
// prefix/suffix text so the renderer can render `prefix → AuditCompletionCard →
// suffix`. See research.md Decision 3.
//
// FR-R3-203 — reads the block and the badge the way the host does. The markers
// and the token rule come from the contract module the host's parsers and the
// prompt also take them from. The last complete open/close pair is the block,
// and the badge is CLEAR exactly when a line of the region from that pair's
// close marker to the end passes the host's token rule.

import {
  AUDIT_LOG_CLOSE_MARKER,
  AUDIT_LOG_OPEN_MARKER,
  containsTerminationToken
} from '../../../../src/contracts/phase-output-contract';
import type { AuditFooterDetection, AuditFooterStatus } from './types';

// Match the marker only when it appears at start-of-line and is not followed
// by an extra equals sign. `indexOf` alone would match a padded copy of the
// open marker, because the three-equals marker is a substring of the
// four-equals one.
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

// The host's token rule is per line, so the region is split first: its pattern's
// whitespace matches a newline, and a token split across two lines is not one.
function regionStatus(region: string): AuditFooterStatus {
  return region.split(/\r?\n/).some(containsTerminationToken) ? 'CLEAR' : 'UNKNOWN';
}

export function detectAuditFooter(text: string): AuditFooterDetection {
  if (text.length === 0) return { matched: false };
  const firstOpenIdx = findMarkerLineStart(text, AUDIT_LOG_OPEN_MARKER, 0);
  if (firstOpenIdx === -1) return { matched: false };

  // Pair the markers as the host's parser pairs them: an open marker, the next
  // close marker after it, then resume after that close marker. The last
  // complete pair is the block.
  let lastPair: { openIdx: number; closeIdx: number } | null = null;
  let openIdx = firstOpenIdx;
  while (openIdx !== -1) {
    const closeIdx = findMarkerLineStart(
      text,
      AUDIT_LOG_CLOSE_MARKER,
      openIdx + AUDIT_LOG_OPEN_MARKER.length
    );
    if (closeIdx === -1) break;
    lastPair = { openIdx, closeIdx };
    openIdx = findMarkerLineStart(text, AUDIT_LOG_OPEN_MARKER, closeIdx + AUDIT_LOG_CLOSE_MARKER.length);
  }

  if (lastPair === null) {
    // Streaming / truncated — an open marker with no close after it.
    return {
      matched: true,
      status: 'UNKNOWN',
      blockText: text.slice(firstOpenIdx),
      prefixText: text.slice(0, firstOpenIdx),
      suffixText: ''
    };
  }

  const endOfClose = lastPair.closeIdx + AUDIT_LOG_CLOSE_MARKER.length;
  return {
    matched: true,
    status: regionStatus(text.slice(lastPair.closeIdx)),
    blockText: text.slice(lastPair.openIdx, endOfClose),
    prefixText: text.slice(0, lastPair.openIdx),
    suffixText: text.slice(endOfClose)
  };
}
