import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARGV_ENUM_CLOSED_FIELDS,
  ARGV_FREE_FORM_FIELDS,
  AUTHORED_PHASE_FIELDS
} from '../../src/config/process-definition-validator';

/**
 * FR-R3-105 (FR-061) — every authored field is classified, so the next one that reaches
 * the child's command line cannot be added without a decision.
 *
 * WHY A PARTITION AND NOT A BOUND ON `model`. The defect was that `model` reached argv
 * unbounded, and fixing `model` alone leaves the identical hole open for the next
 * argv-reaching field someone authors. `AUTHORED_PHASE_FIELDS` is the existing inventory
 * and `pipeline-config.ts` already derives from it rather than restating it, so the rule
 * here is: three classes, and their union is the inventory exactly.
 *
 * The teeth are in the third class being **implicit**. A new field lands in
 * "does not reach argv" by default, and this gate then asserts that claim against the
 * adapters: if the field's name appears beside an `args.push` in any adapter, it does
 * reach argv and the default classification is wrong. So a new field is either
 * classified deliberately or caught here — never silently unbounded.
 */
const ROOT = resolve(__dirname, '..', '..');
const ADAPTERS = [
  'src/runner/claude-cli.ts',
  'src/runner/codex-cli.ts',
  'src/runner/agy-cli.ts'
] as const;

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** Every `request.<field>` that appears inside an `args.push(...)` call. */
function argvReachingFields(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const adapter of ADAPTERS) {
    const source = read(adapter);
    for (const push of source.matchAll(/args\.push\(([^;]*?)\);/gs)) {
      for (const field of (push[1] as string).matchAll(/request\.([a-zA-Z]+)/g)) {
        found.add(field[1] as string);
      }
    }
  }
  return found;
}

describe('FR-R3-105 — the authored-field argv partition holds', () => {
  it('scanned all three adapters and found argv pushes, or this gate reads nothing', () => {
    for (const adapter of ADAPTERS) {
      expect(read(adapter), `${adapter} must still build argv`).toContain('args.push(');
    }
    expect(argvReachingFields().size).toBeGreaterThan(0);
  });

  it('the two argv classes are disjoint', () => {
    const both = [...ARGV_FREE_FORM_FIELDS].filter((f) => ARGV_ENUM_CLOSED_FIELDS.has(f));
    expect(both, 'a field cannot be both free-form and enum-closed').toEqual([]);
  });

  it('every classified field is an authored field', () => {
    // A class naming something the inventory does not have is a bound on nothing.
    for (const field of [...ARGV_FREE_FORM_FIELDS, ...ARGV_ENUM_CLOSED_FIELDS]) {
      expect(
        AUTHORED_PHASE_FIELDS.has(field),
        `${field} is classified as argv-reaching but is not an authored field`
      ).toBe(true);
    }
  });

  it('every authored field the adapters actually push is classified', () => {
    // The load-bearing direction. An authored field that reaches argv and sits in neither
    // class is exactly the defect FR-R3-105 closed, one field later.
    const reaching = argvReachingFields();
    const classified = new Set([...ARGV_FREE_FORM_FIELDS, ...ARGV_ENUM_CLOSED_FIELDS]);
    const unclassified = [...reaching].filter(
      (field) => AUTHORED_PHASE_FIELDS.has(field) && !classified.has(field)
    );
    expect(
      unclassified,
      'An AUTHORED field is pushed into a backend command line without being classified as ' +
        'argv-reaching. An operator-imported document controls it, so an unbounded value is ' +
        'flag injection — add it to ARGV_FREE_FORM_FIELDS (and bound it) or to ' +
        'ARGV_ENUM_CLOSED_FIELDS if it is already closed to an enum.'
    ).toEqual([]);
  });

  it('no classified field has silently stopped reaching argv', () => {
    // The other direction, so the classification cannot rot into a bound on nothing: a
    // field claimed to reach argv that no adapter pushes any more is a stale entry.
    const reaching = argvReachingFields();
    const stale = [...ARGV_FREE_FORM_FIELDS, ...ARGV_ENUM_CLOSED_FIELDS].filter(
      (field) => !reaching.has(field)
    );
    expect(
      stale,
      'A field is classified as argv-reaching but no adapter pushes it. Remove the ' +
        'classification rather than leaving a bound whose subject is gone.'
    ).toEqual([]);
  });

  it('NON-VACUITY: an unclassified argv-reaching authored field would be detected', () => {
    // Simulated against the real extraction, so a future change to the regex shows up.
    const reaching = new Set([...argvReachingFields(), 'skill']);
    const classified = new Set([...ARGV_FREE_FORM_FIELDS, ...ARGV_ENUM_CLOSED_FIELDS]);
    const unclassified = [...reaching].filter(
      (field) => AUTHORED_PHASE_FIELDS.has(field) && !classified.has(field)
    );
    expect(AUTHORED_PHASE_FIELDS.has('skill'), 'skill must be an authored field for this probe').toBe(
      true
    );
    expect(unclassified).toEqual(['skill']);
  });
});
