// Feature 029 T012 — MultiLineCodeBlock: renders text inside
// `<pre><code>`, honors newlines, exposes a copy button, and provides
// an expand affordance for blocks over 800 lines.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import MultiLineCodeBlock from '../../parts/MultiLineCodeBlock.svelte';

afterEach(() => cleanup());

describe('Feature 029 T012 — MultiLineCodeBlock', () => {
  it('renders text inside <pre><code> elements', () => {
    const { container } = render(MultiLineCodeBlock, {
      props: { text: 'line 1\nline 2\nline 3' }
    });
    const pre = container.querySelector('pre');
    const code = container.querySelector('pre > code');
    expect(pre).not.toBeNull();
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('line 1\nline 2\nline 3');
  });

  it('preserves newlines so each source line renders on its own visual line', () => {
    const { container } = render(MultiLineCodeBlock, {
      props: { text: 'a\nb' }
    });
    const code = container.querySelector('pre > code') as HTMLElement;
    // The textContent itself preserves the \n; the CSS `white-space: pre`
    // is what makes them visible. We verify presence in the text content
    // here; the CSS contract is asserted in the implementation snapshot.
    expect(code.textContent).toContain('\n');
  });

  it('exposes a Copy button that copies the rendered text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });
    const text = 'copy me\nplease';
    const { getByTestId } = render(MultiLineCodeBlock, {
      props: { text }
    });
    const btn = getByTestId('multiline-copy') as HTMLButtonElement;
    btn.click();
    // Wait a microtask for the async call.
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it('shows an Expand affordance when the text is longer than 800 lines', () => {
    const longText = Array.from({ length: 850 }, (_, i) => `line-${i}`).join('\n');
    const { queryByTestId } = render(MultiLineCodeBlock, {
      props: { text: longText }
    });
    expect(queryByTestId('multiline-expand')).not.toBeNull();
  });

  it('does not show an Expand affordance when the text is short', () => {
    const { queryByTestId } = render(MultiLineCodeBlock, {
      props: { text: 'one\ntwo' }
    });
    expect(queryByTestId('multiline-expand')).toBeNull();
  });

  it('reflects the language hint via data-lang when provided', () => {
    const { container } = render(MultiLineCodeBlock, {
      props: { text: 'foo(1)', language: 'js' }
    });
    const code = container.querySelector('pre > code');
    expect(code?.getAttribute('data-lang')).toBe('js');
  });
});
