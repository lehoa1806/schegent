/**
 * FR-R6-F13 — builds and delivers the observations of one ACP connection.
 *
 * Each observation takes the next host receive sequence and the clock's time, with or without a
 * listener. A listener fault never reaches the protocol or a prompt outcome.
 *
 * Zero `vscode` imports.
 */
import type { AcpClock, AcpObservation, AcpStopReason } from '../../contracts/acp-runtime';
import type { AcpNormalizedEvent } from '../phase-log/acp-live-projection';
import type { AcpUsageUpdate } from '../usage-accounting/acp-usage-mapping';
import type { Attribution } from './session-state';

export type ObservationBody =
  | { readonly kind: 'turn-started'; readonly requestId: number }
  | { readonly kind: 'turn-completed'; readonly requestId: number; readonly stopReason: AcpStopReason }
  | { readonly kind: 'display'; readonly event: AcpNormalizedEvent }
  | { readonly kind: 'usage'; readonly usage: AcpUsageUpdate };

export class ObservationEmitter {
  private receiveSeq = 0;

  constructor(
    private readonly generation: number,
    private readonly clock: AcpClock,
    private readonly listener: ((observation: AcpObservation) => void) | undefined
  ) {}

  emit(sessionId: string, attribution: Attribution, build: (seq: number, at: string) => ObservationBody): void {
    this.receiveSeq += 1;
    const seq = this.receiveSeq;
    const at = this.clock.nowUtc();
    const observation: AcpObservation = {
      generation: this.generation,
      hostReceiveSeq: seq,
      observedAtUtc: at,
      origin: attribution.origin,
      acpSessionId: sessionId,
      turnId: attribution.turnId,
      attemptId: attribution.attemptId,
      binding: attribution.binding,
      ...build(seq, at)
    };
    if (this.listener === undefined) return;
    try {
      this.listener(observation);
    } catch {
      // An observer fault never reaches the protocol or the prompt outcome.
    }
  }
}
