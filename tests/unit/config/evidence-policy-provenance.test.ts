/**
 * FR-R3-096 — `required` gains teeth, and the migration that makes it safe to.
 *
 * THE PROBLEM THIS FILE IS ABOUT is not the enforcement. It is that
 * `snapshotPhaseDef` has resolved an omitted `evidencePolicy` to `'required'`
 * since the field existed, so `'required'` is already written into every snapshot
 * ever taken — by every Phase that never declared one. The stored value therefore
 * describes a population, not a decision, and enforcing on it would retroactively
 * tighten runs whose authors said nothing, on the decision where a silent
 * retroactive change is worst: what advances a Phase.
 *
 * `evidencePolicyDeclaredAt` is the datum that separates the two, and **absence
 * reads as defaulted** — so the migration is not a version comparison anyone has
 * to maintain. Every snapshot written before the origin existed carries no origin,
 * and is un-enforced by construction.
 *
 * The enforcement itself is pinned next door in
 * `tests/unit/parser/invocation-warnings.test.ts`, beside the safety property it
 * had to preserve. This file is about where the origin comes from and what
 * happens to the rows that predate it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotPhaseDef } from '../../../src/config/pipeline-snapshot';
import type { PhaseDef } from '../../../src/config/pipeline-config';
import { parseInvocation } from '../../../src/parser/stdout-parser';
import { parseAuditLogBlock } from '../../../src/parser/audit-log-parser';
import { validatePhaseDefinition } from '../../../src/config/process-definition-validator';

const TOKEN = '[SCHEGENT_STATUS: CLEAR]';
const PRE_082_STATE = join(__dirname, '../../fixtures/state/pre-082-workspace-state.json');

function phase(overrides: Partial<PhaseDef> = {}): PhaseDef {
  return { id: 'speckit-implement', name: 'Implement', instruction: 'do it', ...overrides };
}

/** Drive one snapshotted phase through the real parser on a no-audit-block turn. */
function advances(snapshot: Pick<PhaseDef, 'evidencePolicy' | 'evidencePolicyDeclaredAt'>): boolean {
  const audit = parseAuditLogBlock(TOKEN);
  const result = parseInvocation({
    stdout: TOKEN,
    stderr: '',
    exitCode: 0,
    rateLimit: { matched: false, cause: '' },
    auditEntry: audit.entry,
    auditWarnings: audit.warnings,
    region: audit.region,
    evidencePolicy: snapshot.evidencePolicy,
    evidencePolicyDeclaredAt: snapshot.evidencePolicyDeclaredAt
  });
  return result.kind === 'clean';
}

describe('FR-R3-096 — the freeze records where evidencePolicy came from', () => {
  it('marks an authored policy `phase-definition`, whatever the value', () => {
    for (const declared of ['required', 'best-effort', 'none'] as const) {
      const snapshot = snapshotPhaseDef(phase({ evidencePolicy: declared }));
      expect(snapshot.evidencePolicy).toBe(declared);
      expect(snapshot.evidencePolicyDeclaredAt).toBe('phase-definition');
    }
  });

  it('marks an omitted policy `default`, and still stores `required`', () => {
    // Both halves matter. The stored VALUE is unchanged -- FR-R3-096 §5 forbids
    // enforcing by editing the default, because changing `?? 'required'` would
    // not reach the snapshots already written and would leave two populations
    // with the same value meaning different things.
    const snapshot = snapshotPhaseDef(phase());
    expect(snapshot.evidencePolicy).toBe('required');
    expect(snapshot.evidencePolicyDeclaredAt).toBe('default');
  });

  it('re-freezing a snapshot does not promote a defaulted policy to an authored one', () => {
    // The teeth-by-accident path. After one freeze the phase carries a literal
    // `evidencePolicy: 'required'` that nobody authored; a second freeze that
    // recomputed provenance from the value would read it as a declaration and
    // silently start withholding advancement for a Phase that never asked.
    const once = snapshotPhaseDef(phase());
    const twice = snapshotPhaseDef(once);
    expect(twice.evidencePolicy).toBe('required');
    expect(twice.evidencePolicyDeclaredAt).toBe('default');
    expect(advances(twice)).toBe(true);
  });

  it('an authored `required` survives a re-freeze as authored', () => {
    // Non-vacuity for the guard above: carrying the origin forward must preserve
    // both answers, not pin every re-freeze to `default`.
    const twice = snapshotPhaseDef(snapshotPhaseDef(phase({ evidencePolicy: 'required' })));
    expect(twice.evidencePolicyDeclaredAt).toBe('phase-definition');
    expect(advances(twice)).toBe(false);
  });

  it('refuses an authored document that tries to declare its own provenance', () => {
    // Provenance is derived, never authored. A document that could set it could
    // forge the consent the whole design turns on -- or, more likely, clear it
    // and opt a Phase out of an enforcement its author did ask for.
    const result = validatePhaseDefinition({
      phaseId: 'forged',
      name: 'Forged',
      version: 1,
      instruction: 'x',
      evidencePolicy: 'required',
      evidencePolicyDeclaredAt: 'phase-definition'
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'unknown-field')).toBe(true);
  });
});

describe('FR-R3-096 — the population that already exists is untouched', () => {
  it('a REAL captured pre-feature run carries no origin and still advances', () => {
    // `pre-082-workspace-state.json` is a captured memento, not a hand-written
    // one: a persisted Run from before any of this existed. Its phases declare no
    // `evidencePolicy` at all, which is the shape the majority of persisted rows
    // have. Read through the parser, every one of them advances clean on a turn
    // with no audit block -- exactly as it did before FR-R3-096.
    const state = JSON.parse(readFileSync(PRE_082_STATE, 'utf8')) as Record<string, unknown>;
    const run = state['schegent.run'] as { pipeline: { phases: PhaseDef[] } };
    expect(run.pipeline.phases.length).toBeGreaterThan(0);
    for (const persisted of run.pipeline.phases) {
      expect(persisted.evidencePolicyDeclaredAt).toBeUndefined();
      expect(advances(persisted)).toBe(true);
    }
  });

  it('a snapshot written by the PRE-096 freeze advances, baked-in `required` and all', () => {
    // The harder population, and the one FR-R3-096 was really filed about: rows
    // written after `?? 'required'` existed and before the origin did, which carry
    // a literal `required` nobody authored.
    //
    // RECONSTRUCTED, and labelled as such. No captured example of this shape
    // exists in the tree, so it is produced by taking today's freeze and removing
    // the one field the old writer did not emit -- which is precisely the
    // difference between the two writers and nothing else. The captured fixture
    // above is the real evidence; this covers the rows it cannot speak for.
    const { evidencePolicyDeclaredAt: _dropped, ...preO96 } = snapshotPhaseDef(phase());
    expect(preO96.evidencePolicy).toBe('required');
    expect('evidencePolicyDeclaredAt' in preO96).toBe(false);
    expect(advances(preO96)).toBe(true);
  });

  it('and the same row starts withholding the moment its author declares one', () => {
    // Non-vacuity for both cases above: `advances() === true` must mean "this row
    // was not enforced", never "the parser advances everything".
    expect(advances(snapshotPhaseDef(phase({ evidencePolicy: 'required' })))).toBe(false);
  });
});
