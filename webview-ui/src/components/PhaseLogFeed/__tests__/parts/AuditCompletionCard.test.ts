// Feature 029 T025 — AuditCompletionCard: visually highlight a
// detected audit log block. Renders a status badge variant
// per match.status (CLEAR / UNKNOWN) and embeds the block
// body inside MultiLineCodeBlock so newlines render correctly.
// FR-R3-203: the block text is the host's block, built from the contract
// module's markers, and the token the badge reads sits after the block.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import AuditCompletionCard from '../../parts/AuditCompletionCard.svelte';
import type { AuditFooterMatch } from '../../../../lib/activity-feed/types';
import {
  AUDIT_LOG_CLOSE_MARKER,
  AUDIT_LOG_OPEN_MARKER,
  TERMINATION_TOKEN
} from '../../../../../../src/contracts/phase-output-contract';

afterEach(() => cleanup());

function match(
  status: AuditFooterMatch['status'],
  blockText: string,
  suffixText = ''
): AuditFooterMatch {
  return {
    matched: true,
    status,
    blockText,
    prefixText: '',
    suffixText
  };
}

describe('Feature 029 T025 — AuditCompletionCard', () => {
  it('renders a CLEAR status badge', () => {
    const { getByTestId } = render(AuditCompletionCard, {
      props: {
        match: match(
          'CLEAR',
          `${AUDIT_LOG_OPEN_MARKER}\nphase: implement\n${AUDIT_LOG_CLOSE_MARKER}`,
          `\n${TERMINATION_TOKEN}`
        )
      }
    });
    const card = getByTestId('audit-completion-card');
    expect(card.getAttribute('data-status')).toBe('CLEAR');
    expect(card.textContent).toContain('CLEAR');
  });

  it('renders an UNKNOWN status badge', () => {
    const { getByTestId } = render(AuditCompletionCard, {
      props: {
        match: match('UNKNOWN', `${AUDIT_LOG_OPEN_MARKER}\nno status\n${AUDIT_LOG_CLOSE_MARKER}`)
      }
    });
    const card = getByTestId('audit-completion-card');
    expect(card.getAttribute('data-status')).toBe('UNKNOWN');
  });

  it('renders the block body inside MultiLineCodeBlock', () => {
    const block = `${AUDIT_LOG_OPEN_MARKER}\nphase: implement\nstatus: ok\n${AUDIT_LOG_CLOSE_MARKER}`;
    const { container } = render(AuditCompletionCard, {
      props: { match: match('CLEAR', block, `\n${TERMINATION_TOKEN}`) }
    });
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('phase: implement');
    expect(code?.textContent).toContain('status: ok');
  });
});
