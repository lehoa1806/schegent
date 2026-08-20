// Feature 096 T015 — Model Catalog export, end to end through the sidebar
// command.
//
// Model Catalog is simpler than the other three kinds: one fixed writable
// layer ('workspace'), no dependency resolution, and — per FR-007 — no
// `ExportProcessYamlUnavailable` outcome exists for it at all, because an
// empty catalog is still a valid, exportable document. That last point is
// what quickstart.md's step 5 pins and what the third describe block below
// asserts directly.

import { describe, expect, it, vi } from 'vitest';

import { CMD_EXPORT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ExportProcessYamlCommand,
  ExportProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { parseModelCatalogDocument } from '../../../src/services/process-yaml/model-catalog-yaml-mapper';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
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
}

function buildHarness(
  opts: {
    models?: Record<string, readonly string[]>;
    withReader?: boolean;
    saveResult?: Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>;
  } = {}
): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: AuditEntry[] = [];
  const saved: { suggestedFileName: string; text: string }[] = [];

  const saveProcessYamlDocument = async (request: {
    suggestedFileName: string;
    text: string;
  }): Promise<Exclude<ExportProcessYamlResult, { outcome: 'unavailable' }>> => {
    saved.push({ ...request });
    return opts.saveResult ?? { outcome: 'saved' };
  };

  const ctx = {
    deps: {
      ...(opts.withReader === false ? {} : { readModelsConfig: () => opts.models ?? {} }),
      saveProcessYamlDocument,
      audit: {
        append: async (entry: AuditEntry) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (s: string) => s
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'model-catalog-export-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, acks, audits, saved };
}

const command: ExportProcessYamlCommand = {
  type: CMD_EXPORT_PROCESS_YAML,
  correlationId: 'model-catalog-export-test-1',
  payload: { resourceKind: 'modelCatalog' }
};

/** Parses a serialized document back, failing loudly rather than returning undefined. */
function parseExported(text: string) {
  const scanned = parseDocumentText(text);
  if (!scanned.ok) throw new Error(`export did not parse: ${scanned.refusal.message}`);
  const parsed = parseModelCatalogDocument(scanned.node);
  if (!parsed.ok) throw new Error(`export was refused: ${parsed.refusal.message}`);
  return parsed.document;
}

describe('Feature 096 — Model Catalog export', () => {
  it('exports a well-formed document for a populated catalog', async () => {
    const h = buildHarness({
      models: { claude: ['claude-opus-5', 'claude-sonnet-5'], codex: ['gpt-6-codex'], agy: [] }
    });
    await exportHandler(h.ctx, command);

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.suggestedFileName).toBe('model-catalog.yaml');

    const document = parseExported(h.saved[0]!.text);
    expect(document.groups.map((group) => group.backend)).toEqual(['claude', 'codex', 'agy']);
    expect(document.groups.find((group) => group.backend === 'claude')?.models).toEqual([
      'claude-opus-5',
      'claude-sonnet-5'
    ]);
    expect(document.groups.find((group) => group.backend === 'codex')?.models).toEqual([
      'gpt-6-codex'
    ]);
    // Absent, not an empty sequence (research R3's absent-not-empty convention).
    expect(document.groups.find((group) => group.backend === 'agy')?.models).toBeUndefined();

    expect(h.acks[0]!.status).toBe('accepted');
    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
  });

  it('exports a well-formed document for a fully empty catalog (quickstart step 5)', async () => {
    const h = buildHarness({ models: {} });
    await exportHandler(h.ctx, command);

    expect(h.saved).toHaveLength(1);
    const document = parseExported(h.saved[0]!.text);
    expect(document.groups.map((group) => group.backend)).toEqual(['claude', 'codex', 'agy']);
    for (const group of document.groups) {
      expect(group.models).toBeUndefined();
    }

    expect(h.acks[0]!.status).toBe('accepted');
    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });
  });

  it('never reports unavailable (FR-007), even with no reader wired', async () => {
    const h = buildHarness({ withReader: false });
    await exportHandler(h.ctx, command);

    expect(h.saved).toHaveLength(1);
    expect(h.acks[0]!.status).toBe('accepted');
    expect(h.acks[0]!.result).not.toMatchObject({ outcome: 'unavailable' });
    expect(h.acks[0]!.result).toEqual({ outcome: 'saved' });

    // The audit envelope carries the fixed literal id (contract §3 — a
    // singleton, nothing to identify), never an 'unavailable' outcome or a
    // location. Feature 099 (FR-041) removed `scope` from every export payload:
    // with one catalog there is no layer left to name beside the id.
    expect(h.audits[0]!.payload).toMatchObject({
      resourceKind: 'modelCatalog',
      resourceIds: ['model-catalog'],
      outcomes: ['saved']
    });
    expect(h.audits[0]!.payload).not.toHaveProperty('scope');
  });
});
