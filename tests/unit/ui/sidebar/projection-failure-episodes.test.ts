// The failure-episode tracker (FR-R4-F08, contract F: F-T8, N1; F3, F4).
//
// WHAT THIS PINS. `ProjectionFailureEpisodes` writes a projection failure only
// when it opens an episode for that source, ends an episode on the first compose
// that returns normally without that failure, and leaves an episode open when a
// compose throws. Every row of data model section 1's state table is a case here.
//
// N1 (the source-text half): the composer reports failures through
// `projectionFailed` and never writes a `warn` itself, and the runtime composes
// through the tracker. Both read the real files with `readFileSync`; the
// `vi.mock` below replaces only the module the tracker imports, so it cannot
// hide what is read from disk. The runtime assertion is the control that must hit.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectionFailureEpisodes,
  type ComposeInput,
  type ProjectionFailureSource,
  type ProjectionLogger
} from '../../../../src/ui/sidebar/projection-failure-episodes';
import type { WorkflowSnapshot } from '../../../../src/ui/sidebar/snapshot';

interface ScriptedFailure {
  readonly source: ProjectionFailureSource;
  readonly message: string;
}

interface ScriptedCompose {
  readonly failures: readonly ScriptedFailure[];
  readonly throws?: boolean;
}

const script = vi.hoisted(() => ({
  steps: [] as { failures: { source: string; message: string }[]; throws?: boolean }[],
  seenLogger: null as unknown
}));

vi.mock('../../../../src/ui/sidebar/snapshot-composer', () => ({
  composeWorkflowSnapshot: (context: { logger: ProjectionLogger | null }) => {
    script.seenLogger = context.logger;
    const step = script.steps.shift();
    if (step === undefined) throw new Error('the script ran out of composes');
    for (const failure of step.failures) {
      context.logger?.projectionFailed(failure.source as ProjectionFailureSource, failure.message);
    }
    if (step.throws === true) throw new Error('compose threw');
    return { fixed: true } as unknown as WorkflowSnapshot;
  }
}));

const SRC = resolve(__dirname, '../../../../src/ui/sidebar');

function fakeLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
    sanitize: vi.fn((value: string) => `sanitized:${value}`)
  };
}

function input(logger: ReturnType<typeof fakeLogger> | null): ComposeInput {
  return { logger } as unknown as ComposeInput;
}

function play(steps: readonly ScriptedCompose[]): void {
  script.steps.splice(0, script.steps.length, ...steps.map((step) => ({
    failures: [...step.failures],
    ...(step.throws === true ? { throws: true } : {})
  })));
}

const pipeline = (message: string): ScriptedFailure => ({ source: 'pipeline-catalog', message });
const workflow = (message: string): ScriptedFailure => ({ source: 'workflow-catalog', message });

describe('F-T8 ProjectionFailureEpisodes: data model section 1, row by row', () => {
  beforeEach(() => {
    script.steps.length = 0;
    script.seenLogger = null;
  });

  it('closed, failure during a compose: opens and writes one WARN line, the first message', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([{ failures: [pipeline('first cause')] }]);
    tracker.compose(input(logger));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('first cause');
  });

  it('open, failure during a compose: stays open and writes nothing, whatever the message', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([
      { failures: [pipeline('first cause')] },
      { failures: [pipeline('a different cause')] },
      { failures: [pipeline('yet another cause')] }
    ]);
    tracker.compose(input(logger));
    tracker.compose(input(logger));
    tracker.compose(input(logger));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('first cause');
  });

  it('open, a normally returned compose with no failure of this source: closes and writes nothing', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([
      { failures: [pipeline('first cause')] },
      { failures: [] },
      { failures: [pipeline('second episode cause')] }
    ]);
    tracker.compose(input(logger));
    tracker.compose(input(logger));
    expect(logger.warn, 'recovery itself writes nothing').toHaveBeenCalledTimes(1);
    tracker.compose(input(logger));
    expect(logger.warn, 'a failure after recovery opens a new episode').toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith('second episode cause');
  });

  it('open, a compose that throws: stays open, writes nothing, and rethrows', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([
      { failures: [pipeline('first cause')] },
      { failures: [], throws: true },
      { failures: [pipeline('after the throw')] }
    ]);
    tracker.compose(input(logger));
    expect(() => tracker.compose(input(logger))).toThrow('compose threw');
    tracker.compose(input(logger));
    expect(logger.warn, 'the throw closed nothing, so the later failure is inside the same episode').toHaveBeenCalledTimes(1);
  });

  it('closed, a normally returned compose with no failure: stays closed and writes nothing', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([{ failures: [] }, { failures: [] }]);
    const first = tracker.compose(input(logger));
    tracker.compose(input(logger));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(first, 'the composed snapshot is returned as composed').toEqual({ fixed: true });
  });

  it('sources are independent: one open source does not hide another source\'s first failure', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([
      { failures: [pipeline('pipeline cause')] },
      { failures: [pipeline('pipeline cause'), workflow('workflow cause')] },
      { failures: [workflow('workflow cause')] }
    ]);
    tracker.compose(input(logger));
    tracker.compose(input(logger));
    expect(logger.warn).toHaveBeenCalledTimes(2);
    tracker.compose(input(logger));
    // The pipeline source reported nothing in the third compose, so its episode ended there.
    expect(logger.warn, 'the workflow episode is still open').toHaveBeenCalledTimes(2);
  });

  it('a null logger writes nothing and still tracks the episode', () => {
    const tracker = new ProjectionFailureEpisodes();
    const logger = fakeLogger();
    play([
      { failures: [pipeline('unlogged cause')] },
      { failures: [pipeline('now there is a logger')] }
    ]);
    expect(() => tracker.compose(input(null))).not.toThrow();
    tracker.compose(input(logger));
    expect(logger.warn, 'the episode opened under the null logger, so the second failure is not a first').not.toHaveBeenCalled();
  });

  it('hands the composer a logger that delegates sanitize and debug to the caller\'s logger', () => {
    const logger = fakeLogger();
    const tracker = new ProjectionFailureEpisodes();
    play([{ failures: [] }]);
    tracker.compose(input(logger));
    const seen = script.seenLogger as ProjectionLogger;
    expect(seen.sanitize('abc')).toBe('sanitized:abc');
    seen.debug('a debug line');
    expect(logger.debug).toHaveBeenCalledWith('a debug line');
  });
});

describe('N1 the composer reports, the runtime composes through the tracker', () => {
  const composer = readFileSync(resolve(SRC, 'snapshot-composer.ts'), 'utf8');
  const runtime = readFileSync(resolve(SRC, 'state-projector-runtime.ts'), 'utf8');

  it('the composer holds no logger warn call and exactly three projectionFailed calls', () => {
    expect(composer.includes('ctx.logger?.warn('), 'a projection failure written by the composer').toBe(false);
    expect((composer.match(/\.projectionFailed\(/g) ?? []).length, 'projectionFailed calls').toBe(3);
  });

  it('the runtime composes through the tracker (the control that must hit)', () => {
    expect(runtime.includes('failureEpisodes.compose('), 'the runtime\'s compose call').toBe(true);
  });
});
