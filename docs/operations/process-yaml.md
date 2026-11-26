# Import and export process YAML

Use the catalog editors to exchange a Phase, Workflow, or the Model
Catalog as a portable YAML document. The host owns every open and save dialog:
the webview sends no file location and receives none.

<!-- Source: webview-ui/src/lib/process-yaml-ipc.ts -->
<!-- Source: src/extension.ts -->

## Export a document

Choose the control for the resource you want to export:

| Resource | Control and choices |
| --- | --- |
| Phase | Open a saved, valid Phase and choose **Export…** from **More phase actions**. |
| Workflow | Open a saved Workflow and choose **Export YAML…** from **More workflow actions**. Under **Include**, select **References only** or **Include child Workflows and Phases**, then choose **Export**. The default is references only. |
| Model Catalog | On the Models tab, choose **Export…**, which assistive technology names **Export Model Catalog**. The catalog is exportable even when it is empty. |

<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PhaseEditorPage.svelte -->
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

1. In the Phase catalog, choose **Import…** under **Import a Phase,
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

For process definitions, Confirm sends the plan's definitions as one publication:
every layer you are importing, Phases and Workflows, in a single
request. Each layer carries the revision captured during inspection, so a
catalog changed since then is refused rather than overwritten.

The host validates the whole document before it writes anything, with every
definition in it applied over the catalog, so a Workflow that uses a Phase or child
Workflow from the same document is checked against the definitions it is about to
receive. Only then does it write the definitions as drafts and publish them, in
dependency order (Phases first, then child Workflows before parent Workflows).

- **An invalid definition means nothing is written.** Every defect is shown on the
  row it belongs to, and the other rows read **Not written: the package was
  refused**. Fix the document and inspect it again.
- **A storage failure part-way is reported row by row.** Each row says whether it
  was published, saved as a draft but not published, or not written. Nothing that
  landed is removed.
- **This is not a rollback.** Checking the whole document first stops a bad
  document from being written; it does not make the write all-or-nothing on disk.
  To recover from a partial import, fix the reported condition, publish each
  draft the import left from the Builder (a second import does not publish a
  draft an earlier one left), and inspect the same document again. Definitions
  already present, drafts included, are planned as **Skip**, and a definition
  that needs a draft is **Blocked** until that draft is published.

<!-- Source: webview-ui/src/components/ProcessImport/process-import-state.ts -->
<!-- Source: webview-ui/src/lib/catalog-lifecycle.ts -->

A Model Catalog plan uses a separate, single write. It sends only eligible model
additions, grouped by backend, and checks the Model Catalog revision captured by
inspection.

<!-- Source: webview-ui/src/components/ProcessImport/process-import-state.ts -->
<!-- Source: webview-ui/src/lib/save-models.ts -->

## Choose the repositories the two reviews read

Before each Code Review or Security Review iteration, Schegent resolves the repositories,
runs the selected reviewer in each changed target, and supplies the review scope to the repair pass.
The Phase includes that scope under `Review scope:`. For a feature across several repositories,
declare the implementation repositories in the workspace root.

### Declare the repositories

Add a section headed exactly `## Implementation repositories` to the workspace root's
`AGENTS.md`. Each bullet that starts with inline code is one repository:

- the path relative to the workspace root, in inline code, with `.` for the root itself;
- optionally, a second inline-code span, `(base: <ref>)`, naming the branch to compare against.
  The base defaults to `develop`.

A path or ref uses only letters, digits and the characters `.` `_` `/` `-`, and does not start
with `-`. Every other line in the section is prose and is ignored. This example is for a planning
root with linked repositories, which the reviews do not review themselves:

```markdown
## Implementation repositories

The feature code lives in these linked repositories.

- `client-source`
- `datahub`
- `shopify-app` `(base: main)`
- `klaviyo`
```

A bullet that starts with inline code but breaks the form, such as one with a space in its path,
makes the whole scope unresolved. It is never skipped as prose, so a typo cannot quietly drop a
repository from the review. The same holds for a section with no entry, two such sections, and two
entries that resolve to the same directory.

### What is read, and what is not

The root declaration determines the targets. Schegent reads the configured base in each
target and selects committed, staged, unstaged, and untracked changes. The scope excludes
`specs/`, `.specify/`, and nested Git repositories that are covered separately.

Without a declaration the reviews infer the target, as before:

- a standalone repository: the workspace root;
- the envelope: `repo/`, when the root holds `specs/` and `repo/` is a repository, including a
  `repo/` that is a linked worktree;
- a planning root with linked repositories: neither applies, so the scope is unresolved until you
  write the declaration.

Schegent checks the repository top level with Git. Both regular checkouts and linked worktrees qualify.

A linked repository, a Git entry of mode `160000`, is a repository and not a file. One the
declaration does not name is listed as "changed, not declared, not reviewed" when it changed, which
does not block the review, and as not reviewed when it did not. Without a declaration, a changed
one inside the inferred repository stops the review instead, because the inferred target alone
would hide it.

### When the scope cannot be resolved

Each of these is an unresolved condition: a declared path that does not exist, is outside the
workspace, is not a repository top level, or has no base because its base branch does not resolve
there; and a broken declaration, as described above. Each is reported as one counted finding,
tagged `[needs-decision]`, naming the path and the reason. The review never reviews a substitute
for it, and it never edits the declaration.

- **The review never reports clear while one stands.** Findings count toward
  `code_review_findings` and `security_review_findings`, so the loop condition stays true.
- **It costs iterations.** The Phase retries up to its iteration cap, or stops early when
  `schegent.loop.maxUnchangedComparisons` is set (see
  [retry-contract.md](retry-contract.md#stopping-a-loop-whose-judged-metrics-stop-changing)), and a
  Phase whose cap outcome is to fail, the default for these two, then fails the Run.
- **The remedy is the declaration.** For a repository that has no `develop`, declare it with
  `(base: <ref>)`. The reviews do not fall back to another branch, a remote-tracking ref or a
  fetch.

### What discovery never does

Working out the scope only reads. It stages nothing, switches no branch, creates or deletes no
branch, fetches nothing, stashes nothing, writes no ref, touches no index and updates no
submodule. The reviews fix confirmed findings only inside the resolved targets and review the
updated changes.

### Review commands and fixes

| Backend | Code Review | Security Review |
|---|---|---|
| Claude | Starts `/code-review --max-findings all` in a new headless Claude Code session. | Starts `/security-review` when the committed scope matches the default branch comparison for `origin`. Claude uses a scoped security review turn for a different base or local changes. |
| Codex | Runs `codex exec --json --sandbox read-only review -` with the scoped review instructions on stdin. | Runs the separate `codex-security scan` CLI against the working tree and resolved base **only after explicit operator consent** via `Schegent: Grant Native Review Scanner` (`schegent.backend.uncontainedScanners` + workspace fingerprint binding); refused by default with zero subprocess spawns. |
| Agy | Runs a dedicated Antigravity ACP turn for correctness findings. | Runs a dedicated Antigravity ACP turn for security findings and defensive fixes. |

Claude Code 2.1.288 or newer supports the `--max-findings` option. Codex Security (`codex-security`) is a standalone executable with **no observed OS containment sandbox** (`mechanism: 'none'`); granting `codex` alone never admits it. It needs `codex-security` on the extension host's sanitized PATH, its own configured credentials, and explicit opt-in via `Schegent: Grant Native Review Scanner` (and can be revoked at any time with `Schegent: Revoke Native Review Scanner`, returning to fail-closed zero-spawn refusal).
[Claude Code review](https://code.claude.com/docs/en/code-review-local),
[Claude Code commands](https://code.claude.com/docs/en/commands),
[Codex Security CLI](https://learn.chatgpt.com/docs/security/cli/reference).

The repair pass receives each report and fixes confirmed findings. When it changes the reviewed
patch, Schegent clears the verification metric and the Phase runs the reviewer again. A missing or
failed reviewer report stops the Phase. The example gives each review its own retry condition and
fails at the configured cap if findings remain or verification is incomplete.

<!-- Source: examples/speckit-new-feature.workflow.yaml -->
<!-- Source: src/controller/native-review.ts -->
<!-- Source: src/services/acp-runtime/bridges/acp-stdio-bridge.ts -->

## Finalize across repositories

The new-feature example ends at `claude-finalize`. It runs repository checks, commits
feature-owned paths, and reports any blockers. Merging follows the target repository's
procedure. Schegent's own workspace requires a recorded gate and a merge with a gate trailer.

Finalize uses the same repository declaration as review and adds the workspace root last on
`develop` when the root is a repository top level and the declaration omits it.

- Ownership comes from the feature directory, the plan or tasks, a named task that accounts
  for the change, or the gitlink of a repository with feature work. A shared pointer belongs to
  the feature while it names that feature's directory.
- Finalize reports ambiguous paths as `[needs-decision]` and leaves them out of the commit.
  This covers mixed ownership, partially staged files, and renames with an unowned side.
- When checks pass and the blockers are resolved, Finalize stages untracked owned paths and
  commits the owned paths explicitly. It handles the implementation repositories first and the
  workspace root last.
- The finalization record reports the checks, commits, skipped paths, and remaining hand-offs.

<!-- Source: examples/speckit-new-feature.workflow.yaml -->

## Bring an existing catalog to a revised example

A catalog that already holds an example's ids does not pick up a later version of that
example on its own. This section walks through the new-feature example's version 3, which
revises the Phases `speckit-tasks`, `speckit-implement` and `finalize` and the Workflow
`speckit-new-feature`. Each numbered step is one thing you do, or one thing that follows.

1. **An import skips what you already have.** Inspecting the revised example plans every id
   the catalog already holds as **Skip**, at any status, and confirming writes nothing for
   them. An import cannot deliver a changed definition, and deleting a row to import it again is not
   the route: a deactivated row still claims its id.
2. **Publish each changed definition by hand.** Open it in the catalog editor, replace its
   fields with the revised document's, save a draft (**Save** on a Phase's page), then choose
   **Publish**. For version 3 these are `speckit-tasks`, `speckit-implement` and `finalize`,
   and the Workflow `speckit-new-feature` for its record. For version 4: `speckit-analyze`,
   `speckit-implement`, `speckit-code-review`, `speckit-security-review` and `finalize`, which
   ask for issue tags. For version 5: `speckit-code-review` and `speckit-security-review`, which
   resolve the repositories to review (see
   [Choose the repositories the two reviews read](#choose-the-repositories-the-two-reviews-read)),
   and the Workflow `speckit-new-feature` for its record. The Workflow names its Phases by
   id, so the Phases carry the behavior. Saving a Phase that declares `retryCondition`, as
   `speckit-implement` does, needs the `retryConditions` capability.

   Version 6 is the first version of the example that adds a Phase. Inspecting the revised example plans
   `integrate` as an **Import** row, because its id is new, and confirming writes it as a Draft;
   every other id is still **Skip**. Publish in this order:

   1. `integrate`;
   2. `finalize`, saved from the revised text (version 5), which now commits only the feature's
      paths and no longer merges;
   3. the Workflow `speckit-new-feature`, saved from the revised text (version 6).

   The Workflow's node list changed, so "for its record" does not apply to it: publishing it is
   what makes a newly composed item run `integrate`, and publishing it after `integrate` lets the
   new node's Phase reference resolve. An item composed before the publish keeps its frozen snapshot and still
   merges the version-4 way (see step 5).

   Version 9 adds Converge and backend-specific Implement, Converge, and review Phases. Publish the
   selected definitions first, then update and publish the Workflow. Its default path ends at
   Finalize.

   Version 10 gives every Phase a backend-specific ID, including `claude-speckit-specify` and
   `claude-speckit-finalize`. Import and publish the new IDs, then update the existing Workflow's
   Phase bindings and publish it. Apply the revised instructions when publishing an existing
   Implement or Converge Phase.

   Version 11 names review phases independently of Spec Kit, for example `claude-code-review`
   and `codex-security-review`. The last node is `claude-finalize`. Publish the new definitions
   before using their IDs in the Workflow.

   Version 12 updated the review instructions to use each backend's review mechanism and check
   the patch after fixes. The current example declares version `1` for the Workflow and all
   included Phases. It uses `nativeReview` for the review Phases and ends at Finalize. Save and
   publish the revised review Phases and the Workflow to use native dispatch on new Runs.
3. **The version number does not move.** The editor shows **Version** read-only, and a save
   keeps it. The published copy carries the revised text under its old number. The catalog's
   own record id (`v<N>`), which advances on every save, is what tells the two apart.
4. **Compose new items after the publish.** A composed item freezes the definitions that are
   active at the moment it is composed.
5. **Decide about items queued earlier.** An item composed before the publish keeps its plan
   and the old text: compose it again and enqueue it again if you want the new text. An item
   enqueued without a plan resolves when its Run is created, so it runs whatever is active
   then.
6. **Existing Runs do not change.** A Run keeps the frozen snapshot it was created with,
   including when it is resumed. A Run that failed at its retry cap under the old text runs
   the old text again when resumed, so it can fail at the cap again.
7. **Removing an old row deletes its session data.** Removing a Task deletes its Run's session
   directory and raw transcript. A failed Run's failure record and the audit log stay. Copy what
   you need first.

<!-- Source: src/services/process-yaml/import-planner.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PhaseEditorPage.svelte -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PhaseEditorForm.svelte -->
<!-- Source: webview-ui/src/components/Builder/DefinitionActions.svelte -->
<!-- Source: src/catalog/version-record.ts -->
<!-- Source: src/contracts/pipeline-definitions.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/controller/task-deletion.ts -->
