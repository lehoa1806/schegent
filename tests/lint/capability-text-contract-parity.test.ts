// FR-R3-086 — every operator-facing sentence about the mechanism cites a
// declared audit event or a source constant, and the contract is declared FIRST.
//
// `D2` exists because a manifest promised a record the contract did not declare.
// FR-R3-086 §3 names it directly: "The audit contract extended with the events
// the mechanism actually emits, declared in `repo/src/contracts/audit-events.ts`
// BEFORE the claim is made anywhere in operator-facing text … this item must not
// repeat it."
//
// So the direction of the check matters. It is not "does the contract match the
// docs" — it is "does every event a document names exist in the contract", which
// fails when prose runs ahead of the mechanism and passes when the mechanism runs
// ahead of the prose. Those are not symmetric, and only one of them is a defect.
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_AUDIT_EVENT_TYPES } from '../../src/contracts/audit-events';
import { ALL_PHASE_CAPABILITIES } from '../../src/contracts/phase-capabilities';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(REPO_ROOT, '..');

const read = (absolute: string): string => readFileSync(absolute, 'utf8');

/** Operator-facing surfaces that describe the capability mechanism. */
const SURFACES = [
  { root: REPO_ROOT, path: 'docs/security/threat-model.md' },
  { root: ENVELOPE_ROOT, path: 'docs/architecture/agent-capability-posture.md' }
] as const;

const declaredEvents = new Set<string>(ALL_AUDIT_EVENT_TYPES as readonly string[]);

describe('FR-R3-086 — operator-facing text cannot name an event the contract lacks', () => {
  it('the refusal event is declared in the contract', () => {
    // Contract first. If this fails, nothing below is worth checking.
    expect(declaredEvents.has('capability-refused')).toBe(true);
  });

  it('the capability union is closed and non-empty', () => {
    expect(ALL_PHASE_CAPABILITIES.length).toBeGreaterThan(2);
    expect(new Set(ALL_PHASE_CAPABILITIES).size).toBe(ALL_PHASE_CAPABILITIES.length);
  });

  it.each(SURFACES.map((surface) => [surface.path, surface] as const))(
    '%s names no audit event the contract does not declare',
    (_path, surface) => {
      const absolute = resolve(surface.root, surface.path);
      if (!existsSync(absolute)) {
        // A repo-only clone cannot see the envelope. Degrade rather than fail —
        // a gate that makes a standalone checkout red for a document that is not
        // part of it is a gate someone deletes.
        expect(existsSync(absolute)).toBe(false);
        return;
      }
      const body = read(absolute);
      // Backticked spans that LOOK like an audit event type: lower-kebab, at
      // least two segments, and matching the shape the contract uses.
      const candidates = [...body.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+){1,4})`/g)]
        .map((match) => match[1] as string)
        // Only judge spans that already look like event types this feature or
        // its neighbours emit; a settings id or a flag is not a claim about the
        // audit contract.
        .filter((token) => /^(capability|backend|phase|run|process|queue)-/.test(token))
        // Capabilities share the lower-kebab shape and live in a DIFFERENT
        // namespace: `process-spawn` is something an agent may do, not something
        // the audit log records. Conflating the two made this gate report a
        // correctly-declared capability as an undeclared event on its first run.
        .filter((token) => !(ALL_PHASE_CAPABILITIES as readonly string[]).includes(token));
      const undeclared = [...new Set(candidates)].filter((token) => !declaredEvents.has(token));
      expect(
        undeclared,
        `${surface.path} names event-shaped token(s) the audit contract does not declare. ` +
          `Declare them in src/contracts/audit-events.ts first — D2 exists because a manifest ` +
          `promised a record the contract did not carry.`
      ).toEqual([]);
    }
  );

  it('the threat model states what the mechanism does NOT bound, beside what it does', () => {
    // A containment claim without its limits is the R-14 class, and FR-R3-086 §4
    // requires the limits in the SAME section rather than in a footnote.
    const body = read(resolve(REPO_ROOT, 'docs/security/threat-model.md'));
    expect(body).toContain('The host does not observe tool calls');
    expect(body).toContain('refused before it starts');
    expect(body).toContain('The default is unchanged');
    expect(body).toContain('not a mediated broker');
  });

  it('every capability named in operator-facing text is a member of the closed union', () => {
    const body = read(resolve(REPO_ROOT, 'docs/security/threat-model.md'));
    const named = [...body.matchAll(/`(workspace-write|outside-workspace-write|process-spawn|network)`/g)].map(
      (match) => match[1] as string
    );
    expect(named.length).toBeGreaterThan(2);
    for (const capability of named) {
      expect(ALL_PHASE_CAPABILITIES as readonly string[]).toContain(capability);
    }
  });

  it('NON-VACUITY: an undeclared event-shaped token is detected', () => {
    const probe = 'The mechanism emits `capability-quietly-ignored` on refusal.';
    const candidates = [...probe.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+){1,4})`/g)]
      .map((match) => match[1] as string)
      .filter((token) => /^(capability|backend|phase|run|process|queue)-/.test(token));
    expect(candidates).toContain('capability-quietly-ignored');
    expect(candidates.filter((token) => !declaredEvents.has(token))).toHaveLength(1);
  });
});
