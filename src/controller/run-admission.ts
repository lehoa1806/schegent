/**
 * Feature 093 (T049a) — the admission contract between the controller and the
 * auto-drain coordinator.
 *
 * Starting a Run has two halves that used to be one await: *admitting* it —
 * creating the record, writing it to the queue's slot, marking the Task in
 * flight — and *driving* it to a terminal status. `startNew` awaited both, so a
 * drain that promoted a queue could not look at the next one until that Run
 * finished. Separating them lets the drain wait for the first and hand the
 * second back.
 *
 * These types live outside `workflow-controller.ts` because they are the shape
 * two modules agree on rather than an internal of either. The coordinator
 * depends on the controller through `Pick<…, 'admitNew' | 'admitResume'>`, and
 * this file is what that Pick resolves to.
 */

/**
 * The promise of an admitted Run's execution.
 *
 * `completed` resolves at the Run's terminal transition, or immediately when
 * there was nothing to drive. It never rejects for a Run that merely *failed*: a
 * failing Run is routed through the controller's own start-failure handling
 * exactly as it was when `startNew` owned the whole span, so awaiting it is
 * byte-for-byte the old contract.
 */
export interface RunAdmission {
  readonly completed: Promise<void>;
}

/** A resume also reports whether there was anything to resume. */
export interface ResumeAdmission extends RunAdmission {
  readonly resumed: boolean;
}

/** Admission failed before a Run existed; there is no drive to await. */
export const NOTHING_TO_DRIVE: RunAdmission = { completed: Promise.resolve() };

/** The queue had no resumable Run; the caller falls through to a fresh start. */
export const NOT_RESUMED: ResumeAdmission = { resumed: false, completed: Promise.resolve() };
