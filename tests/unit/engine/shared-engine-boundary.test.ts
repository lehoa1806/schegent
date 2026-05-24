import { describe, expect, it, vi } from 'vitest';
import {
  CurrentExtensionEngineAdapter,
  ENGINE_COMMAND_NAMES,
  ENGINE_EVENT_NAMES,
  ENGINE_HOST_DEPENDENCIES,
  ENGINE_PARITY_FIXTURES,
  ENGINE_STORAGE_POLICIES,
  ENGINE_STORAGE_RESPONSIBILITIES,
  isEngineCommandName,
  type EngineCommandName
} from '../../../src/engine';

describe('shared engine boundary', () => {
  it('covers current command, event, storage, and host dependency families', () => {
    expect(ENGINE_COMMAND_NAMES).toEqual(
      expect.arrayContaining([
        'queue.enqueue',
        'workflow.resume',
        'phase.breakpoint.set',
        'settings.save-wakeup',
        'logs.phase.read',
        'wakeup.session-log.reveal',
        'engine.snapshot.read'
      ])
    );
    expect(ENGINE_EVENT_NAMES).toEqual(
      expect.arrayContaining([
        'engine.command-ack',
        'engine.snapshot',
        'engine.audit-tail',
        'engine.phase-log-entry',
        'engine.telemetry'
      ])
    );
    expect(ENGINE_STORAGE_RESPONSIBILITIES).toEqual(
      expect.arrayContaining([
        'workspace-state',
        'app-global-state',
        'structured-audit-log',
        'raw-transcript-sink',
        'wakeup-session-log'
      ])
    );
    expect(ENGINE_HOST_DEPENDENCIES).toEqual(
      expect.arrayContaining([
        'workspace',
        'configuration',
        'state',
        'storage',
        'notifications',
        'commands',
        'files',
        'scheduler',
        'lifecycle'
      ])
    );
  });

  it('keeps raw transcript storage marked as an unredacted sink that is never UI-exposed', () => {
    expect(ENGINE_STORAGE_POLICIES.find((policy) => policy.id === 'raw-transcript-sink'))
      .toMatchObject({
        owner: 'sink',
        redactionPolicy: 'unredacted-sink',
        uiExposure: 'never'
      });
  });

  it('declares required parity fixtures before default enablement', () => {
    expect(ENGINE_PARITY_FIXTURES.map((fixture) => fixture.id)).toEqual([
      'enqueue-and-complete',
      'pause-resume',
      'retry-rate-limit',
      'phase-breakpoint',
      'task-deletion-cleanup',
      'wakeup-invocation-record'
    ]);
  });

  it('recognizes only declared engine command names', () => {
    expect(isEngineCommandName('queue.enqueue')).toBe(true);
    expect(isEngineCommandName('not-a-command')).toBe(false);
  });

  it('dispatches handled commands and publishes typed acknowledgement events', async () => {
    const handler = vi.fn();
    const engine = new CurrentExtensionEngineAdapter({
      handlers: {
        'queue.enqueue': handler
      }
    });
    const events: unknown[] = [];
    engine.subscribe((event) => events.push(event));

    const ack = await engine.dispatch({
      name: 'queue.enqueue',
      correlationId: 'corr-1',
      payload: { description: 'Build feature' }
    });

    expect(handler).toHaveBeenCalledWith({
      name: 'queue.enqueue',
      correlationId: 'corr-1',
      payload: { description: 'Build feature' }
    });
    expect(ack).toEqual({
      type: 'engine.command-ack',
      correlationId: 'corr-1',
      commandName: 'queue.enqueue',
      status: 'accepted'
    });
    expect(events).toEqual([
      {
        type: 'engine.command-ack',
        correlationId: 'corr-1',
        payload: ack
      }
    ]);
  });

  it('rejects unwired commands without mutation for rollback safety', async () => {
    const engine = new CurrentExtensionEngineAdapter({ handlers: {} });

    await expect(
      engine.dispatch({
        name: 'workflow.resume',
        correlationId: 'corr-2'
      })
    ).resolves.toEqual({
      type: 'engine.command-ack',
      correlationId: 'corr-2',
      commandName: 'workflow.resume',
      status: 'rejected',
      reason: 'engine-command-unavailable'
    });
  });

  it('rejects throwing handlers and keeps the command name closed', async () => {
    const commandName: EngineCommandName = 'phase.resume';
    const engine = new CurrentExtensionEngineAdapter({
      handlers: {
        [commandName]: () => {
          throw new Error('boom');
        }
      }
    });

    await expect(
      engine.dispatch({ name: commandName, correlationId: 'corr-3' })
    ).resolves.toEqual({
      type: 'engine.command-ack',
      correlationId: 'corr-3',
      commandName,
      status: 'rejected',
      reason: 'boom'
    });
  });
});
