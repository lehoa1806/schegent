// FR-R6-F07 T038 (FR-017, F07-AC-08 projection half) — F13's normalized ACP
// events projected to display entries, qualified against fixtures. No ACP
// transport exists yet; these fixtures are the shape F13 maps its decoder to.
//
// WHAT THIS PINS:
//   - a reconnect (a new connection generation) opens a new segment behind one
//     `transport-gap` row, so continuity is never invented across it;
//   - replayed history is labelled apart from live activity and never shares a
//     segment with it;
//   - a history event without a source id after one with an id is an uncertain
//     correlation: a new segment behind a gap;
//   - the stream sequence is assigned by the host, starts at 0 and only rises,
//     whatever the events claim;
//   - every entry passes the shared truncation, sanitization and entry budget;
//   - an event that is not the normalized shape is one `parse-omission` gap and
//     none of its content is shown.

import { describe, expect, it } from 'vitest';
import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  initialAcpProjectionState,
  projectAcpEvents,
  type AcpNormalizedEvent,
  type AcpProjectedItem
} from '../../../../src/services/phase-log/acp-live-projection';
import { LIVE_LOG_ENTRY_MAX_BYTES } from '../../../../src/contracts/phase-log-bounds';

const logger = new SanitizedLogger();
const OPTIONS = { sanitize: (s: string): string => logger.sanitize(s), caps: { perFieldBytes: 4096 } };

function live(generation: string, text: string, sourceEventId: string | null = null): AcpNormalizedEvent {
  return { connectionGeneration: generation, attemptId: 'attempt-1', sourceEventId, origin: 'live', kind: 'message', text };
}

function history(generation: string, text: string, sourceEventId: string | null): AcpNormalizedEvent {
  return { connectionGeneration: generation, attemptId: 'attempt-1', sourceEventId, origin: 'history', kind: 'message', text };
}

function project(events: readonly unknown[]): readonly AcpProjectedItem[] {
  return projectAcpEvents(initialAcpProjectionState(), events, OPTIONS).items;
}

function textsOf(items: readonly AcpProjectedItem[]): (string | undefined)[] {
  return items.map((item) => item.entry.body.text);
}

function gapReasons(items: readonly AcpProjectedItem[]): unknown[] {
  return items.filter((item) => item.entry.kind === 'coverage-gap').map((item) => item.entry.body.reason);
}

describe('FR-R6-F07 T038 — ACP live projection (FR-017)', () => {
  it('keeps one segment while live events arrive on one connection', () => {
    const items = project([live('g1', 'one'), live('g1', 'two'), live('g1', 'three')]);
    expect(textsOf(items)).toEqual(['one', 'two', 'three']);
    expect(items.map((item) => item.segment)).toEqual([0, 0, 0]);
    expect(items.map((item) => item.entry.kind)).toEqual(['assistant-text', 'assistant-text', 'assistant-text']);
    expect(gapReasons(items)).toEqual([]);
  });

  it('opens a new segment behind one transport-gap after a reconnect', () => {
    const items = project([live('g1', 'before'), live('g2', 'after'), live('g2', 'later')]);
    expect(items.map((item) => item.entry.kind)).toEqual([
      'assistant-text',
      'coverage-gap',
      'assistant-text',
      'assistant-text'
    ]);
    expect(gapReasons(items)).toEqual(['transport-gap']);
    const [before, gap, after] = [items.at(0), items.at(1), items.at(2)];
    expect(before?.segment).toBe(0);
    expect(gap?.segment).toBe(1);
    expect(after?.segment).toBe(1);
    expect(after?.connectionGeneration).toBe('g2');
  });

  it('carries the reconnect across calls through the returned state', () => {
    const first = projectAcpEvents(initialAcpProjectionState(), [live('g1', 'before')], OPTIONS);
    const second = projectAcpEvents(first.state, [live('g2', 'after')], OPTIONS);
    expect(gapReasons(second.items)).toEqual(['transport-gap']);
    expect(second.items.at(0)?.streamSeq).toBe(1);
    expect(second.items.at(-1)?.segment).toBe(1);
  });

  it('labels replayed history apart from live activity and never shares a segment with it', () => {
    const items = project([
      live('g1', 'live-1'),
      history('g1', 'old-1', 'e1'),
      history('g1', 'old-2', 'e2'),
      live('g1', 'live-2')
    ]);
    const shown = items.filter((item) => item.entry.kind === 'assistant-text');
    expect(shown.map((item) => [item.entry.body.text, item.origin])).toEqual([
      ['live-1', 'live'],
      ['old-1', 'history'],
      ['old-2', 'history'],
      ['live-2', 'live']
    ]);
    const segmentOf = (text: string): number | undefined =>
      shown.find((item) => item.entry.body.text === text)?.segment;
    expect(segmentOf('old-1')).toBe(segmentOf('old-2'));
    expect(segmentOf('old-1')).not.toBe(segmentOf('live-1'));
    expect(segmentOf('live-2')).not.toBe(segmentOf('old-2'));

    const markers = items.filter((item) => item.entry.kind === 'system');
    expect(markers.map((item) => item.entry.body.systemSubtype)).toEqual(['acp-history', 'acp-live']);
    expect(markers.every((marker) => (marker.entry.body.systemSummary ?? '').length > 0)).toBe(true);
    // A switch between live and history is labelled, not reported as lost output.
    expect(gapReasons(items)).toEqual([]);
  });

  it('starts a new segment behind a gap when a history event without an id follows one with an id', () => {
    const items = project([history('g1', 'known', 'e1'), history('g1', 'unknown', null), history('g1', 'also-unknown', null)]);
    expect(items.map((item) => item.entry.kind)).toEqual([
      'system',
      'assistant-text',
      'coverage-gap',
      'assistant-text',
      'assistant-text'
    ]);
    expect(gapReasons(items)).toEqual(['transport-gap']);
    const known = items.find((item) => item.entry.body.text === 'known');
    const unknown = items.find((item) => item.entry.body.text === 'unknown');
    const alsoUnknown = items.find((item) => item.entry.body.text === 'also-unknown');
    expect(unknown?.segment).not.toBe(known?.segment);
    expect(alsoUnknown?.segment).toBe(unknown?.segment);
    expect(unknown?.origin).toBe('history');
  });

  it('assigns a host stream sequence from 0 that only rises, whatever the events carry', () => {
    const items = project([
      live('g1', 'a', '900'),
      live('g1', 'b', '3'),
      history('g1', 'c', null),
      live('g2', 'd', '1')
    ]);
    const seqs = items.map((item) => item.streamSeq);
    expect(seqs.at(0)).toBe(0);
    expect(seqs).toEqual(seqs.map((_, index) => index));
    expect(items.map((item) => item.entry.seq)).toEqual(seqs);
    expect(items.find((item) => item.entry.body.text === 'a')?.sourceEventId).toBe('900');
  });

  it('maps each event kind to the display kind that shows it', () => {
    const base = { connectionGeneration: 'g1', attemptId: 'attempt-7', sourceEventId: null, origin: 'live' } as const;
    const items = project([
      { ...base, kind: 'message', text: 'said' },
      { ...base, kind: 'tool-call', toolName: 'Read', toolArgs: { path: 'notes.md' } },
      { ...base, kind: 'tool-result', text: 'file body' },
      { ...base, kind: 'plan', text: 'step one' },
      { ...base, kind: 'status', text: 'thinking' }
    ]);
    expect(items.map((item) => item.entry.kind)).toEqual(['assistant-text', 'tool-use', 'tool-result', 'system', 'system']);
    expect(items.at(1)?.entry.body.toolName).toBe('Read');
    expect(items.at(1)?.entry.body.toolArguments).toEqual({ path: 'notes.md' });
    expect(items.at(2)?.entry.body.toolResult).toBe('file body');
    expect(items.at(3)?.entry.body).toMatchObject({ systemSubtype: 'acp-plan', systemSummary: 'step one' });
    expect(items.at(4)?.entry.body).toMatchObject({ systemSubtype: 'acp-status', systemSummary: 'thinking' });
    expect(items.every((item) => item.attemptId === 'attempt-7')).toBe(true);
  });

  it('passes every entry through the shared truncation, sanitization and entry budget', () => {
    const secret = 'sk' + '-acp0projection0secret0value0123456789';
    const long = 'x'.repeat(OPTIONS.caps.perFieldBytes * 3);
    const items = project([live('g1', `token ${secret}`), live('g1', long)]);
    expect(JSON.stringify(items)).not.toContain(secret);
    const cut = items.at(1);
    expect(Buffer.byteLength(cut?.entry.body.text ?? '', 'utf8')).toBeLessThanOrEqual(OPTIONS.caps.perFieldBytes);
    expect(cut?.entry.bodyTruncated?.text?.originalLength).toBe(long.length);
    for (const item of items) {
      expect(Buffer.byteLength(JSON.stringify(item.entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
    }
  });

  it('shows an event that is not the normalized shape as one parse-omission gap holding none of it', () => {
    const items = project([
      live('g1', 'fine'),
      { connectionGeneration: 'g1', origin: 'sideways', kind: 'message', text: 'leaked-text' },
      'not an event',
      null,
      live('g1', 'still fine')
    ]);
    expect(textsOf(items.filter((item) => item.entry.kind === 'assistant-text'))).toEqual(['fine', 'still fine']);
    expect(gapReasons(items)).toEqual(['parse-omission']);
    expect(items.find((item) => item.entry.kind === 'coverage-gap')?.entry.body.count).toBe(3);
    expect(JSON.stringify(items)).not.toContain('leaked-text');
  });

  it('reports how many gaps of each reason it produced, for the counters', () => {
    const result = projectAcpEvents(
      initialAcpProjectionState(),
      [live('g1', 'a'), live('g2', 'b'), live('g3', 'c'), 'bad'],
      OPTIONS
    );
    expect(result.gaps).toEqual({ 'transport-gap': 2, 'parse-omission': 1 });
  });

  it('does not change the state it was given', () => {
    const state = initialAcpProjectionState();
    const snapshot = JSON.stringify(state);
    projectAcpEvents(state, [live('g1', 'a'), live('g2', 'b')], OPTIONS);
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(Object.isFrozen(state)).toBe(true);
  });
});
