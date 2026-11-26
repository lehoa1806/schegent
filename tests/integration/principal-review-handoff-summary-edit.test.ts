/**
 * Principal review Finding 4 — narrow host-side handoff summary patch (`op: 'editSummary'`)
 * preserves authentic sparse acceptance sequences, outcomes, decisions, constraints,
 * unresolved issues, artifacts, and sibling producer summaries, then renders them intact
 * into the next Phase's prompt.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManifestSource } from '../../src/contracts/phase-context/context-manifest';
import { validateInboundMessage } from '../../src/contracts/runtime-validators';
import { CMD_DECIDE_PHASE_HANDOFF } from '../../src/contracts/sidebar-ipc';
import { createPhaseContextApi } from '../../src/headless/phase-context-api';
import { SanitizedLogger } from '../../src/lib/logger';
import { SqliteApplicationStore } from '../../src/services/sqlite-store';
import { buildManifest, manifestDigestOf, parseManifest, serializeManifest } from '../../src/services/phase-context/manifest';
import { createSqliteHandoffStore } from '../../src/services/phase-context/sqlite-handoff-store';
import { createPhaseHandoffCoordinator } from '../../src/services/phase-context/phase-handoff-coordinator';
import { renderContext } from '../../src/services/phase-context/renderer';
import { handler as decideHandoffHandler } from '../../src/ui/sidebar/commands/cmd-decide-phase-handoff';
import type { HandlerContext } from '../../src/ui/sidebar/commands/handler-contract';

function makeSource(
  phaseId: string,
  attemptId: string,
  acceptedSequence: number,
  summary: string
): ManifestSource {
  return {
    producer: {
      nodePath: phaseId,
      occurrenceId: `occ-${phaseId}-1`,
      attemptId
    },
    acceptedSequence,
    coverage: 'complete',
    required: true,
    selectedBy: { kind: 'selector', id: `sel-${phaseId}` },
    outcomes: [`${phaseId}-outcome-preserved`],
    decisions: [`${phaseId}-decision-preserved`],
    constraints: [`${phaseId}-constraint-preserved`],
    unresolvedIssues: [`${phaseId}-issue-preserved`],
    summary,
    artifacts: [
      {
        artifactId: `art-${phaseId}`,
        immutableVersion: 'v1',
        digestHex: 'a'.repeat(64),
        byteSize: 128,
        kind: 'text'
      }
    ]
  };
}

describe('Principal review Finding 4 — host-side handoff summary patch', () => {
  it('validates editSummary IPC envelope, preserves sparse sequence (7 & 11) and all structured fields + sibling summary, and renders intact for the next Phase', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'schegent-f4-handoff-'));
    const sqlite = new SqliteApplicationStore({ databasePath: join(tmp, 'state.db') });
    try {
      const coordinator = createPhaseHandoffCoordinator({
        store: createSqliteHandoffStore(sqlite.writerConnection, () => 1_700_000_000_000),
        primaryWorkspaceRoot: tmp,
        workspaceId: 'ws-f4'
      });
      const api = createPhaseContextApi(() => coordinator);

      const srcSpec = makeSource('specify', 'att-spec-7', 7, 'Original specify summary');
      const srcPlan = makeSource('plan', 'att-plan-11', 11, 'Original plan summary');

      const manifest = buildManifest({
        revision: 1,
        previousRevision: null,
        origin: 'selected',
        identity: {
          workspaceId: 'ws-f4',
          rootExecutionId: 'root-f4',
          sourceInvocationId: 'frame-f4-1',
          targetNodePath: 'implement',
          targetOccurrenceId: 'occ-implement-1',
          inputEnvelopeRevision: 1,
          sourceAttempts: [srcSpec.producer, srcPlan.producer]
        },
        policyDigest: 'a'.repeat(64),
        approval: 'manual',
        session: 'fresh',
        cutoffSequence: 12,
        targetInstructionsDigest: 'b'.repeat(64),
        renderedBytesMax: 32 * 1024,
        sources: [srcSpec, srcPlan],
        omissions: [],
        omissionsUnlisted: 0
      });

      const serialized = serializeManifest(manifest);
      const accepted = coordinator.acceptance.accept({
        manifest,
        serialized,
        manifestDigest: manifestDigestOf(serialized),
        rendered: renderContext(manifest)
      });
      if (!accepted.ok) throw new Error(`accept failed: ${accepted.failure}/${accepted.detail}`);
      expect(accepted.ok).toBe(true);

      // 1. Validate narrow IPC command envelope through the generated runtime validator.
      const rawMsg = {
        type: CMD_DECIDE_PHASE_HANDOFF,
        correlationId: 'corr-edit-summary-1',
        payload: {
          op: 'editSummary',
          handoffId: manifest.handoffId,
          baseRevision: 1,
          summary: 'Curated specify summary only',
          producerAttemptId: 'att-spec-7'
        }
      };
      const validated = validateInboundMessage(rawMsg);
      expect(validated.ok).toBe(true);
      if (!validated.ok || validated.command.type !== CMD_DECIDE_PHASE_HANDOFF) {
        throw new Error('validator rejected valid editSummary command');
      }

      // 2. Drive the actual sidebar host command handler (`cmd-decide-phase-handoff.ts`).
      const acks: Array<{ status: string; reason?: string; result?: unknown }> = [];
      const ctx = {
        deps: {
          phaseContextApi: () => api,
          logger: new SanitizedLogger()
        },
        postAck: async (msg: unknown) => {
          acks.push(msg as { status: string; reason?: string; result?: unknown });
        },
        correlationId: 'corr-edit-summary-1'
      } as unknown as HandlerContext;

      await decideHandoffHandler(ctx, validated.command);
      expect(acks).toHaveLength(1);
      expect(acks[0]!.status).toBe('accepted');

      // 3. Inspect persisted revision 2 directly from SQLite and render next Phase prompt!
      const inspected = coordinator.acceptance.inspect(manifest.handoffId);
      expect(inspected.ok).toBe(true);
      if (!inspected.ok || inspected.record === null) throw new Error('inspect failed');
      expect(inspected.record.revisions).toHaveLength(2);
      const rev2 = inspected.record.revisions[1]!;
      expect(rev2.revision).toBe(2);
      expect(rev2.state).toBe('waiting-approval');

      const parsedRes = parseManifest(JSON.parse(rev2.serializedManifest));
      expect(parsedRes.kind).toBe('valid');
      if (parsedRes.kind !== 'valid') throw new Error(`parseManifest failed: ${parsedRes.kind}`);
      const parsedManifest = parsedRes.manifest;
      expect(parsedManifest.origin).toBe('edited');

      expect(parsedManifest.sources).toHaveLength(2);
      const specOut = parsedManifest.sources[0]!;
      const planOut = parsedManifest.sources[1]!;
      // Sparse acceptance sequences preserved verbatim (7 and 11, NOT 1 and 2!)
      expect(specOut.acceptedSequence).toBe(7);
      expect(planOut.acceptedSequence).toBe(11);
      // Targeted source summary updated; sibling summary untouched!
      expect(specOut.summary).toBe('Curated specify summary only');
      expect(planOut.summary).toBe('Original plan summary');
      // ALL structured evidence survived intact on both sources!
      expect(specOut.outcomes).toEqual(['specify-outcome-preserved']);
      expect(specOut.decisions).toEqual(['specify-decision-preserved']);
      expect(specOut.constraints).toEqual(['specify-constraint-preserved']);
      expect(specOut.unresolvedIssues).toEqual(['specify-issue-preserved']);
      expect(specOut.artifacts.map((a) => a.artifactId)).toEqual(['art-specify']);
      expect(planOut.outcomes).toEqual(['plan-outcome-preserved']);
      expect(planOut.artifacts.map((a) => a.artifactId)).toEqual(['art-plan']);

      // Rendered prompt for the next Phase carries the new summary AND every preserved field!
      const rendered = renderContext(parsedManifest);
      expect(rendered.text).toContain('Curated specify summary only');
      expect(rendered.text).toContain('Original plan summary');
      expect(rendered.text).toContain('specify-outcome-preserved');
      expect(rendered.text).toContain('specify-decision-preserved');
      expect(rendered.text).toContain('specify-constraint-preserved');
      expect(rendered.text).toContain('specify-issue-preserved');
      expect(rendered.text).toContain('art-specify');
      expect(rendered.text).toContain('plan-outcome-preserved');

      // 4. Negative controls: forbidden control/bidi/line-separator/surrogate characters MUST be
      //    refused before persistence so SQLite can never be self-bricked!
      for (const hostileSummary of [
        'Windows\r\nCRLF paste',
        'Null\u0000byte',
        'Ansi\u001b[31mred',
        'Bidi\u202eoverride',
        'LineSep\u2028break',
        'Lone\ud800surrogate'
      ]) {
        const refused = api.editHandoffSummary(
          manifest.handoffId,
          2,
          hostileSummary,
          'att-spec-7'
        );
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
          expect(refused.failure).toBe('invalid-source');
          expect(refused.detail).toBe('edit-summary');
        }
      }

      // 5. Negative control: omitting `producerAttemptId` on a multi-producer handoff must fail
      //    closed instead of clobbering every source's summary.
      const ambiguous = api.editHandoffSummary(
        manifest.handoffId,
        2,
        'Would overwrite all sources'
      );
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) {
        expect(ambiguous.failure).toBe('invalid-source');
        expect(ambiguous.detail).toBe('edit-ambiguous-source');
      }

      // 6. Handoff remains intact, readable, and approvable after all refused edits.
      const approved = api.approveHandoff(
        manifest.handoffId,
        2,
        'dec-approve-after-refusals'
      );
      expect(approved.ok).toBe(true);
    } finally {
      sqlite.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
