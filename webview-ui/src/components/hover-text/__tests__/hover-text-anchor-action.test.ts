import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __test__, hoverTextAnchor } from '../hover-text-anchor-action';

const SHORT = 'short';
const LONG = 'x'.repeat(120);

function makeAnchor(): HTMLInputElement {
  const node = document.createElement('input');
  node.type = 'text';
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('hoverTextAnchor action — direct unit', () => {
  it('exposes the timing constants used by the contract', () => {
    expect(__test__.HOVER_OPEN_DELAY_MS).toBe(400);
    expect(__test__.MOUSELEAVE_GRACE_MS).toBe(100);
  });

  it('inline path: creates <p id="desc-<id>"> as the next sibling and sets aria-describedby', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-inline',
      description: { body: SHORT }
    });
    const next = node.nextSibling as HTMLParagraphElement | null;
    expect(next).not.toBeNull();
    expect(next?.id).toBe('desc-unit-inline');
    expect(next?.className).toBe('hover-text-inline-help');
    expect(node.getAttribute('aria-describedby')).toBe('desc-unit-inline');
    handle.destroy();
    expect(document.getElementById('desc-unit-inline')).toBeNull();
    expect(node.hasAttribute('aria-describedby')).toBe(false);
  });

  it('popover path: sets data-hover-text-anchored on attach, no popover host until open', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-popover',
      description: { body: LONG }
    });
    expect(node.getAttribute('data-hover-text-anchored')).toBe('true');
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    handle.destroy();
    expect(node.hasAttribute('data-hover-text-anchored')).toBe(false);
  });

  it('popover path: hover open after 400ms portals a single host into document.body', async () => {
    vi.useFakeTimers();
    try {
      const node = makeAnchor();
      const handle = hoverTextAnchor(node, {
        controlId: 'unit-popover',
        description: { body: LONG }
      });
      node.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(400);
      const hosts = document.querySelectorAll('.hover-text-portal-host');
      expect(hosts.length).toBe(1);
      expect(node.getAttribute('aria-describedby')).toBe('hover-text-unit-popover');
      handle.destroy();
      expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Escape on the anchor closes an open popover', async () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-popover',
      description: { body: LONG }
    });
    node.dispatchEvent(new FocusEvent('focus'));
    expect(document.querySelector('.hover-text-portal-host')).not.toBeNull();
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    node.dispatchEvent(ev);
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    handle.destroy();
  });

  it('destroy() while popover is open tears down both listeners and the portal host', async () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-popover',
      description: { body: LONG }
    });
    node.dispatchEvent(new FocusEvent('focus'));
    expect(document.querySelector('.hover-text-portal-host')).not.toBeNull();
    handle.destroy();
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    expect(node.hasAttribute('data-hover-text-anchored')).toBe(false);
    expect(node.hasAttribute('aria-describedby')).toBe(false);
  });

  it('update() across the 80-char threshold rebuilds (inline -> popover)', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-mut',
      description: { body: SHORT }
    });
    expect(document.getElementById('desc-unit-mut')).not.toBeNull();
    expect(node.hasAttribute('data-hover-text-anchored')).toBe(false);

    handle.update({ controlId: 'unit-mut', description: { body: LONG } });
    expect(document.getElementById('desc-unit-mut')).toBeNull();
    expect(node.getAttribute('data-hover-text-anchored')).toBe('true');
    handle.destroy();
  });

  it('update() within inline mode updates id, text, and aria-describedby', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-mut',
      description: { body: SHORT }
    });
    handle.update({ controlId: 'unit-mut-2', description: { body: 'updated short' } });
    const p = document.getElementById('desc-unit-mut-2');
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe('updated short');
    expect(node.getAttribute('aria-describedby')).toBe('desc-unit-mut-2');
    handle.destroy();
  });

  it('update() with disabled=true detaches everything', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'unit-mut',
      description: { body: SHORT }
    });
    expect(document.getElementById('desc-unit-mut')).not.toBeNull();
    handle.update({ controlId: 'unit-mut', description: { body: SHORT }, disabled: true });
    expect(document.getElementById('desc-unit-mut')).toBeNull();
    expect(node.hasAttribute('aria-describedby')).toBe(false);
    handle.destroy();
  });
});

describe('BUG-001 regression — reactive update() with value-equal params keeps popover open', () => {
  it('repeated update() with fresh object literals but identical values does NOT close an open popover', async () => {
    vi.useFakeTimers();
    try {
      const node = makeAnchor();
      const baseDescription = { title: 'Auto-compact', body: LONG };
      const handle = hoverTextAnchor(node, {
        controlId: 'bug001-stable',
        description: baseDescription
      });

      // Open the popover via the 400ms hover path.
      node.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelector('.hover-text-portal-host')).not.toBeNull();
      expect(node.getAttribute('aria-describedby')).toBe('hover-text-bug001-stable');

      // Simulate Svelte 5's per-render `update()` invocation: a fresh object
      // literal each time, but every value-equality-relevant field unchanged.
      // Pre-fix this would tear down the popover on the first such call.
      for (let i = 0; i < 5; i += 1) {
        handle.update({
          controlId: 'bug001-stable',
          description: { title: 'Auto-compact', body: LONG }
        });
        expect(document.querySelector('.hover-text-portal-host')).not.toBeNull();
        expect(node.getAttribute('aria-describedby')).toBe('hover-text-bug001-stable');
      }

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('update() with a changed description.body still closes the open popover (content drift path preserved)', async () => {
    vi.useFakeTimers();
    try {
      const node = makeAnchor();
      const handle = hoverTextAnchor(node, {
        controlId: 'bug001-drift',
        description: { body: LONG }
      });
      node.dispatchEvent(new MouseEvent('mouseenter'));
      await vi.advanceTimersByTimeAsync(400);
      expect(document.querySelector('.hover-text-portal-host')).not.toBeNull();

      // A real content swap (derived list reuses the same anchor with a new
      // description) still tears down — the popover must not display stale
      // content. This is the genuine-content-change branch from T048.
      handle.update({
        controlId: 'bug001-drift',
        description: { body: 'y'.repeat(150) }
      });
      expect(document.querySelector('.hover-text-portal-host')).toBeNull();
      expect(node.hasAttribute('aria-describedby')).toBe(false);

      handle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('update() with a changed disabled flag (true → no-op-equivalent close) tears down popover-mode wiring', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'bug001-disable',
      description: { body: LONG }
    });
    node.dispatchEvent(new FocusEvent('focus'));
    expect(document.querySelector('.hover-text-portal-host')).not.toBeNull();

    handle.update({
      controlId: 'bug001-disable',
      description: { body: LONG },
      disabled: true
    });
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    expect(node.hasAttribute('data-hover-text-anchored')).toBe(false);
    handle.destroy();
  });
});

describe('T022 — keyboard / screen-reader contract', () => {
  it('(a) focus on the anchor sets aria-describedby="hover-text-<controlId>"', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'kbd-a',
      description: { body: LONG }
    });
    expect(node.hasAttribute('aria-describedby')).toBe(false);
    node.dispatchEvent(new FocusEvent('focus'));
    expect(node.getAttribute('aria-describedby')).toBe('hover-text-kbd-a');
    handle.destroy();
  });

  it('(b) blur from the anchor removes aria-describedby after a microtask', async () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'kbd-b',
      description: { body: LONG }
    });
    node.dispatchEvent(new FocusEvent('focus'));
    expect(node.getAttribute('aria-describedby')).toBe('hover-text-kbd-b');
    node.dispatchEvent(new FocusEvent('blur'));
    await Promise.resolve();
    expect(node.hasAttribute('aria-describedby')).toBe(false);
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    handle.destroy();
  });

  it('(c) Escape closes popover and the anchor retains focus (no programmatic blur)', () => {
    const node = makeAnchor();
    document.body.appendChild(node);
    const handle = hoverTextAnchor(node, {
      controlId: 'kbd-c',
      description: { body: LONG }
    });
    node.focus();
    node.dispatchEvent(new FocusEvent('focus'));
    expect(document.activeElement).toBe(node);
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    node.dispatchEvent(ev);
    expect(document.querySelector('.hover-text-portal-host')).toBeNull();
    expect(node.hasAttribute('aria-describedby')).toBe(false);
    expect(document.activeElement).toBe(node);
    handle.destroy();
  });

  it('(d) inline-mode aria-describedby persists across the action lifetime (never toggled by state)', () => {
    const node = makeAnchor();
    const handle = hoverTextAnchor(node, {
      controlId: 'kbd-d',
      description: { body: SHORT }
    });
    expect(node.getAttribute('aria-describedby')).toBe('desc-kbd-d');
    node.dispatchEvent(new FocusEvent('focus'));
    expect(node.getAttribute('aria-describedby')).toBe('desc-kbd-d');
    node.dispatchEvent(new MouseEvent('mouseenter'));
    expect(node.getAttribute('aria-describedby')).toBe('desc-kbd-d');
    node.dispatchEvent(new FocusEvent('blur'));
    expect(node.getAttribute('aria-describedby')).toBe('desc-kbd-d');
    handle.destroy();
  });
});

describe('FR-015 regression — theme.css contract', () => {
  it('theme.css still constrains .hover-text-popover-body to max-width 320px / min-width 180px', () => {
    const themeCssPath = join(__dirname, '../../../lib/theme.css');
    const css = readFileSync(themeCssPath, 'utf8');
    const bodyRule = css.match(/\.hover-text-popover-body\s*\{[^}]*\}/);
    expect(bodyRule).not.toBeNull();
    expect(bodyRule?.[0]).toMatch(/max-width:\s*320px/);
    expect(bodyRule?.[0]).toMatch(/min-width:\s*180px/);
  });
});
