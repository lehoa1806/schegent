// Feature 096 T014 — contracts/model-catalog-exchange.md.
//
// `groupsFromModelsConfig` / `modelsConfigFromGroups` are the domain-shape
// half of the round trip; `serializeModelCatalogDocument` /
// `parseModelCatalogDocument` are the document-shape half. This test chains
// all four so a regression in either half shows up as a lossy round trip
// rather than only as a unit-level mismatch.

import { describe, expect, it } from 'vitest';

import { groupsFromModelsConfig, modelsConfigFromGroups } from '../../src/config/model-catalog';
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../../src/contracts/backend-kinds';
import {
  parseModelCatalogDocument,
  serializeModelCatalogDocument
} from '../../src/services/process-yaml/model-catalog-yaml-mapper';
import {
  MODEL_CATALOG_YAML_KIND,
  PHASE_YAML_API_VERSION,
  type ModelCatalogYamlDocument,
  type ModelCatalogYamlGroup
} from '../../src/services/process-yaml/types';
import { parseDocumentText } from '../../src/services/process-yaml/yaml-parser';

type ModelsConfig = Record<BackendRunnerKind, readonly string[]>;

function documentFor(groups: readonly ModelCatalogYamlGroup[]): ModelCatalogYamlDocument {
  return { apiVersion: PHASE_YAML_API_VERSION, kind: MODEL_CATALOG_YAML_KIND, groups };
}

function roundTrip(config: ModelsConfig): ModelsConfig {
  const document = documentFor(groupsFromModelsConfig(config));
  const text = serializeModelCatalogDocument(document);
  const scanned = parseDocumentText(text);
  if (!scanned.ok) {
    throw new Error(`round-trip fixture did not parse: ${scanned.refusal.message}`);
  }
  const parsed = parseModelCatalogDocument(scanned.node);
  if (!parsed.ok) {
    throw new Error(`round-trip fixture was refused: ${parsed.refusal.message}`);
  }
  return modelsConfigFromGroups(parsed.document.groups);
}

describe('Model Catalog document round trip (contracts/model-catalog-exchange.md)', () => {
  it('round-trips a populated catalog losslessly', () => {
    const config: ModelsConfig = {
      claude: ['claude-opus-5', 'claude-sonnet-5'],
      codex: ['gpt-6-codex'],
      agy: []
    };
    expect(roundTrip(config)).toEqual(config);
  });

  it('round-trips a fully empty catalog losslessly', () => {
    const config: ModelsConfig = { claude: [], codex: [], agy: [] };
    expect(roundTrip(config)).toEqual(config);
  });

  it('emits one group per SUPPORTED_BACKENDS member, in order', () => {
    const config: ModelsConfig = { claude: ['a'], codex: [], agy: ['b'] };
    const groups = groupsFromModelsConfig(config);
    expect(groups.map((group) => group.backend)).toEqual([...SUPPORTED_BACKENDS]);
  });

  it('omits the models key, rather than an empty sequence, for a backend with no custom models', () => {
    const config: ModelsConfig = { claude: [], codex: ['gpt-6-codex'], agy: [] };
    const groups = groupsFromModelsConfig(config);

    const claudeGroup = groups.find((group) => group.backend === 'claude');
    expect(claudeGroup).toEqual({ backend: 'claude' });

    const text = serializeModelCatalogDocument(documentFor(groups));
    const lines = text.split('\n');
    const claudeLine = lines.findIndex((line) => line.includes('backend: claude'));
    expect(claudeLine).toBeGreaterThanOrEqual(0);
    expect(lines[claudeLine + 1]).not.toContain('models:');
  });
});
