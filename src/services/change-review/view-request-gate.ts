/**
 * FR-R6-F12 (FR-016, NFR-002; research R7) — the view-request gate.
 *
 * One view holds at most one request in flight. `begin` aborts the view's previous request with
 * `superseded` and issues a ticket; `run` races the work against the ticket's abort, so an abort
 * answers at once even while a Git read is still pending; `cancel` aborts with `canceled`. A result
 * or failure that arrives after an abort is dropped: the abandoned read ends on its own deadline.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { reviewRefused, type ReviewResult } from '../../contracts/change-review';

const SUPERSEDED = 'superseded';
const CANCELED = 'canceled';

export interface ViewTicket {
  readonly viewKey: string;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface ViewRequestGate {
  /** Starts a request for `viewKey`, superseding the one in flight. */
  begin(viewKey: string): ViewTicket;
  /** The work's result, or `superseded`/`canceled` as soon as the ticket is aborted. */
  run<T>(ticket: ViewTicket, work: (signal: AbortSignal) => Promise<ReviewResult<T>>): Promise<ReviewResult<T>>;
  /** Aborts the view's request in flight; false when there is none. */
  cancel(viewKey: string): boolean;
}

interface InFlight {
  readonly controller: AbortController;
  readonly generation: number;
}

function refusalOf<T>(signal: AbortSignal): ReviewResult<T> {
  return reviewRefused(signal.reason === CANCELED ? 'canceled' : 'superseded');
}

/** A gate holding one request in flight per view key. */
export function createViewRequestGate(): ViewRequestGate {
  const inFlight = new Map<string, InFlight>();
  let generation = 0;

  const release = (ticket: ViewTicket): void => {
    if (inFlight.get(ticket.viewKey)?.generation === ticket.generation) inFlight.delete(ticket.viewKey);
  };

  return {
    begin: (viewKey) => {
      inFlight.get(viewKey)?.controller.abort(SUPERSEDED);
      generation += 1;
      const controller = new AbortController();
      inFlight.set(viewKey, { controller, generation });
      return { viewKey, generation, signal: controller.signal };
    },
    run: async <T>(ticket: ViewTicket, work: (signal: AbortSignal) => Promise<ReviewResult<T>>) => {
      const { signal } = ticket;
      if (signal.aborted) return refusalOf<T>(signal);
      let onAbort: () => void = () => undefined;
      const aborted = new Promise<ReviewResult<T>>((resolve) => {
        onAbort = () => resolve(refusalOf<T>(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const done = work(signal).then((result) => (signal.aborted ? refusalOf<T>(signal) : result));
      done.catch(() => undefined);
      try {
        return await Promise.race([aborted, done]);
      } finally {
        signal.removeEventListener('abort', onAbort);
        release(ticket);
      }
    },
    cancel: (viewKey) => {
      const current = inFlight.get(viewKey);
      if (current === undefined) return false;
      inFlight.delete(viewKey);
      current.controller.abort(CANCELED);
      return true;
    }
  };
}
