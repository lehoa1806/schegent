// Feature 029 T024 — MetadataStrip: collapsed-by-default summary row
// showing the latest value per known metadata key; an expand toggle
// reveals all detected lines. Latest-value-wins de-duplication: when
// the same key appears multiple times in the input, the strip shows
// the last occurrence.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/svelte';
import MetadataStrip from '../../parts/MetadataStrip.svelte';
import type { MetadataLine } from '../../../../lib/activity-feed/types';

afterEach(() => cleanup());

function mk(key: MetadataLine['key'], value: string, rawKey?: string): MetadataLine {
  return { key, rawKey: rawKey ?? key, value };
}

describe('Feature 029 T024 — MetadataStrip', () => {
  it('renders nothing visible when given an empty lines array', () => {
    const { container } = render(MetadataStrip, { props: { lines: [] } });
    const root = container.querySelector('[data-testid="metadata-strip"]');
    expect(root === null || root.textContent?.trim() === '').toBe(true);
  });

  it('is collapsed by default and shows the summary row', () => {
    const lines: MetadataLine[] = [
      mk('cwd', '/Users/me/x'),
      mk('session_id', 'abc-123'),
      mk('duration_ms', '1234'),
      mk('cost', '0.001')
    ];
    const { getByTestId, queryByTestId } = render(MetadataStrip, {
      props: { lines }
    });
    const strip = getByTestId('metadata-strip');
    expect(strip).not.toBeNull();
    expect(strip.getAttribute('data-expanded')).toBe('false');
    expect(queryByTestId('metadata-strip-expanded')).toBeNull();
    expect(strip.textContent).toContain('cwd');
  });

  it('shows the full list when the toggle is clicked', async () => {
    const lines: MetadataLine[] = [
      mk('cwd', '/x'),
      mk('session_id', 'sess-1'),
      mk('duration_ms', '999'),
      mk('cost', '0.02')
    ];
    const { getByTestId } = render(MetadataStrip, { props: { lines } });
    const strip = getByTestId('metadata-strip');
    expect(strip.getAttribute('data-expanded')).toBe('false');
    const btn = getByTestId('metadata-strip-toggle');
    await fireEvent.click(btn);
    expect(strip.getAttribute('data-expanded')).toBe('true');
    const expanded = getByTestId('metadata-strip-expanded');
    expect(expanded.textContent).toContain('sess-1');
  });

  it('latest-value-wins when the same key appears more than once', () => {
    const lines: MetadataLine[] = [
      mk('duration_ms', '1000'),
      mk('duration_ms', '2000'),
      mk('duration_ms', '3000')
    ];
    const { getByTestId } = render(MetadataStrip, { props: { lines } });
    const strip = getByTestId('metadata-strip');
    expect(strip.textContent).toContain('3000');
    expect(strip.textContent).not.toContain('1000');
  });

  it('renders all unique keys in the collapsed summary order', () => {
    const lines: MetadataLine[] = [
      mk('cwd', '/x'),
      mk('session_id', 'sess'),
      mk('model', 'claude-opus-4-7'),
      mk('tools', 'Read,Write')
    ];
    const { getByTestId } = render(MetadataStrip, { props: { lines } });
    const strip = getByTestId('metadata-strip');
    for (const expected of ['cwd', 'session_id', 'model', 'tools']) {
      expect(strip.textContent).toContain(expected);
    }
  });
});
