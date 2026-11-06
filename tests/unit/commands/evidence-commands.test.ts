// FR-R3-127 (T018) — the two commands `evidence-retention-disclosure.md` promised.
//
// The services own the behaviour and carry their own tests. What is asserted here
// is what a palette invocation adds: the three inputs, the confirmation, and the
// rendering of an outcome union arm by arm — because collapsing "refused, a writer
// is live" and "there was nothing to remove" into one message would make opposite
// facts read the same.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DELETE_EVIDENCE_TEXT,
  EXPORT_TEXT,
  destinationIsInsideEvidenceStore,
  runDeleteRunEvidenceCommand,
  runExportRunEvidenceCommand,
  type EvidenceCommandDeps
} from '../../../src/commands/evidence-commands';
import type { Notifier } from '../../../src/ui/notifications';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { DeleteOutcome } from '../../../src/services/evidence-delete';
import { retentionDisclosure } from '../../../src/services/retention-disclosure';
import type { ExportOutcome } from '../../../src/contracts/evidence-export-outcome';

const RUN = '11111111-1111-4111-8111-111111111111';

let workspaceRoot: string;
let destination: string;
let warnings: string[];
let audited: DeleteOutcome[];
let shownRows: string[][];
let exportRows: ExportOutcome[];
/** The action the operator picks on the result notice, when the test sets one. */
let pickedAction: string | undefined;

function deps(overrides: Partial<EvidenceCommandDeps> = {}): EvidenceCommandDeps {
  return {
    workspaceRoot,
    isRunActive: () => false,
    promptForRunId: async () => RUN,
    promptForDestination: async () => ({ scheme: 'file', fsPath: destination }),
    confirmDelete: async () => true,
    notifier: {
      warn: (m: string, ...actions: string[]) => {
        warnings.push(m);
        return Promise.resolve(actions.includes(pickedAction ?? '') ? pickedAction : undefined);
      }
    } as unknown as Notifier,
    logger: { info: () => {}, warn: () => {}, sanitize: (value: string) => value } as unknown as SanitizedLogger,
    auditDeletion: async (_runId, outcome) => { audited.push(outcome); },
    // FR-R4-F04 (D5, D7) — the private checkpoint root, the legacy transport probe and the retained-items
    // view. The workspace root doubles as an empty private storage, so no checkpoint exists to remove.
    checkpointRoot: workspaceRoot,
    legacyAgesOutBy: () => null,
    showRetainedItems: async (rows) => { shownRows.push([...rows]); },
    auditExport: async (_runId, outcome) => { exportRows.push(outcome); },
    ...overrides
  };
}

/** A run with something to delete: the raw transcript the disclosure page names. */
function seedEvidence(): void {
  const sessions = join(workspaceRoot, '.schegent', 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `raw-${RUN}.log`), 'unredacted prompt and output\n');
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'schegent-evidence-cmd-ws-'));
  destination = mkdtempSync(join(tmpdir(), 'schegent-evidence-cmd-out-'));
  warnings = [];
  audited = [];
  shownRows = [];
  exportRows = [];
  pickedAction = undefined;
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });
});

describe('the run id arrives as an argument or from a prompt', () => {
  it('uses the argument when one is passed, and does not prompt', async () => {
    // Same shape as `src/commands/cancel.ts`'s optional `taskId`: a caller that
    // knows the target should not be asked for it.
    const prompt = vi.fn(async () => RUN);
    seedEvidence();
    await runDeleteRunEvidenceCommand(deps({ promptForRunId: prompt }), RUN);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('prompts when no argument is passed', async () => {
    const prompt = vi.fn(async () => RUN);
    seedEvidence();
    await runDeleteRunEvidenceCommand(deps({ promptForRunId: prompt }));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('refuses a value that is not a Run id, and says what one is', async () => {
    const result = await runDeleteRunEvidenceCommand(
      deps({ promptForRunId: async () => 'the failed one' })
    );
    expect(result).toBeNull();
    // The operator typed it, so the message is about what they typed.
    expect(warnings.join(' ')).toMatch(/is not a Run id/);
    expect(warnings.join(' ')).toMatch(/UUID/);
    expect(audited).toEqual([]);
  });

  it('does nothing when the prompt is dismissed', async () => {
    const result = await runDeleteRunEvidenceCommand(
      deps({ promptForRunId: async () => undefined })
    );
    expect(result).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe('delete confirms first, and renders every arm distinctly', () => {
  it('does not delete when the confirmation is declined', async () => {
    seedEvidence();
    const result = await runDeleteRunEvidenceCommand(deps({ confirmDelete: async () => false }));
    expect(result).toBeNull();
    expect(audited, 'a declined confirmation is not a deletion to audit').toEqual([]);
  });

  it('reports what it removed', async () => {
    seedEvidence();
    const result = await runDeleteRunEvidenceCommand(deps());
    expect(result?.outcome).toBe('completed');
    // FR-R4-F04 (O2, TA8) — the result text is the table's, not the old "removed N evidence artifact(s)".
    expect(warnings.join(' ')).toMatch(/Deleted \d+ item\(s\) of this Run's evidence\. 0 item\(s\) were kept\./);
    expect(audited).toHaveLength(1);
  });

  it('refuses while a writer is live, and says nothing was removed', async () => {
    seedEvidence();
    const result = await runDeleteRunEvidenceCommand(deps({ isRunActive: () => true }));
    expect(result?.outcome).toBe('refused');
    if (result?.outcome !== 'refused') return;
    expect(result.reason).toBe('active-writer');
    // The two facts an operator needs: why, and that the tree is untouched.
    expect(warnings.join(' ')).toMatch(/still executing/);
    expect(warnings.join(' ')).toMatch(/Nothing was\s+removed|Nothing was removed/);
    // Audited even though nothing was removed: the refusal is a decision, and a
    // decision about evidence is the thing this log exists to hold.
    expect(audited).toHaveLength(1);
  });

  it('says "nothing is held" differently from "refused"', async () => {
    // The arm that a collapsed grade would merge with the one above, and they are
    // opposite facts: one has a live writer to wait for, the other has nothing.
    const result = await runDeleteRunEvidenceCommand(deps());
    expect(result?.outcome).toBe('refused');
    if (result?.outcome !== 'refused') return;
    expect(result.reason).toBe('no-evidence');
    expect(warnings.join(' ')).toMatch(/no evidence is held/i);
    expect(warnings.join(' ')).not.toMatch(/still executing/);
  });
});

describe('export chooses a destination and refuses the evidence store', () => {
  it('refuses a destination inside .schegent/', () => {
    // A loop, and a way to move unredacted content past a retention sweep.
    expect(destinationIsInsideEvidenceStore(resolve('/tmp/ws/.schegent'))).toBe(true);
    expect(destinationIsInsideEvidenceStore(resolve('/tmp/ws/.schegent/sessions'))).toBe(true);
    expect(destinationIsInsideEvidenceStore(resolve('/tmp/ws/exports'))).toBe(false);
    // Not fooled by a name that merely contains the string.
    expect(destinationIsInsideEvidenceStore(resolve('/tmp/ws/my.schegentbackup'))).toBe(false);
  });

  it('does not call the service when the destination is refused', async () => {
    seedEvidence();
    const inside = join(workspaceRoot, '.schegent', 'sessions');
    const result = await runExportRunEvidenceCommand(
      deps({ promptForDestination: async () => ({ scheme: 'file', fsPath: inside }) })
    );
    expect(result).toBeNull();
    // FR-R4-F04 (O6) — the refusal text is the table's, and a refused row is recorded.
    expect(warnings.join(' ')).toContain(EXPORT_TEXT.refusal['destination-in-evidence-store']);
  });

  it('exports and names where it went', async () => {
    seedEvidence();
    const result = await runExportRunEvidenceCommand(deps());
    expect(result?.outcome).toBe('exported');
    expect(warnings.join(' ')).toMatch(/exported evidence for run/);
    // The manifest is the point of the export, per the disclosure page.
    expect(warnings.join(' ')).toMatch(/manifest/);
  });

  it('renders an export refusal with its reason', async () => {
    // No evidence seeded: the service refuses, and the handler must not present
    // that as a success with an empty archive.
    const result = await runExportRunEvidenceCommand(deps());
    expect(result?.outcome).toBe('refused');
    expect(warnings.join(' ')).toMatch(/export refused/);
  });

  it('does nothing when the destination prompt is dismissed', async () => {
    seedEvidence();
    const result = await runExportRunEvidenceCommand(
      deps({ promptForDestination: async () => undefined })
    );
    expect(result).toBeNull();
    expect(warnings).toEqual([]);
  });
});

// FR-R4-F04 (feature 251, contract T8; FR-012, FR-013, O1, O2, D7) — the deletion command says what it
// removes and what it keeps, shows every retained item, and shows the result even when its audit append
// fails.
describe('FR-R4-F04 T8 — the deletion notice, the retained-items view and the audit failure', () => {
  it("the confirmation is O1's: it names the classes and the kept stores, and never says all local evidence", () => {
    const text = `${DELETE_EVIDENCE_TEXT.confirmPrompt} ${DELETE_EVIDENCE_TEXT.confirmDetail}`;
    expect(text).not.toMatch(/all local evidence/i);
    for (const named of ['session directory', 'raw transcripts', 'verbose diagnostics', 'failure records', 'private recovery checkpoint']) {
      expect(text, named).toContain(named);
    }
    for (const kept of ['audit log', 'runtime log', 'metrics rollup', 'Run history', 'legacy transport']) {
      expect(text, kept).toContain(kept);
    }
    expect(DELETE_EVIDENCE_TEXT.confirmLabel).toBe('Delete evidence');
  });

  it('offers "Show retained items", and the view holds one row per retained item and per kept store', async () => {
    seedEvidence();
    mkdirSync(join(workspaceRoot, '.schegent', 'history'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.schegent', 'history', `${RUN}.txt`), 'the description\n');
    pickedAction = DELETE_EVIDENCE_TEXT.showRetainedAction;

    const result = await runDeleteRunEvidenceCommand(deps({ legacyAgesOutBy: () => '2026-12-01T00:00:00.000Z' }));
    // The view opens when the notice's action is chosen, off the command's own promise, so one macrotask
    // lets the choice resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result?.outcome).toBe('completed');
    expect(warnings.join(' ')).toMatch(/Deleted \d+ item\(s\) of this Run's evidence\. 1 item\(s\) were kept\./);
    expect(shownRows).toHaveLength(1);
    const rows = shownRows[0] ?? [];
    expect(rows.some((row) => row.includes(`${RUN}.txt`) && row.includes('run-history')), 'the retained history description').toBe(true);
    for (const store of ['Audit log', 'Runtime log', 'Metrics rollup', 'Run history']) {
      expect(rows.some((row) => row.startsWith(store)), store).toBe(true);
    }
    expect(rows.some((row) => row.startsWith('Legacy transport') && row.includes('ages out 2026-12-01')), 'the legacy row carries its date').toBe(true);
  });

  it('does not open the view when the operator does not ask for it', async () => {
    seedEvidence();
    await runDeleteRunEvidenceCommand(deps());
    expect(shownRows).toEqual([]);
  });

  it('does not call the runtime log aged: the inventory decided it has no age bound (G11)', () => {
    // The label repeats a decision the inventory records (the log's path can be configured outside the
    // workspace, where an age sweep would delete files in a place the operator chose). Saying "aged by its
    // own settings" told the operator the opposite of what the log does, in the view they open to check.
    const row = retentionDisclosure().find((candidate) => candidate.store === 'Runtime log');
    expect(row?.bounds, 'the inventory is the source of the decision').toContain('no age bound');
    const label = DELETE_EVIDENCE_TEXT.keptStore['runtime-log'];
    expect(label, 'the label must not say the log is aged').not.toMatch(/\bage[ds]?\b/i);
    expect(label, 'the label says what bounds it').toMatch(/rotated by .*size.*generation/i);
  });

  it('shows the result and says it was not recorded when the audit append throws', async () => {
    seedEvidence();
    const logged: string[] = [];
    const result = await runDeleteRunEvidenceCommand(
      deps({
        auditDeletion: async () => {
          throw new Error('disk full');
        },
        logger: { info: () => {}, warn: (m: string) => logged.push(m), sanitize: (value: string) => value } as unknown as SanitizedLogger
      })
    );

    expect(result?.outcome, 'the deletion happened and its outcome is returned').toBe('completed');
    expect(warnings.join(' ')).toContain('Deleted');
    expect(warnings.join(' ')).toContain(DELETE_EVIDENCE_TEXT.notRecorded);
    expect(logged.join(' '), 'the failure is logged without its message text').not.toContain('disk full');
  });

  it('still records nothing for a declined confirmation (a pin)', async () => {
    seedEvidence();
    await runDeleteRunEvidenceCommand(deps({ confirmDelete: async () => false }));
    expect(audited).toEqual([]);
    expect(warnings).toEqual([]);
  });
});


// Feature 251 (FR-R4-F04, contract T8; FR-020, FR-021; E1, E3, E6, E7) — the Run export records one row per
// outcome and none when the operator dismisses a dialog, defaults its folder dialog to the home directory,
// and keeps its output when the audit append fails.
describe('FR-R4-F04 T8 — the Run export records one outcome', () => {
  it('records one exported row, with the manifest counts, for a completed export', async () => {
    seedEvidence();
    const result = await runExportRunEvidenceCommand(deps());

    expect(result?.outcome).toBe('exported');
    expect(exportRows).toHaveLength(1);
    expect(exportRows[0]).toMatchObject({ kind: 'run-evidence', outcome: 'exported' });
    if (result?.outcome !== 'exported') return;
    expect(exportRows[0]).toMatchObject({
      included: result.manifest.contents.length,
      omitted: result.manifest.deliberateOmissions.length
    });
  });

  it.each([
    ['no evidence for the Run', () => ({}), 'no-evidence'],
    ['a destination inside the store', () => ({ inside: true }), 'destination-in-evidence-store'],
    ['a destination that is not a local file', () => ({ remote: true }), 'destination-not-local-file']
  ] as const)('records one refused row for %s', async (_label, variant, refusal) => {
    const flags = variant() as { inside?: boolean; remote?: boolean };
    if (flags.inside || flags.remote) seedEvidence();
    const target = flags.inside
      ? { scheme: 'file', fsPath: join(workspaceRoot, '.schegent', 'sessions') }
      : { scheme: flags.remote ? 'vscode-remote' : 'file', fsPath: destination };

    await runExportRunEvidenceCommand(deps({ promptForDestination: async () => target }));

    expect(exportRows).toHaveLength(1);
    expect(exportRows[0]).toMatchObject({ kind: 'run-evidence', outcome: 'refused', included: 0, refusal });
  });

  it('records one refused row for a value that is not a Run id', async () => {
    await runExportRunEvidenceCommand(deps({ promptForRunId: async () => 'the failed one' }));
    expect(exportRows).toHaveLength(1);
    expect(exportRows[0]).toMatchObject({ outcome: 'refused', refusal: 'invalid-run-id' });
  });

  it('records nothing when the Run id prompt or the folder dialog is dismissed', async () => {
    seedEvidence();
    await runExportRunEvidenceCommand(deps({ promptForRunId: async () => undefined }));
    await runExportRunEvidenceCommand(deps({ promptForDestination: async () => undefined }));
    expect(exportRows).toEqual([]);
  });

  it('opens the folder dialog in the home directory', async () => {
    seedEvidence();
    const suggested: string[] = [];
    await runExportRunEvidenceCommand(
      deps({
        promptForDestination: async (suggestedPath: string) => {
          suggested.push(suggestedPath);
          return undefined;
        },
        homeDirectory: () => '/synthetic/home'
      })
    );
    expect(suggested).toEqual(['/synthetic/home']);
  });

  it('keeps the output and says it was not recorded when the append throws (O5)', async () => {
    seedEvidence();
    const result = await runExportRunEvidenceCommand(
      deps({
        auditExport: async () => {
          throw new Error('disk full');
        }
      })
    );

    expect(result?.outcome, 'the export happened and its result is returned').toBe('exported');
    expect(warnings.join(' ')).toContain(EXPORT_TEXT.notRecorded);
    expect(warnings.join(' ')).not.toContain('disk full');
    expect(existsSync(join(destination, 'manifest.json')), 'the output is not deleted').toBe(true);
  });

  it('refuses cleanly, rolls back partial files, records write-failed, and warns when sanitization fails mid-export (FR-R5-F14, NU-10)', async () => {
    seedEvidence();
    writeFileSync(join(workspaceRoot, '.schegent', 'audit.log'), '{"eventType":"run-started"}\n');
    let sanitizeCount = 0;
    const result = await runExportRunEvidenceCommand(
      deps({
        logger: {
          info: () => {},
          warn: () => {},
          sanitize: (value: string) => {
            sanitizeCount += 1;
            if (sanitizeCount >= 2) throw new RangeError('sanitizer failure');
            return value;
          }
        } as unknown as SanitizedLogger
      })
    );

    expect(result).toEqual({
      outcome: 'refused',
      reason: 'write-failed',
      detail: 'redaction-failed'
    });
    expect(exportRows).toHaveLength(1);
    expect(exportRows[0]).toMatchObject({
      kind: 'run-evidence',
      outcome: 'refused',
      included: 0,
      omitted: 0,
      refusal: 'write-failed'
    });
    expect(warnings.join(' ')).toContain(EXPORT_TEXT.refusal['write-failed']);
    expect(existsSync(join(destination, '.schegent__audit.log'))).toBe(false);
    expect(existsSync(join(destination, 'manifest.json'))).toBe(false);
  });
});
