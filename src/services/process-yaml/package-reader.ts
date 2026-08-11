// Feature 086 T034 — the reading primitives a package of any kind needs.
//
// Feature 085 wrote all of this inside `pipeline-document.ts`, which was right
// while there was one package kind. Feature 086 adds a second, and these pieces
// are the ones that turned out to be about PACKAGES rather than about Pipelines:
// coercing a scalar the way the catalog will see it, synthesizing a
// prototype-less mapping, admitting a section against a closed key set, refusing
// a second root, finding a repeated declared id, and putting the envelope back on
// an included body so the shipped reader for that kind can do the work.
//
// The alternative to a shared module was to export them from `pipeline-document`,
// which would have made the Pipeline reader the de-facto library for a third
// kind, or to copy them, which would fork `plainValue` — and `plainValue` is the
// one thing standing between a `__proto__` key in a document nobody here wrote
// and a prototype on an object handed straight to a catalog validator. A forked
// copy of a security-relevant rule is the failure mode this module exists to
// prevent.
//
// What is NOT here: anything that knows a kind's field names, admitted key sets,
// or validator. Those stay in the reader for that kind, so this module cannot
// become a place where the two kinds' rules quietly converge.

import { defect, unknownField } from './phase-yaml-validator';
import type {
  ImportDefect,
  YamlMappingEntry,
  YamlMappingNode,
  YamlNode,
  YamlScalarNode
} from './types';
import { PHASE_YAML_API_VERSION } from './types';

const INTEGER_PATTERN = /^[-+]?\d+$/;

/** How much of an author-supplied value a refusal may quote back. */
const ECHO_MAX = 64;

export function echo(value: string): string {
  return value.length <= ECHO_MAX ? value : value.slice(0, ECHO_MAX);
}

export function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * A scalar's value as the catalog validator will see it.
 *
 * A quoted scalar is text by the author's own hand and stays text; an unquoted
 * one becomes a number or a boolean when it reads as one. That split is not a
 * guess — `chooseScalarStyle` quotes exactly the scalars whose unquoted form
 * another reader would re-type, so a document this project wrote round-trips to
 * the values it started from.
 *
 * The non-integer arm states the rule as the property rather than as a second
 * pattern: type a scalar only when the number it produces re-emits to exactly
 * these bytes, which is what `renderScalar` writes for a number. Being the
 * emitter's inverse by construction is what makes `NaN`, `Infinity`, `0x1f`,
 * `1.50`, and `1:30` stay text — none is a form the emitter produces, so none can
 * have been a number on the way out, and guessing at one would invent a value the
 * author did not write. The integer arm above is deliberately looser and is left
 * exactly as 084 wrote it: `+1` and `007` read as 1 and 7, so a hand-authored
 * document normalizes on its first write rather than round-tripping byte-for-byte.
 * That is the same visible, converging rewrite 085 accepted for `required: true`,
 * and narrowing it now would change how two shipped formats read.
 *
 * Feature 086 is what makes the non-integer arm load-bearing. Until a Workflow
 * condition arrived, every numeric field in the format was an integer, so a
 * fractional scalar reached the catalog as text and was refused there — visible,
 * and documented as deliberate. A condition's `right` accepts a string literal
 * AND a numeric one, so the same text is now silently accepted as a different
 * value: `greaterThanOrEqual 0.75` would become a comparison against `'0.75'`
 * with nothing downstream able to notice.
 */
export function scalarValue(node: YamlScalarNode): string | number | boolean {
  if (node.quoted) return node.value;
  if (INTEGER_PATTERN.test(node.value)) {
    const parsed = Number(node.value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  const numeric = Number(node.value);
  if (Number.isFinite(numeric) && String(numeric) === node.value) return numeric;
  if (node.value === 'true') return true;
  if (node.value === 'false') return false;
  return node.value;
}

/**
 * A node as a plain value.
 *
 * Every synthesized mapping is prototype-less. A mapping below the admitted key
 * sets — a port, a binding, `executionDefaults`, a Workflow condition operand —
 * is forwarded wholesale to the catalog validator, so a `__proto__` key in a
 * document the operator did not write would otherwise set a prototype instead of
 * an own property and escape both the unknown-field scan and `Object.keys`. First
 * entry wins on a duplicate key, which is the rule `findScalar` already follows.
 */
export function plainValue(node: YamlNode): unknown {
  if (node.kind === 'scalar') return scalarValue(node);
  if (node.kind === 'sequence') return node.items.map(plainValue);
  const mapping = Object.create(null) as Record<string, unknown>;
  for (const entry of node.entries) {
    if (hasOwn(mapping, entry.key)) continue;
    mapping[entry.key] = plainValue(entry.value);
  }
  return mapping;
}

/**
 * Collect the admitted keys of one section into the raw object the catalog
 * validator reads, reporting anything the closed format does not admit.
 */
export function admitSection(
  section: YamlMappingNode,
  admitted: ReadonlySet<string>,
  raw: Record<string, unknown>,
  defects: ImportDefect[],
  rename?: Readonly<Record<string, string>>
): void {
  for (const entry of section.entries) {
    if (!admitted.has(entry.key)) {
      defects.push(unknownField(entry.key));
      continue;
    }
    const key = rename?.[entry.key] ?? entry.key;
    if (hasOwn(raw, key)) continue;
    raw[key] = plainValue(entry.value);
  }
}

/**
 * FR-003a — a package has exactly one root. An included resource that repeats
 * `apiVersion` or `kind` is a second one, and the whole document is refused
 * before any resource is classified so FR-026 holds.
 */
export function declaresSecondRoot(items: readonly YamlNode[]): boolean {
  return items.some(
    (item) =>
      item.kind === 'mapping' &&
      item.entries.some((entry) => entry.key === 'apiVersion' || entry.key === 'kind')
  );
}

/**
 * The id an included resource DECLARES, before anyone asks whether it is a good
 * one.
 *
 * Read raw rather than taken from classification, because the check it feeds runs
 * before any resource is classified (FR-026) and because a malformed resource
 * still declared something. Classification reports `resourceId: null` for an id
 * that fails the pattern — correct there, since a malformed row claims no id for
 * dependency resolution — but reusing that answer here would let a well-formed
 * resource silently win over a broken twin, which is exactly the outcome the
 * duplicate-id refusal excludes.
 *
 * An absent or empty declaration is not a claim: two resources that name no id
 * are not two claims on one id, and each reports its own defect.
 */
function declaredId(item: YamlNode, idKey: string): string | null {
  if (item.kind !== 'mapping') return null;
  const metadata = item.entries.find((entry) => entry.key === 'metadata');
  if (metadata === undefined || metadata.value.kind !== 'mapping') return null;
  const declared = metadata.value.entries.find((entry) => entry.key === idKey);
  if (declared === undefined || declared.value.kind !== 'scalar') return null;
  if (declared.value.value.length === 0) return null;
  return declared.value.value;
}

/**
 * The first id two resources in one section both claim, or `null`.
 *
 * Ids are compared **within** a section only. Each section is a different
 * catalog, so a Phase spelled like the Pipeline that includes it is not a second
 * claim on the Pipeline's id; and a package declares exactly one root by
 * construction, because `declaresSecondRoot` has already refused anything else.
 *
 * `idKey` is the section's own spelling — `id` for a Pipeline, `phaseId` for a
 * Phase. Passing it in rather than trying both keeps a Phase that happens to
 * carry an `id` key from being read as a claim: that key is an unknown field
 * there, and this scan is not the place that says so.
 */
export function firstRepeatedDeclaredId(
  items: readonly YamlNode[],
  idKey: string
): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    const declared = declaredId(item, idKey);
    if (declared === null) continue;
    if (seen.has(declared)) return declared;
    seen.add(declared);
  }
  return null;
}

/**
 * An included resource as the standalone document it is the body of.
 *
 * The package declared `apiVersion` and `kind` once, for every resource in it.
 * Putting them back on each body is what lets the shipped reader for that kind do
 * the work: the defects and the id an included resource gets are the ones a
 * standalone document of that kind would have got, produced by the same rules
 * rather than by a second copy of them (FR-008).
 */
export function standaloneNode(item: YamlMappingNode, kind: string): YamlMappingNode {
  const declare = (key: string, value: string): YamlMappingEntry => ({
    key,
    value: { kind: 'scalar', value, quoted: false, line: item.line },
    line: item.line
  });
  return {
    kind: 'mapping',
    line: item.line,
    entries: [
      declare('apiVersion', PHASE_YAML_API_VERSION),
      declare('kind', kind),
      ...item.entries
    ]
  };
}

/**
 * The `included` section, read once.
 *
 * `present` is whether the key exists at all — a references-only document has no
 * `included`, which is not a defect. `declared` is every named section whose key
 * exists whatever its shape, and `bySection` is only those that are well-formed
 * sequences; the two differ exactly for a section that is present and malformed,
 * which is why both are reported. Which sections are MANDATORY is the caller's
 * rule, not this function's: a Pipeline package's `included` carries Phases or
 * nothing, while a Workflow's three export depths differ precisely in which of
 * its sections they write, so a shared "at least one" rule would either refuse a
 * legal document or admit an empty section.
 *
 * The defects belong to the ROOT resource: there is no other resource to own
 * them, and ignoring a malformed `included` would quietly drop resources the
 * document declared.
 */
export interface IncludedRead {
  readonly present: boolean;
  readonly declared: ReadonlySet<string>;
  readonly bySection: ReadonlyMap<string, readonly YamlNode[]>;
  readonly defects: readonly ImportDefect[];
}

/**
 * Read `included` once, because its items feed two things that must agree: the
 * second-root and duplicate-id gates, which run before anything is classified,
 * and the per-item classification after them.
 *
 * `sections` is ordered, and callers iterate it in that order, so the read order
 * is the write order and a package's resources are classified in the order the
 * document declares them. A section the caller did not name is an unknown key.
 */
export function readIncludedSections(
  node: YamlMappingNode,
  sections: readonly string[]
): IncludedRead {
  const bySection = new Map<string, readonly YamlNode[]>();
  const declared = new Set<string>();
  const entry = node.entries.find((candidate) => candidate.key === 'included');
  if (entry === undefined) return { present: false, declared, bySection, defects: [] };

  const defects: ImportDefect[] = [];
  if (entry.value.kind !== 'mapping') {
    defects.push(defect('included', 'mapping-required', 'included must be a mapping'));
    return { present: true, declared, bySection, defects };
  }

  const admitted = new Set(sections);
  for (const child of entry.value.entries) {
    if (!admitted.has(child.key)) defects.push(unknownField(`included.${child.key}`));
  }

  for (const section of sections) {
    const found = entry.value.entries.find((candidate) => candidate.key === section);
    if (found === undefined) continue;
    declared.add(section);
    if (found.value.kind !== 'sequence') {
      defects.push(
        defect(
          `included.${section}`,
          'sequence-required',
          `included.${section} must be a sequence`
        )
      );
      continue;
    }
    bySection.set(section, found.value.items);
  }

  return { present: true, declared, bySection, defects };
}
