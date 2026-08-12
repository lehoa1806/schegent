import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as AuthoritativeAudit from '../../../src/contracts/audit-events';
import * as AuthoritativeSidebar from '../../../src/contracts/sidebar-ipc';
import * as Generated from '../../../src/contracts/generated/boundary-contracts';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('generated shared contract artifacts', () => {
  it('are fresh relative to the source contract files', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ['scripts/generate-contract-schemas.mjs', '--check'],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      )
    ).not.toThrow();
  });

  it('mirror authoritative sidebar command and host message literals', () => {
    expect(Generated.SIDEBAR_COMMAND_TYPES).toEqual(AuthoritativeSidebar.COMMAND_TYPES);
    expect(Generated.HOST_MESSAGE_TYPES).toEqual(AuthoritativeSidebar.HOST_MESSAGE_TYPES);
  });

  it('mirror authoritative audit event literals and preserve unknown-event policy metadata', () => {
    expect(Generated.AUDIT_EVENT_TYPES).toEqual(AuthoritativeAudit.ALL_AUDIT_EVENT_TYPES);

    const schema = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'src/contracts/generated/schemas/audit-events.schema.json'),
        'utf8'
      )
    ) as { properties: { unknownAuditEventPolicy: { const: string } } };
    expect(schema.properties.unknownAuditEventPolicy.const).toBe('warn-and-preserve');
  });

  it('classifies every PRD release-boundary family', () => {
    const families = new Set(Generated.CONTRACT_FAMILIES.map((family) => family.family));
    expect(families).toEqual(
      new Set([
        'sidebar-ipc',
        'settings',
        'queue',
        'workflow-state',
        'audit-events',
        'backend-runner',
        'raw-transcript-bytes'
      ])
    );
  });

  it('does not generate raw transcript bytes into UI-facing schemas', () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(REPO_ROOT, 'src/contracts/generated/schemas/contract-families.json'),
        'utf8'
      )
    ) as { families: readonly { family: string; status: string; schemaFiles: readonly string[] }[] };
    const rawTranscript = manifest.families.find(
      (family) => family.family === 'raw-transcript-bytes'
    );
    expect(rawTranscript).toMatchObject({
      status: 'typescript-only',
      schemaFiles: []
    });
  });
});
