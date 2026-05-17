import { describe, it, expect, vi } from 'vitest';
import { SchegentStatusBar, type StatusBarItemLike } from '../../../src/ui/status-bar';

function makeItem(): StatusBarItemLike & {
  __text: () => string;
  __tooltip: () => string;
  __command: () => string | undefined;
  __shows: () => number;
} {
  let text = '';
  let tooltip: unknown = '';
  let command: unknown = undefined;
  let shows = 0;
  const item: StatusBarItemLike & {
    __text: () => string;
    __tooltip: () => string;
    __command: () => string | undefined;
    __shows: () => number;
  } = {
    get text() {
      return text;
    },
    set text(v: string) {
      text = v;
    },
    get tooltip() {
      return tooltip;
    },
    set tooltip(v: unknown) {
      tooltip = v;
    },
    get command() {
      return command;
    },
    set command(v: unknown) {
      command = v;
    },
    show: vi.fn(() => {
      shows += 1;
    }),
    hide: vi.fn(),
    dispose: vi.fn(),
    __text: () => text,
    __tooltip: () => String(tooltip ?? ''),
    __command: () => (typeof command === 'string' ? command : undefined),
    __shows: () => shows
  };
  return item;
}

describe('SchegentStatusBar (T063)', () => {
  it('default text on construction is "schegent: idle" and command points to audit log', () => {
    const item = makeItem();
    new SchegentStatusBar(item);
    expect(item.__text()).toBe('schegent: idle');
    expect(item.__command()).toBe('schegent.showAuditLog');
    expect(item.__shows()).toBe(1);
  });

  it('idle + pendingCount >= 1 renders "schegent: queue <n>"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'idle', pendingCount: 3 });
    expect(item.__text()).toBe('schegent: queue 3');
  });

  it('idle + pendingCount === 0 stays as "schegent: idle"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'idle', pendingCount: 0 });
    expect(item.__text()).toBe('schegent: idle');
  });

  it('running + phase + iteration renders recursive phase form', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'running', phase: 'speckit-clarify', iteration: 2, iterationCap: 10 });
    expect(item.__text()).toBe('schegent: speckit-clarify [2/10]');
  });

  it('running + phase without iteration renders non-recursive phase form', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'running', phase: 'speckit-plan' });
    expect(item.__text()).toBe('schegent: speckit-plan');
  });

  it('paused with detail renders "schegent: paused (<reason>)"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'paused', detail: 'no-credits' });
    expect(item.__text()).toBe('schegent: paused (no-credits)');
  });

  it('paused without detail keeps the legacy nextPollAt form', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    const nextPollAt = new Date('2026-05-10T13:30:00.000Z').getTime();
    bar.update({ kind: 'paused', nextPollAt });
    expect(item.__text()).toMatch(/^schegent: paused \(next poll \d{2}:\d{2}\)$/);
  });

  it('stalled kind renders "schegent: stalled"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'stalled' });
    expect(item.__text()).toBe('schegent: stalled');
  });

  it('terminal kinds render "schegent: <state>"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update({ kind: 'completed' });
    expect(item.__text()).toBe('schegent: completed');
    bar.update({ kind: 'failed' });
    expect(item.__text()).toBe('schegent: failed');
    bar.update({ kind: 'canceled' });
    expect(item.__text()).toBe('schegent: canceled');
  });

  it('transitions across all forms do not flicker (no intermediate text)', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    const sequence = [
      { kind: 'idle' as const, pendingCount: 0 },
      { kind: 'idle' as const, pendingCount: 2 },
      { kind: 'running' as const, phase: 'speckit-specify' as const },
      { kind: 'running' as const, phase: 'speckit-clarify' as const, iteration: 1, iterationCap: 10 },
      { kind: 'stalled' as const },
      { kind: 'paused' as const, detail: 'rate-limited' },
      { kind: 'failed' as const }
    ];
    const observed: string[] = [];
    for (const s of sequence) {
      bar.update(s);
      observed.push(item.__text());
    }
    expect(observed).toEqual([
      'schegent: idle',
      'schegent: queue 2',
      'schegent: speckit-specify',
      'schegent: speckit-clarify [1/10]',
      'schegent: stalled',
      'schegent: paused (rate-limited)',
      'schegent: failed'
    ]);
  });
});
