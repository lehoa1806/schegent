// Feature 085 T019 — Pipeline export, references-only, end to end.
//
// The 084 handler is extended rather than duplicated, so this file mirrors
// `phase-export.test.ts`'s harness and asserts the two things the Pipeline
// branch adds:
//
//   * the document is a package root with NO `included` section at all
//     (FR-013) — not an empty one, not a null one, absent;
//   * a Pipeline whose referenced Phases resolve nowhere is still exportable
//     (FR-018), carrying its full ordered `phaseIds`.
//
// Those two pull against FR-014 ("export reads the EFFECTIVE catalog"), because
// `resolvePipelineCatalog` nulls a row's definition and marks it `invalid` on
// ANY error, and two of its errors are reference-class: `unknown-phase` and
// `binding-unknown-phase`. Research R11 records the resolution — strict
// resolution first, and a reference-relaxed second pass reached only when the
// strict pass found nothing. The tests below pin both halves: the relaxed pass
// must rescue a missing-Phase Pipeline, and it must never promote a layer over
// one that actually runs.

import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_PIPELINES } from '../../../src/config/pipeline-config';
import { CMD_EXPORT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ExportProcessYamlResult,
  PipelineExportInclusion
} from '../../../src/contracts/sidebar-ipc';
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
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
}

interface HarnessOptions {
  readonly pipelines?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
  readonly phases?: { user?: readonly unknown[]; workspace?: readonly unknown[] };
  readonly saveResult?: Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>;
  readonly saveThrows?: Error;
  readonly withSaveAdapter?: boolean;
}

function buildHarness(opts: HarnessOptions = {}): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const saved: { suggestedFileName: string; text: string }[] = [];
  const warnings: string[] = [];
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();

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
      readPipelineConfig: () => ({
        user: opts.pipelines?.user ?? [],
        workspace: opts.pipelines?.workspace ?? []
      }),
      readPhaseConfig: () => ({
        user: opts.phases?.user ?? [],
        workspace: opts.phases?.workspace ?? []
      }),
      updateConfig,
      executeCommand,
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
    correlationId: 'pipeline-export-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, acks, audits, saved, warnings, updateConfig, executeCommand };
}

function command(
  resourceId: string,
  inclusion: PipelineExportInclusion = 'references-only'
): ExportProcessYamlCommand {
  return {
    type: CMD_EXPORT_PROCESS_YAML,
    correlationId: 'pipeline-export-1',
    payload: { resourceKind: 'pipeline', resourceId, inclusion }
  };
}

/** The same export, with the operator asking for the referenced definitions. */
function includingCommand(resourceId: string): ExportProcessYamlCommand {
  return command(resourceId, 'include-referenced');
}

/** A Phase row good enough to resolve, so a Pipeline may legally name its id. */
function phaseRow(phaseId: string, name = phaseId): Record<string, unknown> {
  return { phaseId, name, version: 1, instruction: `Run ${name}.` };
}

const PHASE_LAYER = Object.freeze([
  phaseRow('draft', 'Draft'),
  phaseRow('review', 'Review')
]);

/**
 * US1's independent test subject: two ports, three ordered Phase references
 * with a repeat, and two bindings. The repeat is why bindings address a Phase by
 * `phaseIndex` and never by `phaseId`, and why the sequence's order is data.
 */
const AUTHORED_PIPELINE = Object.freeze({
  pipelineId: 'ship-it',
  name: 'Ship It',
  description: 'Draft, review, draft again.',
  version: 3,
  phaseIds: Object.freeze(['draft', 'review', 'draft']),
  inputs: Object.freeze([
    { portId: 'brief', label: 'Brief', type: 'text', required: true },
    { portId: 'carried', label: 'Carried', type: 'pipeline-output' }
  ]),
  outputs: Object.freeze([{ portId: 'carried', label: 'Carried', type: 'markdown' }]),
  bindings: Object.freeze([
    {
      kind: 'input',
      phaseIndex: 0,
      inputKey: 'brief',
      source: { from: 'pipeline-input', portId: 'brief' }
    },
    { kind: 'output', phaseIndex: 0, portId: 'carried', outputKey: 'draft' }
  ]),
  executionDefaults: Object.freeze({ effort: 'high', timeoutSeconds: 900 }),
  recommendedNext: Object.freeze(['ship-it-again'])
});

/** The same Pipeline, naming Phases no layer defines. Nothing else differs. */
const GHOST_PIPELINE = Object.freeze({
  ...AUTHORED_PIPELINE,
  phaseIds: Object.freeze(['ghost-one', 'ghost-two', 'ghost-one'])
});

describe('Feature 085 — export one Pipeline, references-only (US1, FR-011..FR-014)', () => {
  it('writes a package document naming the Pipeline, its ports, sequence, and bindings', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.acks[0]!.status).toBe('accepted');
    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(h.saved).toHaveLength(1);

    const text = h.saved[0]!.text;
    expect(text).toContain('apiVersion: schegent/v1');
    expect(text).toContain('kind: Pipeline');
    expect(text).toContain('  id: ship-it');
    expect(text).toContain('  name: Ship It');
    expect(text).toContain('  version: 3');
    expect(text).toContain('    - portId: brief');
    expect(text).toContain('    - portId: carried');
    expect(text).toContain('      inputKey: brief');
    expect(text).toContain('      outputKey: draft');
    expect(text).toContain('    effort: high');
    expect(text).toContain('    - ship-it-again');
  });

  it('preserves the ordered sequence including a repeated Phase (US1 scenario 2)', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved[0]!.text).toContain(
      ['  phaseIds:', '    - draft', '    - review', '    - draft', ''].join('\n')
    );
  });

  it('carries no included section at all (FR-013)', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('included');
    // Nor the Phase bodies an inclusion export would carry: a referenced Phase
    // appears only as its identifier in `phaseIds`.
    expect(text).not.toContain('kind: Phase');
    expect(text).not.toContain('instruction:');
    const topLevel = text
      .split('\n')
      .filter((line) => /^[A-Za-z]/.test(line))
      .map((line) => line.split(':')[0]);
    expect(topLevel).toEqual(['apiVersion', 'kind', 'metadata', 'spec']);
  });

  it('exports the layer that actually runs, not a shadowed copy (FR-014, US1 scenario 3)', async () => {
    const h = buildHarness({
      pipelines: {
        user: [{ ...AUTHORED_PIPELINE, name: 'User Copy' }],
        workspace: [{ ...AUTHORED_PIPELINE, name: 'Workspace Copy', version: 7 }]
      },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    const text = h.saved[0]!.text;
    expect(text).toContain('  name: Workspace Copy');
    expect(text).toContain('  version: 7');
    expect(text).not.toContain('User Copy');
    expect(h.audits[0]!.payload).toMatchObject({ scope: 'workspace' });
  });

  it('exports a built-in Pipeline no layer overrides', async () => {
    const builtIn = BUILT_IN_PIPELINES[0]!;
    const h = buildHarness();
    await exportHandler(h.ctx, command(builtIn.id));

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.text).toContain(`  id: ${builtIn.id}`);
    expect(h.audits[0]!.payload).toMatchObject({ scope: 'built-in' });
  });

  it('is deterministic — ten exports of an unchanged Pipeline are byte-identical', async () => {
    const texts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const h = buildHarness({
        pipelines: { user: [AUTHORED_PIPELINE] },
        phases: { user: PHASE_LAYER }
      });
      await exportHandler(h.ctx, command('ship-it'));
      texts.push(h.saved[0]!.text);
    }
    expect(new Set(texts).size).toBe(1);
  });
});

describe('Feature 085 — references-only never requires the Phases to resolve (FR-018)', () => {
  it("exports a Pipeline whose Phases are missing from every layer, sequence intact", async () => {
    // US1's independent test for FR-018. No Phase layer defines `ghost-one` or
    // `ghost-two`, so the strict resolution marks every row `invalid` with
    // `unknown-phase`/`binding-unknown-phase` and produces no effective record.
    // The document is still produced (research R11).
    const h = buildHarness({ pipelines: { user: [GHOST_PIPELINE] } });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(h.saved[0]!.text).toContain(
      ['  phaseIds:', '    - ghost-one', '    - ghost-two', '    - ghost-one', ''].join('\n')
    );
  });

  it('a Phase that resolves nowhere is still only an identifier in the document (FR-009)', async () => {
    const h = buildHarness({ pipelines: { user: [GHOST_PIPELINE] } });
    await exportHandler(h.ctx, command('ship-it'));

    const text = h.saved[0]!.text;
    expect(text).not.toContain('included');
    expect(text).not.toContain('kind: Phase');
  });

  it('the relaxation never promotes a layer over one that actually runs (FR-014)', async () => {
    // The hazard research R11 names: relax first and the workspace row, whose
    // only defect is a missing Phase, outranks a user row that genuinely
    // resolves — and export would emit bytes this installation does not run.
    // Strict-first makes that unreachable.
    const h = buildHarness({
      pipelines: {
        user: [{ ...AUTHORED_PIPELINE, name: 'Runs Here' }],
        workspace: [{ ...GHOST_PIPELINE, name: 'Never Runs' }]
      },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved[0]!.text).toContain('  name: Runs Here');
    expect(h.saved[0]!.text).not.toContain('Never Runs');
    expect(h.audits[0]!.payload).toMatchObject({ scope: 'user' });
  });

  it('relaxes only the reference-class defects, never a structural one', async () => {
    // Same missing Phases, plus a binding that reads a port the Pipeline never
    // declares. `binding-unknown-input-port` is computed from the definition's
    // own ports, so no Phase catalog can suppress it and the row stays invalid.
    const h = buildHarness({
      pipelines: {
        user: [
          {
            ...GHOST_PIPELINE,
            bindings: [
              {
                kind: 'input',
                phaseIndex: 0,
                inputKey: 'brief',
                source: { from: 'pipeline-input', portId: 'undeclared' }
              }
            ]
          }
        ]
      }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('relaxes nothing for a binding that points outside the sequence', async () => {
    const h = buildHarness({
      pipelines: {
        user: [
          {
            ...GHOST_PIPELINE,
            bindings: [{ kind: 'output', phaseIndex: 9, portId: 'carried', outputKey: 'draft' }]
          }
        ]
      }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });
});

describe('Feature 085 — the two absences stay told apart (FR-015)', () => {
  it('reports an intrinsically broken row as does-not-resolve', async () => {
    const h = buildHarness({
      pipelines: { user: [{ ...AUTHORED_PIPELINE, version: 'not-a-number' }] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'does-not-resolve' });
  });

  it('reports an id no layer mentions as not-found', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('no-such-pipeline'));

    expect(h.saved).toHaveLength(0);
    expect(h.acks[0]!.result).toEqual({ outcome: 'unavailable', reason: 'not-found' });
  });

  it('never reports dependency-does-not-resolve for a references-only export', async () => {
    // That reason belongs to US2's inclusion path alone (FR-017). Reaching it
    // here would be FR-018 broken with a friendlier message.
    const h = buildHarness({ pipelines: { user: [GHOST_PIPELINE] } });
    await exportHandler(h.ctx, command('ship-it'));

    expect(JSON.stringify(h.acks[0]!)).not.toContain('dependency-does-not-resolve');
  });
});

describe('Feature 085 — export one Pipeline with its Phases (US2, FR-015..FR-019)', () => {
  it('carries a complete definition for each distinct referenced Phase', async () => {
    // FR-015/FR-016 — `phaseIds` is ['draft', 'review', 'draft']: three
    // positions, two definitions, the repeat collapsed onto its first mention.
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, includingCommand('ship-it'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
    expect(h.saved[0]!.text).toContain(
      [
        'included:',
        '  phases:',
        '    - metadata:',
        '        phaseId: draft',
        '        name: Draft',
        '        version: 1',
        '      spec:',
        '        instruction: Run Draft.',
        '    - metadata:',
        '        phaseId: review',
        '        name: Review',
        '        version: 1',
        '      spec:',
        '        instruction: Run Review.',
        ''
      ].join('\n')
    );
  });

  it('leaves the ordered sequence authoritative and unchanged (FR-019)', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, includingCommand('ship-it'));

    const text = h.saved[0]!.text;
    // The de-duplicated `included` order is emphatically not the run order.
    expect(text).toContain(
      ['  phaseIds:', '    - draft', '    - review', '    - draft', ''].join('\n')
    );
    // And the same Pipeline, references-only, differs by the added section only.
    const bare = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(bare.ctx, command('ship-it'));
    expect(text.startsWith(bare.saved[0]!.text)).toBe(true);
  });

  it('includes the Phase the installation actually runs, not a shadowed copy (FR-014)', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: {
        user: [{ ...phaseRow('draft', 'Draft'), instruction: 'User copy.' }, phaseRow('review', 'Review')],
        workspace: [{ ...phaseRow('draft', 'Draft'), version: 4, instruction: 'Workspace copy.' }]
      }
    });
    await exportHandler(h.ctx, includingCommand('ship-it'));

    const text = h.saved[0]!.text;
    expect(text).toContain('        instruction: Workspace copy.');
    expect(text).not.toContain('User copy.');
  });

  it('refuses when a referenced Phase does not resolve, naming it (FR-017)', async () => {
    // US2 acceptance scenario 3. `GHOST_PIPELINE` itself still resolves — the
    // reference-relaxed pass rescues it for FR-018 — so this refusal is the
    // inclusion check's alone, not the selection's.
    const h = buildHarness({ pipelines: { user: [GHOST_PIPELINE] } });
    await exportHandler(h.ctx, includingCommand('ship-it'));

    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toEqual({
      outcome: 'unavailable',
      reason: 'dependency-does-not-resolve',
      unresolvedPhaseId: 'ghost-one'
    });
  });

  it('names the first unresolved reference in sequence order, deterministically', async () => {
    // `ghost-one` resolves here, `ghost-two` does not, so the refusal moves to
    // the second position rather than always reporting the first id.
    const h = buildHarness({
      pipelines: { user: [GHOST_PIPELINE] },
      phases: { user: [phaseRow('ghost-one', 'Ghost One')] }
    });
    await exportHandler(h.ctx, includingCommand('ship-it'));

    expect(h.acks[0]!.result).toMatchObject({ unresolvedPhaseId: 'ghost-two' });
  });

  it('writes no partial document when a reference does not resolve (FR-017)', async () => {
    const h = buildHarness({
      pipelines: { user: [GHOST_PIPELINE] },
      phases: { user: [phaseRow('ghost-one', 'Ghost One')] }
    });
    await exportHandler(h.ctx, includingCommand('ship-it'));

    // Nothing reached the adapter — not the resolved half, not a stub for the
    // missing one. The audit still records the attempt with no scope.
    expect(h.saved).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.payload).toMatchObject({
      operation: 'export',
      resourceKind: 'pipeline',
      resourceIds: ['ship-it'],
      scope: null,
      outcomes: ['unavailable'],
      counts: { exported: 0 }
    });
    expect(JSON.stringify({ ack: h.acks[0], audit: h.audits[0] })).not.toContain('/Users');
  });

  it('is the inclusion choice alone that makes the same Pipeline unexportable', async () => {
    // The pair FR-017 and FR-018 describe: identical catalog, identical id, and
    // the only difference is what the operator asked the document to carry.
    const bare = buildHarness({ pipelines: { user: [GHOST_PIPELINE] } });
    await exportHandler(bare.ctx, command('ship-it'));
    expect(bare.acks[0]!.result).toEqual({ outcome: 'saved' });

    const including = buildHarness({ pipelines: { user: [GHOST_PIPELINE] } });
    await exportHandler(including.ctx, includingCommand('ship-it'));
    expect(including.acks[0]!.result).toMatchObject({ reason: 'dependency-does-not-resolve' });
  });

  it('is deterministic — ten inclusion exports are byte-identical', async () => {
    const texts: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const h = buildHarness({
        pipelines: { user: [AUTHORED_PIPELINE] },
        phases: { user: PHASE_LAYER }
      });
      await exportHandler(h.ctx, includingCommand('ship-it'));
      texts.push(h.saved[0]!.text);
    }
    expect(new Set(texts).size).toBe(1);
  });
});

describe('Feature 085 — export changes nothing and names no location (FR-020, FR-021)', () => {
  it('writes no configuration and runs no command (FR-020)', async () => {
    const pipelines = { user: [AUTHORED_PIPELINE], workspace: [] as readonly unknown[] };
    const before = JSON.stringify(pipelines);
    const h = buildHarness({ pipelines, phases: { user: PHASE_LAYER } });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(pipelines)).toBe(before);
  });

  it('hands the adapter a bare name and no location', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.saved[0]!.suggestedFileName).toBe('ship-it.pipeline.yaml');
    expect(h.saved[0]!.suggestedFileName).not.toContain('/');
    expect(h.saved[0]!.suggestedFileName).not.toContain('\\');
  });

  it('turns an adapter throw into a generic failure and keeps the detail in the log (FR-021)', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER },
      saveThrows: new Error('EACCES: permission denied writing the chosen location')
    });
    await exportHandler(h.ctx, command('ship-it'));

    const ack = h.acks[0]!;
    expect(ack.status).toBe('rejected');
    expect(ack.result).toEqual({ outcome: 'failed', message: 'Could not write the document.' });
    expect(JSON.stringify(ack)).not.toContain('EACCES');
    expect(h.warnings.join('\n')).toContain('EACCES');
    expect(h.audits[0]!.outcome).toBe('failure');
  });

  it('reports a canceled dialog without treating it as a failure', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER },
      saveResult: { outcome: 'canceled' }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.acks[0]!.result).toEqual({ outcome: 'canceled' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['canceled'], counts: { exported: 0 } });
    expect(h.audits[0]!.outcome).toBe('info');
  });

  it('rejects cleanly when the host wired no save adapter', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER },
      withSaveAdapter: false
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.result).toMatchObject({ outcome: 'failed' });
    expect(h.audits[0]!.payload).toMatchObject({ outcomes: ['failed'], scope: 'user' });
  });

  it('audits the Pipeline kind with the same bounded envelope and no location', async () => {
    const h = buildHarness({
      pipelines: { user: [AUTHORED_PIPELINE] },
      phases: { user: PHASE_LAYER }
    });
    await exportHandler(h.ctx, command('ship-it'));

    expect(h.audits).toHaveLength(1);
    const entry = h.audits[0]!;
    expect(entry.eventType).toBe('process-exchange-export');
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
      resourceKind: 'pipeline',
      resourceIds: ['ship-it'],
      scope: 'user',
      outcomes: ['saved'],
      counts: { exported: 1 }
    });
    const serialized = JSON.stringify({ ack: h.acks[0], audit: entry });
    expect(serialized).not.toContain('.pipeline.yaml');
    expect(serialized).not.toContain('/Users');
  });
});
