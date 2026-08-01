import type { AuditEntry } from '../../audit/audit-entry';
import type { SanitizedLogger } from '../../lib/logger';
import { readAuditTailColdStart } from './audit-tail-coldstart';
import { projectAuditEntry } from './audit-tail-projector';
import { AUDIT_TAIL_MAX, type AuditTailEntry } from './snapshot';

/** Owns the bounded mutable audit-tail cache and cold-start merge policy. */
export class AuditTailState {
  private readonly entries: AuditTailEntry[] = [];
  private hydrationStarted = false;

  public beginHydration(): boolean {
    if (this.hydrationStarted) return false;
    this.hydrationStarted = true;
    return true;
  }

  public readColdStart(
    workspaceRoot: string,
    logger?: SanitizedLogger
  ): Promise<readonly AuditTailEntry[]> {
    return readAuditTailColdStart(workspaceRoot, logger);
  }

  public mergeColdStart(tail: readonly AuditTailEntry[]): boolean {
    if (tail.length === 0) return false;
    const seenIds = new Set(this.entries.map((entry) => entry.id));
    for (const entry of tail) {
      if (seenIds.has(entry.id)) continue;
      this.entries.push(entry);
      seenIds.add(entry.id);
    }
    this.trim();
    return true;
  }

  public append(entry: AuditEntry): AuditTailEntry {
    const projected = projectAuditEntry(entry);
    this.entries.push(projected);
    this.trim();
    return projected;
  }

  public seed(entries: readonly AuditTailEntry[]): void {
    this.entries.length = 0;
    this.entries.push(...entries.slice(-AUDIT_TAIL_MAX));
  }

  public snapshot(): readonly AuditTailEntry[] {
    return this.entries.slice();
  }

  private trim(): void {
    if (this.entries.length > AUDIT_TAIL_MAX) {
      this.entries.splice(0, this.entries.length - AUDIT_TAIL_MAX);
    }
  }
}
