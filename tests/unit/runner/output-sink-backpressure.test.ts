import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { InvocationOutputSink } from '../../../src/runner/invocation-result';
import { OutputSinkBackpressure } from '../../../src/runner/output-sink-backpressure';

describe('OutputSinkBackpressure', () => {
  it('suspends once and resumes the idle timer only after both streams drain', () => {
    const drains = new Map<'stdout' | 'stderr', () => void>();
    const sink: InvocationOutputSink = {
      write: vi.fn(() => false),
      onceDrain: (stream, callback) => drains.set(stream, callback)
    };
    const suspend = vi.fn();
    const resume = vi.fn();
    const controller = new OutputSinkBackpressure(sink, suspend, resume);
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdoutPause = vi.spyOn(stdout, 'pause');
    const stdoutResume = vi.spyOn(stdout, 'resume');
    const stderrPause = vi.spyOn(stderr, 'pause');
    const stderrResume = vi.spyOn(stderr, 'resume');

    controller.write('stdout', stdout, 'a');
    controller.write('stderr', stderr, 'b');

    expect(controller.isBlocked).toBe(true);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(stdoutPause).toHaveBeenCalledTimes(1);
    expect(stderrPause).toHaveBeenCalledTimes(1);

    drains.get('stdout')?.();
    expect(stdoutResume).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();

    drains.get('stderr')?.();
    expect(stderrResume).toHaveBeenCalledTimes(1);
    expect(controller.isBlocked).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
