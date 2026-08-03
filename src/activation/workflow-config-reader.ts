// Feature 083 — the VS Code-shaped seam for `schegent.workflows`.
//
// Separate from `CatalogConfigReader` because the Workflow layers have their own
// writable scopes and their own save command, and separate from
// `config/workflow-config.ts` because that module stays free of `vscode` so the
// headless validators can import it. It lives here rather than inline in
// `extension.ts` because that file is at its LOC budget; a focused module is the
// split the budget asks for.

import * as vscode from 'vscode';
import type { WorkflowConfigReader } from '../config/workflow-config';
import { WORKFLOW_CONFIG_KEY } from '../config/workflow-config';

/**
 * Reads the raw per-scope values, so a defect in one layer never silently adopts
 * the other's rows — the same shape the Phase and Pipeline readers use.
 */
export function createWorkflowConfigReader(workspaceRoot: string): WorkflowConfigReader {
  return {
    getWorkflows(scope) {
      const inspect = vscode.workspace
        .getConfiguration('schegent', vscode.Uri.file(workspaceRoot))
        .inspect<readonly unknown[]>(WORKFLOW_CONFIG_KEY);
      if (!inspect) return undefined;
      return scope === 'workspace' ? inspect.workspaceValue : inspect.globalValue;
    }
  };
}
