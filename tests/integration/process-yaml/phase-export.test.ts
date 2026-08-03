// Feature 084 T025 — Phase export, end to end through the sidebar command.
//
// Covers quickstart scenarios QS-1 through QS-7. The handler is driven with a
// fake `RouterDeps` so the whole path is exercised — catalog resolution, the
// mapper, the serializer, the save adapter, the ack, and the audit append —
// without a VS Code host.
//
// The scenario this file exists to pin hardest is QS-7: after an export, no
// configuration key, no state field, no audit record, and no ack payload
// carries the location the operator chose. The adapter is the only thing that
// ever sees one, and it is given a bare file name, not a location.

import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';
import { CMD_EXPORT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ExportProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { documentFromPhaseDefinition } from '../../../src/services/process-yaml/phase-yaml-mapper';
import { serializePhaseDocument } from '../../../src/services/process-yaml/yaml-serializer';
import { handler as exportHandler } from '../../../src/ui/sidebar/commands/cmd-export-process-yaml';

interface AuditEntry {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly outcome: string;
  readonly runId: string;
}

interface Harness {
  readonly ctx: Parameters<typeof exportHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly audits: AuditEntry[];
  readonly saved: { suggestedFileName: string; text: string }[];
  readonly warnings: string[];
}

function buildHarness(
  opts: {
    user?: readonly unknown[];
    workspace?: readonly unknown[];
    saveResult?: Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>;
    saveThrows?: Error;
    withSaveAdapter?: boolean;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const saved: { suggestedFileName: string; text: string }[] = [];
  const warnings: string[] = [];

  const saveProcessYamlDocument = async (request: {
    suggestedFileName: string;
    text: string;
  }): Promise<Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>> => {
    if (opts.saveThrows) throw opts.saveThrows;
    saved.push({ ...request });
    return opts.saveResult ?? { outcome: 'saved' };
  };

  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: opts.user ?? [], workspace: opts.workspace ?? [] }),
      ...(opts.withSaveAdapter === false ? {} : { saveProcessYamlDocument }),
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'export-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, acks, audits, saved, warnings };
}

function command(resourceId: string): ExportProcessYamlCommand {
  return {
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'export-test-1',
    payload: { resourceKind: 'phase', resourceId }
  };
}

/** A complete, valid authored row for the writable layers. */
const AUTHORED_PHASE = Object.freeze({
  phaseId: 'ship-it',
  name: 'Ship It',
  version: 3,
  instruction: 'Ship the thing.',
  model: 'claude-opus-5',
  timeoutSeconds: 900
});

describe('Feature 084 — Phase export (QS-1..QS-7)', () => {
  it('QS-1 exports exactly the declared fields and nothing else', async () => {
    const h = buildHarness({ user: [AUTHORED_PHASE] });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved).toHaveLength(1);
    const text = h.saved[0]!.text;
    expect(text).toContain('apiVersion: schegent/v1');
    expect(text).toContain('kind: Phase');
    expect(text).toContain('phaseId: ship-it');
    expect(text).toContain('name: Ship It');
    expect(text).toContain('version: 3');
    expect(text).toContain('instruction: Ship the thing.');
    expect(text).toContain('model: claude-opus-5');
    expect(text).toContain('timeoutSeconds: 900');

    // Nothing else: every top-level and nested key in the document is one of
    // the eight above, so an added field fails here rather than shipping.
    const keys = text
      .split('\n')
      .map((line) => line.match(/^\s*([A-Za-z][A-Za-z0-9]*):/)?.[1])
      .filter((key): key is string => key !== undefined);
    expect([...keys].sort()).toEqual([
      'apiVersion',
      'instruction',
      'kind',
      'metadata',
      'model',
      'name',
      'phaseId',
      'spec',
      'timeoutSeconds',
      'version'
    ]);
  });

  it('QS-2 is deterministic — ten exports of an unchanged Phase are byte-identical', async () => {
    const texts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const h = buildHarness({ user: [AUTHORED_PHASE] });
      await exportHandler(h.ctx, command('ship-it'));
      texts.push(h.saved[0]!.text);
    }
    expect(new Set(texts).size).toBe(1);
  });

  it('QS-3 omits an absent optional rather than writing the host default', async () => {
    const h = buildHarness({ user: [AUTHORED_PHASE] });
    await exportHandler(h.ctx, command('ship-it'));

    // The authored row declares no `effort`, `loopable`, `isRequired`,
    // `retryCondition`, `runner`, or `description`.
    const text = h.saved[0]!.text;
    for (const absent of [
      'effort',
      'loopable',
      'isRequired',
      'retryCondition',
      'runner',
      'description'
    ]) {
      expect(text, `${absent} must not be defaulted into the document`).not.toContain(
        `${absent}:`
      );
    }
  });

  it('QS-4 emits no non-portable field from a definition that carries them at runtime', () => {
    // The document type has no key for a host-resolved field, so the mapper
    // reads named keys only. Feeding it an object that does carry them proves
    // the emitter drops them rather than relying on the type to be enough
    // (FR-009, FR-010, SC-008).
    const definition = {
      phaseId: 'ship-it',
      name: 'Ship It',
      version: 3,
      instruction: 'Ship the thing.',
      sideEffects: ['writes-files'],
      evidencePolicy: 'strict',
      promptVersion: 7,
      sourceScope: 'user'
    } as unknown as PhaseDefinition;

    const text = serializePhaseDocument(documentFromPhaseDefinition(definition));
    for (const field of ['sideEffects', 'evidencePolicy', 'promptVersion', 'sourceScope']) {
      expect(text, `${field} must not appear in the document`).not.toContain(field);
    }
  });

  it('QS-4 refuses to export a stored row that declares a non-portable field', async () => {
    // The other half: the catalog treats a non-portable key on an authored row
    // as an unknown field, so the row carries no valid definition and export
    // reports it rather than quietly emitting a stripped document.
    const h = buildHarness({
      user: [{ ...AUTHORED_PHASE, sideEffects: ['writes-files'] }]
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('QS-5 exports the effective definition when a layer shadows a built-in', async () => {
    const builtIn = BUILT_IN_PHASES.find((p) => p.id === 'speckit-specify');
    expect(builtIn).toBeDefined();

    const h = buildHarness({
      user: [
        {
          phaseId: 'speckit-specify',
          name: 'Locally Overridden Specify',
          version: 2,
          instruction: 'Use the local house style.',
          model: 'claude-sonnet-5'
        }
      ]
    });
    await exportHandler(h.ctx, command('speckit-specify'));

    const text = h.saved[0]!.text;
    expect(text).toContain('name: Locally Overridden Specify');
    expect(text).toContain('model: claude-sonnet-5');
    // The shadowed built-in's own values are not what this installation runs.
    expect(text).not.toContain(`name: ${builtIn!.name}`);
  });

  it('QS-6 reports a row that exists but does not resolve as does-not-resolve', async () => {
    // `timeoutSeconds` as a string fails validation, so the row is stored but
    // carries no valid definition.
    const h = buildHarness({
      user: [{ ...AUTHORED_PHASE, timeoutSeconds: 'not-a-number' }]
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved).toHaveLength(0);
    const ack = h.acks[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('QS-6 reports an id no layer mentions as not-found', async () => {
    const h = buildHarness({ user: [AUTHORED_PHASE] });
    await exportHandler(h.ctx, command('no-such-phase'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'not-found' });
  });

  it('QS-7 records no location in the ack, the audit payload, or the adapter request', async () => {
    const h = buildHarness({ user: [AUTHORED_PHASE] });
    await exportHandler(h.ctx, command('ship-it'));

    // The response says the document was saved and nothing about where.
    const ack = h.acks[0]!;
    expect(ack.status).toBe('accepted');
    expect(ack.result).toEqual({ outcome: 'saved' });

    // The adapter is handed a bare name, never a location.
    expect(h.saved[0]!.suggestedFileName).toBe('ship-it.phase.yaml');
    expect(h.saved[0]!.suggestedFileName).not.toContain('/');
    expect(h.saved[0]!.suggestedFileName).not.toContain('\\');

    // The audit payload is bounded to operation, ids, scope, outcomes, counts.
    expect(h.audits).toHaveLength(1);
    const entry = h.audits[0]!;
    expect(entry.eventType).toBe('process-exchange-export');
    expect(entry.outcome).toBe('info');
    expect(Object.keys(entry.payload).sort()).toEqual([
      'counts',
      'operation',
      'outcomes',
      'resourceIds',
      'resourceKind',
      'scope'
    ]);
    expect(entry.payload).toMatchObject({
      operation: 'export',
      resourceKind: 'phase',
      resourceIds: ['ship-it'],
      scope: 'user',
      outcomes: ['saved'],
      counts: { exported: 1 }
    });

    // Neither the audit entry nor the ack mentions a file name or a separator.
    const serialized = JSON.stringify({ ack, audit: entry });
    expect(serialized).not.toContain('.phase.yaml');
    expect(serialized).not.toContain('/Users');
    expect(serialized).not.toContain('\\\\');
  });

  it('reports a canceled dialog without treating it as a failure', async () => {
    const h = buildHarness({ user: [AUTHORED_PHASE], saveResult: { outcome: 'canceled' } });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'canceled' });
    expect(h.audits[0]!.payload).toMatchObject({
      outcomes: ['canceled'],
      counts: { exported: 0 }
    });
    expect(h.audits[0]!.outcome).toBe('info');
  });

  it('turns an adapter throw into a generic failure and keeps the detail in the log', async () => {
    const h = buildHarness({
      user: [AUTHORED_PHASE],
      saveThrows: new Error('EACCES: permission denied writing the chosen location')
    });
    await exportHandler(h.ctx, command('ship-it'));

    const ack = h.acks[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.result).toEqual({ outcome: 'failed', message: 'Could not write the document.' });
    // The adapter's own message can name a location, so it stays in the log.
    expect(JSON.stringify(ack)).not.toContain('EACCES');
    expect(h.warnings.join('\n')).toContain('EACCES');
    expect(h.audits[0]!.outcome).toBe('failure');
  });

  it('rejects cleanly when the host wired no save adapter', async () => {
    const h = buildHarness({ user: [AUTHORED_PHASE], withSaveAdapter: false });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toMatchObject({ outcome: 'failed' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['failed'], scope: 'user' });
  });
});
