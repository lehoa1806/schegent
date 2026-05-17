import { describe, it, expect, vi } from 'vitest';
import { SchegentOutputChannel, type OutputChannelLike } from '../../../src/ui/output-channel';
import { SanitizedLogger } from '../../../src/lib/logger';

function makeChannel(): OutputChannelLike & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine: vi.fn((line: string) => {
      lines.push(line);
    }),
    show: vi.fn(),
    dispose: vi.fn()
  };
}

describe('SchegentOutputChannel', () => {
  it('writes log lines with the [schegent] prefix', () => {
    const channel = makeChannel();
    const out = new SchegentOutputChannel(channel, new SanitizedLogger());
    out.log('hello');
    expect(channel.appendLine).toHaveBeenCalledWith('[schegent] hello');
  });

  it('sanitizes secrets in log calls', () => {
    const channel = makeChannel();
    const out = new SchegentOutputChannel(channel, new SanitizedLogger());
    out.log('Bearer abcdefghijklmnopqrst');
    expect(channel.lines[0]).toContain('[REDACTED]');
    expect(channel.lines[0]).not.toContain('abcdefghijklmnopqrst');
  });

  it('mirrors logger output through the registered sink', () => {
    const channel = makeChannel();
    const logger = new SanitizedLogger();
    new SchegentOutputChannel(channel, logger);
    logger.info('phase started');
    expect(channel.lines.some((l) => l.includes('INFO') && l.includes('phase started'))).toBe(true);
  });

  it('reveal calls show with preserveFocus=true', () => {
    const channel = makeChannel();
    const out = new SchegentOutputChannel(channel, new SanitizedLogger());
    out.reveal();
    expect(channel.show).toHaveBeenCalledWith(true);
  });

  it('dispose forwards to the underlying channel', () => {
    const channel = makeChannel();
    const out = new SchegentOutputChannel(channel, new SanitizedLogger());
    out.dispose();
    expect(channel.dispose).toHaveBeenCalled();
  });
});
