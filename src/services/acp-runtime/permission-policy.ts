/**
 * FR-R6-F13 (FR-009, FR-011, research R4) — `session/request_permission`: validation and a
 * fail-closed answer.
 *
 * The host policy may choose one offered option. With no policy, an `undecided` answer, a choice
 * the agent did not offer, or a policy that throws, the answer is the first `reject_once`
 * option, then the first `reject_always`, then `cancelled`. While a cancellation is in progress
 * every request is answered `cancelled` and the policy is not consulted.
 *
 * Zero `vscode` imports.
 */
import {
  ACP_RUNTIME_LIMITS,
  type AcpPermissionOptionKind,
  type AcpPermissionPolicy,
  type AcpPermissionRequest
} from '../../contracts/acp-runtime';
import { isAgentIdentifier } from './agent-identifier';

export type PermissionParams =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly toolCallId: string | null;
      readonly toolTitle: string | null;
      readonly options: AcpPermissionRequest['options'];
    }
  | { readonly ok: false };

export type PermissionAnswer =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' };

const OPTION_KINDS: ReadonlySet<string> = new Set<AcpPermissionOptionKind>([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always'
]);
const FALLBACK_ORDER: readonly AcpPermissionOptionKind[] = ['reject_once', 'reject_always'];
const REFUSED: PermissionParams = Object.freeze({ ok: false });
const CANCELLED: PermissionAnswer = Object.freeze({ outcome: 'cancelled' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseOptions(value: unknown): AcpPermissionRequest['options'] | null {
  if (!Array.isArray(value) || value.length > ACP_RUNTIME_LIMITS.maxPermissionOptions) return null;
  const options: { optionId: string; kind: AcpPermissionOptionKind }[] = [];
  for (const option of value as readonly unknown[]) {
    if (!isRecord(option) || !isAgentIdentifier(option['optionId'])) return null;
    const kind = option['kind'];
    if (typeof kind !== 'string' || !OPTION_KINDS.has(kind)) return null;
    options.push({ optionId: option['optionId'], kind: kind as AcpPermissionOptionKind });
  }
  return options;
}

/** Reads `session/request_permission` params; anything malformed is refused. */
export function parsePermissionParams(params: unknown): PermissionParams {
  if (!isRecord(params) || !isAgentIdentifier(params['sessionId'])) return REFUSED;
  const options = parseOptions(params['options']);
  if (options === null) return REFUSED;
  const toolCall = isRecord(params['toolCall']) ? params['toolCall'] : {};
  const toolCallId = isAgentIdentifier(toolCall['toolCallId']) ? toolCall['toolCallId'] : null;
  const toolTitle = typeof toolCall['title'] === 'string' ? toolCall['title'] : null;
  return { ok: true, sessionId: params['sessionId'], toolCallId, toolTitle, options };
}

function policyChoice(request: AcpPermissionRequest, policy: AcpPermissionPolicy | undefined): string | null {
  if (policy === undefined) return null;
  try {
    const choice = policy(request);
    return choice === 'undecided' ? null : choice.optionId;
  } catch {
    return null;
  }
}

/** The answer to one permission request. */
export function decidePermission(
  request: AcpPermissionRequest,
  policy: AcpPermissionPolicy | undefined,
  cancelling: boolean
): PermissionAnswer {
  if (cancelling) return CANCELLED;
  const chosen = policyChoice(request, policy);
  if (chosen !== null && request.options.some((option) => option.optionId === chosen)) {
    return { outcome: 'selected', optionId: chosen };
  }
  for (const kind of FALLBACK_ORDER) {
    const fallback = request.options.find((option) => option.kind === kind);
    if (fallback !== undefined) return { outcome: 'selected', optionId: fallback.optionId };
  }
  return CANCELLED;
}
