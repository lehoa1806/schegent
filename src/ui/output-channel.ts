import type { SanitizedLogger } from '../lib/logger';

export interface OutputChannelLike {
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export class SchegentOutputChannel {
  private readonly channel: OutputChannelLike;
  private readonly logger: SanitizedLogger;

  constructor(channel: OutputChannelLike, logger: SanitizedLogger) {
    this.channel = channel;
    this.logger = logger;
    logger.addSink({ appendLine: (l) => channel.appendLine(l) });
  }

  public log(message: string): void {
    this.channel.appendLine(`[schegent] ${this.logger.sanitize(message)}`);
  }

  public reveal(): void {
    this.channel.show(true);
  }

  public dispose(): void {
    this.channel.dispose();
  }
}
