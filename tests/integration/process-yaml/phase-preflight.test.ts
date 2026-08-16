// Feature 084 T032 — import preflight, end to end through the sidebar command.
//
// The scenario this file exists to pin hardest is QS-24: a preflight changes
// nothing. The harness supplies every write-shaped dependency a handler in this
// directory could reach — `writePhaseConfig`, `executeCommand`, `notifyWarning`
// — and asserts each was never called, and that both layer revisions read the
// same before and after. It also asserts the chosen document is read EXACTLY
// once: no second read, no re-read on a refusal, nothing retained past the call.
//
// Covers QS-8/QS-11/QS-13 at the command level (document-level refusals carry no
// plan, FR-027), the stored-rows presence rule (FR-030), and the T031 boundary:
// author-supplied strings are sanitized and bounded before they leave the host.

import { describe, expect, it, vi } from 'vitest';

import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';

type OpenResult =
  | { outcome: 'read'; bytes: Uint8Array }
  | { outcome: 'canceled' }
  | { outcome: 'failed'; message: string };

interface Harness {
  readonly ctx: Parameters<typeof preflightHandler>[0];
  readonly acks: CommandAckMessage[];
  readonly audits: unknown[];
  readonly warnings: string[];
  readonly opens: { count: number };
  readonly writePhaseConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly notifyWarning: ReturnType<typeof vi.fn>;
}

function buildHarness(
  opts: {
    user?: readonly unknown[];
    workspace?: readonly unknown[];
    open?: OpenResult;
    openThrows?: Error;
    withOpenAdapter?: boolean;
    sanitize?: (value: string) => string;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: unknown[] = [];
  const warnings: string[] = [];
  const opens = { count: 0 };
  const writePhaseConfig = vi.fn();
  const executeCommand = vi.fn();
  const notifyWarning = vi.fn();

  const openProcessYamlDocument = async (): Promise<OpenResult> => {
    opens.count += 1;
    if (opts.openThrows) throw opts.openThrows;
    return opts.open ?? { outcome: 'canceled' };
  };

  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: opts.user ?? [], workspace: opts.workspace ?? [] }),
      writePhaseConfig,
      executeCommand,
      notifyWarning,
      ...(opts.withOpenAdapter === false ? {} : { openProcessYamlDocument }),
      audit: {
        append: async (entry: unknown) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: (msg: string) => warnings.push(msg),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: opts.sanitize ?? ((s: string) => s)
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'preflight-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return {
    ctx,
    acks,
    audits,
    warnings,
    opens,
    writePhaseConfig,
    executeCommand,
    notifyWarning
  };
}

const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'preflight-test-1',
  // Preflight carries nothing: no location, no bytes, no scope, and — since
  // feature 085 — no kind either. The document declares its own `kind:`.
  payload: {}
});

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function document(body: string): string {
  return `apiVersion: schegent/v1\nkind: Phase\n${body}`;
}

const NEW_PHASE_DOCUMENT = document(
  [
    'metadata:',
    '  phaseId: ship-it',
    '  name: Ship It',
    '  version: 1',
    'spec:',
    '  instruction: Ship the thing.',
    ''
  ].join('\n')
);

/** The single result the webview receives, read off the ack. */
function resultOf(h: Harness): PreflightProcessYamlResult {
  expect(h.acks).toHaveLength(1);
  return h.acks[0]!.result as PreflightProcessYamlResult;
}

describe('Feature 084 — Phase import preflight', () => {
  it('plans a new id as import and returns both writable layer revisions (FR-033)', async () => {
    const h = buildHarness({ open: { outcome: 'read', bytes: bytes(NEW_PHASE_DOCUMENT) } });
    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows).toEqual([
      {
        outcome: 'import',
        resourceKind: 'phase',
        resourceId: 'ship-it',
        name: 'Ship It',
        requiresRetryConditionCapability: false,
        // What the commit will write, exactly as the document authored it
        // (FR-046a). The plan carries it because the host retains nothing past
        // this read (FR-031); asserted with `toEqual` so a field silently added
        // to the row fails here rather than crossing the boundary unnoticed.
        definition: {
          phaseId: 'ship-it',
          name: 'Ship It',
          version: 1,
          instruction: 'Ship the thing.'
        }
      }
    ]);
    expect(result.plan.counts).toEqual({ import: 1, skip: 0, invalid: 0, blocked: 0 });
    const expected = resolvePhaseCatalog({ builtIn: BUILT_IN_PHASES, user: [], workspace: [] });
    expect(result.plan.computedAgainstRevision).toEqual(expected.revisions);
    expect(h.acks[0]!.status).toBe('accepted');
  });

  // QS-24. Everything a handler in this directory could write with, and both
  // revisions, checked either side of the call.
  it('QS-24 writes nothing, moves neither revision, and reads the document exactly once', async () => {
    const layers = { user: [], workspace: [] } as const;
    const before = resolvePhaseCatalog({ builtIn: BUILT_IN_PHASES, ...layers });
    const h = buildHarness({ open: { outcome: 'read', bytes: bytes(NEW_PHASE_DOCUMENT) } });

    await preflightHandler(h.ctx, COMMAND);

    const after = resolvePhaseCatalog({ builtIn: BUILT_IN_PHASES, ...layers });
    expect(after.revisions).toEqual(before.revisions);
    expect(h.writePhaseConfig).not.toHaveBeenCalled();
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(h.notifyWarning).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
    expect(h.opens.count).toBe(1);
  });

  it('reads the document exactly once even when it is refused', async () => {
    const h = buildHarness({
      open: { outcome: 'read', bytes: bytes('apiVersion: schegent/v2\nkind: Phase\n') }
    });

    await preflightHandler(h.ctx, COMMAND);

    expect(h.opens.count).toBe(1);
    const result = resultOf(h);
    expect(result.outcome).toBe('refused');
  });

  it('skips an id claimed by an INVALID stored row, which no effective catalog contains (FR-030)', async () => {
    // `ship-it` exists only as a row that fails validation, so it appears in no
    // effective definition. Presence must still find it.
    const h = buildHarness({
      user: [{ phaseId: 'ship-it', name: 'Ship It', version: 1 }],
      open: { outcome: 'read', bytes: bytes(NEW_PHASE_DOCUMENT) }
    });

    await preflightHandler(h.ctx, COMMAND);

    const resolved = resolvePhaseCatalog({
      builtIn: BUILT_IN_PHASES,
      user: [{ phaseId: 'ship-it', name: 'Ship It', version: 1 }],
      workspace: []
    });
    expect(resolved.effective.some((def) => def.phaseId === 'ship-it')).toBe(false);

    const result = resultOf(h);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows).toEqual([
      {
        outcome: 'skip',
        resourceKind: 'phase',
        resourceId: 'ship-it',
        name: 'Ship It',
        presentIn: 'user',
        presentRowStatus: 'invalid'
      }
    ]);
    expect(result.plan.counts).toEqual({ import: 0, skip: 1, invalid: 0, blocked: 0 });
  });

  it('QS-8 refuses an over-size document before the scanner is entered, with no plan', async () => {
    const oversize = `${NEW_PHASE_DOCUMENT}# ${'x'.repeat(PHASE_YAML_MAX_BYTES)}\n`;
    const h = buildHarness({ open: { outcome: 'read', bytes: bytes(oversize) } });

    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('too-large');
    // FR-027 — a refusal carries no partial plan, not even an empty one.
    expect(Object.keys(result)).toEqual(['outcome', 'refusal']);
    expect(h.acks[0]!.status).toBe('rejected');
    expect(h.acks[0]!.reason).toBe('refused');
  });

  it('reports a canceled dialog as canceled, not as a failure', async () => {
    const h = buildHarness({ open: { outcome: 'canceled' } });
    await preflightHandler(h.ctx, COMMAND);

    expect(resultOf(h)).toEqual({ outcome: 'canceled' });
    expect(h.acks[0]!.reason).toBe('canceled');
  });

  it('keeps an adapter error out of the operator message and in the log only', async () => {
    const h = buildHarness({ openThrows: new Error('EACCES: /Users/someone/secret/phase.yaml') });

    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result).toEqual({ outcome: 'failed', message: 'Could not read the document.' });
    expect(JSON.stringify(result)).not.toContain('/Users');
    expect(h.warnings.join('\n')).toContain('EACCES');
  });

  it('reports a read failure generically without the adapter message', async () => {
    const h = buildHarness({
      open: { outcome: 'failed', message: 'EISDIR: /Users/someone/phases' }
    });

    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result).toEqual({ outcome: 'failed', message: 'Could not read the document.' });
    expect(JSON.stringify(result)).not.toContain('/Users');
  });

  it('fails cleanly when the window has no open adapter', async () => {
    const h = buildHarness({ withOpenAdapter: false });

    await preflightHandler(h.ctx, COMMAND);

    expect(resultOf(h)).toEqual({
      outcome: 'failed',
      message: 'Import is unavailable in this window.'
    });
    expect(h.opens.count).toBe(0);
  });

  // The format's own caps already bound a valid document's name and id, so the
  // observable half of T031 is the sanitizer: document-derived text must go
  // through the injected redactor rather than being passed through.
  it('T031 sanitizes author-supplied strings before they leave the host', async () => {
    const h = buildHarness({
      open: { outcome: 'read', bytes: bytes(NEW_PHASE_DOCUMENT) },
      sanitize: (value) => value.replaceAll('Ship', '[redacted]')
    });

    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('import');
    if (row?.outcome !== 'import') return;
    if (row.resourceKind === 'modelCatalog') return;
    expect(row.name).toBe('[redacted] It');
  });

  it('T031 bounds a defect message the document forced past the boundary cap', async () => {
    // An empty instruction produces defects. The sanitizer stands in for a
    // redactor whose output is longer than its input — a real possibility, since
    // a redaction placeholder can exceed the text it replaces — so the cap has
    // to be applied AFTER sanitizing, which is what this pins.
    const h = buildHarness({
      open: {
        outcome: 'read',
        bytes: bytes(
          document(
            [
              'metadata:',
              '  phaseId: ship-it',
              '  name: Ship It',
              '  version: 1',
              'spec:',
              '  instruction: ""',
              ''
            ].join('\n')
          )
        )
      },
      sanitize: (value) => `${value}${'!'.repeat(600)}`
    });

    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    for (const defect of row.defects) {
      expect(defect.field.length).toBeLessThanOrEqual(32);
      expect(defect.code.length).toBeLessThanOrEqual(64);
      expect(defect.message.length).toBe(512);
    }
  });

  it('bounds a defect list and still reports the pre-cap total', async () => {
    const manyUnknownKeys = document(
      [
        'metadata:',
        '  phaseId: ship-it',
        '  name: Ship It',
        '  version: 1',
        'spec:',
        '  instruction: Ship the thing.',
        ...Array.from({ length: 25 }, (_unused, index) => `  bogus${index}: x`),
        ''
      ].join('\n')
    );
    const h = buildHarness({ open: { outcome: 'read', bytes: bytes(manyUnknownKeys) } });

    await preflightHandler(h.ctx, COMMAND);

    const result = resultOf(h);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    expect(row.defects).toHaveLength(20);
    expect(row.totalDefects).toBe(25);
    // Counts describe rows, so the defect cap does not desynchronize them.
    expect(result.plan.counts).toEqual({ import: 0, skip: 0, invalid: 1, blocked: 0 });
  });
});
