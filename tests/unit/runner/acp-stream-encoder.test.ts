import { describe, expect, it } from 'vitest';
import {
  AcpStreamEncoder,
  MAX_COALESCED_ACP_TEXT_BYTES
} from '../../../src/runner/acp-stream-encoder';
import type { AcpNormalizedEvent } from '../../../src/services/phase-log/acp-live-projection';
import { StreamLineProjector } from '../../../src/services/phase-log/phase-log-display-projector';
import { unwrapStreamJson } from '../../../src/parser/stream-json-unwrapper';

function makeEvent(
  partial: Omit<AcpNormalizedEvent, 'connectionGeneration' | 'attemptId' | 'origin'> & {
    readonly origin?: AcpNormalizedEvent['origin'];
  }
): AcpNormalizedEvent {
  return {
    connectionGeneration: '1',
    attemptId: 'attempt-1',
    origin: partial.origin ?? 'live',
    kind: partial.kind,
    sourceEventId: partial.sourceEventId,
    ...(partial.text !== undefined ? { text: partial.text } : {}),
    ...(partial.toolName !== undefined ? { toolName: partial.toolName } : {}),
    ...('toolArgs' in partial ? { toolArgs: partial.toolArgs } : {})
  };
}

function projectLines(lines: readonly string[]) {
  const projector = new StreamLineProjector();
  const entries = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    entries.push(...projector.project(JSON.parse(trimmed)));
  }
  return entries;
}

describe('Feature 020 BUG-004 (T087, FR-012b) — AcpStreamEncoder', () => {
  it('coalesces contiguous message deltas across mid-word splits, flushes on paragraph breaks, and flushes remainder at turn end', () => {
    const encoder = new AcpStreamEncoder();
    const out: string[] = [];

    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'message',
          sourceEventId: null,
          text: 'Awaiting completion of the independent code review'
        })
      )
    );
    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'message',
          sourceEventId: null,
          text: ' subagent and `security:secrets` scan.'
        })
      )
    );
    expect(out).toEqual([]);

    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'message',
          sourceEventId: null,
          text: '\n\n`build:host`, `docs:check`, and `security:'
        })
      )
    );
    // First paragraph flushed at `\n\n`; trailing partial paragraph held until flush.
    expect(out).toHaveLength(1);

    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'message',
          sourceEventId: null,
          text: 'secrets` passed.\n[SCHEGENT_STATUS:'
        })
      )
    );
    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'message',
          sourceEventId: null,
          text: ' CLEAR]\n'
        })
      )
    );
    out.push(...encoder.flush());

    expect(out).toHaveLength(2);
    const entries = projectLines(out);
    expect(entries).toEqual([
      {
        seq: 0,
        kind: 'assistant-text',
        ts: null,
        body: {
          text: 'Awaiting completion of the independent code review subagent and `security:secrets` scan.\n\n'
        },
        bodyTruncated: null
      },
      {
        seq: 0,
        kind: 'assistant-text',
        ts: null,
        body: {
          text: '`build:host`, `docs:check`, and `security:secrets` passed.\n[SCHEGENT_STATUS: CLEAR]\n'
        },
        bodyTruncated: null
      }
    ]);

    const unwrapped = unwrapStreamJson(out.join(''));
    expect(unwrapped.textSource).toBe('model');
    expect(unwrapped.text).toBe(
      'Awaiting completion of the independent code review subagent and `security:secrets` scan.\n\n' +
        '`build:host`, `docs:check`, and `security:secrets` passed.\n[SCHEGENT_STATUS: CLEAR]\n'
    );
  });

  it('flushes buffered status/message chunks on event-kind transitions and encodes tool-call, tool-result, plan, and status', () => {
    const encoder = new AcpStreamEncoder();
    const out: string[] = [];

    out.push(...encoder.push(makeEvent({ kind: 'status', sourceEventId: null, text: 'Inspecting ' })));
    out.push(...encoder.push(makeEvent({ kind: 'status', sourceEventId: null, text: 'runner wiring...' })));
    expect(out).toEqual([]);

    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'plan',
          sourceEventId: null,
          text: '[in_progress] Read runner\n[pending] Patch tee'
        })
      )
    );
    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'tool-call',
          sourceEventId: 'call-42',
          toolName: 'read_file',
          toolArgs: { path: 'src/runner/acp-backed-runner.ts' }
        })
      )
    );
    out.push(
      ...encoder.push(
        makeEvent({
          kind: 'tool-result',
          sourceEventId: 'call-42',
          text: 'read 695 lines'
        })
      )
    );
    out.push(...encoder.push(makeEvent({ kind: 'message', sourceEventId: null, text: 'Done.' })));
    out.push(...encoder.flush());

    const entries = projectLines(out);
    expect(entries.map((entry) => ({ kind: entry.kind, body: entry.body }))).toEqual([
      {
        kind: 'system',
        body: { systemSubtype: 'acp-status', systemSummary: 'Inspecting runner wiring...' }
      },
      {
        kind: 'system',
        body: {
          systemSubtype: 'acp-plan',
          systemSummary: '[in_progress] Read runner\n[pending] Patch tee'
        }
      },
      {
        kind: 'tool-use',
        body: {
          toolName: 'read_file',
          toolInput: '{"path":"src/runner/acp-backed-runner.ts"}',
          toolArguments: { path: 'src/runner/acp-backed-runner.ts' }
        }
      },
      {
        kind: 'tool-result',
        body: { toolResult: 'read 695 lines', isError: false }
      },
      {
        kind: 'assistant-text',
        body: { text: 'Done.' }
      }
    ]);

    // Tool, plan, and status lines must never pollute model text unwrapped for completion parsing.
    const unwrapped = unwrapStreamJson(out.join(''));
    expect(unwrapped.textSource).toBe('model');
    expect(unwrapped.text).toBe('Done.');
  });

  it('bounds buffered text at MAX_COALESCED_ACP_TEXT_BYTES and ignores non-live history events', () => {
    const encoder = new AcpStreamEncoder();
    expect(MAX_COALESCED_ACP_TEXT_BYTES).toBe(65_536);

    // History events are never emitted by the live stream encoder.
    expect(
      encoder.push(
        makeEvent({
          origin: 'history',
          kind: 'message',
          sourceEventId: null,
          text: 'replayed history must stay out of live stdout'
        })
      )
    ).toEqual([]);

    const chunkA = 'x'.repeat(40_000);
    const chunkB = 'y'.repeat(30_000);
    const first = encoder.push(makeEvent({ kind: 'message', sourceEventId: null, text: chunkA }));
    expect(first).toEqual([]);

    const second = encoder.push(makeEvent({ kind: 'message', sourceEventId: null, text: chunkB }));
    expect(second).toHaveLength(1);
    const rest = encoder.flush();
    expect(rest).toHaveLength(1);

    const unwrapped = unwrapStreamJson([...second, ...rest].join(''));
    expect(unwrapped.text).toBe(chunkA + chunkB);
  });
});

