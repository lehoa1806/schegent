// Feature 031 T029 — message router contract for `CMD_READ_WAKEUP_SESSION_LOG`.
//
// Per `specs/031-advanced-wakeup-logs-models/contracts/wakeup-session-log-ipc.md`:
//   * The command is READ-ONLY by construction — it MUST NOT be in
//     `MUTATING_COMMANDS` (a secondary VS Code host can still inspect
//     a previously captured session). The contract still requires a
//     primary-host gate, but it is enforced **inside the handler** so
//     the response reason vocabulary matches the contract
//     (`'not-primary-host'`) rather than the generic
//     `'secondary-window-readonly'` that the mutating gate emits.
//   * The handler validates `correlationId` shape (UUIDv4) BEFORE
//     touching the filesystem — a malformed id MUST resolve to
//     `'invalid-correlation-id'` without ever calling the reader.
//   * The handler delegates to an injected reader service. Unknown
//     correlation-ids surface as `'unknown-correlation-id'`; the
//     happy-path ack carries the full
//     `ReadWakeupSessionLogResponseSuccess` payload in `ack.result`.
//
// The handler/router additions land in T036; this test is the red-first
// pin that drives the contract surface. The reader dep mirrors the
// `phaseLogService` shape — a single `read(req): Promise<response>`
// method whose result is forwarded verbatim to `ack.result`.

import { describe, expect, it, vi } from 'vitest';
import {
  CMD_READ_WAKEUP_SESSION_LOG
} from '../../../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../../../src/contracts/sidebar-ipc';
import {
  isMutatingCommand,
  MessageRouter,
  type AckPoster,
  type RouterDeps
} from '../../../../src/ui/sidebar/message-router';

// Canonical UUIDv4 fixture (version nibble = 4, variant nibble in 8-b).
const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// Malformed — wrong length and characters. Used to drive the
// `invalid-correlation-id` short-circuit branch.
const MALFORMED_UUID = 'NOT-A-UUID';
// Syntactically valid but unknown to the reader (no block on disk).
const UNKNOWN_UUID = 'bbbbbbbb-cccc-4ddd-9eee-ffffffffffff';

const noopExecuteCommand: RouterDeps['executeCommand'] = (() =>
  Promise.resolve(undefined)) as RouterDeps['executeCommand'];

interface ReaderResponseSuccess {
  readonly status: 'success';
  readonly correlationId: string;
  readonly capturedAtMs: number;
  readonly trigger: 'scheduled' | 'manual';
  readonly model: string;
  readonly outcome: 'succeeded' | 'failed';
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly fullBlockBytesOnDisk: number;
}

interface ReaderResponseRejected {
  readonly status: 'rejected';
  readonly reason:
    | 'not-primary-host'
    | 'invalid-correlation-id'
    | 'unknown-correlation-id'
    | 'session-log-unavailable'
    | 'unknown-error';
}

type ReaderResponse = ReaderResponseSuccess | ReaderResponseRejected;

interface ReaderServiceDep {
  read(req: { correlationId: string }): Promise<ReaderResponse>;
}

function makeRouter(opts: {
  isPrimary?: boolean;
  reader?: ReaderServiceDep;
}): {
  router: MessageRouter;
  ackSpy: ReturnType<
    typeof vi.fn<Parameters<AckPoster>, ReturnType<AckPoster>>
  >;
  reader: ReaderServiceDep;
} {
  const ackSpy = vi.fn<Parameters<AckPoster>, ReturnType<AckPoster>>(() =>
    Promise.resolve(true)
  );
  const reader: ReaderServiceDep = opts.reader ?? {
    read: vi.fn(async (req) => ({
      status: 'success',
      correlationId: req.correlationId,
      capturedAtMs: 1716000000000,
      trigger: 'scheduled',
      model: 'runner-default',
      outcome: 'succeeded',
      body: 'OUT: hello world\n',
      bodyTruncated: false,
      fullBlockBytesOnDisk: 'OUT: hello world\n'.length
    } satisfies ReaderResponseSuccess))
  };
  const router = new MessageRouter({
    executeCommand: noopExecuteCommand,
    queueRemover: { remove: vi.fn(() => Promise.resolve(false)) },
    isPrimary: () => opts.isPrimary ?? true,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (s: string) => s
    },
    // The T036 implementation introduces a new optional `wakeupSessionLogService`
    // dep on `RouterDeps`. Casting through `unknown` keeps the red-first test
    // wire-format-stable while the production interface is added in T036.
    wakeupSessionLogService: reader
  } as unknown as RouterDeps);
  return { router, ackSpy, reader };
}

describe('Feature 031 T029 — CMD_READ_WAKEUP_SESSION_LOG dispatcher contract', () => {
  it('is NOT a mutating command (read-only by construction)', () => {
    // Per contract §5: the read command stays out of MUTATING_COMMANDS so
    // secondary VS Code hosts can still ask the host for a previously
    // captured session. The primary-host check is enforced inside the
    // handler with the contract-specified `'not-primary-host'` reason.
    expect(isMutatingCommand(CMD_READ_WAKEUP_SESSION_LOG)).toBe(false);
  });

  it('valid UUIDv4 correlationId resolves to success and carries the reader payload in ack.result', async () => {
    const { router, ackSpy, reader } = makeRouter({ isPrimary: true });
    await router.dispatch(
      {
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: 'corr-1',
        payload: { correlationId: VALID_UUID }
      },
      ackSpy
    );
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledWith({ correlationId: VALID_UUID });
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.status).toBe('accepted');
    const result = lastAck?.result as ReaderResponseSuccess | undefined;
    expect(result?.status).toBe('success');
    expect(result?.correlationId).toBe(VALID_UUID);
    expect(result?.body).toContain('OUT: hello world');
    expect(result?.bodyTruncated).toBe(false);
  });

  it('malformed correlationId short-circuits to invalid-correlation-id without touching the reader', async () => {
    const readerSpy = vi.fn();
    const { router, ackSpy } = makeRouter({
      isPrimary: true,
      reader: { read: readerSpy }
    });
    await router.dispatch(
      {
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: 'corr-2',
        payload: { correlationId: MALFORMED_UUID }
      },
      ackSpy
    );
    // The host validates the canonical UUIDv4 shape BEFORE invoking the
    // reader (defense in depth — same discipline as the 020 phase-log
    // composer which re-validates against the snapshot before composing
    // any filesystem path).
    expect(readerSpy).not.toHaveBeenCalled();
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.status).toBe('rejected');
    expect(lastAck?.reason).toBe('invalid-correlation-id');
    const result = lastAck?.result as ReaderResponseRejected | undefined;
    expect(result?.status).toBe('rejected');
    expect(result?.reason).toBe('invalid-correlation-id');
  });

  it('secondary host rejection uses the contract-specified not-primary-host reason (NOT secondary-window-readonly)', async () => {
    const readerSpy = vi.fn();
    const { router, ackSpy } = makeRouter({
      isPrimary: false,
      reader: { read: readerSpy }
    });
    await router.dispatch(
      {
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: 'corr-3',
        payload: { correlationId: VALID_UUID }
      },
      ackSpy
    );
    // Contract §5 reject vocabulary: `'not-primary-host'`. The mutating
    // gate's `'secondary-window-readonly'` reason MUST NOT leak into this
    // read-only command's rejection vocabulary.
    expect(readerSpy).not.toHaveBeenCalled();
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.status).toBe('rejected');
    expect(lastAck?.reason).toBe('not-primary-host');
    expect(lastAck?.reason).not.toBe('secondary-window-readonly');
    const result = lastAck?.result as ReaderResponseRejected | undefined;
    expect(result?.status).toBe('rejected');
    expect(result?.reason).toBe('not-primary-host');
  });

  it('unknown but well-formed correlationId surfaces unknown-correlation-id from the reader', async () => {
    const reader: ReaderServiceDep = {
      read: vi.fn(async () => ({
        status: 'rejected',
        reason: 'unknown-correlation-id'
      } satisfies ReaderResponseRejected))
    };
    const { router, ackSpy } = makeRouter({ isPrimary: true, reader });
    await router.dispatch(
      {
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: 'corr-4',
        payload: { correlationId: UNKNOWN_UUID }
      },
      ackSpy
    );
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledWith({ correlationId: UNKNOWN_UUID });
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.status).toBe('rejected');
    expect(lastAck?.reason).toBe('unknown-correlation-id');
    const result = lastAck?.result as ReaderResponseRejected | undefined;
    expect(result?.status).toBe('rejected');
    expect(result?.reason).toBe('unknown-correlation-id');
  });

  it('session-log-unavailable propagates from the reader unchanged', async () => {
    const reader: ReaderServiceDep = {
      read: vi.fn(async () => ({
        status: 'rejected',
        reason: 'session-log-unavailable'
      } satisfies ReaderResponseRejected))
    };
    const { router, ackSpy } = makeRouter({ isPrimary: true, reader });
    await router.dispatch(
      {
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: 'corr-5',
        payload: { correlationId: VALID_UUID }
      },
      ackSpy
    );
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.status).toBe('rejected');
    expect(lastAck?.reason).toBe('session-log-unavailable');
  });

  it('uncaught reader exception is caught and surfaced as unknown-error', async () => {
    const reader: ReaderServiceDep = {
      read: vi.fn(async () => {
        throw new Error('disk i/o exploded');
      })
    };
    const { router, ackSpy } = makeRouter({ isPrimary: true, reader });
    await router.dispatch(
      {
        type: CMD_READ_WAKEUP_SESSION_LOG,
        correlationId: 'corr-6',
        payload: { correlationId: VALID_UUID }
      },
      ackSpy
    );
    const lastAck = ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as
      | CommandAckMessage
      | undefined;
    expect(lastAck?.status).toBe('rejected');
    expect(lastAck?.reason).toBe('unknown-error');
  });
});
