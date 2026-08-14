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
    bar.update('run-1', { kind: 'idle', pendingCount: 3 });
    expect(item.__text()).toBe('schegent: queue 3');
  });

  it('idle + pendingCount === 0 stays as "schegent: idle"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'idle', pendingCount: 0 });
    expect(item.__text()).toBe('schegent: idle');
  });

  it('running + phase + iteration renders recursive phase form', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'running', phase: 'speckit-clarify', iteration: 2, iterationCap: 10 });
    expect(item.__text()).toBe('schegent: speckit-clarify [2/10]');
  });

  it('running + phase without iteration renders non-recursive phase form', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'running', phase: 'speckit-plan' });
    expect(item.__text()).toBe('schegent: speckit-plan');
  });

  it('paused with detail renders "schegent: paused (<reason>)"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'paused', detail: 'no-credits' });
    expect(item.__text()).toBe('schegent: paused (no-credits)');
  });

  it('paused without detail keeps the legacy nextPollAt form', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    const nextPollAt = new Date('2026-05-10T13:30:00.000Z').getTime();
    bar.update('run-1', { kind: 'paused', nextPollAt });
    expect(item.__text()).toMatch(/^schegent: paused \(next poll \d{2}:\d{2}\)$/);
  });

  it('stalled kind renders "schegent: stalled"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'stalled' });
    expect(item.__text()).toBe('schegent: stalled');
  });

  it('terminal kinds render "schegent: <state>"', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'completed' });
    expect(item.__text()).toBe('schegent: completed');
    bar.update('run-1', { kind: 'failed' });
    expect(item.__text()).toBe('schegent: failed');
    bar.update('run-1', { kind: 'canceled' });
    expect(item.__text()).toBe('schegent: canceled');
  });

  it('surfaces degraded and unavailable evidence without losing workflow state', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-1', { kind: 'running', phase: 'speckit-plan' });

    bar.setEvidenceHealth('degraded');
    expect(item.__text()).toContain('schegent: speckit-plan');
    expect(item.__text()).toContain('evidence degraded');
    expect(item.__tooltip()).toContain('optional execution evidence degraded');

    bar.setEvidenceHealth('unavailable');
    expect(item.__text()).toContain('evidence unavailable');
    expect(item.__tooltip()).toContain('fail-closed policy');

    bar.setEvidenceHealth('healthy');
    expect(item.__text()).toBe('schegent: speckit-plan');
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
      bar.update('run-1', s);
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

describe('SchegentStatusBar aggregates N concurrent Runs (T050)', () => {
  it('two running Runs render a count instead of one Run winning', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', { kind: 'running', phase: 'speckit-plan' });
    bar.update('run-b', { kind: 'running', phase: 'speckit-tasks' });
    expect(item.__text()).toBe('schegent: 2 runs');
  });

  it('a second Run reporting the same kind does not overwrite the first', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', { kind: 'running', phase: 'speckit-plan' });
    bar.update('run-b', { kind: 'running', phase: 'speckit-tasks' });
    bar.update('run-a', { kind: 'running', phase: 'speckit-analyze' });
    expect(item.__text()).toBe('schegent: 2 runs');
    expect(item.__tooltip()).toContain('phase: speckit-analyze');
    expect(item.__tooltip()).toContain('phase: speckit-tasks');
    expect(item.__tooltip()).not.toContain('phase: speckit-plan');
  });

  it('running outranks paused and stalled outranks paused in the headline', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', { kind: 'paused', detail: 'awaiting-approval' });
    bar.update('run-b', { kind: 'running', phase: 'speckit-plan' });
    expect(item.__text()).toBe('schegent: speckit-plan');

    bar.update('run-b', { kind: 'stalled' });
    expect(item.__text()).toBe('schegent: stalled');
  });

  it('counts only the Runs sharing the headline kind', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', { kind: 'paused', detail: 'awaiting-approval' });
    bar.update('run-b', { kind: 'paused', detail: 'rate-limited' });
    bar.update('run-c', { kind: 'stalled' });
    expect(item.__text()).toBe('schegent: stalled');

    bar.update('run-c', { kind: 'completed' });
    expect(item.__text()).toBe('schegent: 2 paused');
  });

  it('a settled Run leaves the live set and the survivor gets its own form back', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', { kind: 'running', phase: 'speckit-plan' });
    bar.update('run-b', { kind: 'running', phase: 'speckit-tasks' });
    expect(item.__text()).toBe('schegent: 2 runs');

    bar.update('run-b', { kind: 'completed' });
    expect(item.__text()).toBe('schegent: speckit-plan');

    bar.update('run-a', { kind: 'canceled' });
    expect(item.__text()).toBe('schegent: canceled');
  });

  it('a window-level condition outranks the aggregate and clearing it restores the aggregate', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', { kind: 'running', phase: 'speckit-plan' });
    bar.update('run-b', { kind: 'running', phase: 'speckit-tasks' });

    bar.updateWindow({ kind: 'paused', detail: 'no-credits' });
    expect(item.__text()).toBe('schegent: paused (no-credits)');

    // The Runs kept reporting underneath; the window condition merely hid them.
    bar.update('run-a', { kind: 'running', phase: 'speckit-analyze' });
    expect(item.__text()).toBe('schegent: paused (no-credits)');

    bar.updateWindow(null);
    expect(item.__text()).toBe('schegent: 2 runs');
  });

  it('the multi-Run tooltip carries phase detail but no run or queue identifier', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', {
      kind: 'running',
      phase: 'speckit-clarify',
      iteration: 2,
      iterationCap: 10
    });
    bar.update('run-b', { kind: 'paused', detail: 'awaiting-approval' });

    const tooltip = item.__tooltip();
    expect(tooltip.split('\n')).toEqual([
      'running — phase: speckit-clarify — iteration: 2/10',
      'paused — awaiting-approval',
      'click to view audit log'
    ]);
    expect(tooltip).not.toContain('run-a');
    expect(tooltip).not.toContain('run-b');
  });

  it('a single live Run keeps the pre-feature single-line tooltip', () => {
    const item = makeItem();
    const bar = new SchegentStatusBar(item);
    bar.update('run-a', {
      kind: 'running',
      phase: 'speckit-clarify',
      iteration: 2,
      iterationCap: 10
    });
    expect(item.__tooltip()).toBe(
      'phase: speckit-clarify — iteration: 2/10 — click to view audit log'
    );
  });
});
