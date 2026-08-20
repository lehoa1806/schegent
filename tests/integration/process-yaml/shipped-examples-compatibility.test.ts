// Feature 098 T010 — the documents that ship in the VSIX still read
// (FR-003a, SC-005a).
//
// `spec.sideEffects` and `spec.evidencePolicy` are the only externally-visible
// format change in this feature. Both are optional and the admitted key set
// GROWS rather than changes, so `apiVersion` stays `schegent/v1` and every
// document already on an operator's disk stays valid. That claim is cheap to
// make and easy to break — a required field, a renamed key, or a bumped version
// would each break it silently, because the failure shows up when an operator
// opens a file we no longer ship a copy of.
//
// So this file reads the real `repo/examples/` directory rather than a fixture
// of it. Nothing here is hand-copied: adding an example makes it a case, and
// removing one removes its case, which is the only arrangement that cannot drift
// from what actually gets packaged. `vsix-allowlist-grounding.test.ts` pins that
// the same directory is what ships.
//
// The assertions are deliberately about REFUSALS AND DEFECTS, not about row
// outcomes. On this build the built-in layer still claims the example ids, so
// these documents preflight to `skip` rows; after Stage 3 empties that layer the
// same documents preflight to `import` rows. Both are correct in their own
// stage, and neither is what FR-003a is about. What must hold in every stage is
// that the document is read without complaint.

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
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { parsePipelinePackage } from '../../../src/services/process-yaml/pipeline-document';
import { PHASE_YAML_API_VERSION } from '../../../src/services/process-yaml/types';

const EXAMPLES_DIR = resolve(__dirname, '..', '..', '..', 'examples');

/** Every YAML document the VSIX carries, discovered rather than listed. */
const EXAMPLES: readonly string[] = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
  .sort();

const COMMAND: PreflightProcessYamlCommand = Object.freeze({
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'shipped-examples-1',
  payload: {}
});

function readExample(name: string): string {
  return readFileSync(resolve(EXAMPLES_DIR, name), 'utf8');
}

/**
 * Preflight one document through the sidebar command, with the stored catalog
 * left empty. An empty operator catalog is the state a fresh install is in, which
 * is the state these documents are shipped for.
 *
 * Feature 099 (T496f, FR-042) — "every catalog layer the host can read" was three
 * empty pairs; there is one layer now, so it is three empty stores. The claim is
 * the same one it always was and the fixture no longer enumerates tiers to make it.
 */
/** What an empty store reports itself at; nothing here depends on its shape. */
const FRESH_STORE_REVISION = 'empty-store';

async function preflightExample(name: string): Promise<PreflightProcessYamlResult> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ rows: [], revision: FRESH_STORE_REVISION }),
      readPipelineConfig: () => ({ rows: [], revision: FRESH_STORE_REVISION }),
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await preflightHandler(ctx, COMMAND);
  expect(acks).toHaveLength(1);
  return acks[0]!.result as PreflightProcessYamlResult;
}

describe('the shipped example documents after the two fields are admitted', () => {
  it('finds the examples directory and at least one document in it', () => {
    // A glob that quietly matched nothing would make every it.each below vacuous.
    expect(EXAMPLES.length).toBeGreaterThan(0);
  });

  it.each(EXAMPLES)('%s parses', (name) => {
    const parsed = parseDocumentText(readExample(name));
    expect(parsed.ok, parsed.ok ? '' : `${parsed.refusal.code}: ${parsed.refusal.message}`).toBe(
      true
    );
  });

  it.each(EXAMPLES)('%s declares the unchanged apiVersion', (name) => {
    // FR-003a: additive fields, so no version bump. Asserted on the raw text
    // rather than on a parsed field so a reader that silently defaulted a
    // missing `apiVersion` could not hide the change.
    expect(readExample(name)).toContain(`apiVersion: ${PHASE_YAML_API_VERSION}`);
  });

  it.each(EXAMPLES)('%s preflights without a refusal', async (name) => {
    const result = await preflightExample(name);
    expect(
      result.outcome,
      result.outcome === 'refused' ? `${result.refusal.code}: ${result.refusal.message}` : ''
    ).not.toBe('refused');
  });

  it.each(EXAMPLES)('%s produces a plan with no defect on any row', async (name) => {
    const result = await preflightExample(name);
    // Asserted rather than guarded: a bare early return on a non-`planned`
    // outcome would let this pass for a document that produced no plan at all.
    // The `if` below only narrows the union for the row read.
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    // `defects` lives on the `invalid` arm alone, so the arm IS the assertion —
    // there is no defect-carrying `import` or `skip` row to also check for.
    const withDefects = result.plan.rows.filter((row) => row.outcome === 'invalid');
    expect(withDefects, `rows carrying defects in ${name}`).toEqual([]);
  });

  it('still ships a document that declares neither new field', () => {
    // The compatibility claim needs a document that exercises the old shape. It
    // used to be every example; `speckit-new-feature.pipeline.yaml` now declares
    // `sideEffects` on the two Phases that write Git metadata (see below), so the
    // assertion moved from "all of them" to "at least one of them". Nothing here
    // pins WHICH one — an example that starts declaring a field is a normal
    // change, and only the last one to do so should fail this.
    const untouched = EXAMPLES.filter((name) => {
      const text = readExample(name);
      return !text.includes('sideEffects') && !text.includes('evidencePolicy');
    });
    expect(untouched, 'examples declaring neither new field').not.toEqual([]);
  });
});

// The examples ship Pipeline packages, whose Phases are nested under `included:`
// rather than being standalone documents. Reading them through the package
// reader rather than through a plan row is what makes these assertions stable
// across the feature's stages: the reader parses the included Phases whatever
// the operator's catalog contains, while a plan row's shape depends on which ids
// are already claimed.
const PACKAGES: readonly string[] = EXAMPLES.filter((name) =>
  readExample(name).includes('kind: Pipeline')
);

// The Phases in the shipped packages that write Git metadata, and so must say so.
//
// This is not a revival of the deleted `GIT_METADATA_WRITE_PHASE_IDS`: the host
// still asks a Phase only what it declares, and an id carries no authority there
// (FR-008). This is an assertion about these two documents. `speckit-specify`
// creates the feature branch through its skill's `before_specify` hook and
// `finalize` commits and merges — its instruction says so in as many words. The
// built-in table used to supply `sideEffects: git` for both; with that table
// empty, nothing supplies it but the document itself, and a Phase that resolves
// to the `workspace` default takes NEITHER the mutation-plan approval gate NOR
// the pre-phase checkpoint in `run-driver` while the Claude CLI still runs with
// `--dangerously-skip-permissions`. An omission here is a silently removed
// operator consent gate on `git commit`, which is why it is pinned.
const GIT_WRITING_EXAMPLE_PHASE_IDS: ReadonlySet<string> = new Set([
  'speckit-specify',
  'finalize'
]);

describe.skipIf(PACKAGES.length === 0)(
  'the Phases inside a shipped package declare the containment they need',
  () => {
    // The complement of the round-trip test in `yaml-serializer.test.ts`: there,
    // an omitted field re-reads as `undefined`; here, the documents that actually
    // ship are the ones doing the omitting. Every Phase that does NOT write Git
    // metadata omits both fields, so the FR-005 defaults are what the freeze
    // applies — and after T017 that default is `workspace`, not the
    // `unrestricted` an unrecognised Phase used to take.
    it.each(PACKAGES)('%s reads every included Phase', (name) => {
      const parsed = parseDocumentText(readExample(name));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const pkg = parsePipelinePackage(parsed.node);
      expect(pkg.ok, pkg.ok ? '' : `${pkg.refusal.code}: ${pkg.refusal.message}`).toBe(true);
      if (!pkg.ok) return;

      const phases = pkg.resources.filter(
        (resource) => resource.ok && resource.resourceKind === 'phase'
      );
      expect(phases.length, `included Phases in ${name}`).toBeGreaterThan(0);

      for (const resource of phases) {
        if (!resource.ok || resource.resourceKind !== 'phase') continue;
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
      // Without this, renaming or dropping `finalize` would turn the pinned
      // branch of that assertion into a branch nothing takes, and the consent
      // gate could go missing again with every test still green.
      const shipped = new Set<string>();
      for (const name of PACKAGES) {
        const parsed = parseDocumentText(readExample(name));
        if (!parsed.ok) continue;
        const pkg = parsePipelinePackage(parsed.node);
        if (!pkg.ok) continue;
        for (const resource of pkg.resources) {
          if (!resource.ok || resource.resourceKind !== 'phase') continue;
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
      const pkg = parsePipelinePackage(parsed.node);
      if (!pkg.ok) return;
      const refused = pkg.resources.filter((resource) => !resource.ok);
      expect(refused, `refused resources in ${name}`).toEqual([]);
    });
  }
);
