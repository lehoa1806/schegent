// The `preflightProcessYaml` correlated-request contract, and specifically its
// ack budget.
//
// The other helpers in this family (`savePhases`, `saveQueueSettings`, …) time
// out at 5 s, which is right for them: they post to handlers that compute an
// answer and ack. Preflight does not. Its handler
// (`src/ui/sidebar/commands/cmd-preflight-process-yaml.ts`) awaits
// `openProcessYamlDocument()` — a native `showOpenDialog` — before it can ack
// anything, so the budget spans an operator browsing a file picker. A 5 s
// budget therefore reported "The host did not respond." on a perfectly healthy
// host whenever picking a file took longer than five seconds, and the real ack
// arriving afterwards was dropped by the already-unsubscribed listener.
//
// The two timing tests below pin the fixed shape rather than the constant:
// still pending well past any latency budget, and still gives up eventually so
// a genuinely dead host cannot leave the promise unsettled forever.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_PREFLIGHT_PROCESS_YAML } from '../messages';
import type { ImportPlan, PreflightProcessYamlResult } from '../messages';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];

let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingSet.add(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

vi.mock('../vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

const { preflightProcessYaml } = await import('../process-yaml-ipc');

function fireAck(id: string, status: 'accepted' | 'rejected', result?: unknown): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, result });
}

const EMPTY_PLAN: ImportPlan = {
  rows: [],
  counts: { import: 0, skip: 0, blocked: 0, invalid: 0 },
  computedAgainstRevision: { user: 'user-rev', workspace: 'workspace-rev' }
};

const PLANNED: PreflightProcessYamlResult = { outcome: 'planned', plan: EMPTY_PLAN };

/**
 * Longer than any plausible file-picking session, so a timer that survives it
 * is a liveness backstop rather than a latency budget. Deliberately not the
 * module's constant: the test pins the shape, not the number.
 */
const BEYOND_ANY_HUMAN_DIALOG_MS = 30 * 60 * 1000;

/** Comfortably past the 5 s the rest of this family uses, and nowhere near the above. */
const PAST_A_LATENCY_BUDGET_MS = 60 * 1000;

/** Resolves to the settled value, or `null` while the promise is still pending. */
function track(promise: Promise<PreflightProcessYamlResult>): {
  settled: () => PreflightProcessYamlResult | null;
  promise: Promise<PreflightProcessYamlResult>;
} {
  let value: PreflightProcessYamlResult | null = null;
  const tracked = promise.then((result) => {
    value = result;
    return result;
  });
  return { settled: () => value, promise: tracked };
}

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  posted.length = 0;
  nextId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('preflightProcessYaml', () => {
  it('posts a single CMD_PREFLIGHT_PROCESS_YAML envelope with an empty payload', async () => {
    const promise = preflightProcessYaml();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.type).toBe(CMD_PREFLIGHT_PROCESS_YAML);
    // No location, no bytes, no resource kind — the document declares its own.
    expect(posted[0]!.payload).toEqual({});
    expect(pendingSet.has(posted[0]!.correlationId)).toBe(true);

    fireAck(posted[0]!.correlationId, 'accepted', PLANNED);
    await expect(promise).resolves.toEqual(PLANNED);
  });

  it('resolves the wire result verbatim', async () => {
    const promise = preflightProcessYaml();
    const refused: PreflightProcessYamlResult = {
      outcome: 'refused',
      refusal: { code: 'unsupported-kind', message: 'Unsupported kind' }
    };

    fireAck(posted[0]!.correlationId, 'rejected', refused);
    await expect(promise).resolves.toEqual(refused);
  });

  it('reports a failure when the ack carries no recognizable outcome', async () => {
    const promise = preflightProcessYaml();

    fireAck(posted[0]!.correlationId, 'accepted', { outcome: 'something-else' });
    await expect(promise).resolves.toEqual({
      outcome: 'failed',
      message: 'The host did not report a usable result.'
    });
  });

  it('stays pending while the host is showing its open dialog', async () => {
    const { settled, promise } = track(preflightProcessYaml());

    await vi.advanceTimersByTimeAsync(PAST_A_LATENCY_BUDGET_MS);
    expect(settled()).toBeNull();

    // The operator picked a file a minute in; the plan still reaches the caller.
    fireAck(posted[0]!.correlationId, 'accepted', PLANNED);
    await expect(promise).resolves.toEqual(PLANNED);
  });

  it('gives up eventually, so a dead host cannot leave the promise unsettled', async () => {
    const promise = preflightProcessYaml();

    await vi.advanceTimersByTimeAsync(BEYOND_ANY_HUMAN_DIALOG_MS);
    await expect(promise).resolves.toEqual({
      outcome: 'failed',
      message: 'The host did not respond.'
    });
  });

  it('ignores an ack that arrives after the timeout fired', async () => {
    const promise = preflightProcessYaml();
    const { correlationId } = posted[0]!;

    await vi.advanceTimersByTimeAsync(BEYOND_ANY_HUMAN_DIALOG_MS);
    await expect(promise).resolves.toMatchObject({ outcome: 'failed' });

    // `finalise` unsubscribed, so nothing is left listening to shout at.
    expect(ackListeners.has(correlationId)).toBe(false);
  });
});
