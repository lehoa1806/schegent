import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveGovernanceScope } from './envelope-presence';

const EXECUTION_REPO_ROOT = resolve(__dirname, '..', '..');
const ENVELOPE_ROOT = resolve(EXECUTION_REPO_ROOT, '..');
const SPECS_ROOT = resolve(ENVELOPE_ROOT, 'specs');

const SCOPE = resolveGovernanceScope();
const ENVELOPE_HERE = SCOPE.kind === 'envelope';

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
  // FR-R3-118 — guarded. `SPECS_ROOT` is `../specs`, which does not exist in a
  // standalone clone.
  if (!ENVELOPE_HERE) return [];
  return readdirSync(SPECS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{3}-/.test(entry.name))
    .map((entry) => {
      const directory = resolve(SPECS_ROOT, entry.name);
      const specPath = resolve(directory, 'spec.md');
      const tasksPath = resolve(directory, 'tasks.md');
      // FR-R3-058 — guarded, for the reason FR-R3-063 recorded when it guarded
      // `check-docs.mjs`: an unreadable required file threw ENOENT and killed the
      // whole run, so the one case this loop exists to notice was the one case it
      // could not report. A gate that crashes rather than reports is the same
      // defect as one that passes vacuously.
      let body: string;
      try {
        body = readFileSync(specPath, 'utf8');
      } catch {
        body = '';
      }
      const status = /^\*\*Status\*\*:\s*(.+?)\s*$/m.exec(body)?.[1] ?? '';
      return { directory, specPath, tasksPath, body, status };
    });
}

describe('spec traceability governance', () => {
  const artifacts = readArtifacts();

  // Vacuity control. Every assertion below filters `artifacts` and expects
  // nothing left, so an empty list passes all of them. This gate is unusual in
  // scanning OUTSIDE the execution repo — SPECS_ROOT resolves through
  // `../specs`, into the planning envelope — which makes an empty scan the
  // likely state rather than the unlikely one: a checkout of repo/ alone, or a
  // renamed envelope directory, yields zero artifacts and a fully green suite.
  it.skipIf(!ENVELOPE_HERE)('reads the spec artifacts it governs', () => {
    expect(
      artifacts.length,
      `No NNN-prefixed spec directory was found under ${SPECS_ROOT}. Every assertion ` +
        `below is passing over an empty list — the planning envelope is not where ` +
        `this gate expects it.`
    ).toBeGreaterThan(20);
    // A status line must actually parse out of at least most of them. The regex
    // is anchored and multiline; a template change to the Status heading would
    // leave every status as '' and silently empty the vocabulary check.
    const withStatus = artifacts.filter((artifact) => artifact.status.length > 0);
    expect(
      withStatus.length,
      'No spec yielded a parsed **Status**: line. The status regex no longer matches ' +
        'the template, so the vocabulary assertion is comparing empty strings.'
    ).toBeGreaterThan(artifacts.length / 2);
  });

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

  it.skipIf(!ENVELOPE_HERE)(
    'does not leave a completed or superseded feature as the AGENTS active plan',
    () => {
    // FR-R3-118 — guarded by the same predicate. `AGENTS.md` is the envelope's,
    // not the execution repository's.
    const agents = readFileSync(resolve(ENVELOPE_ROOT, 'AGENTS.md'), 'utf8');
    const active = /^Active plan:\s*(.+?)\s*$/m.exec(agents)?.[1] ?? '';
    if (/^none\.?$/i.test(active)) return;

    const relativePlan = /\((specs\/[^)]+\/plan\.md)\)/.exec(active)?.[1];
    expect(relativePlan, 'AGENTS.md must point to a feature plan or explicitly say none').toBeTruthy();
    const directory = resolve(ENVELOPE_ROOT, relativePlan!, '..');
    const artifact = artifacts.find((candidate) => candidate.directory === directory);
    expect(artifact, `missing spec for active plan ${relativePlan}`).toBeDefined();
    expect(['Complete', 'Superseded']).not.toContain(artifact!.status);
    }
  );

  // FR-R3-118 — the skip is REPORTED, not silent. Without this, a standalone
  // clone and a broken envelope path look identical from the outside: both are
  // a green suite with fewer tests.
  it('reports why it skipped when no planning envelope is present', () => {
    if (ENVELOPE_HERE) {
      expect(SCOPE.kind).toBe('envelope');
      return;
    }
    // Narrowed by the early return above, so a second `kind` comparison here is
    // dead. Assert on the reason directly.
    expect(SCOPE.kind).toBe('skipped');
    expect(SCOPE.reason).toContain('no planning envelope');
  });
});
