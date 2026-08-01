import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const EXECUTION_REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(EXECUTION_REPO_ROOT, '..');
const SPECS_ROOT = resolve(ENVELOPE_ROOT, 'specs');

const ALLOWED_STATUSES = new Set([
  'Draft',
  'Ready',
  'In Progress',
  'Verification Pending',
  'Deferred',
  'Superseded',
  'Complete'
]);

interface SpecArtifact {
  readonly directory: string;
  readonly specPath: string;
  readonly tasksPath: string;
  readonly body: string;
  readonly status: string;
}

function readArtifacts(): readonly SpecArtifact[] {
  return readdirSync(SPECS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3}-/.test(entry.name))
    .map((entry) => {
      const directory = resolve(SPECS_ROOT, entry.name);
      const specPath = resolve(directory, 'spec.md');
      const tasksPath = resolve(directory, 'tasks.md');
      const body = readFileSync(specPath, 'utf8');
      const status = /^\*\*Status\*\*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? '';
      return { directory, specPath, tasksPath, body, status };
    });
}

describe('spec traceability governance', () => {
  const artifacts = readArtifacts();

  it('uses only the authoritative status vocabulary', () => {
    const invalid = artifacts
      .filter((artifact) => !ALLOWED_STATUSES.has(artifact.status))
      .map((artifact) => `${basename(artifact.directory)}: ${artifact.status || '[missing]'}`);
    expect(invalid).toEqual([]);
  });

  it('does not classify specs as Complete while tasks remain unchecked', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Complete' && existsSync(artifact.tasksPath))
      .filter((artifact) => /^- \[ \]/m.test(readFileSync(artifact.tasksPath, 'utf8')))
      .map((artifact) => basename(artifact.directory));
    expect(invalid).toEqual([]);
  });

  it('requires every Superseded spec to name a successor link', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Superseded')
      .filter((artifact) => !/^\*\*Successor\*\*:\s*\[[^\]]+\]\([^)]+\)\s*$/m.test(artifact.body))
      .map((artifact) => basename(artifact.directory));
    expect(invalid).toEqual([]);
  });

  it('requires every Deferred spec to carry a rationale and backlog owner', () => {
    const invalid = artifacts
      .filter((artifact) => artifact.status === 'Deferred')
      .filter(
        (artifact) =>
          !/^## Deferral rationale\s*$/m.test(artifact.body) ||
          !/^\*\*Backlog owner\*\*:\s*\S.+$/m.test(artifact.body)
      )
      .map((artifact) => basename(artifact.directory));
    expect(invalid).toEqual([]);
  });

  it('does not leave a completed or superseded feature as the AGENTS active plan', () => {
    const agents = readFileSync(resolve(ENVELOPE_ROOT, 'AGENTS.md'), 'utf8');
    const active = /^Active plan:\s*(.+?)\s*$/m.exec(agents)?.[1] ?? '';
    if (/^none\.?$/i.test(active)) return;

    const relativePlan = /\((specs\/[^)]+\/plan\.md)\)/.exec(active)?.[1];
    expect(relativePlan, 'AGENTS.md must point to a feature plan or explicitly say none').toBeTruthy();
    const directory = resolve(ENVELOPE_ROOT, relativePlan!, '..');
    const artifact = artifacts.find((candidate) => candidate.directory === directory);
    expect(artifact, `missing spec for active plan ${relativePlan}`).toBeDefined();
    expect(['Complete', 'Superseded']).not.toContain(artifact!.status);
  });
});
