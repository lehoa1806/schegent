import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SUPPORTED_BACKENDS } from '../../src/contracts/backend-kinds';
import { SETTINGS_SCHEMA } from '../../src/config/settings-schema';

describe('Backend Runner Kind Exhaustive Parity (Feature 074 / FR-R7-06)', () => {
  it('ensures SUPPORTED_BACKENDS matches settings-schema enum and createBackendRunner switch', () => {
    const factoryContent = fs.readFileSync(
      path.join(__dirname, '../../src/runner/backend-runner-factory.ts'),
      'utf-8'
    );

    // 1. Extract case branches from createBackendRunner
    const caseRegex = /case\s+'([^']+)'\s*:/g;
    const cases = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = caseRegex.exec(factoryContent)) !== null) {
      const captured = match.at(1);
      if (captured !== undefined) cases.add(captured);
    }

    // 2. Read enum values directly from SETTINGS_SCHEMA
    const runnerEntry = Object.getOwnPropertyDescriptor(SETTINGS_SCHEMA, 'schegent.backend.runner')
      ?.value as { readonly enum?: readonly string[] } | undefined;
    const schemaEnum = runnerEntry?.enum ?? [];

    const supportedBackendsList = [...SUPPORTED_BACKENDS].sort();
    const casesList = [...cases].sort();
    const schemaEnumsList = [...schemaEnum].sort();

    expect(casesList).toEqual(supportedBackendsList);
    expect(schemaEnumsList).toEqual(supportedBackendsList);
    expect([...schemaEnum]).toEqual([...SUPPORTED_BACKENDS]);
  });
});
