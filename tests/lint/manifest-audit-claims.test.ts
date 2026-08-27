// FR-R3-064 — a shipped setting description may not claim an audit record the
// contract does not declare.
//
// THE INCIDENT
//
// `schegent.backend.allowUncontainedBackends` told an operator, at the exact
// moment they decided whether to permit an unbounded agent, that "every run that
// uses an uncontained backend records the fact in the audit log". No such record
// existed: no event type, no emitter. The sentence and the item that filed the
// gap as outstanding landed in the same commit.
//
// That is the third instance this round of shipped operator-facing text
// over-promising against the tree — R-14 for the documentation corpus,
// FR-R3-051 for the settings defaults, this for the audit contract. FR-R3-063
// established the response: for a recurring class, the fix is a check, not a
// correction.
//
// WHAT THIS GATE GUARANTEES
//
//   - a setting description that asserts something is recorded in the audit log
//     resolves to at least one member of `ALL_AUDIT_EVENT_TYPES`, either by
//     naming it or through a registry entry that carries a reason;
//   - a registry entry naming an undeclared event fails, naming both;
//   - a registry entry whose setting or whose recorded claim fragment no longer
//     exists fails — an allowlist that outlives its subject is an allowlist
//     nobody has read.
//
// WHAT IT DOES NOT GUARANTEE
//
//   - Claim DETECTION is a co-occurrence rule over an explicit noun list and an
//     explicit verb list, evaluated per sentence. A claim worded outside those
//     lists is not detected. This gate proves that the claims it recognises
//     cannot go unsubstantiated; it does not prove no unsubstantiated claim can
//     ever be written. The alternative — a heuristic scan for anything that
//     smells like an assertion — is the shape of gate that produces false
//     positives and gets switched off, which this round has recorded eight times.
//   - It resolves a claim to a DECLARED EVENT TYPE, not to a live emitter. A
//     declared type nobody writes would satisfy this gate. `backend-posture-
//     admitted`'s own emission is asserted by
//     `tests/unit/controller/phase-runner-backend-posture.test.ts` and its route
//     coverage by `tests/lint/backend-posture-emission-funnel.test.ts`; those are
//     the checks that make the record real, and this is the one that makes the
//     sentence answerable.
//   - It reads `package.json` only. The same claim in a guide is not covered
//     here. That boundary is deliberate — the manifest is the surface an operator
//     reads while making the decision — and it is a boundary, not a proof.
//
// OBSERVED NON-VACUOUS, 2026-08-24, darwin/arm64
//
// Two seeded false claims, each restored afterwards:
//
//   1. A plain-language claim with no registry entry — added
//      "Every switch between runners is recorded in the audit log." to
//      `schegent.backend.runner`. `npx vitest run tests/lint/manifest-audit-claims.test.ts`
//      exited non-zero: 1 failed / 5 passed, naming `schegent.backend.runner` and
//      quoting the claim sentence.
//   2. A named but undeclared event — added
//      "Every switch writes a `trust.runner-switched` audit entry." to the same
//      setting. Exited non-zero: 2 failed / 4 passed, naming the setting and
//      `trust.runner-switched` as undeclared.
//
// Restored manifest: 6 passed / 6.
//
// The gate also produced a FALSE POSITIVE on its first run against the real
// manifest, and the fix is recorded at `isAuditRecordClaim` rather than quietly
// applied: four rotation and retention settings were reported because the verb
// `log` matched inside the noun "audit log".
//
// HERMETIC: `node:fs` and a direct import of the contract. No `grep`, no `find`,
// no `rg` — `lint-gates-are-hermetic` allows `git`, `node` and `npm` only, and
// the three-OS matrix is why.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_AUDIT_EVENT_TYPES } from '../../src/contracts/audit-events';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MANIFEST = 'package.json';

/**
 * Nouns that name the audit log as a thing written to. "audit evidence" and
 * "audit rotation" are deliberately absent: a sentence about retention or
 * rotation is a statement about the log's lifecycle, not a promise that a
 * particular fact is recorded in it.
 */
const AUDIT_NOUNS = ['audit log', 'audit entry', 'audit record', 'audit event', 'audit trail'];

/** Verbs that turn a mention of the log into an assertion that something lands in it. */
const RECORDING_VERBS = [
  'record',
  'records',
  'recorded',
  'log',
  'logs',
  'logged',
  'write',
  'writes',
  'written',
  'emit',
  'emits',
  'emitted',
  'audited'
];

/**
 * The registry. One entry per setting whose description asserts an audit record
 * in plain language rather than by naming the event.
 *
 * `claim` is the fragment that must still be present — so an edit that removes
 * the promise also removes the entry's reason to exist, and the gate says so.
 * `why` is not decoration: FR-R3-063 requires every allowlist entry in this
 * family to carry the reason it is there.
 */
const AUDIT_CLAIM_REGISTRY: ReadonlyArray<{
  readonly setting: string;
  readonly claim: string;
  readonly events: readonly string[];
  readonly why: string;
}> = [
  {
    setting: 'schegent.backend.uncontainedBackends',
    claim: 'records which backend it used',
    events: ['backend-posture-admitted'],
    why:
      'FR-R3-064 built the per-run posture record this sentence promises. The description states the ' +
      'fact in operator-facing language and deliberately does not carry the event identifier: this is ' +
      'the text someone reads while deciding whether to permit an unbounded agent, and an internal ' +
      'event id in it makes that surface worse, not more honest. The identifier lives here instead, ' +
      'where the reason lives too.'
  }
];

interface ConfigProperty {
  readonly description?: string;
  readonly markdownDescription?: string;
}

function readSettings(): ReadonlyArray<{ key: string; text: string }> {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, MANIFEST), 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, ConfigProperty> } };
  };
  const properties = manifest.contributes?.configuration?.properties;
  if (!properties) throw new Error('contributes.configuration.properties absent from package.json');
  return Object.entries(properties).map(([key, value]) => ({
    key,
    text: `${value.description ?? ''}\n${value.markdownDescription ?? ''}`
  }));
}

/** Split on sentence boundaries so a noun in one sentence cannot borrow a verb from the next. */
function sentences(text: string): string[] {
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isAuditRecordClaim(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  if (!AUDIT_NOUNS.some((noun) => lower.includes(noun))) return false;
  // Strip the noun before looking for a verb, and the reason is a false positive
  // this gate produced on its first run against the real manifest: "Audit log
  // rotation threshold in megabytes" matched the verb `log` INSIDE the noun
  // "audit log", so four retention and rotation settings were reported as making
  // record claims. A sentence about the log's lifecycle is not a promise that a
  // fact lands in it, and the noun's own letters must not be able to supply the
  // verb that makes it one.
  const withoutNouns = AUDIT_NOUNS.reduce(
    (text, noun) => text.split(noun).join(' '),
    lower
  );
  // Word-boundary match, so "recording" and "logging" do not count a noun-only
  // sentence as a claim, and "prunes"/"rotation" never do.
  return RECORDING_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(withoutNouns));
}

const DECLARED = new Set<string>(ALL_AUDIT_EVENT_TYPES as readonly string[]);

/**
 * Backticked tokens in a sentence that are exactly a declared event type.
 *
 * Exact-match on a BACKTICKED token, and both halves of that matter.
 * `ALL_AUDIT_EVENT_TYPES` contains bare words — `pause`, `resume`, `error`,
 * `warning`, `cancel` — so a substring scan over prose would read "…records the
 * fact when a run is canceled" as naming the `cancel` event and resolve a claim
 * that names nothing. That is a false NEGATIVE, the worst kind for this gate: it
 * would let exactly the sentence this feature exists to catch through.
 */
function backtickedTokens(sentence: string): string[] {
  return [...sentence.matchAll(/`([^`]+)`/g)].map(([, token]) => token);
}

function namedEventsIn(sentence: string): string[] {
  return backtickedTokens(sentence).filter((token) => DECLARED.has(token));
}

let claimCache: Map<string, string[]> | undefined;

const claimsBySetting = (): Map<string, string[]> => {
  if (claimCache) return claimCache;
  const found = new Map<string, string[]>();
  for (const { key, text } of readSettings()) {
    const claims = sentences(text).filter(isAuditRecordClaim);
    if (claims.length > 0) found.set(key, claims);
  }
  claimCache = found;
  return found;
};

describe('manifest audit claims resolve to declared events (FR-R3-064)', () => {
  it('every audit-record claim resolves to a declared event type', () => {
    const claims = claimsBySetting();
    const registered = new Map(AUDIT_CLAIM_REGISTRY.map((e) => [e.setting, e]));
    const unresolved: string[] = [];

    for (const [setting, sentenceList] of claims) {
      const entry = registered.get(setting);
      const namesDeclaredEvent = sentenceList.some(
        (sentence) => namedEventsIn(sentence).length > 0
      );
      if (namesDeclaredEvent) continue;
      if (entry) continue;
      unresolved.push(
        `${setting} asserts an audit record but resolves to no declared event type.\n` +
          `    claim: ${sentenceList[0]}\n` +
          '    Either name a declared event type in the description, or add a registry entry in ' +
          'tests/lint/manifest-audit-claims.test.ts naming the event(s) that substantiate it and why. ' +
          'If nothing records it, the sentence is the thing to change — not this gate.'
      );
    }

    expect(unresolved, unresolved.join('\n')).toEqual([]);
  });

  it('every event a registry entry names is declared by the contract', () => {
    const undeclared: string[] = [];
    for (const entry of AUDIT_CLAIM_REGISTRY) {
      for (const event of entry.events) {
        if (!DECLARED.has(event)) {
          undeclared.push(
            `${entry.setting} claims audit event '${event}', which ALL_AUDIT_EVENT_TYPES does not declare`
          );
        }
      }
    }
    expect(undeclared, undeclared.join('\n')).toEqual([]);
  });

  it('every event a description names literally is declared by the contract', () => {
    // The stronger half of the same rule: a description that names an event id is
    // self-substantiating, and this is what catches a claim about an event the
    // contract dropped. Backticked tokens only, so ordinary prose is not scanned.
    const undeclared: string[] = [];
    for (const [setting, sentenceList] of claimsBySetting()) {
      for (const sentence of sentenceList) {
        for (const token of backtickedTokens(sentence)) {
          const looksLikeEventId = /^[a-z][a-z0-9]*([.-][a-z0-9]+)+$/.test(token);
          if (!looksLikeEventId) continue;
          if (token.startsWith('schegent.')) continue;
          if (DECLARED.has(token)) continue;
          // Only tokens that share a dotted namespace with a declared event are
          // treated as event claims; `workspace-write` and `stream-json` are argv
          // fragments and must not be read as audit events.
          const namespace = token.split('.')[0];
          const sharesNamespace =
            token.includes('.') && [...DECLARED].some((d) => d.startsWith(`${namespace}.`));
          if (!sharesNamespace) continue;
          undeclared.push(
            `${setting} names audit event '${token}', which ALL_AUDIT_EVENT_TYPES does not declare`
          );
        }
      }
    }
    expect(undeclared, undeclared.join('\n')).toEqual([]);
  });

  it('no registry entry outlives its setting or its claim', () => {
    const settings = new Map(readSettings().map(({ key, text }) => [key, text]));
    const stale: string[] = [];
    for (const entry of AUDIT_CLAIM_REGISTRY) {
      const text = settings.get(entry.setting);
      if (text === undefined) {
        stale.push(`${entry.setting} has a registry entry but no longer exists in the manifest`);
        continue;
      }
      if (!text.includes(entry.claim)) {
        stale.push(
          `${entry.setting}'s registry entry records the claim '${entry.claim}', which its ` +
            'description no longer contains. If the promise was withdrawn, remove the entry; if it ' +
            'was reworded, update the fragment so the entry still points at something real.'
        );
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('every registry entry carries a reason', () => {
    for (const entry of AUDIT_CLAIM_REGISTRY) {
      expect(entry.why.length, `${entry.setting} has no recorded reason`).toBeGreaterThan(40);
      expect(entry.events.length, `${entry.setting} names no event`).toBeGreaterThan(0);
    }
  });

  it('the corrected uncontained-backends description carries no event identifier', () => {
    // FR-R3-064 SC-009, scoped to this setting rather than to every description.
    // `schegent.trust.allowCustomPhases` names `trust.capability-denied` and is
    // BETTER for it — a description that names its event is self-substantiating.
    // The choice not to name one here is about this specific surface: it is the
    // text an operator reads while deciding whether to permit an unbounded agent,
    // and an internal identifier in that sentence makes the decision harder to
    // read, not easier to audit. The registry carries the identifier instead.
    const setting = readSettings().find(
      (s) => s.key === 'schegent.backend.uncontainedBackends'
    );
    expect(setting).toBeDefined();
    for (const type of ALL_AUDIT_EVENT_TYPES as readonly string[]) {
      expect(
        setting?.text.includes(type),
        `the uncontainedBackends description names '${type}'; state the fact in operator ` +
          'language and let the registry entry carry the identifier'
      ).toBe(false);
    }
  });
});
