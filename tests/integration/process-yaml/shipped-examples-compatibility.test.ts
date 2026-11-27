// Feature 098 T010 — the documents that ship in the VSIX still read
// (FR-003a, SC-005a).

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { standaloneNode } from '../../../src/services/process-yaml/package-reader';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  type YamlMappingNode,
  type YamlNode
} from '../../../src/services/process-yaml/types';

import { parseWorkflowPackage } from '../../../src/services/process-yaml/workflow-document';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';

const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');

/** Every YAML document the VSIX carries, discovered rather than listed. */
const EXAMPLES: readonly string[] = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  .sort();

const SUPPORTED_EXAMPLES: readonly string[] = EXAMPLES;

const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'shipped-examples-1',
  payload: {}
});

function readExample(name: string): string {
  return readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');
}

const FRESH_STORE_REVISION = 'empty-store';

async function preflightExample(name: string): Promise<PreflightProcessYamlResult> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ rows: [], revision: FRESH_STORE_REVISION }),
      readWorkflowConfig: () => ({ rows: [], revision: FRESH_STORE_REVISION }),
      readModelsConfig: () => ({}),
      writePhaseConfig: vi.fn(),
      updateConfig: vi.fn(),
      executeCommand: vi.fn(),
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(readExample(name), 'utf8'))
      }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (value: string) => value
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'shipped-examples-1'
  } as any;

  await preflightHandler(ctx, COMMAND);
  expect(acks).toHaveLength(1);
  return acks[0]!.result as PreflightProcessYamlResult;
}

describe('the shipped example documents after the two fields are admitted', () => {
  it('finds the examples directory and at least one document in it', () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
    expect(SUPPORTED_EXAMPLES.length).toBeGreaterThan(0);
  });

  it.each(EXAMPLES)('%s parses', (name) => {
    const parsed = parseDocumentText(readExample(name));
    expect(parsed.ok, parsed.ok ? '' : `${parsed.refusal.code}: ${parsed.refusal.message}`).toBe(
      true
    );
  });

  it.each(EXAMPLES)('%s declares the unchanged apiVersion', (name) => {
    expect(readExample(name)).toContain(`apiVersion: ${PHASE_YAML_API_VERSION}`);
  });

  it('uses backend-specific Phase ids and routes the default steps through Finalize', () => {
    const parsed = parseDocumentText(readExample('speckit-new-feature.workflow.yaml'));
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const pkg = parseWorkflowPackage(parsed.node);
    if (!pkg.ok) throw new Error(pkg.refusal.message);
    const root = pkg.resources.at(0);
    if (!root?.ok || root.resourceKind !== 'workflow') throw new Error('Missing root Workflow');
    const defaultIds = [
      ...['specify', 'clarify', 'plan', 'tasks', 'checklist', 'analyze', 'implement', 'converge']
        .map((role) => `claude-speckit-${role}`),
      'claude-code-review', 'claude-security-review', 'claude-finalize'
    ];
    expect(root.definition.startNodeIds).toEqual(['claude-speckit-specify']);
    expect(root.definition.nodes.map(({ nodeId, phaseId }) => [nodeId, phaseId])).toEqual(
      defaultIds.map((id) => [id, id])
    );
    expect(root.definition.connections.map(({ from, to }) => [from.nodeId, to.nodeId])).toEqual(
      defaultIds.slice(1).map((id, index) => [defaultIds[index], id])
    );

    for (const resource of pkg.resources) {
      if (!resource.ok || resource.resourceKind !== 'phase') continue;
      const { metadata, spec } = resource.document;
      expect(spec.runner).toBeDefined();
      expect(metadata.phaseId).toMatch(new RegExp(`^${spec.runner}-[a-z-]+$`));
      expect(metadata.name.toLowerCase()).toMatch(new RegExp(`\\(${spec.runner}\\)$`));
    }

    for (const role of ['speckit-implement', 'speckit-converge', 'code-review', 'security-review']) {
      for (const backend of SUPPORTED_BACKENDS) {
        const id = `${backend}-${role}`;
        const phase = pkg.resources.find(
          (resource) =>
            resource.ok && resource.resourceKind === 'phase' && resource.document.metadata.phaseId === id
        );
        if (!phase?.ok || phase.resourceKind !== 'phase') throw new Error(`Missing Phase ${id}`);
        expect(phase.document.spec.runner).toBe(backend);
      }
    }
  });

  it.each(SUPPORTED_EXAMPLES)('%s preflights without a refusal', async (name) => {
    const result = await preflightExample(name);
    expect(
      result.outcome,
      result.outcome === 'refused' ? `${result.refusal.code}: ${result.refusal.message}` : ''
    ).not.toBe('refused');
  });

  it.each(SUPPORTED_EXAMPLES)('%s produces a plan with no defect on any row', async (name) => {
    const result = await preflightExample(name);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const withDefects = result.plan.rows.filter((row) => row.outcome === 'invalid');
    expect(
      withDefects,
      `rows carrying defects in ${name}: ${JSON.stringify(withDefects, null, 1)}`
    ).toEqual([]);
  });

  it('still ships a document that declares neither new field', () => {
    const untouched = EXAMPLES.filter((name) => {
      const text = readExample(name);
      return !text.includes('sideEffects') && !text.includes('evidencePolicy');
    });
    expect(untouched, 'examples declaring neither new field').not.toEqual([]);
  });
});

const PACKAGES: readonly string[] = EXAMPLES.filter((name) =>
  readExample(name).includes('included:')
);

const GIT_WRITING_EXAMPLE_PHASE_IDS: ReadonlySet<string> = new Set([
  'claude-speckit-specify',
  'claude-finalize'
]);

function extractIncludedPhases(root: YamlMappingNode) {
  const included = root.entries.find((e) => e.key === 'included')?.value;
  if (included?.kind !== 'mapping') return [];
  const phasesNode = included.entries.find((e) => e.key === 'phases')?.value;
  if (phasesNode?.kind !== 'sequence') return [];
  return phasesNode.items.map((item: YamlNode) => {
    if (item.kind !== 'mapping') {
      return { ok: false as const };
    }
    const validated = validatePhaseDocument(standaloneNode(item, PHASE_YAML_KIND));
    if (validated.ok) {
      return { ok: true as const, document: validated.document };
    }
    return { ok: false as const };
  });
}

describe.skipIf(PACKAGES.length === 0)(
  'the Phases inside a shipped package declare the containment they need',
  () => {
    it.each(PACKAGES)('%s reads every included Phase', (name) => {
      const parsed = parseDocumentText(readExample(name));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const phases = extractIncludedPhases(parsed.node).filter((r) => r.ok);
      expect(phases.length, `included Phases in ${name}`).toBeGreaterThan(0);

      for (const resource of phases) {
        if (!resource.ok) continue;
        const { phaseId } = resource.document.metadata;
        expect(resource.document.spec.sideEffects, `sideEffects on ${phaseId}`).toBe(
          GIT_WRITING_EXAMPLE_PHASE_IDS.has(phaseId) ? 'git' : undefined
        );
        expect(
          resource.document.spec.evidencePolicy,
          `evidencePolicy on ${phaseId}`
        ).toBeUndefined();
      }
    });

    it('the Git-writing Phases the assertion above pins are actually shipped', () => {
      const shipped = new Set<string>();
      for (const name of PACKAGES) {
        const parsed = parseDocumentText(readExample(name));
        if (!parsed.ok) continue;
        for (const resource of extractIncludedPhases(parsed.node)) {
          if (!resource.ok) continue;
          shipped.add(resource.document.metadata.phaseId);
        }
      }
      for (const phaseId of GIT_WRITING_EXAMPLE_PHASE_IDS) {
        expect(shipped, `pinned Git-writing Phase ${phaseId}`).toContain(phaseId);
      }
    });

    it.each(PACKAGES)('%s declares no resource the reader refuses', (name) => {
      const parsed = parseDocumentText(readExample(name));
      if (!parsed.ok) return;
      const refused = extractIncludedPhases(parsed.node).filter((resource) => !resource.ok);
      expect(refused, `refused resources in ${name}`).toEqual([]);
    });
  }
);
