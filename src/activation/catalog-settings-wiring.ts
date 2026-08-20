// Feature 099 (T496f, FR-054, FR-056) — the settings half of the catalog wiring.
//
// `catalog-store-wiring.ts` pairs the versioned store with VS Code; this pairs
// what the store does NOT own with VS Code. Two keys survive the collapse: the
// Model Catalog, which stays exactly as feature 096 left it, and the default
// Pipeline id, which names a definition rather than holding one. Both the read
// and the write of those keys live here, together, so a reader that inspects one
// scope and a writer that updates another cannot drift apart across two files.

import * as vscode from 'vscode';

import type { CatalogConfigReader } from '../config/pipeline-config-loader';

/**
 * Read the two configuration-backed keys the catalog store does not hold.
 *
 * Feature 099 (T494, FR-054) — `getPhases` and `getPipelines` are gone with the
 * three retired definition settings keys.
 */
export function createCatalogReader(workspaceRoot: string): CatalogConfigReader {
  return {
    getModels(scope) {
      const inspect = configFor(workspaceRoot).inspect<readonly unknown[]>('models');
      if (!inspect) return undefined;
      return scope === 'workspace' ? inspect.workspaceValue : inspect.globalValue;
    },
    getDefaultPipelineId(scope) {
      const inspect = configFor(workspaceRoot).inspect<string>('defaultPipelineId');
      if (!inspect) return undefined;
      return scope === 'workspace'
        ? inspect.workspaceValue
        : inspect.globalValue ?? inspect.defaultValue;
    }
  };
}

/**
 * The write side of the same two keys, pinned to the workspace target.
 *
 * Feature 099 (T494, T496f, FR-042, FR-056) — the Model Catalog is the only
 * configuration-backed catalog left, and its one writable layer is the
 * workspace, so the scope argument this port used to take had exactly one legal
 * value. Pinning it here rather than passing it per call is what makes that a
 * fact about the wiring instead of a convention every caller has to honour.
 */
export function createCatalogSettingsWriter(
  workspaceRoot: string
): (key: 'models', value: unknown) => Promise<void> {
  return async (key, value) => {
    await configFor(workspaceRoot).update(key, value, vscode.ConfigurationTarget.Workspace);
  };
}

function configFor(workspaceRoot: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('schegent', vscode.Uri.file(workspaceRoot));
}
