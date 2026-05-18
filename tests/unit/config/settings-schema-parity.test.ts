// Feature 056 Track 3 (FR-016) — parity guard between
// `SETTINGS_SCHEMA` (the typed source of truth) and the
// `contributes.configuration.properties` block in `package.json`.
//
// Failing this test means one of three drift sources:
//   1. A new `schegent.*` key was added to `package.json` but not to
//      `SETTINGS_SCHEMA`.
//   2. A key was added to `SETTINGS_SCHEMA` but not advertised in
//      `package.json` (the IDE would never offer it in `settings.json`).
//   3. A `type` / `default` / `minimum` / `maximum` / `enum` field
//      diverged between the two sources (a silent contract change).
//
// Each failure names the offending key so the fix is one edit away.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  SETTINGS_SCHEMA,
  SETTINGS_SCHEMA_KEYS,
  isSchemaCompliantValue
} from '../../../src/config/settings-schema';

const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', '..', '..', 'package.json');

interface PackageProperty {
  readonly type?: string | readonly string[];
  readonly default?: unknown;
  readonly scope?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly items?: { readonly type?: string };
}

function loadPackageProperties(): Record<string, PackageProperty> {
  const raw = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as {
    contributes?: { configuration?: { properties?: Record<string, PackageProperty> } };
  };
  const props = parsed.contributes?.configuration?.properties;
  if (!props) throw new Error('package.json: missing contributes.configuration.properties');
  return props;
}

function schegentKeys(props: Record<string, PackageProperty>): string[] {
  return Object.keys(props).filter((k) => k.startsWith('schegent.')).sort();
}

describe('SETTINGS_SCHEMA parity with package.json', () => {
  const props = loadPackageProperties();
  const packageKeys = schegentKeys(props);
  const schemaKeys = Array.from(SETTINGS_SCHEMA_KEYS).sort();

  it('package.json has at least one schegent.* property (sanity)', () => {
    expect(packageKeys.length).toBeGreaterThan(0);
  });

  it('schema ⊇ package: every schegent.* package property has a schema entry', () => {
    const missingInSchema = packageKeys.filter((k) => !SETTINGS_SCHEMA_KEYS.has(k));
    expect(
      missingInSchema,
      `package.json keys missing in SETTINGS_SCHEMA: ${missingInSchema.join(', ')}`
    ).toEqual([]);
  });

  it('package ⊇ schema: every schema entry has a matching schegent.* package property', () => {
    const missingInPackage = schemaKeys.filter((k) => !(k in props));
    expect(
      missingInPackage,
      `SETTINGS_SCHEMA keys missing in package.json: ${missingInPackage.join(', ')}`
    ).toEqual([]);
  });

  it('type tags agree between schema and package', () => {
    const mismatches: string[] = [];
    for (const key of schemaKeys) {
      if (!(key in props)) continue;
      const entry = SETTINGS_SCHEMA[key];
      const pkg = props[key];
      const pkgTypes = Array.isArray(pkg.type) ? pkg.type : pkg.type ? [pkg.type] : [];
      const expected = mapSchemaTypeToPackage(entry.type, entry.nullable === true);
      const expectedSet = new Set(expected);
      const pkgSet = new Set(pkgTypes);
      if (!setsEqual(expectedSet, pkgSet)) {
        mismatches.push(`${key}: schema=${[...expectedSet].join('|')} package=${[...pkgSet].join('|')}`);
      }
    }
    expect(mismatches, `type mismatches: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('default values agree between schema and package', () => {
    const mismatches: string[] = [];
    for (const key of schemaKeys) {
      if (!(key in props)) continue;
      const entry = SETTINGS_SCHEMA[key];
      const pkg = props[key];
      if (!deepEqual(entry.default, pkg.default)) {
        mismatches.push(`${key}: schema=${JSON.stringify(entry.default)} package=${JSON.stringify(pkg.default)}`);
      }
    }
    expect(mismatches, `default mismatches: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('min/max bounds agree between schema and package', () => {
    const mismatches: string[] = [];
    for (const key of schemaKeys) {
      if (!(key in props)) continue;
      const entry = SETTINGS_SCHEMA[key];
      const pkg = props[key];
      if (entry.min !== pkg.minimum) {
        mismatches.push(`${key} min: schema=${entry.min} package=${pkg.minimum}`);
      }
      if (entry.max !== pkg.maximum) {
        mismatches.push(`${key} max: schema=${entry.max} package=${pkg.maximum}`);
      }
    }
    expect(mismatches, `range mismatches: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('enum values agree between schema and package', () => {
    const mismatches: string[] = [];
    for (const key of schemaKeys) {
      if (!(key in props)) continue;
      const entry = SETTINGS_SCHEMA[key];
      const pkg = props[key];
      const schemaEnum = entry.enum ?? null;
      const pkgEnum = pkg.enum ?? null;
      if (!deepEqual(schemaEnum, pkgEnum)) {
        mismatches.push(`${key}: schema=${JSON.stringify(schemaEnum)} package=${JSON.stringify(pkgEnum)}`);
      }
    }
    expect(mismatches, `enum mismatches: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('pattern strings agree between schema and package', () => {
    const mismatches: string[] = [];
    for (const key of schemaKeys) {
      if (!(key in props)) continue;
      const entry = SETTINGS_SCHEMA[key];
      const pkg = props[key];
      const schemaPattern = entry.pattern ?? null;
      const pkgPattern = pkg.pattern ?? null;
      if (schemaPattern !== pkgPattern) {
        mismatches.push(`${key}: schema=${schemaPattern} package=${pkgPattern}`);
      }
    }
    expect(mismatches, `pattern mismatches: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('scope agrees between schema and package', () => {
    const mismatches: string[] = [];
    for (const key of schemaKeys) {
      if (!(key in props)) continue;
      const entry = SETTINGS_SCHEMA[key];
      const pkg = props[key];
      if (entry.scope !== pkg.scope) {
        mismatches.push(`${key}: schema=${entry.scope} package=${pkg.scope}`);
      }
    }
    expect(mismatches, `scope mismatches: ${mismatches.join('; ')}`).toEqual([]);
  });

  it('every schema default value is itself schema-compliant', () => {
    const violators: string[] = [];
    for (const key of schemaKeys) {
      const entry = SETTINGS_SCHEMA[key];
      if (entry.type === 'array') {
        if (!Array.isArray(entry.default)) {
          violators.push(`${key}: array default is not an array`);
        }
        continue;
      }
      if (!isSchemaCompliantValue(entry, entry.default)) {
        violators.push(`${key}: default ${JSON.stringify(entry.default)} violates own schema`);
      }
    }
    expect(violators, `self-consistency violations: ${violators.join('; ')}`).toEqual([]);
  });
});

// `enum` in package.json is the JSON Schema `enum` keyword; the schema
// type tag is the more abstract `'enum'`. Map back to the package's
// JSON-Schema vocabulary for parity comparison.
function mapSchemaTypeToPackage(
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'enum',
  nullable: boolean
): string[] {
  const base = (() => {
    switch (type) {
      case 'enum':
        return 'string';
      case 'string':
      case 'integer':
      case 'number':
      case 'boolean':
      case 'array':
        return type;
    }
  })();
  return nullable ? [base, 'null'] : [base];
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length) return false;
    if (!ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}
