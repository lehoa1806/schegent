import type { LogSink, SanitizedLogger } from '../lib/logger';

export interface OutputChannelLike {
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export class SchegentOutputChannel {
  private readonly channel: OutputChannelLike;
  private readonly logger: SanitizedLogger;
  private readonly sink: LogSink;

  constructor(channel: OutputChannelLike, logger: SanitizedLogger) {
    this.channel = channel;
    this.logger = logger;
    this.sink = { appendLine: (l) => channel.appendLine(l) };
    logger.addSink(this.sink);
  }

  public log(message: string): void {
    this.channel.appendLine(`[schegent] ${this.logger.sanitize(message)}`);
  }

  public reveal(): void {
    this.channel.show(true);
  }

  public dispose(): void {
    // The logger outlives every Stage 2 wiring that builds one of these.
    this.logger.removeSink(this.sink);
    this.channel.dispose();
  }
}
