import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { SUPPORTED_BACKENDS, DEFAULT_BACKEND } from '../../src/runner/backend-runner-factory';

const ROOT = resolve(__dirname, '../..');
const DECISION_DOC = 'docs/concepts/unprompted-agent-not-contained.md';
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/**
 * What this gate guarantees, and what it does not.
 *
 * Guarantees:
 *   - every runner in SUPPORTED_BACKENDS has a stated permission posture, and
 *     the disclosure surfaces state it;
 *   - a permission-shaped argument cannot be added to or removed from a runner
 *     without the decision document changing;
 *   - `sideEffects` is not described as containment in any shipped document.
 *
 * Explicitly NOT guaranteed:
 *   - PERMISSION_FLAGS is enumerated, so a CLI that introduces a differently
 *     named capability switch passes here until someone adds it. This gate
 *     proves that *these* cannot change silently, not that no permission-
 *     affecting flag can ever appear unnoticed.
 *   - it checks presence and consistency, never whether the surrounding prose
 *     misleads. A document can satisfy every assertion here and still be badly
 *     written; that residual belongs to review.
 *   - it reads source, not runtime. That is sound only while the permission-
 *     shaped entries stay unconditional `const` array literals, which is itself
 *     asserted below rather than assumed — by parsing, not by line shape.
 *   - that assertion is ANCESTOR-based, and two ways of making the flag
 *     conditional do not put a conditional on the literal's ancestor chain:
 *
 *       (a) an early return before the declaration —
 *             if (!request.cliPath) return …;
 *             const args = ['--dangerously-skip-permissions'];
 *           the guard is a sibling statement, not an ancestor;
 *
 *       (b) an unconditional module-scope array spread conditionally at its
 *           use site —
 *             const PERMISSION_ARGS = ['--dangerously-skip-permissions'];
 *             const args = x ? [...PERMISSION_ARGS] : [];
 *           the literal is unconditional; its inclusion is not.
 *
 *     Closing these needs reachability analysis over every use site, which is a
 *     materially different tool from a lint gate. They are stated here instead
 *     of being implied away. Note that both are conspicuous in review — an early
 *     return above the argv, or an argv spread behind a condition, is visible in
 *     a diff in a way a wrapped line or a silent no-op is not, which is why this
 *     is a defensible place to stop rather than a hole left carelessly.
 *   - an argv shape this gate does not recognize FAILS rather than passing. That
 *     is the property that matters most here: the earlier draft ran no assertion
 *     at all on `args = [...]` inside a catch, on `Object.freeze([...])`, and on
 *     a destructured binding, and reported green for all three.
 */

/** Every failure names the decision document, so a contributor reads the decision. */
const seeDoc = (what: string): string =>
  `${what}. The permission posture is recorded in ${DECISION_DOC}; read it before changing this.`;

type Posture = 'prompts-disabled' | 'operator-configurable';

/**
 * The posture is read out of the document rather than pinned here. An operator
 * who later decides prompts should be configurable edits one line and this gate
 * follows. A gate you must delete to change your mind is a gate that gets
 * deleted — the defect feature 114's posture gate found in itself.
 */
function readPosture(): Posture {
  expect(
    existsSync(resolve(ROOT, DECISION_DOC)),
    `the decision document ${DECISION_DOC} is missing. It records why the backend runs without ` +
      `approval prompts, and this gate reads the posture out of it — restore it rather than ` +
      `deleting this test`
  ).toBe(true);
  const declarations = read(DECISION_DOC)
    .split('\n')
    .map((line) => /^Permission-posture:\s*(\S+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  expect(
    declarations.length,
    seeDoc('expected exactly one `Permission-posture:` declaration line')
  ).toBe(1);
  const value = declarations[0][1];
  expect(
    value,
    seeDoc(`\`Permission-posture: ${value}\` is not a recognized posture`)
  ).toMatch(/^(prompts-disabled|operator-configurable)$/);
  return value as Posture;
}

/**
 * The permission-flag family. Each entry carries its reason so the list is
 * reviewable rather than a regex nobody can evaluate. `documented` is the phrase
 * a disclosure surface must contain for a runner carrying that flag.
 */
const PERMISSION_FLAGS: ReadonlyArray<{ flag: string; why: string }> = Object.freeze([
  { flag: '--dangerously-skip-permissions', why: "disables the CLI's own approval prompts entirely" },
  { flag: '--sandbox', why: 'establishes an OS-enforced bound on what the process may touch' },
  { flag: '--permission-mode', why: 'selects a non-default approval posture' },
  { flag: '--allowedTools', why: 'restricts the tool surface the CLI may call' }
]);

/**
 * Surfaces that must state the posture. Split by whether an operator receives
 * them, because that split is the finding: `docs/**` is excluded from the VSIX,
 * so a disclosure written only there reaches nobody who installed the extension.
 */
const PACKAGED_SURFACES = Object.freeze(['README.md', 'SECURITY.md', 'package.json']);
const SOURCE_SURFACES = Object.freeze([
  'docs/security/threat-model.md',
  'docs/operations/backends.md',
  DECISION_DOC
]);

/**
 * Where the flag itself must appear verbatim. Every surface must state the
 * *posture*; only these must spell the flag. An operator-facing paragraph is
 * allowed to say "an OS-enforced workspace-write sandbox" rather than
 * "--sandbox" — requiring the literal everywhere would push argv spelling into
 * prose written for someone who does not read argv.
 */
const FLAG_LITERAL_SURFACES = Object.freeze([
  'package.json',
  'docs/security/threat-model.md',
  'docs/operations/backends.md',
  DECISION_DOC
]);

/**
 * Markdown wraps. Every phrase match below runs against whitespace-collapsed
 * text, or a line break inside a sentence silently defeats the assertion — which
 * is a gate that passes for the wrong reason.
 */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').toLowerCase();

function runnerSource(kind: string): string {
  const path = `src/runner/${kind}-cli.ts`;
  try {
    return read(path);
  } catch {
    // A runner whose adapter does not follow the `<kind>-cli.ts` convention is a
    // real condition, not a crash. Say so, rather than letting an ENOENT stand
    // in for a finding — a raw errno teaches a contributor nothing.
    expect.fail(
      seeDoc(
        `runner \`${kind}\` is in SUPPORTED_BACKENDS but ${path} does not exist. ` +
          `This gate resolves each runner's argv from that path; either add the adapter there ` +
          `or teach this file how ${kind} is resolved`
      )
    );
  }
}

/** The permission-shaped flags a runner's own adapter names. */
function flagsFor(kind: string): string[] {
  const source = runnerSource(kind);
  return PERMISSION_FLAGS.filter((entry) => source.includes(`'${entry.flag}'`)).map((e) => e.flag);
}

describe('backend permission posture', () => {
  it('is declared in exactly one place, in a form this gate can read', () => {
    expect(['prompts-disabled', 'operator-configurable']).toContain(readPosture());
  });

  it('keeps the decision document a decision, not just a declaration line', () => {
    // Parity with tests/lint/localization-posture.test.ts, which anchors the
    // structure of its posture document rather than only its value. Without
    // this, the grounds, the reversal condition, and the pointer back to this
    // gate could all be stripped and nothing would notice — leaving a bare
    // `Permission-posture:` line that satisfies readPosture() and tells a reader
    // nothing about why.
    const doc = read(DECISION_DOC);
    // `Status:` is a single short line by convention, so it stays anchored and
    // multiline. The free-text checks run against collapsed text, per the same
    // rule the rest of this file follows: a phrase that wraps is still the same
    // phrase, and a rule that disagrees produces a false positive on an ordinary
    // meaning-preserving rewrap.
    const collapsed = collapse(doc);
    expect(doc, seeDoc('the decision document must carry a `Status:` line')).toMatch(
      /^Status:\s+\S+/m
    );
    expect(
      collapsed,
      seeDoc('the decision document must name the condition that would reopen the decision')
    ).toMatch(/condition that would reopen/);
    expect(
      collapsed,
      seeDoc('the decision document must name the gate that holds it, so the two stay findable from each other')
    ).toContain('tests/lint/backend-permission-posture.test.ts');
  });

  it('gives every supported runner a permission-shaped flag to be judged by', () => {
    for (const kind of SUPPORTED_BACKENDS) {
      const flags = flagsFor(kind);
      expect(
        flags.length,
        seeDoc(
          `runner \`${kind}\` names no permission-shaped flag, so its posture cannot be stated. ` +
            `Either it carries one of ${PERMISSION_FLAGS.map((e) => e.flag).join(', ')}, or the ` +
            `family in this file needs the new one added with its reason`
        )
      ).toBeGreaterThan(0);
    }
  });

  it('keeps the permission-shaped arguments unconditional, so reading source is sound', () => {
    // The claim in the decision document is that the flag is unconditional. This
    // gate resolves each runner's posture by reading source, and that is sound
    // ONLY while that claim holds — so the claim has to be checked, not assumed.
    //
    // Line-shaped checks cannot do it. A physical line carrying the flag can look
    // perfectly unconditional while the statement it belongs to sits inside an
    // `if`, or while the array is rebuilt by a later reassignment:
    //
    //     let args = ['-p', '-'];
    //     if (!request.model) {
    //       args = [...args, '--dangerously-skip-permissions'];   // <- looks fine
    //     }
    //
    // So the parse is TypeScript's own, following the house pattern in
    // tests/lint/empty-catch-declares-intent.test.ts. Two properties are asserted
    // per flag: no ancestor of the literal is a conditional construct, and the
    // literal is a direct element of an array bound to a `const` that is never
    // reassigned in its function.
    for (const kind of SUPPORTED_BACKENDS) {
      const source = runnerSource(kind);
      const file = ts.createSourceFile(
        `${kind}-cli.ts`,
        source,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true
      );

      for (const flag of flagsFor(kind)) {
        const literals: ts.StringLiteral[] = [];
        const collect = (node: ts.Node): void => {
          if (ts.isStringLiteral(node) && node.text === flag) literals.push(node);
          ts.forEachChild(node, collect);
        };
        collect(file);

        expect(
          literals.length,
          seeDoc(
            `expected to locate \`${flag}\` as a string literal in runner \`${kind}\`. ` +
              `flagsFor() found the text, so it is present but not as a literal this gate can judge`
          )
        ).toBeGreaterThan(0);

        for (const literal of literals) {
          // 1. Nothing on the path to the function root may be a conditional.
          const guards: string[] = [];
          // `parent` is non-optional once the file is parsed with setParentNodes,
          // so the walk terminates at the SourceFile rather than at undefined.
          let cursor: ts.Node = literal.parent;
          let enclosingFunction: ts.Node | undefined;
          while (!ts.isSourceFile(cursor)) {
            if (
              ts.isIfStatement(cursor) ||
              ts.isConditionalExpression(cursor) ||
              ts.isSwitchStatement(cursor) ||
              ts.isTryStatement(cursor) ||
              ts.isCatchClause(cursor) ||
              (ts.isBinaryExpression(cursor) &&
                (cursor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
                  cursor.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
                  cursor.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
            ) {
              guards.push(ts.SyntaxKind[cursor.kind]);
            }
            if (
              !enclosingFunction &&
              (ts.isFunctionDeclaration(cursor) ||
                ts.isMethodDeclaration(cursor) ||
                ts.isArrowFunction(cursor) ||
                ts.isFunctionExpression(cursor))
            ) {
              enclosingFunction = cursor;
            }
            cursor = cursor.parent;
          }
          expect(
            guards,
            seeDoc(
              `runner \`${kind}\` reaches \`${flag}\` through ${guards.join(', ')}, so the flag is ` +
                `conditional. This gate resolves posture by reading source, which is only sound ` +
                `while the permission-shaped arguments are unconditional — and the decision ` +
                `document says they are. Change the flag and the document together, or not at all`
            )
          ).toEqual([]);

          // 2. It must be a direct element of an array bound to a never-reassigned const.
          const arrayLiteral = literal.parent;
          expect(
            ts.isArrayLiteralExpression(arrayLiteral) &&
              arrayLiteral.elements.some((element) => element === literal),
            seeDoc(
              `runner \`${kind}\` must declare \`${flag}\` as a direct element of an array literal, ` +
                `not as part of an expression that produces one`
            )
          ).toBe(true);

          // 3. The array must reach a `const` binding through a recognized shape.
          //
          // The earlier draft only *proceeded* when it saw a VariableDeclaration
          // with an Identifier name, and silently ran no assertion at all
          // otherwise — so `args = [...]` inside a catch, `Object.freeze([...])`
          // (an idiom this very file uses), and `let [flag] = [...]` each skipped
          // the whole check while reporting green. Unrecognized shapes now fail
          // loud, which is the property that matters: a form nobody anticipated
          // must stop the gate, not slip through it.
          let binding: ts.Node = arrayLiteral.parent;
          while (
            ts.isCallExpression(binding) ||        // Object.freeze([...])
            ts.isAsExpression(binding) ||          // [...] as const
            ts.isParenthesizedExpression(binding)
          ) {
            binding = binding.parent;
          }
          expect(
            ts.isVariableDeclaration(binding),
            seeDoc(
              `runner \`${kind}\` reaches \`${flag}\` through a ${ts.SyntaxKind[binding.kind]}, ` +
                `which this gate cannot judge. The permission argv must be a plain \`const\` array ` +
                `so that "unconditional" is checkable — an assignment, a destructuring, or a ` +
                `computed binding is not. If the shape is legitimate, teach this gate about it ` +
                `rather than removing the assertion`
            )
          ).toBe(true);
          const declaration = binding as ts.VariableDeclaration;
          expect(
            ts.isIdentifier(declaration.name),
            seeDoc(
              `runner \`${kind}\` binds the array holding \`${flag}\` with a destructuring ` +
                `pattern. The bound name is what this gate follows for reassignment, so a ` +
                `pattern makes the check unenforceable`
            )
          ).toBe(true);
          const list = declaration.parent;
          expect(
            ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0,
            seeDoc(
              `runner \`${kind}\` binds the array holding \`${flag}\` to a mutable binding. ` +
                `A \`let\` can be reassigned under a condition later in the function, which ` +
                `makes the flag conditional without this line changing`
            )
          ).toBe(true);

          // 4. That identifier must never be reassigned — shadow-aware, so an
          //    unrelated `let` of the same name in another function is not
          //    mistaken for a reassignment of this one.
          const name = (declaration.name as ts.Identifier).text;
          const shadowsName = (node: ts.Node): boolean => {
            if (
              (ts.isFunctionDeclaration(node) ||
                ts.isFunctionExpression(node) ||
                ts.isArrowFunction(node) ||
                ts.isMethodDeclaration(node)) &&
              node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
            ) {
              return true;
            }
            let shadowed = false;
            if (ts.isBlock(node) || ts.isSourceFile(node)) {
              for (const statement of node.statements) {
                if (!ts.isVariableStatement(statement)) continue;
                for (const d of statement.declarationList.declarations) {
                  if (ts.isIdentifier(d.name) && d.name.text === name && d !== declaration) {
                    shadowed = true;
                  }
                }
              }
            }
            return shadowed;
          };
          const reassignments: string[] = [];
          const scanAssignments = (node: ts.Node): void => {
            if (node !== (enclosingFunction ?? file) && shadowsName(node)) return;
            if (
              ts.isBinaryExpression(node) &&
              node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(node.left) &&
              node.left.text === name
            ) {
              reassignments.push(node.getText(file).slice(0, 60));
            }
            ts.forEachChild(node, scanAssignments);
          };
          scanAssignments(enclosingFunction ?? file);
          expect(
            reassignments,
            seeDoc(
              `runner \`${kind}\` reassigns \`${name}\`, the array holding \`${flag}\`, at ` +
                `${reassignments.join('; ')}. A reassignment can add or remove the flag under a ` +
                `condition, which is exactly what "unconditional" rules out`
            )
          ).toEqual([]);
        }
      }
    }
  });

  it('names every runner on every disclosure surface', () => {
    if (readPosture() !== 'prompts-disabled') return;
    for (const surface of [...PACKAGED_SURFACES, ...SOURCE_SURFACES]) {
      const text = collapse(read(surface));
      for (const kind of SUPPORTED_BACKENDS) {
        expect(
          text,
          seeDoc(
            `${surface} does not name runner \`${kind}\`. Every disclosure surface must state ` +
              `what each runner is permitted to do — an omitted runner reads as a contained one`
          )
        ).toContain(kind);
      }
    }
  });

  it('states the posture in words on every surface, and the flag verbatim where the flag is the fact', () => {
    if (readPosture() !== 'prompts-disabled') return;

    // Everywhere: the posture, in terms an operator can act on.
    for (const surface of [...PACKAGED_SURFACES, ...SOURCE_SURFACES]) {
      const text = collapse(read(surface));
      expect(
        text.includes('without asking') ||
          text.includes('approval prompts are off') ||
          text.includes('approval prompts disabled') ||
          text.includes('prompts are disabled'),
        seeDoc(
          `${surface} names the runners but never says what the posture means in practice. ` +
            `State that the agent acts without asking, in words, not only by naming a flag`
        )
      ).toBe(true);
      expect(
        text.includes('sandbox'),
        seeDoc(
          `${surface} does not mention the one runner with an OS-enforced bound. ` +
            `An asymmetry stated only on one side reads as no asymmetry`
        )
      ).toBe(true);
    }

    // Where the flag is the fact: the literal, so a rename cannot pass silently.
    const flags = new Set(SUPPORTED_BACKENDS.flatMap((kind) => flagsFor(kind)));
    for (const surface of FLAG_LITERAL_SURFACES) {
      const text = read(surface);
      for (const flag of flags) {
        expect(
          text,
          seeDoc(
            `${surface} does not mention \`${flag}\`, which at least one runner is spawned with. ` +
              `This surface is technical, so it carries the flag verbatim`
          )
        ).toContain(flag);
      }
    }
  });

  it('identifies the default runner in the disclosure', () => {
    if (readPosture() !== 'prompts-disabled') return;
    // "The only bounded runner is not the default" is the fact that makes the
    // asymmetry matter, so the default has to be identifiable as such — and
    // identifiable *near* the runner's name, not by the word "default"
    // appearing anywhere in a long document.
    for (const surface of [...PACKAGED_SURFACES, ...SOURCE_SURFACES]) {
      const text = collapse(read(surface));
      const near = new RegExp(
        `${DEFAULT_BACKEND}[^.]{0,80}\\bdefault\\b|\\bdefault\\b[^.]{0,80}${DEFAULT_BACKEND}`
      );
      expect(
        near.test(text),
        seeDoc(
          `${surface} must identify \`${DEFAULT_BACKEND}\` as the default runner, close enough to ` +
            `its name that a reader connects the two`
        )
      ).toBe(true);
    }
  });
});

/**
 * Documents whose containment wording is a record of what was true on their
 * date. Enumerated deliberately: a directory-wide exclusion would let the next
 * drift land in a file nobody re-reads.
 *
 * Honest note: on today's tree this list excludes nothing — neither review
 * currently pairs the vocabulary with a `sideEffects` reference, so removing the
 * list would not turn the suite red. It is here because a dated review that
 * quotes the old wording is a normal thing to write, and the mechanism was
 * observed working (a record was given the old wording, the gate stayed green,
 * and the change was reverted) rather than assumed. An allowlist nobody has
 * seen fire is one nobody should trust.
 */
const HISTORICAL_RECORDS = Object.freeze([
  'docs/operations/principal-architecture-review-2026-05-18.md',
  'docs/operations/principal-architecture-review-2026-08-18.md'
]);

/** Phrases that describe `sideEffects` as bounding the subprocess. */
const CONTAINMENT_VOCABULARY = Object.freeze([
  'containment class',
  'declared containment',
  'permitted to write'
]);

/**
 * "Containment" also names a real and unrelated path-boundary mechanism in this
 * product, correctly, in at least eleven places. The rule therefore fires only
 * when the vocabulary and a `sideEffects` reference occupy the same unit of text
 * — a paragraph, a list item, or a table row.
 */
const SIDE_EFFECTS_REFERENCES = Object.freeze([
  'sideeffects',
  'side effects',
  'side-effects'
]);

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(resolve(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) markdownFiles(rel, out);
    else if (entry.endsWith('.md')) out.push(rel);
  }
  return out;
}

/**
 * A "unit of text" is a table row, a list item, or a whitespace-collapsed
 * paragraph — the units a reader actually reads as one statement.
 *
 * Splitting per physical line would be wrong in the same way the first describe
 * block already guards against: this repository hard-wraps prose (README.md
 * does), so a vocabulary phrase and a `sideEffects` reference can sit in one
 * sentence and two lines, and a per-line rule would pass on it. Splitting only
 * on blank lines would be wrong in the other direction: a markdown table is one
 * block, so vocabulary in row 1 and `sideEffects` in row 5 would false-positive.
 * Table rows and list items are therefore their own units; everything else is
 * grouped into paragraphs and collapsed.
 */
function textUnits(source: string): string[] {
  const units: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) units.push(collapse(paragraph.join(' ')));
    paragraph = [];
  };
  let inListItem = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      inListItem = false;
      continue;
    }
    if (trimmed.startsWith('|')) {
      flush();
      inListItem = false;
      units.push(collapse(trimmed));
      continue;
    }
    if (/^[-*+]\s|^\d+\.\s/.test(trimmed)) {
      // A new list item starts a new statement. Its wrapped continuation lines
      // are part of it, so they accumulate rather than becoming units of their
      // own — otherwise a bullet that wraps mid-sentence defeats the rule in
      // exactly the way per-line splitting did.
      flush();
      inListItem = true;
      paragraph.push(trimmed);
      continue;
    }
    if (inListItem && !/^\s/.test(line)) {
      // Lazy continuation: a plain paragraph line butted against a list item
      // with no blank line between them. Markdown tolerates it; merging it into
      // the bullet does not, because it would join two unrelated statements into
      // one unit and report a pairing neither of them makes.
      flush();
      inListItem = false;
    }
    paragraph.push(trimmed);
  }
  flush();
  return units;
}

describe('sideEffects is not described as containment', () => {
  // Every markdown document at the repo root, not a hand-picked two.
  //
  // This listed `README.md` and `SECURITY.md` explicitly and then swept `docs/`,
  // which left `ARCHITECTURE.md`, `CONTRIBUTING.md`, `PRODUCT.md`, `DESIGN.md`
  // and `RELEASE.md` unscanned — and `ARCHITECTURE.md` was carrying an eighth
  // instance of the containment vocabulary the whole time. The sweep that found
  // "seven places" found seven because it only looked in six of them.
  //
  // A gate whose scope is narrower than its claim is the defect this round kept
  // producing. Deriving the root set rather than naming two of it is the fix.
  const rootMarkdown = readdirSync(ROOT)
    .filter((entry) => entry.endsWith('.md'))
    .sort();
  const surfaces = [...rootMarkdown, ...markdownFiles('docs')].filter(
    (path) => !HISTORICAL_RECORDS.includes(path)
  );

  it('finds no containment vocabulary in the same unit of text as a sideEffects reference', () => {
    const offenders: string[] = [];
    for (const surface of surfaces) {
      for (const unit of textUnits(read(surface))) {
        const vocabulary = CONTAINMENT_VOCABULARY.find((phrase) => unit.includes(phrase));
        if (!vocabulary) continue;
        if (!SIDE_EFFECTS_REFERENCES.some((reference) => unit.includes(reference))) continue;
        offenders.push(`${surface}: "${vocabulary}" alongside a sideEffects reference`);
      }
    }
    expect(
      offenders,
      seeDoc(
        `sideEffects must be described by what it selects — a consent prompt, a rollback ` +
          `checkpoint, and the Git-capable-runner refusal — and by what it does not do, which is ` +
          `restrict the spawned subprocess. Offending text:\n  ${offenders.join('\n  ')}`
      )
    ).toEqual([]);
  });

  it('leaves the unrelated path-containment documentation alone', () => {
    // The false-positive control, asserted against the tree rather than assumed:
    // these sentences use the same word for a different and correct mechanism.
    expect(read('docs/security/whitepaper.md').toLowerCase()).toContain('canonical-path containment');
    expect(read('docs/reference/file-layout.md').toLowerCase()).toContain('containment check');
  });

  it('keeps the one real enforcement visible wherever the field is described', () => {
    // Correcting "containment" must not overshoot into "the declaration is inert".
    //
    // Scoped to the units that actually describe the field. A whole-file check
    // would pass on unrelated prose: `settings.md` says "a value outside the
    // range is refused, not clamped" about a concurrency setting, and
    // `custom-phases.md` says "a launch that names no pipeline is refused" —
    // either would satisfy a file-wide substring search while the sideEffects
    // description had lost the refusal entirely.
    for (const surface of ['docs/reference/settings.md', 'docs/features/custom-phases.md', DECISION_DOC]) {
      const describing = textUnits(read(surface)).filter((unit) =>
        SIDE_EFFECTS_REFERENCES.some((reference) => unit.includes(reference))
      );
      expect(
        describing.length,
        seeDoc(`${surface} no longer describes sideEffects at all`)
      ).toBeGreaterThan(0);
      expect(
        describing.some((unit) => unit.includes('git-capable') || unit.includes('refused')),
        seeDoc(
          `${surface} describes sideEffects without mentioning the Git-capable-runner refusal, ` +
            `which is the one rule the declaration really enforces. Correcting "containment" must ` +
            `not overshoot into implying the declaration does nothing`
        )
      ).toBe(true);
    }
  });
});

/**
 * FR-R3-032 — the documented posture must equal the spawned one.
 *
 * FR-R3-031 made the documents say the right thing. These checks make them stay
 * that way per runner: a capability row claiming a bound the adapter does not
 * establish, or denying one it does, fails. The earlier checks cannot catch
 * that — they assert each runner is *named* and that posture words appear
 * *somewhere in the file*, which a stale or copied-and-wrong cell satisfies.
 */
const CAPABILITY_TABLE_DOC = 'docs/operations/backends.md';
const POSTURE_COLUMN = 'Permission posture';

interface CapabilityRow {
  readonly runner: string;
  readonly posture: string;
}

/**
 * Reads the capability table by *header name*, never by column index. Adding a
 * column shifts every index, and a check comparing the wrong cells passes
 * silently — the vacuous-pass failure this file has already been bitten by three
 * times. An unlocatable header or an empty row set fails rather than iterating
 * nothing.
 */
function capabilityRows(): CapabilityRow[] {
  const lines = read(CAPABILITY_TABLE_DOC).split('\n');
  const headerLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trimStart().startsWith('|') && line.includes(POSTURE_COLUMN));
  // Exactly one, not the first of several. A second table with a same-named
  // column would otherwise anchor this silently on the wrong one — the ambiguity
  // failure mode the rest of this file is written to avoid.
  expect(
    headerLines.length,
    seeDoc(
      `expected exactly one capability table with a \`${POSTURE_COLUMN}\` column in ` +
        `${CAPABILITY_TABLE_DOC}, found ${headerLines.length}. Anchoring on the first of several ` +
        `would compare the wrong rows without failing`
    )
  ).toBe(1);
  const headerIndex = headerLines.length === 1 ? headerLines[0].index : -1;
  expect(
    headerIndex,
    seeDoc(
      `could not locate a capability table with a \`${POSTURE_COLUMN}\` column in ` +
        `${CAPABILITY_TABLE_DOC}. This check reads that column by name; if the table was ` +
        `restructured, teach it the new shape rather than deleting the assertion`
    )
  ).toBeGreaterThanOrEqual(0);

  // `\|` inside a cell is an escaped pipe, not a column separator. None exist
  // today; splitting naively would misalign every column after the first one
  // that gained one, and misaligned columns compare the wrong values silently.
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((cell) => cell.replace(/\\\|/g, '|').trim());
  const postureColumn = cells(lines[headerIndex]).indexOf(POSTURE_COLUMN);
  expect(
    postureColumn,
    seeDoc(`the \`${POSTURE_COLUMN}\` header is present but not resolvable as a column`)
  ).toBeGreaterThanOrEqual(0);

  const rows: CapabilityRow[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) break;
    if (/^\|[\s|:-]+\|$/.test(trimmed)) continue; // separator
    const parts = cells(line);
    const runner = /`([a-z][a-z0-9-]*)`/.exec(parts[0] ?? '')?.[1];
    if (!runner) continue;
    rows.push({ runner, posture: parts[postureColumn] ?? '' });
  }
  expect(
    rows.length,
    seeDoc(
      `the capability table in ${CAPABILITY_TABLE_DOC} resolved no runner rows. A table this ` +
        `check cannot read must fail, not pass over an empty set`
    )
  ).toBeGreaterThan(0);
  return rows;
}

/**
 * The sandbox argument a runner actually spawns, with its mode — or null.
 *
 * Recognizes the adjacent-literal form (`'--sandbox', 'workspace-write'`), which
 * is what the only current user spawns. A future adapter using `--sandbox=mode`,
 * a variable holding the mode, or a spread would not match — and the consequence
 * is a loud failure, not a silent gap: this would report "unsandboxed" while the
 * capability row says otherwise, and the correspondence check fails. That is the
 * right direction, and it is stated rather than left to be rediscovered.
 */
function observedSandbox(kind: string): string | null {
  const source = runnerSource(kind);
  const match = /'--sandbox',\s*'([^']+)'/.exec(source);
  return match ? `--sandbox ${match[1]}` : null;
}

describe('documented containment matches the spawned argv', () => {
  it('gives every supported runner a row in the capability table', () => {
    // Being named in prose is not having a row. The FR-R3-031 checks assert the
    // former; only this one asserts the latter.
    const documented = new Set(capabilityRows().map((row) => row.runner));
    for (const kind of SUPPORTED_BACKENDS) {
      expect(
        documented.has(kind),
        seeDoc(
          `runner \`${kind}\` has no row in the ${CAPABILITY_TABLE_DOC} capability table. ` +
            `It may be mentioned in the prose — that is not the same thing, and a reader ` +
            `comparing rows would conclude it does not exist`
        )
      ).toBe(true);
    }
  });

  it('agrees with each runner about whether it is sandboxed, and in which mode', () => {
    for (const row of capabilityRows()) {
      if (!(SUPPORTED_BACKENDS as ReadonlyArray<string>).includes(row.runner)) continue;
      const observed = observedSandbox(row.runner);
      const claimsSandbox = /--sandbox/.test(row.posture);

      expect(
        claimsSandbox,
        seeDoc(
          observed === null
            ? `${CAPABILITY_TABLE_DOC} documents runner \`${row.runner}\` as sandboxed ` +
              `("${row.posture.slice(0, 70)}"), but its adapter spawns no sandbox argument. ` +
              `One of the two is wrong and the document is the one a reader trusts`
            : `${CAPABILITY_TABLE_DOC} documents runner \`${row.runner}\` as unsandboxed ` +
              `("${row.posture.slice(0, 70)}"), but its adapter spawns \`${observed}\`. ` +
              `An understated bound is still a wrong bound`
        )
      ).toBe(observed !== null);

      if (observed !== null) {
        // The mode, not merely the presence. A change from workspace-write to a
        // weaker mode would otherwise pass while the row still promised
        // `.git` read-only.
        expect(
          row.posture,
          seeDoc(
            `${CAPABILITY_TABLE_DOC} documents runner \`${row.runner}\` without naming the ` +
              `sandbox mode it actually spawns (\`${observed}\`). The mode is the bound; ` +
              `naming the flag alone promises less than it appears to`
          )
        ).toContain(observed);
      }
    }
  });

  it('does not let the backend-equivalence claim return', () => {
    // Matched by shape, not by one sentence: the removed claim generalised from
    // "the backends share these properties" to "the trust boundary is the same",
    // and a reworded version would defeat a literal match.
    const offenders: string[] = [];
    for (const surface of ['docs/security/threat-model.md', 'docs/security/whitepaper.md', CAPABILITY_TABLE_DOC]) {
      for (const unit of textUnits(read(surface))) {
        if (!unit.includes('trust boundar')) continue;

        // Detect broadly; exempt narrowly. This is the third design, and the
        // first two failed the same way in opposite directions.
        //
        // A ±120-character proximity window was too narrow: an ordinary sentence
        // can put its backend qualifier further than that from the claim. An
        // enumerated set of subject phrasings was unbounded in the other
        // direction: it recognized "switching backends" and "across backends"
        // and missed "either backend", "any backend", "whichever backend" — and
        // would have missed the next one too, because the set of ways to say
        // "the backends are the same" is not enumerable.
        //
        // So the rule is now: any unit that mentions a backend AND asserts
        // boundary sameness is an offender, unless it is on a short, commented
        // list of statements known to be true. New claims are caught by default;
        // a new exemption is one line in a diff with a reason attached, which is
        // reviewable in a way an absent match is not.
        if (!/\b(backend|runner|adapter|cli)s?\b/.test(unit)) continue;

        // Affirmative equivalence only. These shapes cannot match a negated
        // form — `is not the same` does not satisfy `is\s+the same` — so the
        // true statement, that the boundary is NOT the same while three named
        // properties are, stays sayable without an escape hatch. An earlier
        // draft had one: it exempted any window containing "not" alongside a
        // posture word, which let `Sandbox posture is not the reason: the trust
        // boundary is the same across backends` through.
        const asserts =
          /(introduces?|adds?|creates?)\s+no\s+new\s+trust boundar/.test(unit) ||
          /\bno\s+new\s+trust boundar/.test(unit) ||
          /trust boundar\w*\s+(is|are|remains?|stays?)\s+(the same|identical|unchanged|equivalent)/.test(unit) ||
          /(same|identical|unchanged|equivalent)\s+trust boundar/.test(unit) ||
          /trust boundar\w*\s+(does not|do not|doesn't|don't)\s+(change|differ|vary)/.test(unit) ||
          /trust boundar\w*\s+coincide/.test(unit);
        if (!asserts) continue;

        // Statements that are true, with the reason each one is true. Matched as
        // substrings of the collapsed unit so ordinary rewrapping does not
        // dislodge them.
        const KNOWN_TRUE: ReadonlyArray<{ fragment: string; why: string }> = [
          {
            fragment: 'task-execution lifecycle events',
            why: 'feature 072 events flow through the same appendAudit path; this is about IPC event families, not backend selection'
          },
          {
            fragment: 'read-only ipc commands',
            why: 'about the IPC command registry, not about which backend is spawned'
          }
        ];
        const exempt = KNOWN_TRUE.find((entry) => unit.includes(entry.fragment));
        if (exempt) continue;

        offenders.push(`${surface}: "${unit.slice(0, 150)}"`);
      }
    }
    expect(
      offenders,
      seeDoc(
        `a backend trust-boundary equivalence claim has returned. The three shared properties ` +
          `(shell: false, the monitor sidecar, output-cap truncation) are genuinely identical and ` +
          `may be said so; the boundary is not, because two runners disable the CLI's approval ` +
          `prompts and one does not. Found:\n  ${offenders.join('\n  ')}`
      )
    ).toEqual([]);
  });

  it('still permits the true statement about the three shared properties', () => {
    // False-positive control, asserted against the tree rather than assumed.
    expect(collapse(read('docs/security/threat-model.md'))).toContain(
      'shell: false'
    );
  });
});
