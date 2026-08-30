<script lang="ts">
  /**
   * Feature 059 — per-capability trust policy banner.
   * Contract:
   *   specs/059-fine-grained-trust-scopes/contracts/trust-projection-contract.md
   *
   * Renders a single banner indicating that a save affordance is
   * disabled by workspace policy. The banner text is computed from a
   * fixed template; no string interpolation of user-controlled data
   * (CSP-safe per I-7 of the contract).
   *
   * When `workspaceTrust === false`, the parent component MUST suppress
   * per-capability banners and render only the `'workspace-trust'`
   * variant (FR-010e).
   *
   * Feature 099 (T492, FR-046) — the `pipelines` and `workflows` arms are gone
   * with the layer tier. Each announced that a per-capability *override* scope
   * was withheld, and an override is a statement about one layer redefining
   * another's row; with one layer there is nothing to override. Those two tabs
   * are gated by Workspace Trust alone, which the first arm already reports.
   * The two survivors gate document CONTENT and are untouched (FR-053).
   */
  /**
   * FR-R3-143 (T040) — `decidedBy`, and why the two per-capability titles
   * stopped saying "workspace policy".
   *
   * They said it unconditionally, and it is false whenever the deciding step is
   * `user`: the ladder reads a user-layer `false` as a first-class deny
   * (`src/state/capability-trust-decision.ts`), so an operator whose own user
   * settings denied the capability was told the workspace had done it — and
   * would go looking in the wrong file for a setting that is not there. It is
   * equally false at the Workspace Trust ceiling.
   *
   * The projection that makes the correction possible arrives with this feature
   * (`snapshot.resolvedScope`, T036); before it the banner had no way to know
   * which layer decided, which is why the wrong sentence survived this long.
   *
   * `decidedBy` is optional and `undefined` means UNKNOWN, not a step: an older
   * host bundle omits the field. The banner then names no layer at all, which
   * is the one reading that cannot mislead.
   */
  interface Props {
    variant: 'workspace-trust' | 'phases' | 'retry-conditions';
    decidedBy?: 'user' | 'workspace' | 'workspace-trust';
  }
  const { variant, decidedBy }: Props = $props();

  const TEMPLATES: Record<Props['variant'], { title: string; body: string }> = {
    'workspace-trust': {
      title: 'Workspace is not trusted',
      body:
        'Schegent edits are disabled until VS Code workspace trust is granted. See docs/operations/trust-scopes.md.'
    },
    phases: {
      title: 'Custom phase prompts are disabled',
      body:
        'Reset-to-defaults remains available. See docs/operations/trust-scopes.md.'
    },
    'retry-conditions': {
      title: 'Custom retry-condition expressions are disabled',
      body:
        'Default retry-conditions for each phase remain editable. See docs/operations/trust-scopes.md.'
    }
  };

  const DECIDED_BY_TEXT: Record<NonNullable<Props['decidedBy']>, string> = {
    user: 'Denied by your user settings; a workspace setting cannot override it.',
    workspace: "Denied by this workspace's settings.",
    'workspace-trust': 'Denied by VS Code Workspace Trust; no Schegent setting can widen it.'
  };

  const tpl = $derived(TEMPLATES[variant]);
  // Only the per-capability variants carry a deciding step. The
  // `'workspace-trust'` banner is already a statement about the ceiling, and
  // appending "denied by Workspace Trust" to it would say the same thing twice.
  const cause = $derived(
    variant === 'workspace-trust' || decidedBy === undefined ? null : DECIDED_BY_TEXT[decidedBy]
  );
  const testId = $derived(`trust-banner-${variant}`);
</script>

<div class="trust-banner" data-testid={testId} role="status">
  <div class="trust-banner-title">{tpl.title}</div>
  {#if cause}
    <div class="trust-banner-cause" data-testid="{testId}-decided-by">{cause}</div>
  {/if}
  <div class="trust-banner-body">{tpl.body}</div>
</div>

<style>
  .trust-banner {
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    background: var(--vscode-inputValidation-warningBackground);
    color: var(--vscode-inputValidation-warningForeground, var(--schegent-fg));
    padding: 8px 12px;
    margin-bottom: 8px;
    border-radius: 4px;
    font-size: 0.92em;
  }
  .trust-banner-title {
    font-weight: 600;
    margin-bottom: 2px;
  }
  .trust-banner-cause {
    margin-bottom: 2px;
  }
  .trust-banner-body {
    opacity: 0.9;
  }
</style>
