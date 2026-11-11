// FR-R6-F13 (FR-002) with FR-R3-047 (H-04) -- a long-lived line channel on a child's stdin.
//
// `writePromptToStdin` writes one prompt and ends the stream, which is the wrong shape for a
// protocol that keeps stdin open for many messages. `openStdinLineChannel` is the same
// attach-then-write discipline for that shape: the `'error'` listener goes on before any byte,
// every stream call is guarded, and a broken stream turns later writes into `false`.
//
// The first two cases spawn a real child, for the reason `child-stdin-delivery.test.ts` gives:
// a `Writable` stub cannot emit `EPIPE`, and an uncaught `EPIPE` is the defect.

import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { openStdinLineChannel } from '../../../src/runner/child-stdin';

type ChannelChild = Parameters<typeof openStdinLineChannel>[0];

/** Echoes each stdin line back on stdout, and reports EOF. */
const CHILD_ECHOES_LINES =
  'let buf = "";' +
  'process.stdin.on("data", (c) => { buf += c; let i;' +
  ' while ((i = buf.indexOf("\\n")) >= 0) { console.log("got:" + buf.slice(0, i)); buf = buf.slice(i + 1); } });' +
  'process.stdin.on("end", () => { console.log("eof"); process.exit(0); });';

/** Throws its stdin away, then lingers so later writes meet a dead pipe. */
const CHILD_DESTROYS_STDIN = 'process.stdin.destroy(); setTimeout(() => process.exit(0), 600);';

const LARGE_LINE_BYTES = 1024 * 1024;
const FAULT_SETTLE_MS = 250;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubChild(stdin: unknown): ChannelChild {
  return { stdin } as unknown as ChannelChild;
}

describe('a line channel on a real child', () => {
  it('delivers several lines on one open stream, then EOF on end()', async () => {
    const child = spawn(process.execPath, ['-e', CHILD_ECHOES_LINES], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

    const channel = openStdinLineChannel(child);
    expect(channel.write('one\n')).toBe(true);
    await pause(100);
    expect(channel.write('two\n')).toBe(true);
    expect(channel.write('three\n')).toBe(true);
    channel.end();

    expect(await exited).toBe(0);
    expect(stdout.split('\n').filter((line) => line.length > 0)).toEqual(['got:one', 'got:two', 'got:three', 'eof']);
    // Closed is closed: a write after `end()` is refused, not thrown.
    expect(channel.write('four\n')).toBe(false);
  }, 20_000);

  it('survives a child that destroys stdin, and refuses writes once the stream breaks', async () => {
    const faults: string[] = [];
    const onUncaught = (err: unknown): void => {
      faults.push(`uncaughtException:${String((err as { code?: string }).code)}`);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const child = spawn(process.execPath, ['-e', CHILD_DESTROYS_STDIN], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const channel = openStdinLineChannel(child);

      const line = `${'x'.repeat(LARGE_LINE_BYTES)}\n`;
      for (let index = 0; index < 8; index += 1) {
        channel.write(line);
        await pause(50);
      }
      await exited;
      await pause(FAULT_SETTLE_MS);

      expect(channel.write('late\n')).toBe(false);
      expect(() => channel.end()).not.toThrow();
    } finally {
      await pause(FAULT_SETTLE_MS);
      process.off('uncaughtException', onUncaught);
    }
    expect(faults).toEqual([]);
  }, 20_000);
});

describe('a line channel never throws', () => {
  it('refuses every write when the child has no stdin', () => {
    const channel = openStdinLineChannel(stubChild(null));
    expect(channel.write('line\n')).toBe(false);
    expect(() => channel.end()).not.toThrow();
  });

  it('attaches the error listener before the first byte', () => {
    const calls: string[] = [];
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        calls.push('write');
        callback();
      }
    });
    const on = stdin.on.bind(stdin);
    stdin.on = ((event: string, listener: (...args: unknown[]) => void) => {
      calls.push(`on:${event}`);
      return on(event, listener);
    }) as typeof stdin.on;

    const channel = openStdinLineChannel(stubChild(stdin));
    expect(calls).toEqual(['on:error']);
    expect(channel.write('line\n')).toBe(true);
    expect(calls).toEqual(['on:error', 'write']);
    // With no listener `emit('error')` throws; that throw is the host crash.
    expect(() => stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    // And the stream is now broken for good.
    expect(channel.write('line\n')).toBe(false);
  });

  // A write the stream took can fail later; the error is the only sign, so the owner is told.
  it('reports the break once, and swallows a fault in that callback', () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      }
    });
    let breaks = 0;
    const channel = openStdinLineChannel(stubChild(stdin), () => {
      breaks += 1;
      throw new Error('owner fault');
    });
    expect(channel.write('line\n')).toBe(true);
    expect(breaks).toBe(0);
    expect(() => stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    expect(() => stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    expect(breaks).toBe(1);
    expect(channel.write('line\n')).toBe(false);
  });

  it('never writes to a stream it could not attach a listener to', () => {
    let writes = 0;
    const foreign = {
      destroyed: false,
      writable: true,
      on(): never {
        throw new Error('not an emitter');
      },
      write(): boolean {
        writes += 1;
        return true;
      },
      end(): void {
        writes += 1;
      }
    };

    const channel = openStdinLineChannel(stubChild(foreign));
    expect(channel.write('line\n')).toBe(false);
    expect(() => channel.end()).not.toThrow();
    expect(writes).toBe(0);
  });

  it('turns a write that throws into a refused write', () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      }
    });
    stdin.write = () => {
      throw Object.assign(new Error('boom'), { code: 'ERR_STREAM_DESTROYED' });
    };

    const channel = openStdinLineChannel(stubChild(stdin));
    expect(channel.write('line\n')).toBe(false);
    expect(channel.write('line\n')).toBe(false);
  });

  it('ends the stream once, and tolerates an end() that throws', () => {
    let ends = 0;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      }
    });
    stdin.end = (() => {
      ends += 1;
      throw new Error('already finished');
    }) as typeof stdin.end;

    const channel = openStdinLineChannel(stubChild(stdin));
    expect(() => channel.end()).not.toThrow();
    expect(() => channel.end()).not.toThrow();
    expect(ends).toBe(1);
    expect(channel.write('line\n')).toBe(false);
  });
});
