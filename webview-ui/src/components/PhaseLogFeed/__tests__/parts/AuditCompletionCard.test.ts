// Feature 029 T025 — AuditCompletionCard: visually highlight a
// detected SCHEGENT AUDIT LOG block. Renders a status badge variant
// per match.status (CLEAR / FAILED / UNKNOWN) and embeds the block
// body inside MultiLineCodeBlock so newlines render correctly.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import AuditCompletionCard from '../../parts/AuditCompletionCard.svelte';
import type { AuditFooterMatch } from '../../../../lib/activity-feed/types';

afterEach(() => cleanup());

function match(status: AuditFooterMatch['status'], blockText: string): AuditFooterMatch {
  return {
    matched: true,
    status,
    blockText,
    prefixText: '',
    suffixText: ''
  };
}

describe('Feature 029 T025 — AuditCompletionCard', () => {
  it('renders a CLEAR status badge', () => {
    const { getByTestId } = render(AuditCompletionCard, {
      props: {
        match: match('CLEAR', '=== SCHEGENT AUDIT LOG ===\n[SCHEGENT_STATUS: CLEAR]\n=== END SCHEGENT AUDIT LOG ===')
      }
    });
    const card = getByTestId('audit-completion-card');
    expect(card.getAttribute('data-status')).toBe('CLEAR');
    expect(card.textContent).toContain('CLEAR');
  });

  it('renders a FAILED status badge', () => {
    const { getByTestId } = render(AuditCompletionCard, {
      props: {
        match: match('FAILED', '=== SCHEGENT AUDIT LOG ===\n[SCHEGENT_STATUS: FAILED]\n=== END SCHEGENT AUDIT LOG ===')
      }
    });
    const card = getByTestId('audit-completion-card');
    expect(card.getAttribute('data-status')).toBe('FAILED');
    expect(card.textContent).toContain('FAILED');
  });

  it('renders an UNKNOWN status badge', () => {
    const { getByTestId } = render(AuditCompletionCard, {
      props: {
        match: match('UNKNOWN', '=== SCHEGENT AUDIT LOG ===\nno status\n=== END SCHEGENT AUDIT LOG ===')
      }
    });
    const card = getByTestId('audit-completion-card');
    expect(card.getAttribute('data-status')).toBe('UNKNOWN');
  });

  it('renders the block body inside MultiLineCodeBlock', () => {
    const block = '=== SCHEGENT AUDIT LOG ===\nphase: implement\nstatus: ok\n=== END SCHEGENT AUDIT LOG ===';
    const { container } = render(AuditCompletionCard, {
      props: { match: match('CLEAR', block) }
    });
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('phase: implement');
    expect(code?.textContent).toContain('status: ok');
  });
});
