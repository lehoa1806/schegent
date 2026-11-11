// FR-R6-F13 T034 (NFR-003, SC-005, F13-AC-05) -- adapter-only normalization of one bounded
// message.
//
// One sample is one framed `session/update` line taken through the whole adapter path: frame
// decoding, JSON-RPC classification, the session-update mapper, the F07 event, the observation
// and the F02 envelope. The reference set is one update of each kind the synthetic agent streams,
// plus one 64 KiB message chunk; the samples cycle through it. 20 warm-up and 200 measured
// samples, the F03 floor. Lives in the perf tier, not beside the acceptance test, per FR-R3-042.

import { describe, expect, it } from 'vitest';

import type { AcpObservation, AgentProfile } from '../../src/contracts/acp-runtime';
import { FrameDecoder } from '../../src/services/acp-runtime/frame-decoder';
import { classifyMessage } from '../../src/services/acp-runtime/json-rpc-message';
import { mapSessionUpdate, toNormalizedEvent } from '../../src/services/acp-runtime/session-update-mapper';
import { toSharedAcpEnvelope } from '../../src/services/acp-runtime/shared-envelope';

const WARMUP_SAMPLES = 20;
const MEASURED_SAMPLES = 200;
const P95_BUDGET_MS = 5;
const P50_RANK = 0.5;
const P95_RANK = 0.95;
const LARGE_CHUNK_BYTES = 64 * 1024;
const AT = '2026-11-11T00:00:00.000Z';

const PROFILE: AgentProfile = {
  profileId: 'fixture-agent',
  revision: 3,
  kind: 'native',
  executableRef: 'fake-acp-agent-bin',
  attribution: { provider: 'fixture-provider', backend: 'fixture-backend', model: 'fixture-model' },
  requiredCapabilities: [],
  qualification: 'fixture'
};

const REFERENCE_UPDATES: readonly unknown[] = [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture reply' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'fixture thought' } },
  {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Read fixture',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'fixture.txt' }
  },
  {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'fixture contents' } }]
  },
  { sessionUpdate: 'plan', entries: [{ content: 'step one', priority: 'high', status: 'completed' }] },
  { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(LARGE_CHUNK_BYTES) } }
];

const FRAMES: readonly Uint8Array[] = REFERENCE_UPDATES.map((update) =>
  new TextEncoder().encode(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update } })}\n`
  )
);

function percentile(samples: readonly number[], rank: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1);
  return sorted.at(index) ?? Number.POSITIVE_INFINITY;
}

/** The adapter path for one frame; returns how many envelopes it produced. */
function normalize(decoder: FrameDecoder, frame: Uint8Array, seq: number): number {
  const decoded = decoder.push(frame);
  if (!decoded.ok) throw new Error(decoded.reason);
  let envelopes = 0;
  for (const value of decoded.messages) {
    const message = classifyMessage(value);
    if (message.kind !== 'notification') continue;
    const params: unknown = message.params;
    const update: unknown = typeof params === 'object' && params !== null ? Reflect.get(params, 'update') : undefined;
    const mapped = mapSessionUpdate(update);
    if (mapped.kind !== 'display') continue;
    const observation: AcpObservation = {
      generation: 7,
      hostReceiveSeq: seq,
      observedAtUtc: AT,
      acpSessionId: 'sess-1',
      origin: 'live',
      turnId: 'turn-7-1',
      attemptId: 'attempt-1',
      binding: null,
      kind: 'display',
      event: toNormalizedEvent(mapped.part, { generation: 7, attemptId: 'attempt-1', origin: 'live' })
    };
    if (toSharedAcpEnvelope(observation, PROFILE).messageKind === 'session-update') envelopes += 1;
  }
  return envelopes;
}

describe('FR-R6-F13 ACP normalization latency (NFR-003)', () => {
  it('maps one bounded message in at most 5 ms at p95', () => {
    const decoder = new FrameDecoder();
    const frameAt = (index: number) => FRAMES.at(index % FRAMES.length) ?? new Uint8Array();
    for (let index = 0; index < WARMUP_SAMPLES; index += 1) normalize(decoder, frameAt(index), index);

    const samples: number[] = [];
    let envelopes = 0;
    for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
      const frame = frameAt(index);
      const started = performance.now();
      envelopes += normalize(decoder, frame, WARMUP_SAMPLES + index);
      samples.push(performance.now() - started);
    }

    const p50 = percentile(samples, P50_RANK);
    const p95 = percentile(samples, P95_RANK);
    console.info(JSON.stringify({ samples: samples.length, p50Ms: p50, p95Ms: p95 }));
    expect(samples).toHaveLength(MEASURED_SAMPLES);
    expect(envelopes).toBeGreaterThan(0);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
