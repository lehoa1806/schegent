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
  interface Props {
    variant: 'workspace-trust' | 'phases' | 'retry-conditions';
  }
  const { variant }: Props = $props();

  const TEMPLATES: Record<Props['variant'], { title: string; body: string }> = {
    'workspace-trust': {
      title: 'Workspace is not trusted',
      body:
        'Schegent edits are disabled until VS Code workspace trust is granted. See docs/operations/trust-scopes.md.'
    },
    phases: {
      title: 'Custom phase prompts disabled by workspace policy',
      body:
        'Reset-to-defaults remains available. See docs/operations/trust-scopes.md.'
    },
    'retry-conditions': {
      title: 'Custom retry-condition expressions disabled by workspace policy',
      body:
        'Default retry-conditions for each phase remain editable. See docs/operations/trust-scopes.md.'
    }
  };

  const tpl = $derived(TEMPLATES[variant]);
  const testId = $derived(`trust-banner-${variant}`);
</script>

<div class="trust-banner" data-testid={testId} role="status">
  <div class="trust-banner-title">{tpl.title}</div>
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
  .trust-banner-body {
    opacity: 0.9;
  }
</style>
