// FR-R5-F19 (spec 278, T19.1, FR-001/FR-002) — the first-blocker notice.
//
// One warn notice per Run, on the Run's first report that carries a blocking tag, with a fixed
// template that never echoes an issue summary. The once-per-Run bound is in memory, so a simulated
// host restart (a fresh ledger) notifies once more; that residual is pinned here so it cannot change
// silently.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  BLOCKER_NOTICE_LEDGER_MAX,
  BlockerNoticeLedger,
  blockerNotice,
  emitBlockerNotice
} from '../../../src/services/blocker-notice';
import type { InvocationResult } from '../../../src/parser/stdout-parser';

const sanitizer = new SanitizedLogger();
const sanitize = (value: string): string => sanitizer.sanitize(value);

type Issue = { tag?: string; summary: string; source?: 'host' };

function report(...issues: Issue[]): InvocationResult {
  return { kind: 'remaining_issues', issues, auditEntry: null };
}

const BLOCKING = report({ tag: 'needs-decision', summary: 'Pick the retention window' });
const LABEL = 'Add the export button';

function harness() {
  const warn = vi.fn();
  const logWarn = vi.fn();
  const ledger = new BlockerNoticeLedger();
  const emit = (runId: string, result: InvocationResult, runLabel = LABEL): void =>
    emitBlockerNotice(
      { runId, runLabel, result },
      { ledger, notifier: { warn }, logger: { warn: logWarn }, sanitize }
    );
  return { warn, logWarn, ledger, emit };
}

describe('blockerNotice (pure builder)', () => {
  it('builds one warn notice for a needs-decision issue', () => {
    const notice = blockerNotice({ runLabel: LABEL, result: BLOCKING }, sanitize);
    expect(notice?.level).toBe('warn');
    expect(notice?.message).toContain(LABEL);
  });

  it('builds one for a needs-approval issue', () => {
    const notice = blockerNotice(
      { runLabel: LABEL, result: report({ tag: 'needs-approval', summary: 'x' }) },
      sanitize
    );
    expect(notice?.level).toBe('warn');
  });

  it.each([
    ['regression', report({ tag: 'regression', summary: 'x' })],
    ['unclassified', report({ summary: 'x' })],
    ['malformed tag', report({ tag: 'Needs-Decision', summary: 'x' })],
    ['unknown tag', report({ tag: 'needs-decisions', summary: 'x' })],
    ['host-sourced lookalike', report({ tag: 'needs-decision', summary: 'x', source: 'host' })],
    ['clean result', { kind: 'clean', auditEntry: null } as InvocationResult],
    ['empty issue list', report()]
  ])('builds nothing for %s', (_name, result) => {
    expect(blockerNotice({ runLabel: LABEL, result }, sanitize)).toBeNull();
  });

  it('never echoes the issue summary', () => {
    const secretish = 'SUMMARY-MARKER-9f3a rotate the key';
    const notice = blockerNotice(
      { runLabel: LABEL, result: report({ tag: 'needs-decision', summary: secretish }) },
      sanitize
    );
    expect(notice?.message).not.toContain('SUMMARY-MARKER-9f3a');
  });

  it('says the record can be opened from the queue row', () => {
    const notice = blockerNotice({ runLabel: LABEL, result: BLOCKING }, sanitize);
    expect(notice?.message).toMatch(/queue row/);
  });

  it('passes the Run label through cleanAnnouncementValue (controls stripped, secrets redacted)', () => {
    const hostile = `Task\u0007 Bearer abcdefghijklmnopqrstuvwxyz0123456789`;
    const notice = blockerNotice({ runLabel: hostile, result: BLOCKING }, sanitize);
    expect(notice?.message).not.toContain('\u0007');
    expect(notice?.message).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('is one line', () => {
    const notice = blockerNotice({ runLabel: `a\nb`, result: BLOCKING }, sanitize);
    expect(notice?.message).not.toMatch(/[\r\n]/);
  });
});

describe('emitBlockerNotice (once per Run)', () => {
  it('notifies once on the first blocking report', () => {
    const { warn, emit } = harness();
    emit('run-1', BLOCKING);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not notify again on a repeat report, the same tag or a different one', () => {
    const { warn, emit } = harness();
    emit('run-1', BLOCKING);
    emit('run-1', BLOCKING);
    emit('run-1', report({ tag: 'needs-approval', summary: 'y' }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('notifies once per Run id', () => {
    const { warn, emit } = harness();
    emit('run-1', BLOCKING);
    emit('run-2', BLOCKING);
    emit('run-2', BLOCKING);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not mark a Run notified for a non-blocking report', () => {
    const { warn, emit } = harness();
    emit('run-1', report({ tag: 'regression', summary: 'x' }));
    emit('run-1', BLOCKING);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not notify for unclassified or malformed tags', () => {
    const { warn, emit } = harness();
    emit('run-1', report({ summary: 'x' }));
    emit('run-1', report({ tag: 'NEEDS-DECISION', summary: 'x' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('a notifier that throws does not mark the Run notified, and writes one sanitized log line', () => {
    const { warn, logWarn, ledger, emit } = harness();
    warn.mockImplementationOnce(() => {
      throw new TypeError('toast host gone Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    });
    expect(() => emit('run-1', BLOCKING)).not.toThrow();
    expect(ledger.has('run-1')).toBe(false);
    expect(logWarn).toHaveBeenCalledTimes(1);
    const line = String(logWarn.mock.calls.at(0)?.at(0));
    expect(line).toContain('run-1');
    expect(line).toContain('notify');
    expect(line).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(line).not.toContain('toast host gone');
    // The next report may retry, which keeps the notice from being lost silently.
    emit('run-1', BLOCKING);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(ledger.has('run-1')).toBe(true);
  });

  it('a simulated host restart (fresh ledger) notifies once more: the accepted residual', () => {
    const first = harness();
    first.emit('run-1', BLOCKING);
    const afterRestart = harness();
    afterRestart.emit('run-1', BLOCKING);
    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(afterRestart.warn).toHaveBeenCalledTimes(1);
  });
});

describe('BlockerNoticeLedger bounds', () => {
  it('evicts the oldest entry beyond its bound', () => {
    const ledger = new BlockerNoticeLedger();
    for (let index = 0; index <= BLOCKER_NOTICE_LEDGER_MAX; index += 1) ledger.mark(`run-${index}`);
    expect(ledger.has('run-0')).toBe(false);
    expect(ledger.has(`run-${BLOCKER_NOTICE_LEDGER_MAX}`)).toBe(true);
  });
});

describe('FR-002 (no example-only metric name in generic host code)', () => {
  it('the module source names no metric', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../src/services/blocker-notice.ts'),
      'utf8'
    );
    expect(source).not.toContain('blocked_tasks');
    expect(source).toContain('remaining_issues');
  });
});
