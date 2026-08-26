// An authored Phase field either changes what the host does, or says so.
//
// WHY. `timeoutSeconds` was validated, persisted, snapshotted, carried through
// the exchange format and written onto three audit payloads — and never bounded
// a process (S10, feature-155 security review postscript). The field had plenty
// of MENTIONS. What it had no instance of was a READ: somewhere outside the
// declaration-and-plumbing layer that consults the value to decide something.
//
// That is the distinguishing feature of the whole defect class this round keeps
// closing, and it is mechanically checkable. A field with mentions and no reader
// is either a defect or a deliberate declaration, and the difference cannot be
// inferred from the code — so it has to be stated. This gate makes stating it the
// only way through.
//
// WHAT COUNTS AS PLUMBING. Declaring the field, validating it, copying it into a
// snapshot, mapping it to and from YAML, projecting it to the UI: all of these
// touch the field without ever asking what it says. They are listed by module, so
// adding a plumbing site cannot accidentally satisfy this gate. Everything else
// is a reader.
//
// WHAT THIS GATE IS NOT. It does not check that a reader reads CORRECTLY, and it
// cannot: `phaseDef.timeoutSeconds` had four readers and all four wrote records.
// That is `phase-field-forwarding-seam.test.ts`'s job, which drives the value
// through and asserts the effect. This gate catches the cheaper, blunter case —
// no reader at all — and the two together cover more than either alone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORED_PHASE_FIELDS } from '../../src/config/process-definition-validator';

const SRC = resolve(__dirname, '..', '..', 'src');

/**
 * Modules that carry a Phase field without consulting it. A mention here is not
 * a reader, however many times it appears.
 */
const PLUMBING = [
  'contracts/process-definitions.ts',
  'contracts/generated/',
  'config/process-definition-validator.ts',
  'config/pipeline-config.ts',
  'config/process-catalog.ts',
  'config/pipeline-snapshot.ts',
  'services/process-yaml/',
  'ui/sidebar/phase-catalog-projection.ts',
  'ui/sidebar/phase-projector.ts'
];

/**
 * Fields with NO reader, each with the reason it has none.
 *
 * An entry here is a claim that the field is a declaration the host does not act
 * on. That is a legitimate thing for a field to be — it is not a legitimate thing
 * for a field to be SILENTLY.
 */
const DECLARATORY: Readonly<Record<string, string>> = {
  id: 'identity, not behaviour',
  phaseId: 'identity, not behaviour — the YAML spelling of `id`',
  name: 'identity, not behaviour',
  version: 'catalog lifecycle bookkeeping',
  description: 'operator-facing text',
  instruction: 'consumed by the prompt builder through the Phase, not by field name',
  skill: 'as `instruction`',
  loopable:
    'DEPRECATED and knowingly unread. `transition()` has never consulted it when handed a phase ' +
    'definition, and `run-planned-total.ts` records that at the code: the loop is decided by ' +
    '`retryCondition`. Kept in the shape so a caller holding an older PhaseDef type-checks.'
  // `evidencePolicy` was listed here until 2026-08-26 and has a reader now. The
  // removal is the interesting part: the gate's REVERSE direction is what forced
  // it. A field listed here that quietly gains an effect would otherwise carry a
  // note saying the host ignores it, and a reader would trust that note.
};

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

/** Every non-plumbing file that mentions `field` by name. */
function readers(field: string): string[] {
  const needle = new RegExp(`\\b${field}\\b`);
  return sourceFiles(SRC)
    .filter((file) => {
      const relative = file.slice(SRC.length + 1).replace(/\\/g, '/');
      return !PLUMBING.some((plumb) => relative.startsWith(plumb));
    })
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      // Comments mention fields constantly — several of this repo's best comments
      // are about fields they do not touch. Only code counts.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        // A TYPE MEMBER is not a read. `readonly loopable?: boolean;` in a local
        // shape declares that a caller may hand the field over; it does not ask
        // what the field says. `run-planned-total.ts` is the case that forced
        // this distinction, and it says so at the code: the member exists only so
        // a caller holding an older PhaseDef type-checks.
        .filter((line) => !/^\s*(readonly\s+)?[a-zA-Z][a-zA-Z0-9]*\??:\s*[^=]*;\s*$/.test(line))
        .join('\n');
      return needle.test(code);
    })
    .map((file) => file.slice(SRC.length + 1));
}

describe('every authored Phase field has a reader, or says why not', () => {
  it('finds a reader for each field not declared declaratory', () => {
    const unread = [...AUTHORED_PHASE_FIELDS]
      .filter((field) => !(field in DECLARATORY))
      .filter((field) => readers(field).length === 0);
    expect(
      unread,
      `authored Phase fields nothing reads: ${unread.join(', ')}. ` +
        'Either give the field an effect, or add it to DECLARATORY with the reason it has none.'
    ).toEqual([]);
  });

  it('declares nothing declaratory that actually has a reader', () => {
    // The dangerous direction. A field that GAINS an effect while still listed
    // here would carry a note saying the host ignores it, which is worse than no
    // note: a reader would trust it.
    const wrong = Object.keys(DECLARATORY)
      .filter((field) => !['id', 'name', 'version', 'description', 'instruction', 'skill', 'phaseId'].includes(field))
      .filter((field) => readers(field).length > 0);
    expect(
      wrong,
      `fields declared declaratory that now have readers: ${wrong.map((f) => `${f} (${readers(f).join(', ')})`).join('; ')}`
    ).toEqual([]);
  });

  it('exempts nothing that is not an authored field', () => {
    const stale = Object.keys(DECLARATORY).filter((field) => !AUTHORED_PHASE_FIELDS.has(field));
    expect(stale, `stale exemptions: ${stale.join(', ')}`).toEqual([]);
  });

  it('detects a reader when there is one (sanity)', () => {
    // Without this the scan could be broken and report every field declaratory.
    expect(readers('capabilities').length).toBeGreaterThan(0);
    expect(readers('hostVerification').length).toBeGreaterThan(0);
  });
});
