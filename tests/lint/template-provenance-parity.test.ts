/**
 * FR-R4-F12 (FR-018, FR-019; contract AE6; tests-and-gates L3) -- the artifact criteria and the
 * template provenance record cannot silently disagree.
 *
 * `tests/evals/artifacts/criteria.json` names the provenance id and the SHA-256 of the spec, plan and
 * tasks templates its criteria were derived from. `docs/development/template-provenance.md` records the
 * measured hashes. This holds the two to each other, inside `repo/`, so a re-measurement that changes a
 * template has to change both. It reads files only. It cannot know a template changed unless the record
 * is re-measured; that is the record's own refresh obligation.
 *
 * It also holds the record to its authority and to its honest gap: `speckit_version` 1.2.3 is the only
 * version authority, and the upstream source revision is stated as pending qualification.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CRITERIA = join(REPO_ROOT, 'tests', 'evals', 'artifacts', 'criteria.json');
const RECORD = join(REPO_ROOT, 'docs', 'development', 'template-provenance.md');

interface CriteriaProvenance {
  readonly templateProvenance: {
    readonly id: string;
    readonly specKitVersion: string;
    readonly templates: Readonly<Record<string, string>>;
  };
}

/** What the record must hold for `criteria`: the id, the version authority, each hash. Returns the drift. */
function findDrift(recordText: string, criteria: CriteriaProvenance): string[] {
  const drift: string[] = [];
  const { id, specKitVersion, templates } = criteria.templateProvenance;
  if (!recordText.includes(id)) drift.push(`the record does not contain the provenance id ${id}`);
  if (!recordText.includes(`speckit_version\` ${specKitVersion}`) && !recordText.includes(`speckit_version: "${specKitVersion}"`)) {
    drift.push(`the record does not state speckit_version ${specKitVersion} as the authority`);
  }
  for (const [name, hash] of Object.entries(templates)) {
    if (!recordText.includes(hash)) drift.push(`the record does not contain the ${name} template hash ${hash}`);
  }
  return drift;
}

const criteria = (): CriteriaProvenance => JSON.parse(readFileSync(CRITERIA, 'utf8')) as CriteriaProvenance;
const record = (): string => readFileSync(RECORD, 'utf8');

describe('template provenance: the criteria and the record agree (FR-018)', () => {
  it('the record holds the criteria provenance id, the authority and the three template hashes', () => {
    expect(findDrift(record(), criteria())).toEqual([]);
    expect(Object.keys(criteria().templateProvenance.templates).sort()).toEqual(['plan', 'spec', 'tasks']);
  });

  it('control: a criteria object with one hash altered is reported', () => {
    const altered = criteria();
    const original = altered.templateProvenance.templates.plan as string;
    const mutated: CriteriaProvenance = {
      templateProvenance: {
        ...altered.templateProvenance,
        templates: { ...altered.templateProvenance.templates, plan: `${original.slice(0, -1)}${original.endsWith('0') ? '1' : '0'}` }
      }
    };

    const drift = findDrift(record(), mutated);

    expect(drift).toHaveLength(1);
    expect(drift.at(0)).toContain('the plan template hash');
  });

  it('control: an altered provenance id is reported', () => {
    const altered = criteria();
    const mutated: CriteriaProvenance = {
      templateProvenance: { ...altered.templateProvenance, id: `${altered.templateProvenance.id}-changed` }
    };

    expect(findDrift(record(), mutated)).toEqual([expect.stringContaining('the provenance id')]);
  });
});

describe('template provenance: the record states its authority and its gap (FR-019)', () => {
  it('names speckit_version 1.2.3 as the only version authority', () => {
    expect(record()).toContain('`.specify/init-options.json`, `speckit_version: "1.2.3"`');
    expect(record()).toContain('The only version authority');
  });

  it('states the upstream source revision as pending qualification, with its prerequisite', () => {
    const text = record();

    expect(text).toContain('pending qualification');
    expect(text).toContain("read the v1.2.3 tag's commit from the upstream repository");
  });

  it('records the one template that differs from its manifest', () => {
    const row = record()
      .split('\n')
      .find((line) => line.startsWith('| `.specify/templates/tasks-template.md`'));

    expect(row).toBeDefined();
    expect(row).toContain('locally adapted');
  });
});
