// FR-R4-F06 (FR-012, FR-013; contract K, K4) -- the host's sentence for what a Phase's capability set does.
//
// WHAT IT SAYS. For a set the planner can enforce but not completely, one sentence: what KIND of thing
// enforces the restriction, then what it leaves open. For a set the backend cannot enforce, one sentence
// naming the capabilities it cannot, and, when a flag exists in the planner but no capture has confirmed
// the installed CLI lists it, saying so. For a set with nothing withheld, or one enforced with nothing
// left open, nothing: a line that said "fine" in every launcher would bury the ones that matter.
//
// WHY THE CLASS COMES FIRST. A Claude restriction is the CLI's tool layer applying a denylist to itself.
// It is not an operating-system boundary: a shell the model is still allowed to run can do what the
// denied tool would have done, where the backend's own permission settings let it. An operator reading
// "network is withheld" must not conclude the phase cannot reach the network, so the sentence opens by
// saying what kind of restriction it is, and each residual has one fixed clause, conditional wherever the
// outcome depends on the backend's own settings. `tests/lint/capability-wording.test.ts` keeps any text
// from calling a tool denial containment.
//
// WHAT IS NOT FIXED. The Phase's name, which the catalog has already sanitized and capped. Nothing else
// is composed from operator or model text, and the webview renders the result as text, composing none.
import type { CapabilityResidual } from '../contracts/phase-capabilities';
import type { CapabilityEnforcementPlan } from './capability-enforcement-plan';

/** One fixed clause per residual (K4). The shell clauses are conditional on the backend's own settings. */
const CLAUSES: Readonly<Record<CapabilityResidual, string>> = {
  'shell-network':
    "a granted shell can still reach the network where the backend's own permission settings let it run",
  'shell-workspace-write':
    "a granted shell can still write workspace files where the backend's own permission settings let it run",
  'shell-outside-workspace-write':
    "a granted shell can still write outside the workspace where the backend's own permission settings let it run",
  'unlisted-tools':
    'tools the restriction does not name, including tools from configured extensions or MCP servers, are not covered',
  'sandboxed-commands-run':
    "model-run commands still execute, inside Codex's read-only sandbox, which also blocks file writes",
  'sandbox-scope-unqualified': "the scope of Agy's sandbox has not been qualified",
  'mode-refuses-shell':
    "a granted shell is refused by Agy's accept-edits mode unless the backend's own permission settings allow it, and where they do it can still write outside the workspace",
  'mode-refuses-outside-write':
    "a granted write outside the workspace is refused by Agy's accept-edits mode unless the backend's own permission settings allow it"
};

const TOOL_RESTRICTION_LEAD = 'A tool-access restriction, not OS isolation';
const CLI_SANDBOX_LEAD = "The CLI's own sandbox";

/**
 * The sentence for `plan` on `phaseName`, or `null` when there is nothing to say.
 *
 * `phaseName` is the catalog's sanitized, capped name and the only text that is not a constant.
 */
export function describeCapabilityOutcome(
  plan: CapabilityEnforcementPlan,
  phaseName: string
): string | null {
  if (plan.outcome === 'refused') {
    const refused =
      `Phase "${phaseName}" cannot start on ${plan.kind}: it has no way to withhold ` +
      `${plan.unenforceable.join(', ')}, so it is refused rather than run without the restriction.`;
    return plan.unqualified.length === 0
      ? refused
      : `${refused} The flag for ${plan.unqualified.join(', ')} could not be confirmed: ` +
          'the help capture this extension ships with does not list it.';
  }
  if (plan.residuals.length === 0) return null;
  const lead = plan.enforcement === 'cli-sandbox' ? CLI_SANDBOX_LEAD : TOOL_RESTRICTION_LEAD;
  return `${lead} applies to phase "${phaseName}": ${plan.residuals.map((residual) => CLAUSES[residual]).join('; ')}.`;
}
