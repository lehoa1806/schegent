import { GATE_COMMAND } from './gate-attestation.mjs';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const webview = JSON.parse(readFileSync('webview-ui/package.json', 'utf8'));
const commandReference = readFileSync('docs/reference/commands.md', 'utf8');
const release = readFileSync('RELEASE.md', 'utf8');
const requiredDocs = [
  'docs/reference/audit-events.md',
  'docs/security/threat-model.md',
  'docs/concepts/sessions-and-logs.md',
  'docs/operations/contract-generation.md'
];
const failures = [];
if (root.version !== webview.version) failures.push('root/webview version drift');
for (const file of requiredDocs) {
  // FR-R3-063 — guarded. An unguarded `readFileSync` throws ENOENT on a DELETED
  // required doc, so the one case this loop exists to catch was the one case it
  // could not report: the process died before reaching any other check, and the
  // operator saw a stack trace instead of "is missing or incomplete". A gate that
  // crashes rather than reports is the same defect as one that passes vacuously
  // -- in both, the finding it exists for never reaches a human.
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (err) {
    failures.push(`${file} is missing or unreadable (${err.code ?? 'unknown'})`);
    continue;
  }
  if (body.trim().length < 100) failures.push(`${file} is missing or incomplete`);
}
if (!commandReference.includes('schegent.exportAuditLog')) {
  failures.push('Command Palette reference is stale');
}
// FR-R3-100 follow-up — RELEASE.md must name the command the release binding actually reads,
// DERIVED from that binding rather than typed here.
//
// This check used to require the literal `npm run verify:all`, which was the pre-tag gate when it
// was written. `GATE_COMMAND` has since moved to `npm run gate`, and the check went on passing a
// RELEASE.md that named the old command and never mentioned the new one — a gate pinning the wrong
// string is worse than no gate, because it reads as coverage. Reading the constant means a future
// rename moves the requirement with it.
if (!release.includes(GATE_COMMAND)) {
  failures.push(
    `RELEASE.md omits the attested command (${GATE_COMMAND}), which is what the release binding ` +
      'checks for. Naming a different command in the procedure sends a maintainer to a gate the ' +
      'release does not read.'
  );
}
// FR-R3-154 (T041) — the API reference's action-key paragraph, checked against
// the tuple it describes.
//
// The drift this closes actually happened and this page recorded it as a known
// mismatch: the host allowlist and the webview `ActionKey` union were separate
// hand-maintained copies, the webview grew five keys the host refused, and the
// only place that said so was prose nothing verified. Feature 193 collapsed the
// two into `src/contracts/action-keys.ts`, so the code half cannot drift again --
// `contracts:check` regenerates the webview mirror from the tuple. The prose half
// still could, and stale prose about which keys a boundary accepts is what sent a
// reader wrong last time.
//
// Read from the AST rather than by scanning for quotes: a text scan over this
// file would also match the keys named in its own header comment, so it would
// pass on a doc that repeats the comment and omits the tuple.
//
// Guarded for the same reason the required-docs loop above is (FR-R3-063), and
// the omission was the same shape: `canonicalActionKeys()` throws on a moved
// source file or a tuple that stopped being an array literal, and a throw here
// escapes the `push` and takes the whole run down -- DISCARDING every failure
// already collected, so the operator gets a stack trace instead of the findings.
// The moved-file case is worse than losing the report: `canonicalActionKeys`
// carries a message telling the author to point this check at the new path, and
// an unguarded `readFileSync` reaches ENOENT before that message can be
// produced. A gate that crashes rather than reports is the same defect as one
// that passes vacuously.
try {
  failures.push(...actionKeyDocFailures());
} catch (err) {
  failures.push(
    `action-key documentation check could not run: ${err.message ?? String(err)}`
  );
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Documentation/version checks passed for ${root.version}.`);

/** The canonical action keys, read out of the `ACTION_KEYS` tuple's own AST. */
function canonicalActionKeys() {
  const sourcePath = 'src/contracts/action-keys.ts';
  const text = readFileSync(sourcePath, 'utf8');
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'ACTION_KEYS') continue;
      // Declared as `[...] as const`, so the array is the assertion's operand.
      const initializer =
        declaration.initializer !== undefined && ts.isAsExpression(declaration.initializer)
          ? declaration.initializer.expression
          : declaration.initializer;
      if (initializer === undefined || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(
          `${sourcePath}: ACTION_KEYS is no longer an array literal, so this check cannot read ` +
            'the accepted set. Teach it the new shape rather than removing the check.'
        );
      }
      return initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element)) {
          throw new Error(`${sourcePath}: ACTION_KEYS holds a member that is not a string literal.`);
        }
        return element.text;
      });
    }
  }
  throw new Error(
    `${sourcePath}: no top-level ACTION_KEYS declaration. It is the single source both the host ` +
      'allowlist and the generated webview mirror derive from; if it moved, point this check there.'
  );
}

/**
 * Findings about `docs/reference/api-and-cli.md`'s description of the accepted
 * `CMD_SET_CONFIRM_SUPPRESSION.actionKey` set.
 */
function actionKeyDocFailures() {
  const docPath = 'docs/reference/api-and-cli.md';
  const keys = canonicalActionKeys();
  let doc;
  try {
    doc = readFileSync(docPath, 'utf8');
  } catch (err) {
    return [`${docPath} is missing or unreadable (${err.code ?? 'unknown'})`];
  }

  const problems = [];

  // The stated cardinality doubles as the anchor for the membership check
  // below, so the keys have to be named in the paragraph that makes the claim
  // rather than anywhere on a 400-line page. A count is also the one part of a
  // list a reader trusts without checking, and this paragraph's said eleven.
  const claim = doc.split(/\n\s*\n/).find((block) => block.includes(`these ${keys.length} keys`));
  if (claim === undefined) {
    problems.push(
      `${docPath} must state the accepted set as "these ${keys.length} keys" — that is what ` +
        'ACTION_KEYS holds. Update the sentence when the tuple grows; the wording is fixed so ' +
        'this check can be exact about which claim it is verifying.'
    );
  } else {
    const missing = keys.filter((key) => !claim.includes(`\`${key}\``));
    if (missing.length > 0) {
      problems.push(
        `${docPath} claims ${keys.length} accepted action keys but names ` +
          `${keys.length - missing.length}; missing: ${missing.join(', ')}. The host accepts ` +
          'every member of ACTION_KEYS, so a key absent from that list reads to a caller as one ' +
          'the boundary rejects.'
      );
    }
  }

  // The drift itself: prose calling a canonical key unrecognized. Scoped to the
  // sentences that mention the refusal code, so the listing above is not a
  // finding. To describe the history, name the count rather than the keys.
  for (const sentence of doc.split(/(?<=[.:])\s/)) {
    if (!sentence.includes('unknown-action-key')) continue;
    const named = keys.filter((key) => sentence.includes(`\`${key}\``));
    if (named.length > 0) {
      problems.push(
        `${docPath} describes canonical action key(s) as unknown-action-key: ${named.join(', ')}. ` +
          'The host accepts every ACTION_KEYS member; this is the exact claim that went stale ' +
          'while the host and webview allowlists were separate copies.'
      );
    }
  }

  return problems;
}
