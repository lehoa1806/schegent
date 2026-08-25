// FR-R3-064 — the posture payload stays closed.
//
// WHAT THIS GATE GUARANTEES
//
// Every member of `BackendPostureAdmittedPayload` is a boolean or a reference to
// a closed union of string literals, and each referenced union resolves to such
// a union in its own file. Widening the payload to a `string`, a path, a message,
// or an open record fails here rather than compiling.
//
// WHY A STATIC CHECK AND NOT ONLY A RUNTIME ONE
//
// `phase-runner-backend-posture` asserts the payload the emitter actually writes
// today. That is the stronger assertion about behaviour and the weaker one about
// the contract: a field added to the interface and left unset by the emitter
// passes the runtime test and still widens what any future writer may put in the
// audit log. FR-048's discipline is that a bounded payload is bounded by having
// nowhere to put the forbidden value, and "nowhere" is a property of the type.
//
// WHAT IT DOES NOT GUARANTEE
//
// It reads the declaration, not every writer. A caller that casts through
// `unknown` can still smuggle a value past the interface; that residual belongs
// to review, and to the audit writer's own redaction. It also allows exactly two
// referenced type names by design — adding a third is a deliberate act that has
// to come here and say what the new union is, which is the point.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTRACT_FILE = 'src/contracts/audit-events.ts';
const PAYLOAD = 'BackendPostureAdmittedPayload';

/** Referenced unions this payload may use, and where each is declared. */
const ALLOWED_UNIONS: ReadonlyArray<{ name: string; file: string }> = [
  // FR-R3-089 — identity moved out of the factory; the factory keeps construction.
  { name: 'BackendRunnerKind', file: 'src/contracts/backend-kinds.ts' },
  { name: 'BackendContainment', file: 'src/services/backend-containment-policy.ts' }
];

const parse = (relPath: string): ts.SourceFile =>
  ts.createSourceFile(
    relPath,
    readFileSync(resolve(REPO_ROOT, relPath), 'utf8'),
    ts.ScriptTarget.ES2022,
    true
  );

function findInterface(source: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  let found: ts.InterfaceDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`${name} not declared in ${source.fileName}`);
  return found;
}

function findTypeAlias(source: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) found = node;
  });
  if (!found) throw new Error(`type ${name} not declared in ${source.fileName}`);
  return found;
}

describe('backend posture payload — closed by construction (FR-R3-064)', () => {
  const contract = parse(CONTRACT_FILE);

  it('declares every member as a boolean or an allowed closed union', () => {
    const decl = findInterface(contract, PAYLOAD);
    const allowedNames = ALLOWED_UNIONS.map((u) => u.name);
    expect(decl.members.length).toBeGreaterThan(0);

    for (const member of decl.members) {
      expect(ts.isPropertySignature(member)).toBe(true);
      const property = member as ts.PropertySignature;
      const name = property.name.getText(contract);
      const typeNode = property.type;
      expect(typeNode, `${PAYLOAD}.${name} has no type annotation`).toBeDefined();
      if (!typeNode) continue;

      if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) continue;

      // A type reference is admissible only if it names one of the unions this
      // gate has resolved below. Anything else — `string`, `number`, an inline
      // object, a `Record`, an index signature — fails.
      const isAllowedReference =
        ts.isTypeReferenceNode(typeNode) &&
        ts.isIdentifier(typeNode.typeName) &&
        allowedNames.includes(typeNode.typeName.text);

      expect(
        isAllowedReference,
        `${PAYLOAD}.${name} is \`${typeNode.getText(contract)}\`. This payload admits booleans and ` +
          `these closed unions only: ${allowedNames.join(', ')}. A free-form type here is how a path, ` +
          'an argv, or an operator string reaches the audit log — FR-048 keeps them out by giving the ' +
          'payload nowhere to put them. Widen this list deliberately, and say what the new union is.'
      ).toBe(true);
    }
  });

  it('every member is readonly, so a payload cannot be mutated after projection', () => {
    const decl = findInterface(contract, PAYLOAD);
    for (const member of decl.members) {
      const property = member as ts.PropertySignature;
      const isReadonly = (property.modifiers ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword
      );
      expect(isReadonly, `${PAYLOAD}.${property.name.getText(contract)} is not readonly`).toBe(true);
    }
  });

  it('resolves each referenced union to a closed set of string literals', () => {
    for (const { name, file } of ALLOWED_UNIONS) {
      const alias = findTypeAlias(parse(file), name);
      const members = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
      expect(members.length, `${name} is not a union`).toBeGreaterThan(1);
      for (const member of members) {
        const isStringLiteral =
          ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal);
        expect(
          isStringLiteral,
          `${name} has a non-string-literal member; it is no longer a closed enumeration`
        ).toBe(true);
      }
    }
  });

  it('declares the event type in the contract and registers it in ALL_AUDIT_EVENT_TYPES', () => {
    const text = readFileSync(resolve(REPO_ROOT, CONTRACT_FILE), 'utf8');
    expect(text).toContain("export const BACKEND_POSTURE_EVENT_TYPES = ['backend-posture-admitted'] as const;");
    expect(text).toContain('...BACKEND_POSTURE_EVENT_TYPES,');
    // Additive, per the precedent recorded in this same file.
    expect(text).toContain('export const AUDIT_SCHEMA_VERSION = 3 as const;');
  });
});
