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
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PipelineToolbar.svelte -->
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

## Choose the repositories the two reviews read

Before each iteration, `speckit-code-review` and `speckit-security-review` work out which
repositories to review, review the changes in each, and print them first in their report under
`Review scope:`. A feature whose code lives in several linked repositories needs a declaration
that names them; a workspace without one keeps today's two layouts.

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

A declaration is the only source of targets: the reviews add none, drop none and swap none.
`CLAUDE.md`, a nested `AGENTS.md`, plan files and agent memory never choose a target. Where one of
them names other repositories than the declared ones, the review says so under `Notes:` and changes
nothing.

Without a declaration the reviews infer the target, as before:

- a standalone repository: the workspace root;
- the envelope: `repo/`, when the root holds `specs/` and `repo/` is a repository, including a
  `repo/` that is a linked worktree;
- a planning root with linked repositories: neither applies, so the scope is unresolved until you
  write the declaration.

A directory counts as a repository top level when `git rev-parse --show-prefix` prints nothing
there, so a `.git` file counts like a `.git` directory.

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
submodule. The reviews still fix code, but only inside the resolved targets.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

## Finalize and integrate across repositories

The new-feature example ends with two Phases, and the pair does what `finalize` alone used to do
for one checkout. `finalize` verifies the work, repairs what it may, and commits only this
feature's paths. `integrate`, the last Phase, moves each repository's target branch without touching
any checkout. Both read the declaration described in
[Declare the repositories](#declare-the-repositories), so a feature whose code lives in linked
repositories is finalized in each of them. The workspace root is added as one more repository, last,
on `develop`, when it is a repository top level that the declaration does not list.

Version 4 committed every change in the checkout, so another feature's half-done work went into
this feature's commit, and merged by switching branches in a checkout that other sessions share.
Both are gone.

1. **Two Phases.** `finalize` formats the owned paths, runs each repository's check set, repairs
   failures the feature caused, fixes a dependency advisory inside its authority, and commits. It
   never merges, switches or checks out a branch, resets, stashes or pushes. `integrate` merges the
   committed work into each target and reports how far it got. It reads everything again from the
   repositories and nothing `finalize` said. An operator who integrates another way, for example
   through pull requests, can remove `integrate` from the pipeline; `finalize` still commits only the
   feature's paths.
2. **Ownership.** Each changed path, read with a status that writes no index, is *ambiguous*,
   *owned* or *unrelated*, first match winning. A path is owned when it lies in the feature's
   directory, when the feature's `tasks.md` or `plan.md` names it, when the agent ties it to a named
   task and says which and why, or when it is the changed gitlink of a repository with feature work.
   It is unrelated when another feature claims it, or when it is a changed gitlink of no repository.
   That a path changed never makes it owned. A shared pointer such as `.specify/feature.json` is owned
   only while it names the feature's directory.
3. **Hand-offs.** A path is ambiguous when this feature and another claim it, when both status
   columns are letters (partially staged), when a file mixes a change tied to this feature with one
   that is not, when a rename has one side not owned, or when no feature claims it. An ambiguous path
   is never staged, formatted, committed or restored. It is reported as a `[needs-decision]` hand-off
   with its reason, and while one stands `integrate` integrates nothing in any repository. A busy
   checkout produces more hand-offs, and that is the accepted cost.
4. **The commit.** In each implementation repository, then in the workspace root, `finalize` runs
   `git add` on the untracked owned paths and then `git commit` with the owned paths as the
   pathspec. Other staged entries stay staged, other files keep their bytes, and untracked files stay
   untracked. Nothing is committed in a repository where nothing is owned, where `HEAD` is detached or
   on the base branch, or after an earlier commit failed.
5. **The integration procedure.** For each repository the source is the branch checked out and the
   target is its base. A repository whose target already contains its `HEAD`, for example one checked
   out on its target or one the feature never touched, is already integrated. For every other
   repository `integrate` reads the target ref, computes the merge with `git merge-tree --write-tree`
   (Git 2.38 or later), writes the merge commit with `git commit-tree` (the old target first, the
   source second), and only then moves the ref with `git update-ref`, which fails if the target moved
   in the meantime. A Git too old for `merge-tree --write-tree` is a refusal, never a fallback to
   switching branches.
6. **Refusals.** Each of these is reported before any ref moves, leaves every target ref where it was,
   and withholds every integration: a detached `HEAD` at a commit the target lacks; a target that is
   not a local branch or does not exist (a tag or a remote-tracking ref named as the base is not a
   local branch, and nothing is fetched or created); a target checked out in another worktree, because
   moving a checked-out branch's ref would leave that checkout showing the merge as reversed changes;
   a conflict, with its paths and both commits listed; and a Git that cannot merge without a working
   tree.
7. **The guard.** `integrate` moves a target only when every check is green in every repository it
   integrates, `<feature_dir>/decisions.md` has no `Status: needs-maintainer` entry, nothing is handed
   off or owned but uncommitted, and every implementation `HEAD` the envelope records equals the actual
   one. It runs each repository's check set itself, so the checks run twice per feature, once in each
   Phase. An implementation repository with no check set is unverifiable and withholds; the workspace
   root with none has no check set and does not block.
8. **The record.** `integrate` reports `Finalization record:` on its own line, outside the audit log
   block. It gives the overall state: `integrated`, `partially integrated`,
   `committed, not integrated` or `nothing committed`. It then gives one bullet per repository: its
   source and target; "no feature changes", or the source commit and how many commits the target
   lacks; the owned paths committed; the checks (green, failing, unverifiable, no check set or not
   run); the unrelated paths left; hand-offs; the integration result; and the changed paths the
   checked tree held outside the commit. Only `integrated` ends in `CLEAR`. The wording is the
   agent's, so this block is an illustration and not a fixed format:

   ```text
   Finalization record:
   State: committed, not integrated
   - repo: 247-feature -> develop; 3f1c2a9, 2 commits develop lacks; owned paths committed: 9; checks green; unrelated paths left: 2 (src/b.ts, notes.md); hand-offs: none; integration: withheld (conflict in the envelope); outside the commit: 2 (src/b.ts, notes.md)
   - .: 247-feature -> develop; 8e0d417, 1 commit develop lacks; owned paths committed: 14; no check set; unrelated paths left: 0; hand-offs: none; integration: refused (conflict: specs/README.md; target 1a2b3c4, source 8e0d417); outside the commit: 0

   Remaining issues:
   - [needs-decision] .: merge of 247-feature into develop conflicts in specs/README.md (target 1a2b3c4, source 8e0d417); no ref moved
   ```

9. **Partial progress.** Repositories are applied in order, implementation repositories first and the
   workspace root last, and the first failed ref update stops the rest. That makes the sequence a
   local transactional sync with compensating rollback, not an all-or-nothing operation. If a ref had
   already moved, the state is `partially integrated`, and the record holds, for each such ref, the
   command that restores it: `git -C <path> update-ref refs/heads/<target> <old target> <merge>`. It
   succeeds only while the ref still holds the merge. `integrate` never runs it, because moving a
   ref back is a reset, which this workspace's rules leave to a maintainer's explicit approval.
10. **What the checks saw.** The checks ran on a tree that may hold other features' changes. The
    record lists the paths the checked tree held outside the commit. A feature that depends on one of
    them passes its checks and can integrate green without it, and the list is how a reader sees
    that.
11. **The checkout stays on the feature branch.** `integrate` moves the target's ref and nothing else.
    Switching the checkout back to `develop` is your step.
12. **Resuming a halted Run.** `integrate` is the last Phase, so a withheld or refused integration
    ends the Run with the `last_phase_issues_remain` cause. A resume runs `integrate` again, not
    `finalize`'s repair loop. A fix you made by hand must be committed before you resume, or run the
    item again; otherwise `integrate` withholds the owned paths as uncommitted.

To bring a catalog that already holds these Phases to this version, see
[Bring an existing catalog to a revised example](#bring-an-existing-catalog-to-a-revised-example).

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

## Bring an existing catalog to a revised example

A catalog that already holds an example's ids does not pick up a later revision of that
example on its own. This section walks through the new-feature example's version 3, which
revises the Phases `speckit-tasks`, `speckit-implement` and `finalize` and the pipeline
`speckit-new-feature`. Each numbered step is one thing you do, or one thing that follows.

1. **An import skips what you already have.** Inspecting the revised example plans every id
   the catalog already holds as **Skip**, at any status, and confirming writes nothing for
   them. An import cannot deliver a revision, and deleting a row to import it again is not
   the route: a deactivated row still claims its id.
2. **Publish each changed definition by hand.** Open it in the catalog editor, replace its
   fields with the revised document's, save a draft (**Save Phase**, for a Phase), then choose
   **Publish**. For version 3 these are `speckit-tasks`, `speckit-implement` and `finalize`,
   and the pipeline `speckit-new-feature` for its record. For version 4: `speckit-analyze`,
   `speckit-implement`, `speckit-code-review`, `speckit-security-review` and `finalize`, which
   ask for issue tags. For version 5: `speckit-code-review` and `speckit-security-review`, which
   resolve the repositories to review (see
   [Choose the repositories the two reviews read](#choose-the-repositories-the-two-reviews-read)),
   and the pipeline `speckit-new-feature` for its record. The pipeline names its Phases by
   id, so the Phases carry the behavior. Saving a Phase that declares `retryCondition`, as
   `speckit-implement` does, needs the `retryConditions` capability.

   Version 6 is the first revision that adds a Phase. Inspecting the revised example plans
   `integrate` as an **Import** row, because its id is new, and confirming writes it as a Draft;
   every other id is still **Skip**. Publish in this order:

   1. `integrate`;
   2. `finalize`, saved from the revised text (version 5), which now commits only the feature's
      paths and no longer merges;
   3. the pipeline `speckit-new-feature`, saved from the revised text (version 6).

   The pipeline's Phase list changed, so "for its record" does not apply to it: publishing it is
   what makes a newly composed item run `integrate`, and publishing it after `integrate` lets its
   Phase reference resolve. An item composed before the publish keeps its frozen snapshot and still
   merges the version-4 way (see step 5). What the two Phases do is in
   [Finalize and integrate across repositories](#finalize-and-integrate-across-repositories).
3. **The version number does not move.** The editor shows **Version** read-only, and a save
   keeps it. The published copy carries the revised text under its old number. The catalog's
   own record id (`v<N>`), which advances on every save, is what tells the two apart.
4. **Compose new items after the publish.** A composed item freezes the definitions that are
   active at the moment it is composed.
5. **Decide about items queued earlier.** An item composed before the publish keeps its plan
   and the old text: compose it again and enqueue it again if you want the new text. An item
   enqueued without a plan resolves when its Run is created, so it runs whatever is active
   then.
6. **Existing Runs do not change.** A Run keeps the pipeline snapshot it was created with,
   including when it is resumed. A Run that failed at its retry cap under the old text runs
   the old text again when resumed, so it can fail at the cap again.
7. **Removing an old row deletes its session data.** Removing a Task deletes its Run's session
   directory and raw transcript. A failed Run's failure record and the audit log stay. Copy what
   you need first.

<!-- Source: src/services/process-yaml/import-planner.ts -->
<!-- Source: src/ui/sidebar/commands/cmd-catalog-lifecycle.ts -->
<!-- Source: webview-ui/src/components/PipelineBuilderEditors/PhaseCatalogEditor.svelte -->
<!-- Source: webview-ui/src/components/Builder/DefinitionActions.svelte -->
<!-- Source: src/catalog/version-record.ts -->
<!-- Source: src/contracts/pipeline-definitions.ts -->
<!-- Source: src/services/workflow-run-factory.ts -->
<!-- Source: src/queue/feature-request.ts -->
<!-- Source: src/controller/task-deletion.ts -->
