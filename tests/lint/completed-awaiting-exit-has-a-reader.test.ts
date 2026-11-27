// SC-008 (BUG-001) — `completedAwaitingExit` is READ by the controller, not just
// published to it.
//
// WHAT IT COST TO NOT HAVE THIS. `src/runner/claude-cli.ts` set this field, and
// `src/runner/invocation-result.ts` documented precisely what it means, for the
// whole life of feature 145. No controller code ever asked. So the non-zero-exit
// arm in `PhaseRunner.run` read an exit code of 143 as the backend's verdict when
// 143 was `128 + 15` — the runner's OWN SIGTERM, sent after it had already parsed
// a clean terminal result and waited out FR-025's settle window. A `finalize`
// phase that passed 9 of 9 checks, ran `npm run verify` twice at exit 0, committed
// 165 files and merged them was recorded as having failed, and the queue halted.
//
// The field that would have distinguished the two was RIGHT THERE, on the same
// object, correctly set. Nothing read it.
//
// WHY A GATE AND NOT JUST THE FIX. The fix is one predicate, and the next person
// to simplify the non-zero-exit arm can delete it without a single test naming the
// field — the behavioural tests in `tests/unit/controller/` assert an OUTCOME, so
// they would catch a deletion today but not a rewrite that reintroduced the same
// blind spot by a different route. This gate names the field, which is the thing
// that must not become unread again.
//
// SIBLING, NOT DUPLICATE. `authored-fields-have-readers.test.ts` holds the same
// shape of invariant over `AUTHORED_PHASE_FIELDS` — Phase fields an operator
// writes in YAML. `completedAwaitingExit` is not one of those: it is a runner
// OUTPUT field, produced by the host and consumed by the host, so it sits entirely
// outside that gate's domain. The defect class is identical; the domain is not.
//
// HARD RULE 67 — this searches the field NAME, never a value it might hold. The
// values here are `true` and `143`, and both are among the least searchable tokens
// in the tree: `=== true` appears everywhere and means nothing, and any gate keyed
// on the literal 143 would pass on an unrelated constant while the read it exists
// to protect was gone. See docs/hard-rules.md rule 67 and the worked example in
// `retry-cap-resolution-site.test.ts`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The field name. Not its value — see rule 67 in the header. */
const FIELD = 'completedAwaitingExit';

const SRC = resolve(__dirname, '..', '..', 'src');

/**
 * Where the read has to live. The producer is in `src/runner/`; this gate is about
 * the CONSUMER, because a field with a producer and no consumer is exactly the
 * state that shipped BUG-001.
 */
const CONSUMER_ROOT = resolve(SRC, 'controller');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * The file's code with everything that is not code removed.
 *
 * THIS IS THE LOAD-BEARING PART OF THE GATE. `completedAwaitingExit` is mentioned
 * in three comment blocks under `src/` and in one JSON schema, and every one of
 * those mentions is prose ABOUT the field. A gate that accepted them would have
 * passed on the pre-fix tree — the tree that shipped the defect — because
 * `claude-cli.ts` and `invocation-result.ts` both discussed the field at length
 * while no controller consulted it. Documentation is what the defect had.
 *
 * Stripped, in order: block comments, whole-line `//` comments, and bare type
 * members. A type member (`completedAwaitingExit?: boolean;`) declares that a
 * caller may hand the field over; it does not ask what the field says. Borrowed
 * from `authored-fields-have-readers.test.ts`, which drew the same line for the
 * same reason.
 */
function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .filter((line) => !/^\s*(readonly\s+)?[a-zA-Z][a-zA-Z0-9]*\??:\s*[^=]*;\s*$/.test(line))
    .join('\n');
}

function readersUnder(root: string): string[] {
  return tsFilesUnder(root)
    .filter((file) => codeOf(readFileSync(file, 'utf8')).includes(FIELD))
    .map((file) => file.slice(SRC.length + 1));
}

describe('the completedAwaitingExit runner signal has a controller reader (SC-008)', () => {
  it('finds the files it governs', () => {
    // Vacuity control. Every assertion below is "some file under this root
    // contains X", and an empty file list makes them all fail loudly — but the
    // TRAP is the reverse-direction tests, which pass trivially on an empty scan.
    // A path that stops resolving is the way this gate goes quietly dead.
    const files = tsFilesUnder(CONSUMER_ROOT);
    expect(
      files.length,
      `no .ts file found under ${CONSUMER_ROOT} — this gate is scanning nothing, so ` +
        'it cannot tell a read from its absence. The controller directory moved or ' +
        'was renamed; repoint CONSUMER_ROOT.'
    ).toBeGreaterThan(5);
  });

  it('at least one controller module reads the field', () => {
    const readers = readersUnder(CONSUMER_ROOT);
    expect(
      readers,
      `nothing under src/controller/ reads \`${FIELD}\`. The runner still publishes ` +
        'it and `invocation-result.ts` still documents what it means, which is ' +
        'precisely the state that shipped BUG-001: a host-authored exit code read ' +
        "as the backend's verdict, failing a phase that had succeeded. If the " +
        'attributability check moved, repoint this gate at its new home; if it was ' +
        'deleted, read specs/145-host-verifiable-gates/bugs/BUG-001.md first.'
    ).not.toEqual([]);
  });

  it('the reader is in the module that decides the phase verdict', () => {
    // Narrower than the check above, and deliberately so. A read that had drifted
    // into an unrelated controller module would satisfy "has a reader" while the
    // arm that judges the phase went back to trusting a bare exit code. The
    // verdict site is where the field has to be consulted, because that is the
    // decision it exists to inform.
    expect(readersUnder(CONSUMER_ROOT)).toContain('controller/phase-runner.ts');
  });

  it('does not count prose about the field as a read', () => {
    // The control that gives the gate its meaning. Both fixtures are exactly what
    // the pre-fix tree contained: a field discussed in detail and consulted
    // nowhere. If either of these registers as a read, this gate would have passed
    // on the tree that shipped the defect and is worth nothing.
    const blockComment = `/**\n * ${FIELD} is set when the marker was seen.\n */\nexport const x = 1;\n`;
    const lineComment = `// ${FIELD} means the process lingered past its result.\nexport const y = 2;\n`;
    expect(codeOf(blockComment)).not.toContain(FIELD);
    expect(codeOf(lineComment)).not.toContain(FIELD);
  });

  it('does not count a bare type member as a read', () => {
    // `invocation-result.ts`'s declaration is the field EXISTING, not the host
    // asking what it says. Kept separate from the prose case because it fails for
    // a different reason and would regress independently.
    expect(codeOf(`  ${FIELD}?: boolean;\n`)).not.toContain(FIELD);
  });

  it('counts an actual read (sanity)', () => {
    // Without this the stripper could be over-eager — deleting the real read along
    // with the prose — and every assertion above would still be satisfiable by
    // accident. Both live shapes: the predicate's comparison and the log payload.
    expect(codeOf(`  return raw.${FIELD} !== true;\n`)).toContain(FIELD);
    expect(codeOf(`      ${FIELD}: raw.${FIELD} === true\n`)).toContain(FIELD);
  });

  it('still has a producer for the controller to read', () => {
    // The other half of the pair. A reader consulting a field nobody sets is the
    // same defect inverted: the predicate would answer from `undefined` forever
    // and every phase would look attributable, which is the pre-fix behaviour
    // restored with a check sitting on top of it claiming otherwise.
    const producers = readersUnder(resolve(SRC, 'runner'));
    expect(
      producers,
      `nothing under src/runner/ sets \`${FIELD}\` any more, so the controller's ` +
        'check reads undefined on every invocation and silently answers "attributable" ' +
        'for all of them.'
    ).toContain('runner/claude-cli.ts');
  });
});
