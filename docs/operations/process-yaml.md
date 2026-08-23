# Import and export process YAML

Use the catalog editors to exchange a Phase, Pipeline, Workflow, or the Model
Catalog as a portable YAML document. The host owns every open and save dialog:
the webview sends no file location and receives none.

<!-- Source: webview-ui/src/lib/process-yaml-ipc.ts -->
<!-- Source: src/extension.ts -->

## Export a document

Choose the control for the resource you want to export:

| Resource | Control and choices |
| --- | --- |
| Phase | Select a saved, valid Phase and choose **Export**. |
| Pipeline | Choose **Export Pipeline**. Leave **Include Phase definitions** clear for references only, or select it to carry referenced Phase definitions. |
| Workflow | Choose **Export Workflow** after selecting **References only**, **Include Pipeline definitions**, or **Include Pipelines and their Phases**. The default is references only. |
| Model Catalog | Choose **Export Model Catalog**. The catalog is exportable even when it is empty. |

<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PhaseCatalogEditor.svelte -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PipelineCatalogEditor.svelte -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/WorkflowToolbar.svelte -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/ModelCatalogEditor.svelte -->

In the host's **Export document** dialog, choose a YAML or YML destination and
approve any overwrite there. Canceling the dialog writes nothing. An export
does not change extension state, although it does write the file you selected.
If the write fails, the UI receives the generic message `Could not write the
document.`; location-bearing detail remains in the sanitized host log.

<!-- Source: src/extension.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-export-process-yaml.ts -->

## Inspect an import

1. In the Phase catalog, choose **Import…** under **Import a Phase, Pipeline,
   Workflow, or Model Catalog document**.
2. In the host's **Inspect document** dialog, choose one YAML or YML file.
3. Review every plan row. Its outcome is **Import**, **Skip**, **Blocked**, or
   **Invalid**, and non-import outcomes include their reason.

The inspection reads the selected document once and changes no configuration,
catalog revision, or lock. A document-level refusal shows a refusal code and
reason but no plan table. Canceling the dialog leaves nothing to confirm.

<!-- Source: webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte -->
<!-- Source: webview-ui/src/components/ProcessImport/process-import-state.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-preflight-process-yaml.ts -->
<!-- Source: src/extension.ts -->

The import entry is unavailable while the workspace is untrusted, a Phase save
is pending, or a local Phase edit is outstanding. Save or discard the local edit
and retry. These checks happen before the file picker opens.

<!-- Source: webview-ui/src/components/ProcessImport/process-exchange-entry.ts -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PhaseCatalogEditor.svelte -->

## Confirm the plan

Choose **Confirm import** only after checking the statement beside it. Confirm
writes rows marked **Import** and leaves all other rows unchanged. The control
stays unavailable when the plan has nothing eligible to write or lacks a
revision required to protect a catalog write; inspect the document again to
build a fresh plan.

<!-- Source: webview-ui/src/components/ProcessImport/ProcessImportPreflight.svelte -->
<!-- Source: webview-ui/src/components/ProcessImport/process-import-state.ts -->

For process definitions, writes run in dependency order: Phases, then Pipelines,
then Workflows. Each catalog write checks the revision captured during
inspection. The sequence stops at the first rejected write and does not remove
an earlier accepted layer. To recover from a partial import, fix the reported
condition and inspect the same document again; definitions already present are
planned as **Skip**.

<!-- Source: webview-ui/src/components/ProcessImport/process-import-state.ts -->
<!-- Source: webview-ui/src/lib/catalog-lifecycle.ts -->

A Model Catalog plan uses a separate, single write. It sends only eligible model
additions, grouped by backend, and checks the Model Catalog revision captured by
inspection.

<!-- Source: webview-ui/src/components/ProcessImport/process-import-state.ts -->
<!-- Source: webview-ui/src/lib/save-models.ts -->
