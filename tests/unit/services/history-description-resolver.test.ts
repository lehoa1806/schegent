// FR-R3-071 (feature 152) — the resolver is the single decision site mapping an
// entry's shape and the sidecar store's typed read to the four outcomes the
// replay commands act on. Each case below is one row of that decision table;
// none of them may collapse to a silent preview substitution, because "replay
// the preview knowingly" is force's meaning and force is the caller's decision.

import { describe, it, expect, vi } from 'vitest';
import { resolveHistoryDescription } from '../../../src/services/history/history-description-resolver';
import type { HistoryDescriptionReadOutcome } from '../../../src/services/history/history-description-store';

function makeDeps(read: HistoryDescriptionReadOutcome) {
  return {
    descriptions: { read: vi.fn(async () => read) },
    logger: { warn: vi.fn() }
  };
}

describe('resolveHistoryDescription (FR-R3-071)', () => {
  it('resolves the sidecar bytes when the ref answers — and the ref wins over inline', async () => {
    const deps = makeDeps({ outcome: 'read', text: 'the full sanitized description' });
    const resolution = await resolveHistoryDescription(
      {
        runId: 'run-1',
        descriptionRef: '.schegent/history/run-1.txt',
        originalDescription: 'stale inline copy'
      },
      deps
    );
    expect(resolution).toEqual({
      outcome: 'resolved',
      description: 'the full sanitized description'
    });
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('resolves legacy from inline text when no ref exists', async () => {
    const deps = makeDeps({ outcome: 'missing' });
    const resolution = await resolveHistoryDescription(
      { runId: 'run-2', descriptionRef: undefined, originalDescription: 'pre-sidecar text' },
      deps
    );
    expect(resolution).toEqual({ outcome: 'legacy', description: 'pre-sidecar text' });
    expect(deps.descriptions.read).not.toHaveBeenCalled();
  });

  it('a dangling ref with inline text resolves legacy, and the failure is logged', async () => {
    const deps = makeDeps({ outcome: 'missing' });
    const resolution = await resolveHistoryDescription(
      {
        runId: 'run-3',
        descriptionRef: '.schegent/history/run-3.txt',
        originalDescription: 'authored text'
      },
      deps
    );
    expect(resolution).toEqual({ outcome: 'legacy', description: 'authored text' });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('run-3'));
  });

  it('an absent sidecar with no inline is missing — a named outcome, never a truncation', async () => {
    const deps = makeDeps({ outcome: 'missing' });
    const resolution = await resolveHistoryDescription(
      { runId: 'run-4', descriptionRef: '.schegent/history/run-4.txt', originalDescription: undefined },
      deps
    );
    expect(resolution).toEqual({ outcome: 'missing' });
  });

  it('a refused ref (outside the store or the workspace) is unreadable', async () => {
    const deps = makeDeps({ outcome: 'refused' });
    const resolution = await resolveHistoryDescription(
      { runId: 'run-5', descriptionRef: '../../etc/passwd', originalDescription: undefined },
      deps
    );
    expect(resolution).toEqual({ outcome: 'unreadable' });
  });

  it('an I/O failure is unreadable, distinct from missing', async () => {
    const deps = makeDeps({ outcome: 'unreadable', code: 'EACCES' });
    const resolution = await resolveHistoryDescription(
      { runId: 'run-6', descriptionRef: '.schegent/history/run-6.txt', originalDescription: undefined },
      deps
    );
    expect(resolution).toEqual({ outcome: 'unreadable' });
  });

  it('neither ref nor inline is missing', async () => {
    const deps = makeDeps({ outcome: 'missing' });
    const resolution = await resolveHistoryDescription(
      { runId: 'run-7', descriptionRef: undefined, originalDescription: undefined },
      deps
    );
    expect(resolution).toEqual({ outcome: 'missing' });
    expect(deps.descriptions.read).not.toHaveBeenCalled();
  });
});
