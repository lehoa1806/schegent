// Feature 031 T008 — unit tests for the snapshot projection's
// `wakeUp.model` and `wakeUp.sessionLogPath` fields. Mirrors data-model
// §7 (`SnapshotWakeUp`).
//
// Coverage:
//   (a) the projection carries `wakeUp.model` as a
//       `WakeUpModelSelection` value.
//   (b) the projection carries `wakeUp.sessionLogPath` as a string
//       (the absolute path under `<globalStorageUri>/wakeup/session.log`,
//       composed host-side from the existing `globalStorageUri`
//       resolver — never from operator input).
//   (c) the projection is read-only on the webview: the path field is
//       a string, NOT a payload key the webview routes back to the
//       host. The IPC contract carries only `correlationId`.
//
// These tests pin the foundational T014 projection. Implementation
// MUST satisfy:
//   - `snapshot.wakeUp.model` is read from the
//     `getWakeupModel` dep (typed as `() => WakeUpModelSelection`)
//   - `snapshot.wakeUp.sessionLogPath` is read from the
//     `getWakeupSessionLogPath` dep (typed as `() => string`)
//   - both projections are present even on idle snapshots (with
//     sensible defaults).

import { describe, it, expect } from 'vitest';
import { StateProjector } from '../../../../src/ui/sidebar/state-projector';
import type { SanitizedLogger } from '../../../../src/lib/logger';
import {
  RUNNER_DEFAULT_MODEL,
  type WakeUpModelSelection
} from '../../../../src/wakeup/settings';

function makeProjector(opts: {
  isPrimary?: boolean;
  wakeUpModel?: WakeUpModelSelection;
  wakeupSessionLogPath?: string;
}): StateProjector {
  const sanitizingLogger: Pick<SanitizedLogger, 'sanitize'> = {
    sanitize: (s: string) => s
  };
  return new StateProjector({
    isPrimary: opts.isPrimary ?? true,
    sanitize: (s: string | null | undefined) => (s ?? '').toString(),
    logger: sanitizingLogger as SanitizedLogger,
    now: () => new Date('2026-05-16T00:00:00.000Z'),
    getWakeupModel: () => opts.wakeUpModel ?? RUNNER_DEFAULT_MODEL,
    getWakeupSessionLogPath: () =>
      opts.wakeupSessionLogPath ?? '/tmp/schegent-tests/global-storage/wakeup/session.log'
  });
}

describe('Feature 031 — snapshot.wakeUp.model projection', () => {
  it('projects `runner-default` by default', () => {
    const proj = makeProjector({});
    const snapshot = proj.project();
    expect((snapshot as { wakeUp?: { model?: unknown } }).wakeUp?.model)
      .toBe(RUNNER_DEFAULT_MODEL);
  });

  it('projects `claude-opus-4-7` when the host reports it', () => {
    const proj = makeProjector({ wakeUpModel: 'claude-opus-4-7' });
    const snapshot = proj.project();
    expect((snapshot as { wakeUp?: { model?: unknown } }).wakeUp?.model)
      .toBe('claude-opus-4-7');
  });

  it('projects `claude-sonnet-4-6` when the host reports it', () => {
    const proj = makeProjector({ wakeUpModel: 'claude-sonnet-4-6' });
    const snapshot = proj.project();
    expect((snapshot as { wakeUp?: { model?: unknown } }).wakeUp?.model)
      .toBe('claude-sonnet-4-6');
  });

  it('projects `claude-haiku-4-6` when the host reports it', () => {
    const proj = makeProjector({ wakeUpModel: 'claude-haiku-4-6' });
    const snapshot = proj.project();
    expect((snapshot as { wakeUp?: { model?: unknown } }).wakeUp?.model)
      .toBe('claude-haiku-4-6');
  });
});

describe('Feature 031 — snapshot.wakeUp.sessionLogPath projection', () => {
  it('projects the host-composed absolute path', () => {
    const path = '/Users/x/Library/Application Support/schegent/wakeup/session.log';
    const proj = makeProjector({ wakeupSessionLogPath: path });
    const snapshot = proj.project();
    expect(
      (snapshot as { wakeUp?: { sessionLogPath?: unknown } }).wakeUp?.sessionLogPath
    ).toBe(path);
  });

  it('projects the path as a typed string (not a payload tuple)', () => {
    const proj = makeProjector({});
    const snapshot = proj.project();
    const sessionLogPath = (snapshot as { wakeUp?: { sessionLogPath?: unknown } })
      .wakeUp?.sessionLogPath;
    expect(typeof sessionLogPath).toBe('string');
  });
});

describe('Feature 031 — snapshot.wakeUp is read-only on the webview', () => {
  it('the projection carries a path string, not an IPC-shaped object the webview echoes back', () => {
    const proj = makeProjector({
      wakeupSessionLogPath: '/tmp/wakeup/session.log'
    });
    const snapshot = proj.project();
    const wakeUp = (snapshot as { wakeUp?: Readonly<Record<string, unknown>> }).wakeUp;
    expect(wakeUp).toBeDefined();
    expect(typeof wakeUp?.sessionLogPath).toBe('string');
    // The path is for DISPLAY only; the CMD_READ_WAKEUP_SESSION_LOG
    // payload key is `correlationId`, NOT a path. This test pins the
    // "path is not a payload key" invariant by asserting no `payload`
    // or `request` shape is on the projection.
    expect(Object.prototype.hasOwnProperty.call(wakeUp ?? {}, 'payload')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(wakeUp ?? {}, 'request')).toBe(false);
  });

  it('the projection is deeply frozen', () => {
    const proj = makeProjector({});
    const snapshot = proj.project();
    const wakeUp = (snapshot as { wakeUp?: Readonly<Record<string, unknown>> }).wakeUp;
    expect(Object.isFrozen(wakeUp)).toBe(true);
  });
});
