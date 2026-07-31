import { describe, it, expect } from 'vitest';
import { WebviewLogSink, DEBUG_LOG_TAIL_MAX } from '../../../src/lib/webview-log-sink';

describe('WebviewLogSink', () => {
  it('parses a standard SanitizedLogger line', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-07-30T20:14:02.071Z] DEBUG router: inbound {"type":"CMD_READ_PHASE_LOG"}');
    const entries = sink.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(1);
    expect(entries[0].timestamp).toBe('2026-07-30T20:14:02.071Z');
    expect(entries[0].level).toBe('DEBUG');
    expect(entries[0].message).toBe('router: inbound {"type":"CMD_READ_PHASE_LOG"}');
  });

  it('parses all four log levels', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-01-01T00:00:00Z] DEBUG msg-d');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO msg-i');
    sink.appendLine('[2026-01-01T00:00:02Z] WARN msg-w');
    sink.appendLine('[2026-01-01T00:00:03Z] ERROR msg-e');
    const entries = sink.getEntries();
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.level)).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });

  it('silently skips malformed lines', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('this is not a log line');
    sink.appendLine('');
    sink.appendLine('[no-level] hello');
    expect(sink.getEntries()).toHaveLength(0);
    expect(sink.length).toBe(0);
  });

  it('returns entries in chronological order', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-01-01T00:00:00Z] INFO first');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO second');
    sink.appendLine('[2026-01-01T00:00:02Z] INFO third');
    const entries = sink.getEntries();
    expect(entries[0].message).toBe('first');
    expect(entries[1].message).toBe('second');
    expect(entries[2].message).toBe('third');
  });

  it('assigns monotonically increasing ids', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-01-01T00:00:00Z] INFO a');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO b');
    sink.appendLine('[2026-01-01T00:00:02Z] INFO c');
    const entries = sink.getEntries();
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
    expect(entries[2].id).toBe(3);
  });

  it('evicts oldest entries when capacity is exceeded', () => {
    const sink = new WebviewLogSink(3);
    sink.appendLine('[2026-01-01T00:00:00Z] INFO a');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO b');
    sink.appendLine('[2026-01-01T00:00:02Z] INFO c');
    sink.appendLine('[2026-01-01T00:00:03Z] INFO d');
    expect(sink.length).toBe(3);
    const entries = sink.getEntries();
    expect(entries.map((e) => e.message)).toEqual(['b', 'c', 'd']);
  });

  it('wraps around correctly after many evictions', () => {
    const sink = new WebviewLogSink(2);
    for (let i = 0; i < 10; i++) {
      sink.appendLine(`[2026-01-01T00:00:0${i}Z] INFO msg-${i}`);
    }
    expect(sink.length).toBe(2);
    const entries = sink.getEntries();
    expect(entries[0].message).toBe('msg-8');
    expect(entries[1].message).toBe('msg-9');
  });

  it('returns frozen entries', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-01-01T00:00:00Z] INFO test');
    const entries = sink.getEntries();
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries[0])).toBe(true);
  });

  it('returns empty frozen array when buffer is empty', () => {
    const sink = new WebviewLogSink();
    const entries = sink.getEntries();
    expect(entries).toHaveLength(0);
    expect(Array.isArray(entries)).toBe(true);
  });

  it('clear() resets the buffer', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-01-01T00:00:00Z] INFO a');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO b');
    expect(sink.length).toBe(2);
    sink.clear();
    expect(sink.length).toBe(0);
    expect(sink.getEntries()).toHaveLength(0);
  });

  it('continues incrementing ids after clear', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-01-01T00:00:00Z] INFO a');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO b');
    sink.clear();
    sink.appendLine('[2026-01-01T00:00:02Z] INFO c');
    expect(sink.getEntries()[0].id).toBe(3);
  });

  it('defaults to DEBUG_LOG_TAIL_MAX capacity', () => {
    const sink = new WebviewLogSink();
    for (let i = 0; i < DEBUG_LOG_TAIL_MAX + 50; i++) {
      sink.appendLine(`[2026-01-01T00:00:00Z] INFO msg-${i}`);
    }
    expect(sink.length).toBe(DEBUG_LOG_TAIL_MAX);
    const entries = sink.getEntries();
    expect(entries[0].message).toBe(`msg-50`);
    expect(entries[entries.length - 1].message).toBe(`msg-${DEBUG_LOG_TAIL_MAX + 49}`);
  });

  it('handles capacity of 1', () => {
    const sink = new WebviewLogSink(1);
    sink.appendLine('[2026-01-01T00:00:00Z] INFO first');
    sink.appendLine('[2026-01-01T00:00:01Z] INFO second');
    expect(sink.length).toBe(1);
    expect(sink.getEntries()[0].message).toBe('second');
  });

  it('parses message with context JSON appended', () => {
    const sink = new WebviewLogSink();
    sink.appendLine(
      '[2026-07-30T20:18:09.323Z] DEBUG phase-runner.lock-acquired {"pipelineId":"speckit-new-feature","phaseId":"speckit-analyze"}'
    );
    const entry = sink.getEntries()[0];
    expect(entry.level).toBe('DEBUG');
    expect(entry.message).toBe(
      'phase-runner.lock-acquired {"pipelineId":"speckit-new-feature","phaseId":"speckit-analyze"}'
    );
  });

  it('parses INFO with context', () => {
    const sink = new WebviewLogSink();
    sink.appendLine('[2026-07-30T20:18:09.323Z] INFO phase-start speckit-analyze iter=1');
    const entry = sink.getEntries()[0];
    expect(entry.level).toBe('INFO');
    expect(entry.message).toBe('phase-start speckit-analyze iter=1');
  });
});
