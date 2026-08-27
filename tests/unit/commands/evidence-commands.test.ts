// FR-R3-127 (T018) — the two commands `evidence-retention-disclosure.md` promised.
//
// The services own the behaviour and carry their own tests. What is asserted here
// is what a palette invocation adds: the three inputs, the confirmation, and the
// rendering of an outcome union arm by arm — because collapsing "refused, a writer
// is live" and "there was nothing to remove" into one message would make opposite
// facts read the same.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  destinationIsInsideEvidenceStore,
  runDeleteRunEvidenceCommand,
  runExportRunEvidenceCommand,
  type EvidenceCommandDeps
} from '../../../src/commands/evidence-commands';
import type { Notifier } from '../../../src/ui/notifications';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { DeleteOutcome } from '../../../src/services/evidence-delete';

const RUN = '11111111-1111-4111-8111-111111111111';

let workspaceRoot: string;
let destination: string;
let warnings: string[];
let audited: DeleteOutcome[];

function deps(overrides: Partial<EvidenceCommandDeps> = {}): EvidenceCommandDeps {
  return {
    workspaceRoot,
    isRunActive: () => false,
    promptForRunId: async () => RUN,
    promptForDestination: async () => destination,
    confirmDelete: async () => true,
    notifier: { warn: (m: string) => { warnings.push(m); return Promise.resolve(undefined); } } as unknown as Notifier,
    logger: { info: () => {}, warn: () => {} } as unknown as SanitizedLogger,
    auditDeletion: async (_runId, outcome) => { audited.push(outcome); },
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
    expect(warnings.join(' ')).toMatch(/removed \d+ evidence artifact/);
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
      deps({ promptForDestination: async () => inside })
    );
    expect(result).toBeNull();
    expect(warnings.join(' ')).toMatch(/refusing to export into/);
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
