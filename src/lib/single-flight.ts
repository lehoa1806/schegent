/**
 * Wraps an async action so that concurrent callers share one in-flight run.
 *
 * Review gap GC-03 (2026-11-12). A caller arriving while a run is pending receives that run's
 * promise; once it settles, resolved or rejected, the next call starts a fresh run. Results and
 * errors reach every caller of the shared run.
 */
export function singleFlight(action: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    inFlight ??= action().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
