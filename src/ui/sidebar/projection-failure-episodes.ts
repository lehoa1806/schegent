// Failure episodes for the snapshot projection (FR-R4-F08: FR-001 to FR-005, FR-031).
//
// The sidebar's debug-log sink kicks the projector on every line it appends
// (`live-picture-wiring.ts`), and the composer used to write a WARN line each
// time a catalog or trust projection failed. A projection that kept failing
// therefore wrote a line, which kicked a projection, which failed again and wrote
// another: one of each per debounce window, for as long as the failure lasted.
//
// This module wraps the composer and stops the repeat. A failure source (the
// Pipeline catalog, the Workflow catalog or the trust capabilities) opens an
// episode on its first failure, and that first failure is the only one written.
// The episode ends at the next compose that returns normally without that
// source failing. Nothing here suppresses a projection: only the write is
// suppressed, so a store, audit, monitor or history change during an open
// episode is projected and delivered exactly as before.
//
// The key is the source and never the message text, so a cause that changes on
// every call cannot reopen the episode. The line is written through the caller's
// `SanitizedLogger.warn`, so the existing redaction applies before any sink sees
// it, and no new text is added. This file imports no `vscode`.
//
// Import direction: this module value-imports the composer and the composer
// type-imports `ProjectionLogger` from here, so there is no value cycle.

import type { SanitizedLogger } from '../../lib/logger';
import type { WorkflowSnapshot } from './snapshot';
import { composeWorkflowSnapshot, type SnapshotComposerContext } from './snapshot-composer';

/** The three places a compose can fail without failing the snapshot. */
export type ProjectionFailureSource = 'pipeline-catalog' | 'workflow-catalog' | 'trust-capabilities';

/** The composer's logger, plus the one call projection failures go through. */
export interface ProjectionLogger extends Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> {
  /** Report that `source` failed during this compose; `message` is the existing warning text. */
  projectionFailed(source: ProjectionFailureSource, message: string): void;
}

/** The composer's context, with the caller's plain logger in place of a `ProjectionLogger`. */
export type ComposeInput = Omit<SnapshotComposerContext, 'logger'> & {
  readonly logger: Pick<SanitizedLogger, 'warn' | 'debug' | 'sanitize'> | null;
};

/**
 * One tracker per projector. Episodes last for the projector's lifetime.
 *
 * | State  | Event                                                 | Next   | Written              |
 * |--------|-------------------------------------------------------|--------|----------------------|
 * | closed | failure during a compose                              | open   | one WARN, first text |
 * | open   | failure during a compose                              | open   | nothing              |
 * | open   | a compose that returns with no failure of the source  | closed | nothing              |
 * | open   | a compose that throws                                 | open   | nothing              |
 * | closed | a compose that returns with no failure                | closed | nothing              |
 */
export class ProjectionFailureEpisodes {
  private readonly open = new Set<ProjectionFailureSource>();
  private readonly reportedThisCompose = new Set<ProjectionFailureSource>();

  /**
   * Compose a snapshot, writing a projection failure only when it opens an episode.
   *
   * A compose that throws closes nothing and rethrows: it says nothing about
   * whether a source recovered. With a null logger the episodes are still
   * tracked and nothing is written, as a null logger wrote nothing before.
   */
  public compose(input: ComposeInput): WorkflowSnapshot {
    this.reportedThisCompose.clear();
    const caller = input.logger;
    const logger: ProjectionLogger = {
      // Arguments pass through unchanged, so the caller sees the call it was always given.
      warn: (...args: Parameters<SanitizedLogger['warn']>) => {
        if (caller !== null) caller.warn(...args);
      },
      debug: (...args: Parameters<SanitizedLogger['debug']>) => {
        if (caller !== null) caller.debug(...args);
      },
      // With no caller logger this is the composer's own fallback chain, so the
      // wrapper changes nothing for a host that supplies only `externalSanitize`.
      sanitize: (value) => {
        if (caller !== null) return caller.sanitize(value);
        return input.externalSanitize ? input.externalSanitize(value) : value;
      },
      projectionFailed: (source, message) => {
        this.reportedThisCompose.add(source);
        if (this.open.has(source)) return;
        this.open.add(source);
        if (caller !== null) caller.warn(message);
      }
    };
    const snapshot = composeWorkflowSnapshot({ ...input, logger });
    for (const source of [...this.open]) {
      if (!this.reportedThisCompose.has(source)) this.open.delete(source);
    }
    return snapshot;
  }
}
