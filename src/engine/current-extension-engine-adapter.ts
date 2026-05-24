import type {
  EngineCommandName,
  SharedEngine,
  SharedEngineCommand,
  SharedEngineCommandAck,
  SharedEngineEvent,
  SharedEngineListener
} from './shared-engine';

export type CurrentExtensionEngineHandler = (
  command: SharedEngineCommand
) => Promise<void> | void;

export type CurrentExtensionEngineHandlers = Partial<
  Record<EngineCommandName, CurrentExtensionEngineHandler>
>;

export interface CurrentExtensionEngineAdapterOptions {
  readonly handlers: CurrentExtensionEngineHandlers;
}

export class CurrentExtensionEngineAdapter implements SharedEngine {
  private readonly listeners = new Set<SharedEngineListener>();

  constructor(private readonly options: CurrentExtensionEngineAdapterOptions) {}

  async dispatch(command: SharedEngineCommand): Promise<SharedEngineCommandAck> {
    const handler = this.options.handlers[command.name];
    if (!handler) {
      return this.emitAck({
        type: 'engine.command-ack',
        correlationId: command.correlationId,
        commandName: command.name,
        status: 'rejected',
        reason: 'engine-command-unavailable'
      });
    }

    try {
      await handler(command);
      return this.emitAck({
        type: 'engine.command-ack',
        correlationId: command.correlationId,
        commandName: command.name,
        status: 'accepted'
      });
    } catch (err) {
      return this.emitAck({
        type: 'engine.command-ack',
        correlationId: command.correlationId,
        commandName: command.name,
        status: 'rejected',
        reason: (err as Error).message || 'engine-command-failed'
      });
    }
  }

  subscribe(listener: SharedEngineListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  publish(event: SharedEngineEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private emitAck(ack: SharedEngineCommandAck): SharedEngineCommandAck {
    this.publish({
      type: 'engine.command-ack',
      correlationId: ack.correlationId,
      payload: ack
    });
    return ack;
  }
}
