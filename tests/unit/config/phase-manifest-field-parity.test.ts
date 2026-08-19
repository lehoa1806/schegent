// The `schegent.phases` manifest item schema and the host's authored-field sets
// describe the same closed set of Phase fields, and must agree on it.
//
// `contributes.configuration.properties["schegent.phases"].items` carries
// `additionalProperties: false`, so the manifest is not merely documentation —
// it is a settings-editor *rejection*. A field the host accepts but the manifest
// omits is red-squiggled in `settings.json` while working perfectly, which reads
// to an operator as "unsupported". A field the manifest advertises but the host
// strips before validation is worse: it is offered, accepted, and then never
// checked, so a typo'd enum value passes the oracle that exists to catch it.
//
// Both directions had drifted. `forceContinueOnRetryCap` was host-side only
// (settings, YAML, and the workspace-default that overrides it all shipped
// before the manifest caught up), and feature 098's `sideEffects` /
// `evidencePolicy` were manifest-side only in `ALLOWED_PHASE_FIELDS`, which
// `validateCatalog` uses to strip a row before validating it — so that oracle
// could not reach its own enum checks for the two fields it most needed them on.
//
// `AUTHORED_PHASE_FIELDS` is the anchor: it is what both the save path and the
// import path hold a definition to. The manifest is the same set less `phaseId`,
// the YAML spelling of `id` that never appears in `settings.json`.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AUTHORED_PHASE_FIELDS } from '../../../src/config/process-definition-validator';
import { ALLOWED_PHASE_FIELDS } from '../../../src/config/pipeline-config';

const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', '..', '..', 'package.json');

/** The YAML-only spelling of `id`; `settings.json` rows never carry it. */
const YAML_ONLY_FIELDS: readonly string[] = ['phaseId'];

function manifestPhaseItemFields(): string[] {
  const parsed = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    contributes?: {
      configuration?: {
        properties?: Record<
          string,
          { items?: { additionalProperties?: boolean; properties?: Record<string, unknown> } }
        >;
      };
    };
  };
  const phases = parsed.contributes?.configuration?.properties?.['schegent.phases'];
  if (!phases?.items?.properties) {
    throw new Error('package.json: missing schegent.phases.items.properties');
  }
  // Asserted here rather than in a case of its own: without it the whole file
  // is about a schema that rejects nothing, and every parity claim below is
  // about a set that carries no authority.
  expect(phases.items.additionalProperties, 'schegent.phases items must be a closed set').toBe(
    false
  );
  return Object.keys(phases.items.properties).sort();
}

describe('schegent.phases manifest fields agree with the host', () => {
  const manifest = manifestPhaseItemFields();
  const authored = Array.from(AUTHORED_PHASE_FIELDS).sort();
  const expectedManifest = authored.filter((field) => !YAML_ONLY_FIELDS.includes(field));

  it('declares at least the required id/name pair (sanity)', () => {
    expect(manifest).toContain('id');
    expect(manifest).toContain('name');
  });

  it('advertises every authored field an operator can write in settings.json', () => {
    const missing = expectedManifest.filter((field) => !manifest.includes(field));
    expect(
      missing,
      `fields the host accepts but package.json rejects: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('advertises no field the host does not authorize', () => {
    const extra = manifest.filter((field) => !AUTHORED_PHASE_FIELDS.has(field));
    expect(
      extra,
      `fields package.json offers that the host does not accept: ${extra.join(', ')}`
    ).toEqual([]);
  });

  it('carries no YAML-only spelling', () => {
    for (const field of YAML_ONLY_FIELDS) {
      expect(manifest, `${field} is a YAML alias and has no place in settings.json`).not.toContain(
        field
      );
    }
  });

  it('validateCatalog strips nothing an authored row is allowed to carry', () => {
    // `ALLOWED_PHASE_FIELDS` is the filter `validateCatalog` applies before it
    // calls `validatePhaseRaw`. Any authored field absent from it is a field the
    // validator is structurally unable to see, however good its checks are.
    const stripped = expectedManifest.filter((field) => !ALLOWED_PHASE_FIELDS.has(field));
    expect(
      stripped,
      `authored fields validateCatalog discards before validating: ${stripped.join(', ')}`
    ).toEqual([]);
  });

  it('validateCatalog admits no field outside the authored set', () => {
    const unauthorized = Array.from(ALLOWED_PHASE_FIELDS).filter(
      (field) => !AUTHORED_PHASE_FIELDS.has(field)
    );
    expect(unauthorized, `unauthorized: ${unauthorized.join(', ')}`).toEqual([]);
  });
});
