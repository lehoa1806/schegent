/**
 * FR-R6-F15 (F15-A; FR-001, FR-006, FR-020) — the opt-in policy of one transition, read from
 * an untrusted value. No policy means no handoff. A policy of a newer version is handed back
 * as received and refused, never read as version 1.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  APPROVAL_MODES,
  IDENTIFIER_PATTERN,
  NODE_PATH_PATTERN,
  PHASE_CONTEXT_LIMITS,
  PHASE_CONTEXT_POLICY_VERSION,
  SESSION_POLICIES,
  type BoundInput,
  type ContextSelector,
  type HandoffPolicy
} from '../../contracts/phase-context/context-policy';
import { hasExactKeys, isOneOf, isWholeNumber, listOf, matchesPattern, plainRecord, taggedDigest } from './primitives';

export type PolicyParse =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly policy: HandoffPolicy; readonly digestHex: string }
  | { readonly kind: 'unsupported-version'; readonly preserved: unknown }
  | { readonly kind: 'invalid'; readonly detail: string };

const POLICY_KEYS = ['version', 'approval', 'session', 'selectors'] as const;
const SELECTOR_KEYS = ['selectorId', 'sourceNodePath', 'required', 'priority'] as const;
const BOUND_INPUT_KEYS = ['bindingId', 'sourceNodePath'] as const;
const POLICY_DIGEST_TAG = 'pcp1';

function invalid(detail: string): PolicyParse {
  return { kind: 'invalid', detail };
}

/** The selector, or the detail code of what is wrong with it. */
function parseSelector(value: unknown): ContextSelector | string {
  const record = plainRecord(value);
  if (record === null || !hasExactKeys(record, SELECTOR_KEYS)) return 'selector-shape';
  const { selectorId, sourceNodePath, required, priority } = record;
  if (!matchesPattern(IDENTIFIER_PATTERN, selectorId)) return 'selector-id';
  if (!matchesPattern(NODE_PATH_PATTERN, sourceNodePath)) return 'selector-node-path';
  if (typeof required !== 'boolean') return 'selector-required';
  if (!isWholeNumber(priority, 0, PHASE_CONTEXT_LIMITS.priorityMax)) return 'selector-priority';
  return { selectorId, sourceNodePath, required, priority };
}

function parseSelectors(value: unknown): readonly ContextSelector[] | string {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.selectorsMax);
  if (items === null) return 'selector-count';
  const selectors: ContextSelector[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const selector = parseSelector(item);
    if (typeof selector === 'string') return selector;
    if (seen.has(selector.selectorId)) return 'selector-duplicate';
    seen.add(selector.selectorId);
    selectors.push(selector);
  }
  return selectors;
}

/** The digest that names this policy in a manifest. Selector order is part of it. */
export function policyDigestOf(policy: HandoffPolicy): string {
  return taggedDigest([
    POLICY_DIGEST_TAG,
    policy.version,
    policy.approval,
    policy.session,
    policy.selectors.map((selector) => [selector.selectorId, selector.sourceNodePath, selector.required, selector.priority])
  ]);
}

export function parseHandoffPolicy(value: unknown): PolicyParse {
  if (value === undefined || value === null) return { kind: 'absent' };
  const record = plainRecord(value);
  if (record === null) return invalid('policy-shape');
  const { version } = record;
  if (isWholeNumber(version, PHASE_CONTEXT_POLICY_VERSION + 1)) return { kind: 'unsupported-version', preserved: value };
  if (version !== PHASE_CONTEXT_POLICY_VERSION) return invalid('policy-version');
  if (!hasExactKeys(record, POLICY_KEYS)) return invalid('policy-shape');
  const { approval, session } = record;
  if (!isOneOf(APPROVAL_MODES, approval)) return invalid('approval');
  if (!isOneOf(SESSION_POLICIES, session)) return invalid('session');
  const selectors = parseSelectors(record.selectors);
  if (typeof selectors === 'string') return invalid(selectors);
  const policy: HandoffPolicy = { version: PHASE_CONTEXT_POLICY_VERSION, approval, session, selectors };
  return { kind: 'valid', policy, digestHex: policyDigestOf(policy) };
}

/**
 * The inputs the workflow bound, or `null` when the value is not a list of at most 32 bound
 * inputs with distinct identities (FR-006).
 */
export function parseBoundInputs(value: unknown): readonly BoundInput[] | null {
  const items = listOf(value, PHASE_CONTEXT_LIMITS.boundInputsMax);
  if (items === null) return null;
  const inputs: BoundInput[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const record = plainRecord(item);
    if (record === null || !hasExactKeys(record, BOUND_INPUT_KEYS)) return null;
    const { bindingId, sourceNodePath } = record;
    if (!matchesPattern(IDENTIFIER_PATTERN, bindingId) || !matchesPattern(NODE_PATH_PATTERN, sourceNodePath)) return null;
    if (seen.has(bindingId)) return null;
    seen.add(bindingId);
    inputs.push({ bindingId, sourceNodePath });
  }
  return inputs;
}
