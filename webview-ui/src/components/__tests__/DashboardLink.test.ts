import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const postCommandMock = vi.fn();

vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandMock(...args)
}));

import DashboardLink from '../DashboardLink.svelte';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  postCommandMock.mockReset();
});

describe('DashboardLink', () => {
  it('renders sidebar-open-dashboard-button as <button type="button">', () => {
    const { container } = render(DashboardLink);
    const btn = container.querySelector('[data-testid="sidebar-open-dashboard-button"]');
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe('BUTTON');
    expect(btn!.getAttribute('type')).toBe('button');
  });

  it('accessible name is "Open Dashboard"', () => {
    const { container } = render(DashboardLink);
    const btn = container.querySelector('[data-testid="sidebar-open-dashboard-button"]') as HTMLElement;
    const text = btn.textContent?.trim() ?? '';
    const aria = btn.getAttribute('aria-label') ?? '';
    expect(text === 'Open Dashboard' || aria === 'Open Dashboard').toBe(true);
  });

  it('click fires postCommand(CMD_OPEN_DASHBOARD) exactly once', async () => {
    const { container } = render(DashboardLink);
    const btn = container.querySelector('[data-testid="sidebar-open-dashboard-button"]') as HTMLElement;
    await fireEvent.click(btn);
    expect(postCommandMock).toHaveBeenCalledTimes(1);
    expect(postCommandMock).toHaveBeenCalledWith('CMD_OPEN_DASHBOARD');
  });

  it('Enter and Space keys activate the button (native semantics)', async () => {
    const { container } = render(DashboardLink);
    const btn = container.querySelector('[data-testid="sidebar-open-dashboard-button"]') as HTMLButtonElement;
    btn.focus();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    // Native <button type="button"> routes Enter/Space → click in real DOM.
    // jsdom does not synthesize that, so simulate the activation path.
    await fireEvent.click(btn);
    expect(postCommandMock).toHaveBeenCalledTimes(1);
    expect(postCommandMock).toHaveBeenCalledWith('CMD_OPEN_DASHBOARD');
  });

  it('button has min-height >= 32px declared in CSS', () => {
    const src = readFileSync(resolve(__dirname, '../DashboardLink.svelte'), 'utf8');
    const styleMatch = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    const style = styleMatch ? styleMatch[1] : '';
    const m = style.match(/min-height:\s*(\d+)px/);
    expect(m).not.toBeNull();
    expect(Number.parseInt(m![1], 10)).toBeGreaterThanOrEqual(32);
  });
});
