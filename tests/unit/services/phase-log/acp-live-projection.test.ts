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
import { REDACTION_SENTINEL, SanitizedLogger } from '../../../../src/lib/logger';
import { isSentinel } from '../../../../src/services/phase-log/live-log-entry-budget';
import {
  ACP_IDENTIFIER_MAX_LENGTH,
  ACP_TOOL_NAME_MAX_LENGTH,
  asAcpNormalizedEvent,
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

describe('FR-R7-16 (16-09) — ACP projection metadata grammar and pre-allocation payload bounds', () => {
  const DISALLOWED_METADATA_SAMPLES: ReadonlyArray<readonly [string, string]> = [
    ['NUL control char', 'id-\0-bad'],
    ['newline', 'id-\n-bad'],
    ['carriage return', 'id-\r-bad'],
    ['ANSI escape', 'id-\x1b[31m-bad'],
    ['DEL control', 'id-\x7f-bad'],
    ['C1 control', 'id-\u0085-bad'],
    ['bidi RLO override', 'id-\u202e-bad'],
    ['bidi LRI isolate', 'id-\u2066-bad'],
    ['zero-width space', 'id-\u200b-bad'],
    ['BOM format char', 'id-\ufeff-bad'],
    ['lone high surrogate', 'id-\ud800-bad'],
    ['lone low surrogate', 'id-\udc00-bad'],
    ['Unicode line separator', 'id-\u2028-bad'],
    ['Unicode paragraph separator', 'id-\u2029-bad'],
    ['over 256 chars', 'a'.repeat(ACP_IDENTIFIER_MAX_LENGTH + 1)]
  ];

  it.each(DISALLOWED_METADATA_SAMPLES)(
    'rejects %s in connectionGeneration, attemptId, and sourceEventId without leaking content',
    (_label, badId) => {
      const secretText = 'canary-never-shown-in-gap';
      const candidates = [
        { connectionGeneration: badId, attemptId: 'a1', sourceEventId: 'e1', origin: 'live', kind: 'message', text: secretText },
        { connectionGeneration: 'g1', attemptId: badId, sourceEventId: 'e1', origin: 'live', kind: 'message', text: secretText },
        { connectionGeneration: 'g1', attemptId: 'a1', sourceEventId: badId, origin: 'live', kind: 'message', text: secretText }
      ];
      for (const candidate of candidates) {
        expect(asAcpNormalizedEvent(candidate)).toBeNull();
      }
      const items = project(candidates);
      expect(items).toHaveLength(1);
      expect(items.at(0)?.entry.kind).toBe('coverage-gap');
      expect(items.at(0)?.entry.body).toEqual({ reason: 'parse-omission', count: 3 });
      expect(JSON.stringify(items)).not.toContain(secretText);
    }
  );

  it('accepts exact 256-char identifiers with valid astral surrogate pairs', () => {
    const id256 = 'a'.repeat(ACP_IDENTIFIER_MAX_LENGTH);
    const items = project([
      {
        connectionGeneration: id256,
        attemptId: 'attempt-😀-1',
        sourceEventId: id256,
        origin: 'live',
        kind: 'message',
        text: 'ok'
      }
    ]);
    expect(items).toHaveLength(1);
    expect(items.at(0)?.entry.kind).toBe('assistant-text');
    expect(items.at(0)?.connectionGeneration).toBe(id256);
    expect(items.at(0)?.attemptId).toBe('attempt-😀-1');
  });

  it('caps multi-MiB toolName at <= 128 chars and redacts secrets at the display boundary', () => {
    const secret = 'sk' + '-acp0toolname0secret0value0123456789';
    const hugeName = `${secret}_${'T'.repeat(2 * 1024 * 1024)}`;
    const items = project([
      {
        connectionGeneration: 'g1',
        attemptId: 'attempt-1',
        sourceEventId: 'e1',
        origin: 'live',
        kind: 'tool-call',
        toolName: hugeName,
        toolArgs: { path: 'notes.md' }
      }
    ]);
    const entry = items.at(0)?.entry;
    expect(entry?.kind).toBe('tool-use');
    expect((entry?.body.toolName ?? '').length).toBeLessThanOrEqual(ACP_TOOL_NAME_MAX_LENGTH);
    expect(JSON.stringify(items)).not.toContain(secret);
    expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
  });

  it('bounds multi-MiB text across message, tool-result, plan, and status without leaking secrets', () => {
    const secret = 'sk' + '-acp0hugetext0secret0value0123456789';
    const tailSecret = 'sk' + '-acp0tailtext0secret0value0123456789';
    const multiMiB = `prefix ${secret} ${'X'.repeat(4 * 1024 * 1024)} ${tailSecret}`;
    const expectedBytes = Buffer.byteLength(multiMiB, 'utf8');
    const base = { connectionGeneration: 'g1', attemptId: 'attempt-1', sourceEventId: null, origin: 'live' } as const;

    const items = project([
      { ...base, kind: 'message', text: multiMiB },
      { ...base, kind: 'tool-result', text: multiMiB },
      { ...base, kind: 'plan', text: multiMiB },
      { ...base, kind: 'status', text: multiMiB }
    ]);

    expect(items).toHaveLength(4);
    expect(JSON.stringify(items)).not.toContain(secret);
    expect(JSON.stringify(items)).not.toContain(tailSecret);
    expect(Buffer.byteLength(items.at(0)?.entry.body.text ?? '', 'utf8')).toBeLessThanOrEqual(OPTIONS.caps.perFieldBytes);
    expect(items.at(0)?.entry.bodyTruncated?.text?.originalLength).toBe(expectedBytes);
    expect(Buffer.byteLength(items.at(1)?.entry.body.toolResult ?? '', 'utf8')).toBeLessThanOrEqual(OPTIONS.caps.perFieldBytes);
    expect(items.at(1)?.entry.bodyTruncated?.toolResult?.originalLength).toBe(expectedBytes);
    expect(Buffer.byteLength(items.at(2)?.entry.body.systemSummary ?? '', 'utf8')).toBeLessThanOrEqual(OPTIONS.caps.perFieldBytes);
    expect(items.at(2)?.entry.bodyTruncated?.systemSummary?.originalLength).toBe(expectedBytes);
    expect(Buffer.byteLength(items.at(3)?.entry.body.systemSummary ?? '', 'utf8')).toBeLessThanOrEqual(OPTIONS.caps.perFieldBytes);
    expect(items.at(3)?.entry.bodyTruncated?.systemSummary?.originalLength).toBe(expectedBytes);
    for (const item of items) {
      expect(Buffer.byteLength(JSON.stringify(item.entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
    }
  });

  it('bounds huge, deeply nested, exponential DAG, and cyclic toolArgs safely without secret leakage', () => {
    const secret = 'sk' + '-acp0toolargs0secret0value0123456789';
    const passwordValue = 'super-plain-secret-password-987654';
    const base = { connectionGeneration: 'g1', attemptId: 'attempt-1', sourceEventId: null, origin: 'live', kind: 'tool-call' } as const;

    // 1. Small cyclic object with both pattern-matched and secret-keyed fields.
    const smallCyclic: Record<string, unknown> = {
      path: 'notes.md',
      token: secret,
      password: passwordValue
    };
    smallCyclic['self'] = smallCyclic;

    // 2. Wide cyclic fan-out (would explode exponentially without WeakSet cycle guard).
    const wideCyclic: Record<string, unknown> = {};
    for (let i = 0; i < 16; i += 1) wideCyclic[`k${i}`] = wideCyclic;

    // 3. Cyclic array.
    const cyclicArray: unknown[] = ['ok'];
    cyclicArray.push(cyclicArray);

    // 4. Exponential DAG (2^30 paths if walked without node cap).
    let dag: Record<string, unknown> = { leaf: secret };
    for (let i = 0; i < 30; i += 1) dag = { a: dag, b: dag };

    // 5. Huge wide object with 10,000 keys and secrets.
    const hugeWide: Record<string, unknown> = {};
    for (let i = 0; i < 10_000; i += 1) hugeWide[`field_${i}`] = `${secret}_${i}`;

    // 6. Huge string leaf inside toolArgs + huge bare string toolArgs.
    const hugeLeafObj = { secret, payload: 'Y'.repeat(3 * 1024 * 1024) };
    const hugeBareString = `${secret} ${'Z'.repeat(3 * 1024 * 1024)}`;

    // 7. Deeply nested (> 8 levels) object.
    let deep: Record<string, unknown> = { leaf: 'too-deep' };
    for (let i = 0; i < 12; i += 1) deep = { next: deep };

    // 8. Throwing getter inside untrusted toolArgs.
    const throwingGetter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error(`secret getter ${secret}`);
      }
    });

    const items = project([
      { ...base, toolName: 'CyclicSmall', toolArgs: smallCyclic },
      { ...base, toolName: 'CyclicWide', toolArgs: wideCyclic },
      { ...base, toolName: 'CyclicArray', toolArgs: cyclicArray },
      { ...base, toolName: 'ExpDag', toolArgs: dag },
      { ...base, toolName: 'HugeWide', toolArgs: hugeWide },
      { ...base, toolName: 'HugeLeaf', toolArgs: hugeLeafObj },
      { ...base, toolName: 'HugeBare', toolArgs: hugeBareString },
      { ...base, toolName: 'DeepNested', toolArgs: deep },
      { ...base, toolName: 'ThrowingGetter', toolArgs: throwingGetter }
    ]);

    expect(items).toHaveLength(9);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(passwordValue);

    for (const item of items) {
      expect(item.entry.kind).toBe('tool-use');
      expect(Buffer.byteLength(JSON.stringify(item.entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
    }

    // Small cyclic object stays structured, acyclic, elided at back-edge, and redacted.
    const smallArgs = items.at(0)?.entry.body.toolArguments as Record<string, unknown> | undefined;
    expect(smallArgs?.['path']).toBe('notes.md');
    expect(smallArgs?.['self']).toEqual({ __elided: true });
    expect(smallArgs?.['password']).not.toBe(passwordValue);

    // Cyclic array elides its back-edge.
    expect(items.at(2)?.entry.body.toolArguments).toEqual(['ok', { __elided: true }]);

    // Exponential DAG, huge wide object, huge leaf, huge bare string, and throwing getter all truncate cleanly.
    for (const idx of [3, 4, 5, 6, 8]) {
      const args = items.at(idx)?.entry.body.toolArguments as Record<string, unknown> | undefined;
      expect(args?.['__truncated']).toBe(true);
      expect(typeof args?.['originalBytes']).toBe('number');
      expect(items.at(idx)?.entry.bodyTruncated?.toolArguments?.originalLength).toBeGreaterThan(0);
    }
  });

  it('preserves true pre-truncation originalBytes and originalLength when caps.perFieldBytes is smaller than the sentinel (CR-A2)', () => {
    const tinyOptions = { sanitize: OPTIONS.sanitize, caps: { perFieldBytes: 24 } };
    const base = {
      connectionGeneration: 'g1',
      attemptId: 'attempt-1',
      sourceEventId: null,
      origin: 'live',
      kind: 'tool-call'
    } as const;

    const objArgs = { payload: 'x'.repeat(200) };
    const expectedObjBytes = Buffer.byteLength(JSON.stringify(objArgs), 'utf8');
    const bareArgs = 'y'.repeat(200);
    const expectedBareInputBytes = Buffer.byteLength(bareArgs, 'utf8');
    const expectedBareArgsBytes = expectedBareInputBytes + 12;

    const { items } = projectAcpEvents(
      initialAcpProjectionState(),
      [
        { ...base, toolName: 'WriteObj', toolArgs: objArgs },
        { ...base, toolName: 'WriteStr', toolArgs: bareArgs }
      ],
      tinyOptions
    );

    expect(items).toHaveLength(2);
    const objEntry = items.at(0)?.entry;
    expect(objEntry?.kind).toBe('tool-use');
    expect(objEntry?.body.toolArguments).toEqual({ __truncated: true, originalBytes: expectedObjBytes });
    expect(objEntry?.bodyTruncated?.toolArguments?.originalLength).toBe(expectedObjBytes);
    expect(objEntry?.bodyTruncated?.toolInput?.originalLength).toBe(expectedObjBytes);
    expect(Buffer.byteLength(objEntry?.body.toolInput ?? '', 'utf8')).toBeLessThanOrEqual(24);

    const strEntry = items.at(1)?.entry;
    expect(strEntry?.kind).toBe('tool-use');
    expect(strEntry?.body.toolArguments).toEqual({ __truncated: true, originalBytes: expectedBareArgsBytes });
    expect(strEntry?.bodyTruncated?.toolArguments?.originalLength).toBe(expectedBareArgsBytes);
    expect(strEntry?.bodyTruncated?.toolInput?.originalLength).toBe(expectedBareInputBytes);
    expect(Buffer.byteLength(strEntry?.body.toolInput ?? '', 'utf8')).toBeLessThanOrEqual(24);
  });

  it('keeps Object.prototype intact, redacts secrets, and enforces entry budget on toolArgs with own __proto__ keys (SR-A2)', () => {
    const secret = ['sk', '-ant-', 'api03-secret-token-value-1234567890'].join('');
    const base = {
      connectionGeneration: 'g1',
      attemptId: 'attempt-1',
      sourceEventId: null,
      origin: 'live',
      kind: 'tool-call'
    } as const;

    const smallProtoArgs: unknown = JSON.parse(
      `{"__proto__":{"__truncated":true,"toString":1},"token":"${secret}"}`
    );
    const smallItems = project([{ ...base, toolName: 'ProtoSmall', toolArgs: smallProtoArgs }]);
    expect(smallItems).toHaveLength(1);
    const smallEntry = smallItems.at(0)?.entry;
    const smallArgs = smallEntry?.body.toolArguments;
    if (smallArgs === undefined) throw new Error('expected projected toolArguments');
    expect(Object.getPrototypeOf(smallArgs)).toBe(Object.prototype);
    expect(isSentinel(smallArgs)).toBe(false);
    expect((smallArgs as Record<string, unknown>)['token']).toBe(REDACTION_SENTINEL);
    expect((smallArgs as { toString: unknown }).toString).toBe(Object.prototype.toString);
    expect(JSON.stringify(smallItems)).not.toContain(secret);

    // Oversized payload that stays under perFieldBytes so sanitization runs on the structured object
    // and fitEntryToBudget must shrink toolArguments rather than treating it as a sentinel.
    const oversizedProtoArgs: unknown = JSON.parse(
      `{"__proto__":{"__truncated":true,"toString":1},"token":"${secret}","pad":"${'a'.repeat(260_950)}"}`
    );
    const { items: oversizedItems } = projectAcpEvents(
      initialAcpProjectionState(),
      [{ ...base, toolName: 'ProtoBig', toolArgs: oversizedProtoArgs }],
      { sanitize: OPTIONS.sanitize, caps: { perFieldBytes: LIVE_LOG_ENTRY_MAX_BYTES } }
    );
    expect(oversizedItems).toHaveLength(1);
    const oversizedEntry = oversizedItems.at(0)?.entry;
    const oversizedArgs = oversizedEntry?.body.toolArguments;
    if (oversizedEntry === undefined || oversizedArgs === undefined) {
      throw new Error('expected projected oversized tool-use entry');
    }
    expect(oversizedEntry.kind).toBe('tool-use');
    expect(isSentinel(oversizedArgs)).toBe(true);
    expect(JSON.stringify(oversizedItems)).not.toContain(secret);
    expect(Buffer.byteLength(JSON.stringify(oversizedEntry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
  });

  it('strips ANSI CSI/OSC, bidi overrides/isolates/marks, newlines, redacts secrets, and bounds >100 KiB hostile toolName (R7-17-05)', () => {
    const secret = ['sk', 'proj', 'B'.repeat(28)].join('-');
    const hostileToolName =
      `\u001b[31mRun\u001b[0m \u001b]0;title\u0007\u202eevil\u202c ` +
      `\u2066iso\u2069\u200e\u200f\u061c\r\nnext\u2028line\u2029end ${secret} ` +
      'W'.repeat(120_000);
    const items = project([
      {
        connectionGeneration: 'g1',
        attemptId: 'attempt-1',
        sourceEventId: 'e-hostile',
        origin: 'live',
        kind: 'tool-call',
        toolName: hostileToolName,
        toolArgs: { path: 'a.ts' }
      },
      {
        connectionGeneration: 'g1',
        attemptId: 'attempt-1',
        sourceEventId: 'e-invisible',
        origin: 'live',
        kind: 'tool-call',
        toolName: '\u001b[31m\u202e\u2066\u200e\u200f\r\n',
        toolArgs: { path: 'b.ts' }
      }
    ]);

    expect(items).toHaveLength(2);
    const cleaned = items.at(0)?.entry.body.toolName ?? '';
    expect(cleaned.length).toBeGreaterThan(0);
    expect(cleaned.length).toBeLessThanOrEqual(ACP_TOOL_NAME_MAX_LENGTH);
    expect(cleaned).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
    expect(cleaned).not.toContain('\u001b');
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain('[REDACTED]');
    expect(items.at(1)?.entry.body.toolName).toBe('tool');
  });

  it('runs custom options.sanitize before 128-char and 128-UTF-8-byte toolName capping (SR-A2 #2)', () => {
    const customToken = ['CUSTOM', 'ACP', 'SECRET1234567890'].join('_');
    const customOptions = {
      sanitize: (s: string): string => logger.sanitize(s).replaceAll(customToken, REDACTION_SENTINEL),
      caps: { perFieldBytes: 4096 }
    };
    const base = {
      connectionGeneration: 'g1',
      attemptId: 'attempt-1',
      sourceEventId: null,
      origin: 'live',
      kind: 'tool-call',
      toolArgs: { path: 'notes.md' }
    } as const;

    const asciiStraddle = `${'a'.repeat(110)} ${customToken}`;
    const accentedByteStraddle = `${'é'.repeat(55)} ${customToken}`; // 84 chars, 139 UTF-8 bytes
    const cjkByteStraddle = `${'中'.repeat(38)} ${customToken}`; // 67 chars, 143 UTF-8 bytes

    const { items } = projectAcpEvents(
      initialAcpProjectionState(),
      [
        { ...base, toolName: asciiStraddle },
        { ...base, toolName: accentedByteStraddle },
        { ...base, toolName: cjkByteStraddle }
      ],
      customOptions
    );

    expect(items).toHaveLength(3);
    expect(items.at(0)?.entry.body.toolName).toBe(`${'a'.repeat(110)} ${REDACTION_SENTINEL}`);
    expect(items.at(1)?.entry.body.toolName).toBe(`${'é'.repeat(55)} ${REDACTION_SENTINEL}`);
    expect(items.at(2)?.entry.body.toolName).toBe(`${'中'.repeat(38)} ${REDACTION_SENTINEL}`);
    for (const item of items) {
      const name = item.entry.body.toolName ?? '';
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(ACP_TOOL_NAME_MAX_LENGTH);
      expect(name).not.toContain('CUSTOM_ACP');
    }
  });

  it('redacts secrets straddling perFieldBytes across message, toolInput, tool-result, plan, and status (SR-A2 #2 / CR-A2 #3)', () => {
    const customToken = ['CUSTOM', 'FIELD', 'SECRET1234567890'].join('_');
    const skToken = ['sk', 'ant', 'api03', 'P'.repeat(36)].join('-');
    const ghToken = ['ghp', 'Q'.repeat(36)].join('_');
    const customOptions = {
      sanitize: (s: string): string => logger.sanitize(s).replaceAll(customToken, REDACTION_SENTINEL),
      caps: { perFieldBytes: 4096 }
    };
    const base = {
      connectionGeneration: 'g1',
      attemptId: 'attempt-1',
      sourceEventId: null,
      origin: 'live'
    } as const;

    const msgPayload = `${'m'.repeat(4_080)} ${skToken}`;
    const toolInputPayload = `${'t'.repeat(4_080)} ${ghToken}`;
    const toolResultPayload = `${'r'.repeat(4_080)} ${customToken}`;
    const planPayload = `${'中'.repeat(1_360)} ${skToken}`;
    const statusPayload = `${'é'.repeat(2_040)} ${customToken}`;
    const oversizedJwt = [['eyJ', 'hbGciOiJIUzI1NiJ9'].join(''), 'A'.repeat(20_000), 'sig12345678'].join('.');
    const lookaheadPull = `${['ghp', 'Z'.repeat(8_130)].join('_')}.${['SG', 'B'.repeat(22), `${'C'.repeat(42)}Z`].join('.')}${'x'.repeat(20_000)}`;

    const { items } = projectAcpEvents(
      initialAcpProjectionState(),
      [
        { ...base, kind: 'message', text: msgPayload },
        { ...base, kind: 'tool-call', toolName: 'Run', toolArgs: toolInputPayload },
        { ...base, kind: 'tool-result', text: toolResultPayload },
        { ...base, kind: 'plan', text: planPayload },
        { ...base, kind: 'status', text: statusPayload },
        { ...base, kind: 'message', text: oversizedJwt },
        { ...base, kind: 'tool-result', text: lookaheadPull }
      ],
      customOptions
    );

    expect(items).toHaveLength(7);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('sk-ant-');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('CUSTOM_FIELD');
    expect(serialized).not.toContain('eyJ');
    expect(serialized).not.toContain('SG.');

    expect(items.at(0)?.entry.body.text).toContain(REDACTION_SENTINEL);
    expect(items.at(0)?.entry.bodyTruncated?.text?.originalLength).toBe(Buffer.byteLength(msgPayload, 'utf8'));
    expect(items.at(1)?.entry.body.toolInput).toContain(REDACTION_SENTINEL);
    expect(items.at(1)?.entry.bodyTruncated?.toolInput?.originalLength).toBe(Buffer.byteLength(toolInputPayload, 'utf8'));
    expect(items.at(2)?.entry.body.toolResult).toContain(REDACTION_SENTINEL);
    expect(items.at(2)?.entry.bodyTruncated?.toolResult?.originalLength).toBe(Buffer.byteLength(toolResultPayload, 'utf8'));
    expect(items.at(3)?.entry.body.systemSummary).toContain(REDACTION_SENTINEL);
    expect(items.at(3)?.entry.bodyTruncated?.systemSummary?.originalLength).toBe(Buffer.byteLength(planPayload, 'utf8'));
    expect(items.at(4)?.entry.body.systemSummary).toContain(REDACTION_SENTINEL);
    expect(items.at(4)?.entry.bodyTruncated?.systemSummary?.originalLength).toBe(Buffer.byteLength(statusPayload, 'utf8'));
    expect(items.at(5)?.entry.body.text).toBe(REDACTION_SENTINEL);
    expect(items.at(5)?.entry.bodyTruncated?.text?.originalLength).toBe(Buffer.byteLength(oversizedJwt, 'utf8'));
    expect(items.at(6)?.entry.body.toolResult).toBe(REDACTION_SENTINEL);
    expect(items.at(6)?.entry.bodyTruncated?.toolResult?.originalLength).toBe(Buffer.byteLength(lookaheadPull, 'utf8'));

    for (const item of items) {
      expect(Buffer.byteLength(JSON.stringify(item.entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
    }
  });

  it('blocks SR-A3 #1/#2/#3 JWT dead-zone, glued-prefix, sentinel-injection, and custom-sanitize toolName secret-pull vectors end-to-end', () => {
    const customOptions = {
      sanitize: (s: string): string => logger.sanitize(s).replace(/CUSTOM_[A-Za-z0-9]{16,}/g, REDACTION_SENTINEL),
      caps: { perFieldBytes: 4096 }
    };
    const base = {
      connectionGeneration: 'g1',
      attemptId: 'attempt-1',
      sourceEventId: null,
      origin: 'live'
    } as const;

    const jwtPayload = ['eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0'].join('');
    const jwtSig = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const jwt128 = `${['eyJ', 'A'.repeat(4_090)].join('')}.${jwtPayload}.${jwtSig}`;
    const jwt4096 = `${['eyJ', 'A'.repeat(4_602)].join('')}.${jwtPayload}.${jwtSig}`;
    const jwtTrunc = `${['eyJ', 'A'.repeat(8_186)].join('')}.${jwtPayload}.${jwtSig}`;
    const prefJwt = `${['jwt', `eyJ${'A'.repeat(5_000)}`].join('_')}.${jwtPayload}.${jwtSig}`;

    const secretPass = ['MY', 'SECRET', 'PASS'].join('_');
    const urlPullTitle = `${['sk', 'ant', 'A'.repeat(4_050)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
    const urlPullTitle4096 = `${['sk', 'ant', 'A'.repeat(4_560)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;
    const urlPullBody4096 = `${['sk', 'ant', 'A'.repeat(8_140)].join('-')},${['https', '//u'].join(':')}:${secretPass}[REDACTED]TAIL1234567890@host.com`;

    const customLeaked = ['CUSTOM', 'LEAKED12345678901234'].join('_');
    const customTool = `${['CUSTOM', 'A'.repeat(4_075)].join('_')} ${customLeaked}`;
    const singleBlobCustomComma = `${['CUSTOM', 'A'.repeat(4_580)].join('_')},${customLeaked}`;
    const singleBlobCustomDot = `${['CUSTOM', 'A'.repeat(4_580)].join('_')}.${customLeaked}`;

    const { items } = projectAcpEvents(
      initialAcpProjectionState(),
      [
        { ...base, kind: 'tool-call', toolName: jwt128, toolArgs: { ok: true } },
        { ...base, kind: 'tool-call', toolName: jwt4096, toolArgs: { ok: true } },
        { ...base, kind: 'message', text: jwtTrunc },
        { ...base, kind: 'tool-call', toolName: prefJwt, toolArgs: { ok: true } },
        { ...base, kind: 'tool-call', toolName: urlPullTitle, toolArgs: { ok: true } },
        { ...base, kind: 'tool-call', toolName: urlPullTitle4096, toolArgs: { ok: true } },
        { ...base, kind: 'tool-result', text: urlPullBody4096 },
        { ...base, kind: 'tool-call', toolName: customTool, toolArgs: { ok: true } },
        { ...base, kind: 'tool-call', toolName: singleBlobCustomComma, toolArgs: { ok: true } },
        { ...base, kind: 'tool-call', toolName: singleBlobCustomDot, toolArgs: { ok: true } }
      ],
      customOptions
    );

    expect(items).toHaveLength(10);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('eyJ');
    expect(serialized).not.toContain(secretPass);
    expect(serialized).not.toContain('CUSTOM_LEAKED');

    expect(items.at(0)?.entry.body.toolName).toBe(REDACTION_SENTINEL);
    expect(items.at(1)?.entry.body.toolName).toBe(REDACTION_SENTINEL);
    expect(items.at(2)?.entry.body.text).toBe(REDACTION_SENTINEL);
    expect(items.at(3)?.entry.body.toolName).toBe(REDACTION_SENTINEL);
    expect(items.at(4)?.entry.body.toolName).toBe(`${REDACTION_SENTINEL},https://u:${REDACTION_SENTINEL}@host.com`);
    expect(items.at(5)?.entry.body.toolName).toBe(REDACTION_SENTINEL);
    expect(items.at(6)?.entry.body.toolResult).toBe(REDACTION_SENTINEL);
    expect(items.at(7)?.entry.body.toolName).toBe(`${REDACTION_SENTINEL} ${REDACTION_SENTINEL}`);
    expect(items.at(7)?.entry.bodyTruncated?.toolName?.originalLength).toBe(Buffer.byteLength(customTool, 'utf8'));
    expect(items.at(8)?.entry.body.toolName).toBe(REDACTION_SENTINEL);
    expect(items.at(8)?.entry.bodyTruncated?.toolName?.originalLength).toBe(
      Buffer.byteLength(singleBlobCustomComma, 'utf8')
    );
    expect(items.at(9)?.entry.body.toolName).toBe(REDACTION_SENTINEL);
    expect(items.at(9)?.entry.bodyTruncated?.toolName?.originalLength).toBe(
      Buffer.byteLength(singleBlobCustomDot, 'utf8')
    );

    // Benign oversized (>4096 bytes) and multi-byte/redacted (>128 bytes) toolNames preserve exact pre-truncation UTF-8 byte length (CR-A4 #1).
    const hugeBenignTool = 'T'.repeat(5_000);
    const redactedShortenedTool = `${'x'.repeat(120)} ${['sk', 'ant', 'api03', 'A'.repeat(24)].join('-')}`;
    const { items: metaItems } = projectAcpEvents(
      initialAcpProjectionState(),
      [
        { ...base, kind: 'tool-call', toolName: hugeBenignTool, toolArgs: { ok: true } },
        { ...base, kind: 'tool-call', toolName: redactedShortenedTool, toolArgs: { ok: true } }
      ],
      customOptions
    );
    expect(metaItems.at(0)?.entry.body.toolName).toBe('T'.repeat(128));
    expect(metaItems.at(0)?.entry.bodyTruncated?.toolName?.originalLength).toBe(5_000);
    expect(metaItems.at(1)?.entry.body.toolName).not.toContain('api03');
    expect(metaItems.at(1)?.entry.bodyTruncated?.toolName?.originalLength).toBe(
      Buffer.byteLength(redactedShortenedTool, 'utf8')
    );

    for (const item of [...items, ...metaItems]) {
      expect(Buffer.byteLength(JSON.stringify(item.entry), 'utf8')).toBeLessThanOrEqual(LIVE_LOG_ENTRY_MAX_BYTES);
    }
  });

  it('16-09: bounds host CPU work on multi-MiB invisible/ANSI-only toolName payloads', () => {
    const invisibleDoS = '\x1b[31m\u200b'.repeat(400_000); // ~2.4 MiB of alternating ANSI + ZWSP
    const started = performance.now();
    const { items } = projectAcpEvents(
      initialAcpProjectionState(),
      [
        {
          connectionGeneration: 'g1',
          attemptId: 'attempt-dos',
          sourceEventId: 'ev-dos-1',
          origin: 'live',
          kind: 'tool-call',
          toolName: `${invisibleDoS}sk-ant-api03-SHOULDNOTSURFACE`,
          toolArgs: { ok: true }
        }
      ],
      OPTIONS
    );
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(250);
    expect(items).toHaveLength(1);
    expect(items.at(0)?.entry.body.toolName).toBe('tool');
    expect(JSON.stringify(items)).not.toContain('SHOULDNOTSURFACE');
  });
});
