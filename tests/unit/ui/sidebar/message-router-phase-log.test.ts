// FR-R4-F05 (US2, FR-003; contract T, T6) — message router contract for the 3
// phase-log commands. Feature 020 T008 kept them out of MUTATING_COMMANDS so that a
// secondary host could still read phase logs; each appends an audit row, so FR-003
// gates them now and this file asserts the opposite of what it did.
//
// Asserts:
// 1. The 3 command constants ARE members of MUTATING_COMMANDS (see
//    `tests/lint/phase-log-commands-are-gated.test.ts` for the superseded reason).
// 2. A trusted secondary host (isPrimary === false) is refused with
//    'secondary-window-readonly' before the handler runs, and an untrusted
//    workspace with 'untrusted-workspace'. Trust is checked first.
// 3. A trusted primary host is not refused by either gate.
// 4. FR-R6-F07 (T019) — CMD_ACK_PHASE_LOG_TAIL is gated like the other three and
//    forwards to the tail service's `ack`.

import { describe, expect, it, vi } from 'vitest';
import {
  CMD_READ_PHASE_LOG,
  CMD_ACK_PHASE_LOG_TAIL,
  CMD_START_PHASE_LOG_TAIL,
  CMD_STOP_PHASE_LOG_TAIL
} from '../../../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../../../src/contracts/sidebar-ipc';
import {
  isMutatingCommand,
  MessageRouter,
  type AckPoster,
  type RouterDeps
} from '../../../../src/ui/sidebar/message-router';
import {
  boundedTailErrorCode,
  logPhaseLogTailFailure
} from '../../../../src/ui/sidebar/commands/phase-log-tail-error';
import type { SidebarCommand } from '../../../../src/ui/sidebar/messages';

const noopExecuteCommand: RouterDeps['executeCommand'] = (() =>
  Promise.resolve(undefined)) as RouterDeps['executeCommand'];

const SELECTION = {
  queueId: 'q',
  taskId: 't',
  pipelineId: 'p1',
  phaseId: 'p2',
  iterationN: 1
};

const PHASE_LOG_COMMANDS: ReadonlyArray<{ readonly type: string; readonly command: SidebarCommand }> = [
  {
    type: CMD_READ_PHASE_LOG,
    command: {
      type: CMD_READ_PHASE_LOG,
      correlationId: 'corr-1',
      payload: { selection: { ...SELECTION, iterationN: null } }
    }
  },
  {
    type: CMD_START_PHASE_LOG_TAIL,
    command: {
      type: CMD_START_PHASE_LOG_TAIL,
      correlationId: 'corr-2',
      payload: { selection: SELECTION }
    }
  },
  {
    type: CMD_STOP_PHASE_LOG_TAIL,
    command: {
      type: CMD_STOP_PHASE_LOG_TAIL,
      correlationId: 'corr-3',
      payload: { sessionId: 'session-xyz' }
    }
  },
  {
    type: CMD_ACK_PHASE_LOG_TAIL,
    command: {
      type: CMD_ACK_PHASE_LOG_TAIL,
      correlationId: 'corr-4',
      payload: { sessionId: 'session-xyz', batchSeq: 0 }
    }
  }
];

const ACK_COMMAND: SidebarCommand = {
  type: CMD_ACK_PHASE_LOG_TAIL,
  correlationId: 'corr-5',
  payload: { sessionId: 'session-xyz', batchSeq: 3, duplicate: true }
};

function routerWith(
  gate: {
    readonly isPrimary: () => boolean;
    readonly isTrusted: () => boolean;
  },
  phaseLogTailService?: RouterDeps['phaseLogTailService']
): MessageRouter {
  return new MessageRouter({
    ...(phaseLogTailService === undefined ? {} : { phaseLogTailService }),
    executeCommand: noopExecuteCommand,
    isPrimary: gate.isPrimary,
    isTrusted: gate.isTrusted,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (s: string) => s
    }
  });
}

async function lastAckOf(router: MessageRouter, command: SidebarCommand): Promise<CommandAckMessage | undefined> {
  const ackSpy = vi.fn<AckPoster>(() => Promise.resolve(true));
  await router.dispatch(command, ackSpy);
  expect(ackSpy).toHaveBeenCalled();
  return ackSpy.mock.calls[ackSpy.mock.calls.length - 1]?.[0] as CommandAckMessage | undefined;
}

describe('FR-R4-F05 T032 — phase-log commands are gated', () => {
  for (const { type } of PHASE_LOG_COMMANDS) {
    it(`${type} IS a mutating command`, () => {
      expect(isMutatingCommand(type)).toBe(true);
    });
  }

  for (const { type, command } of PHASE_LOG_COMMANDS) {
    it(`a trusted secondary host is refused ${type} with secondary-window-readonly`, async () => {
      const router = routerWith({ isPrimary: () => false, isTrusted: () => true });
      const ack = await lastAckOf(router, command);
      expect(ack).toMatchObject({ status: 'rejected', reason: 'secondary-window-readonly' });
    });

    it(`an untrusted workspace is refused ${type} with untrusted-workspace`, async () => {
      const router = routerWith({ isPrimary: () => true, isTrusted: () => false });
      const ack = await lastAckOf(router, command);
      expect(ack).toMatchObject({ status: 'rejected', reason: 'untrusted-workspace' });
    });

    it(`an untrusted secondary host is refused ${type} on trust first`, async () => {
      const router = routerWith({ isPrimary: () => false, isTrusted: () => false });
      const ack = await lastAckOf(router, command);
      expect(ack?.reason).toBe('untrusted-workspace');
    });

    it(`a trusted primary host is not refused ${type} by a gate`, async () => {
      const router = routerWith({ isPrimary: () => true, isTrusted: () => true });
      const ack = await lastAckOf(router, command);
      expect(ack?.reason).not.toBe('secondary-window-readonly');
      expect(ack?.reason).not.toBe('untrusted-workspace');
    });
  }
});

describe('FR-R6-F07 T019 — CMD_ACK_PHASE_LOG_TAIL forwards to the tail service', () => {
  const OPEN = { isPrimary: () => true, isTrusted: () => true };

  function tailService(ack: NonNullable<RouterDeps['phaseLogTailService']>['ack']): RouterDeps['phaseLogTailService'] {
    return {
      start: () => Promise.resolve({ outcome: 'failure', reason: 'internal-error' }),
      stop: (req) => Promise.resolve({ outcome: 'failure', sessionId: req.sessionId }),
      ack
    };
  }

  it('passes the ack through and accepts it on success', async () => {
    const ack = vi.fn((req: { readonly sessionId: string }) =>
      Promise.resolve({ outcome: 'success' as const, sessionId: req.sessionId })
    );
    const router = routerWith(OPEN, tailService(ack));
    const reply = await lastAckOf(router, ACK_COMMAND);
    expect(ack).toHaveBeenCalledWith({ sessionId: 'session-xyz', batchSeq: 3, duplicate: true });
    expect(reply).toMatchObject({ status: 'accepted' });
  });

  it('rejects an ack for an unknown session with unknown-session', async () => {
    const router = routerWith(
      OPEN,
      tailService((req) =>
        Promise.resolve({ outcome: 'failure', sessionId: req.sessionId, reason: 'unknown-session' })
      )
    );
    const reply = await lastAckOf(router, ACK_COMMAND);
    expect(reply).toMatchObject({ status: 'rejected', reason: 'unknown-session' });
  });

  it('rejects with internal-error when no tail service is wired', async () => {
    const reply = await lastAckOf(routerWith(OPEN), ACK_COMMAND);
    expect(reply).toMatchObject({ status: 'rejected', reason: 'internal-error' });
  });

  it('rejects with internal-error when the service throws', async () => {
    const router = routerWith(OPEN, tailService(() => Promise.reject(new Error('boom'))));
    const reply = await lastAckOf(router, ACK_COMMAND);
    expect(reply).toMatchObject({ status: 'rejected', reason: 'internal-error' });
  });
});

describe('FR-R7-16 (16-10) — path-free bounded error logs for start, ack, and stop tail commands', () => {
  const OPEN = { isPrimary: () => true, isTrusted: () => true };
  const BOUNDED_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

  const POSIX_PATH = '/Users/alice/private-workspace/.schegent/sessions/run-1/stream.jsonl';
  const WINDOWS_PATH = 'C:\\Users\\alice\\private-workspace\\.schegent\\sessions\\run-1\\stream.jsonl';
  const ARBITRARY_SECRET_TEXT = 'raw-thrown-payload ' + 'sk' + '-tail0secret0value0123456789012345';

  function errnoError(code: string, message: string): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(message);
    err.code = code;
    return err;
  }

  it('boundedTailErrorCode normalizes valid codes and falls back to unknown on crafted or path-bearing codes', () => {
    expect(boundedTailErrorCode(errnoError('EACCES', `open '${POSIX_PATH}'`))).toBe('EACCES');
    expect(boundedTailErrorCode(errnoError('ENOENT', `open '${WINDOWS_PATH}'`))).toBe('ENOENT');
    expect(boundedTailErrorCode(new TypeError(ARBITRARY_SECRET_TEXT))).toBe('TypeError');
    expect(boundedTailErrorCode(errnoError(POSIX_PATH, 'boom'))).toBe('unknown');
    expect(boundedTailErrorCode(errnoError(WINDOWS_PATH, 'boom'))).toBe('unknown');
    expect(boundedTailErrorCode(errnoError('ERR with space', 'boom'))).toBe('unknown');
    expect(boundedTailErrorCode(errnoError('A'.repeat(65), 'boom'))).toBe('unknown');
    expect(boundedTailErrorCode(`raw string ${POSIX_PATH}`)).toBe('unknown');
    expect(boundedTailErrorCode(null)).toBe('unknown');

    class BadNamedError extends Error {}
    Object.defineProperty(BadNamedError, 'name', { value: POSIX_PATH });
    expect(boundedTailErrorCode(new BadNamedError('boom'))).toBe('unknown');

    const warn = vi.fn();
    logPhaseLogTailFailure({ warn }, 'start', errnoError('EPERM', `denied '${POSIX_PATH}'`));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('sidebar router: phase-log tail start failed: EPERM', {
      operation: 'start',
      errorCode: 'EPERM'
    });
  });

  const TAIL_HANDLERS: ReadonlyArray<{
    readonly operation: 'start' | 'ack' | 'stop';
    readonly command: SidebarCommand;
    readonly buildService: (throwErr: () => Promise<never>) => NonNullable<RouterDeps['phaseLogTailService']>;
  }> = [
    {
      operation: 'start',
      command: {
        type: CMD_START_PHASE_LOG_TAIL,
        correlationId: 'corr-err-start',
        payload: { selection: SELECTION }
      },
      buildService: (throwErr) => ({
        start: throwErr,
        ack: () => Promise.resolve({ outcome: 'failure', sessionId: 's' }),
        stop: (req) => Promise.resolve({ outcome: 'failure', sessionId: req.sessionId })
      })
    },
    {
      operation: 'ack',
      command: {
        type: CMD_ACK_PHASE_LOG_TAIL,
        correlationId: 'corr-err-ack',
        payload: { sessionId: 'session-xyz', batchSeq: 1 }
      },
      buildService: (throwErr) => ({
        start: () => Promise.resolve({ outcome: 'failure', reason: 'internal-error' }),
        ack: throwErr,
        stop: (req) => Promise.resolve({ outcome: 'failure', sessionId: req.sessionId })
      })
    },
    {
      operation: 'stop',
      command: {
        type: CMD_STOP_PHASE_LOG_TAIL,
        correlationId: 'corr-err-stop',
        payload: { sessionId: 'session-xyz' }
      },
      buildService: (throwErr) => ({
        start: () => Promise.resolve({ outcome: 'failure', reason: 'internal-error' }),
        ack: () => Promise.resolve({ outcome: 'failure', sessionId: 's' }),
        stop: throwErr
      })
    }
  ];

  const ERROR_CASES: ReadonlyArray<{
    readonly label: string;
    readonly err: unknown;
    readonly expectedCode: string;
    readonly forbiddenSubstrings: readonly string[];
  }> = [
    {
      label: 'POSIX path-bearing ErrnoException',
      err: errnoError('EACCES', `EACCES: permission denied, open '${POSIX_PATH}'`),
      expectedCode: 'EACCES',
      forbiddenSubstrings: [POSIX_PATH, '/Users/alice', 'permission denied']
    },
    {
      label: 'Windows path-bearing ErrnoException',
      err: errnoError('ENOENT', `ENOENT: no such file or directory, open '${WINDOWS_PATH}'`),
      expectedCode: 'ENOENT',
      forbiddenSubstrings: [WINDOWS_PATH, 'C:\\Users', 'no such file']
    },
    {
      label: 'arbitrary message Error',
      err: new Error(`${ARBITRARY_SECRET_TEXT} at ${POSIX_PATH}`),
      expectedCode: 'Error',
      forbiddenSubstrings: [ARBITRARY_SECRET_TEXT, 'sk' + '-tail0secret', POSIX_PATH]
    },
    {
      label: 'crafted POSIX path-bearing err.code',
      err: errnoError(POSIX_PATH, `thrown-text ${ARBITRARY_SECRET_TEXT}`),
      expectedCode: 'unknown',
      forbiddenSubstrings: [POSIX_PATH, '/Users/alice', 'thrown-text', ARBITRARY_SECRET_TEXT]
    },
    {
      label: 'crafted Windows path-bearing err.code',
      err: errnoError(WINDOWS_PATH, `thrown-text ${ARBITRARY_SECRET_TEXT}`),
      expectedCode: 'unknown',
      forbiddenSubstrings: [WINDOWS_PATH, 'C:\\Users', 'thrown-text', ARBITRARY_SECRET_TEXT]
    }
  ];

  for (const { operation, command, buildService } of TAIL_HANDLERS) {
    for (const { label, err, expectedCode, forbiddenSubstrings } of ERROR_CASES) {
      it(`${operation} handler logs distinct operation and bounded code (${expectedCode}) on ${label} with zero path or message leakage`, async () => {
        const warn = vi.fn();
        const sanitize = vi.fn((s: string) => s);
        const router = new MessageRouter({
          phaseLogTailService: buildService(() => Promise.reject(err)),
          executeCommand: noopExecuteCommand,
          isPrimary: OPEN.isPrimary,
          isTrusted: OPEN.isTrusted,
          logger: {
            info: vi.fn(),
            warn,
            error: vi.fn(),
            debug: vi.fn(),
            sanitize
          }
        });

        const reply = await lastAckOf(router, command);
        expect(reply).toMatchObject({ status: 'rejected', reason: 'internal-error' });
        expect(sanitize).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);

        const [message, context] = warn.mock.calls[0] as [string, { operation: string; errorCode: string }];
        expect(message).toBe(`sidebar router: phase-log tail ${operation} failed: ${expectedCode}`);
        expect(context).toEqual({ operation, errorCode: expectedCode });
        expect(context.errorCode).toMatch(BOUNDED_CODE_RE);

        const loggedText = JSON.stringify(warn.mock.calls);
        for (const forbidden of forbiddenSubstrings) {
          expect(loggedText).not.toContain(forbidden);
        }
      });
    }
  }
});
