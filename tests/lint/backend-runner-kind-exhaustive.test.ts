import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SUPPORTED_BACKENDS } from '../../src/runner/backend-runner-factory';

describe('Backend Runner Kind Exhaustive Parity (Feature 074)', () => {
  it('ensures SUPPORTED_BACKENDS matches settings-schema enum and createBackendRunner switch', () => {
    const factoryContent = fs.readFileSync(path.join(__dirname, '../../src/runner/backend-runner-factory.ts'), 'utf-8');
    const settingsContent = fs.readFileSync(path.join(__dirname, '../../src/config/settings-schema.ts'), 'utf-8');

    // 1. Extract case branches from createBackendRunner
    const caseRegex = /case\s+'([^']+)'\s*:/g;
    const cases = new Set<string>();
    let match;
    
    // Find cases inside createBackendRunner by just looking for them in the file
    // since this file only has one switch statement for backend runners
    while ((match = caseRegex.exec(factoryContent)) !== null) {
      cases.add(match[1]);
    }

    // 2. Extract enum values from settings-schema.ts
    let schemaEnums = new Set<string>();
    const runnerEnumMatch = /'schegent\.backend\.runner':\s*\{[^}]*enum:\s*\[([^\]]+)\]/m.exec(settingsContent);
    if (runnerEnumMatch && runnerEnumMatch[1]) {
      const parsed = runnerEnumMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
      schemaEnums = new Set(parsed);
    }

    const supportedBackendsList = [...SUPPORTED_BACKENDS].sort();
    const casesList = [...cases].sort();
    const schemaEnumsList = [...schemaEnums].sort();

    expect(casesList).toEqual(supportedBackendsList);
    expect(schemaEnumsList).toEqual(supportedBackendsList);
  });
});
