import { describe, expect, it } from 'vitest';

import { createSideEffectFailureReporter } from '../../../src/lib/side-effect-failure-reporter';

// Review gap GC-05 (2026-11-12) — lane settlement, the ACP observation ledger, usage accounting and
// the sweep-protection query each ended in a bare `catch {}`, so a broken side effect left no trace.
// They stay best-effort, and each failure is now reported: once per operation, by error class only,
// because the per-observation paths would otherwise write one line per agent event.
describe('side-effect failure reporter', () => {
  function recordingLogger(): { lines: Array<{ message: string; context: unknown }>; warn: (message: string, context?: unknown) => void } {
    const lines: Array<{ message: string; context: unknown }> = [];
    return { lines, warn: (message, context) => lines.push({ message, context }) };
  }

  it('warns once per operation, with the error class and no message', () => {
    const logger = recordingLogger();
    const report = createSideEffectFailureReporter(logger);

    report('usage-accounting', new TypeError('token sk-secret-value in /home/me'));
    report('usage-accounting', new Error('again'));
    report('lane-settlement', 'thrown string');

    expect(logger.lines).toEqual([
      {
        message: 'best-effort side effect failed; later failures of this operation are not logged',
        context: { operation: 'usage-accounting', error: 'TypeError' }
      },
      {
        message: 'best-effort side effect failed; later failures of this operation are not logged',
        context: { operation: 'lane-settlement', error: 'string' }
      }
    ]);
  });
});
