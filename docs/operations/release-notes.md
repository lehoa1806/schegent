# Operator-visible release notes

This file is maintained by hand: neither the version field nor any script can determine which source changes are operator-visible. A release is the manual, local procedure in [`RELEASE.md`](../../RELEASE.md) (`npm run gate:record`, then `npm run release`).
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->

## Unreleased — operator-visible changes awaiting the first release

Recorded as they land, so the first release note is assembled from evidence rather than
from memory.

### Completion tokens without an audit block no longer advance a Phase (FR-R4-F12, 2026-11-01)

A completion token now counts only when it follows a complete audit block, as the prompt asks. A
token printed with no complete block before it, mid-prose, quoted from a file the model read or
echoed from a command, is reported in the Phase's warnings and no longer completes the Phase. Text
that reached the host only as tool output, a stream-json capture holding no model text, is never
read for a token, even after a complete block.

What happens to the turn depends on its shape. Each is what the same output without the token
already got:

- **Exit 0, the process still running when the turn ended:** the Phase reports issues and runs
  another iteration, told to print its audit block and then the token. The Run fails only at the
  iteration cap.
- **The turn settled (the host ended a process that had printed its result):** the Phase is an
  incomplete turn. It is resumed up to twice at once, each time told to end the turn with its
  contract block, and then halts as failed (`incomplete_turn_unresolved`).
- **A non-zero exit, not settled:** the existing delayed retry and its budget.
- **Tool-output text:** reported as in the first case.

Runs already in flight are classified under the new rule at their next invocation. No saved state
is rewritten.

If you want a Phase that completes on a token on its last non-empty line with no audit block, declare
`evidencePolicy: best-effort` or `none` on that Phase. The acceptance is then labelled as a degraded
read. A Phase that declares nothing, or `required`, does not.

Each Phase attempt's `phase-start` audit row now also records a prompt identity: a digest of the
output-contract text and the task block, or a marker that a stored resume prompt was sent. It holds no
prompt text, and rows written before this release simply have none. See
[the `phase-start.promptIdentity` entry](../reference/audit-events.md) for what it covers and what it
does not.

### First-run, install and VSIX instructions corrected (FR-R4-F11, 2026-11-01)

The quickstart now says the first Run on the default backend is refused until you allow it in
`schegent.backend.uncontainedBackends`, a User setting that deleting the walkthrough folder does not
undo, and its rollback removes only the id the walkthrough added; the operator course installs with
`npm ci` and `npm --prefix webview-ui ci` and builds a VSIX locally with `npm run package`, since no
tag or GitHub Release publishes one.

### Credential protection at commit and runtime boundaries (FR-R4-F10, 2026-11-01)

A commit can now be scanned for the bytes it carries, the secret scan detects more, and the redaction of
runtime content covers the shapes it was found to miss. None of this is a guarantee: each control is
best-effort, and the documents say where it stops.

- **A staged scan, and an opt-in hook.** `npm run security:secrets:staged` scans what a commit would carry,
  read from the Git index and not from the working tree, so a secret staged and then edited out of the working
  copy is still found. It judges a renamed or copied file at its new path, never writes the index, and refuses
  rather than passes when it cannot answer. To make `git commit` run it, activate the tracked hook once, inside
  `repo/`, with `git config core.hooksPath scripts/hooks`. Nothing installs it for you. `git commit --no-verify`
  bypasses it, git does not run it for a conflict-free merge, and there is no server-side check, so the tree scan
  in the gate stays the check that covers what was merged.
- **The scan detects more.** A lone AWS access key id and an AWS account id, an Anthropic API key, a JSON web
  token, a password assignment (an unquoted value on an env-style line, or a quoted literal, of at least 8
  characters), and a dotenv file named `.env.<suffix>` other than `.env.example`, `.env.sample` and
  `.env.template`. Test literals the new families reported were rewritten to be built when the test runs. No file or
  directory was added to the exemptions. `SECURITY.md` lists every family and every shape it does not detect.
- **Runtime redaction covers more, and is called what it is.** The value is removed, and the key stays readable,
  for a password, secret or token key in text (`MY_DB_PASSWORD=`, `db_password=`, a JSON `client_secret`) and for a
  string under such a key in a structured record; the password in `scheme://user:password@host` is removed with the
  scheme, user and host kept; and GitHub `gho_`, `ghu_`, `ghs_` and `ghr_` tokens and `npm_` tokens are added. The
  documents that said "sanitized" now say best-effort secret-pattern redacted, otherwise raw.
- **What stays raw.** Ordinary content, file paths and any secret format with no pattern stay in the clear. A keyed
  value shorter than 8 characters in text is not removed. **The process-definition export is written without
  redaction:** its document body does not pass through the redactor, only its audit row does.
- **Redaction is bounded.** Two existing patterns (a JSON web token, and a service-account private key in JSON) cost
  time that grew with the square of a hostile line, about 10 seconds for a 128 Ki line in one case. Both are
  rewritten to linear forms; one sanitize call now takes under 250 ms at the 1 MiB line bound and under 4 seconds for
  a 16 MiB export, checked by a performance test.

### Reproducible release artifacts and qualification (FR-R4-F09, 2026-11-01)

Preparing a release now produces one candidate and one record that names it, and the documents that
describe the release controls say what each control actually checks.

- **`npm run release` builds and checks the candidate itself.** After the preflight it removes every
  existing build output, builds once, generates the SBOM from that build, packages once into
  `.release/`, inspects those exact bytes, and writes `.release/schegent-<version>.release.json`
  beside the candidate. The record names the candidate's SHA-256, the commit, the build mode, the
  advisory evidence it relied on and the gate record. It tags, publishes and uploads nothing, and every
  run says so on its last line. Output is never reused, so a stale or foreign `dist/` cannot become a
  candidate.
- **Release preparation takes two advisory captures.** Pass `--advisory-capture root=<path>` and
  `--advisory-capture webview-ui=<path>`, made by `security:advisory-diff -- capture`. It refuses a
  capture that is incomplete or unavailable, made for a different lockfile than the commit holds,
  from the future, or more than seven days old (seven exactly is accepted). Each finding is listed with
  its advisory id and link, severity, whether the package is in the shipped code, and its disposition;
  a finding without a covering disposition is shown, not refused. Dispositions live in
  `docs/release/advisory-dispositions.json`, which needs a `rationale` on every entry.
- **The SBOM lists what ships.** The webview's bundled third-party code (the Svelte runtime today) is
  listed as shipping, beside zero declared runtime dependencies, where it used to be listed as
  excluded tooling. The SBOM is checked against the archive, and the smoke package now writes and
  checks its own.
- **Gate records say what they observed.** `npm run gate:record` writes version 3, which adds the Node
  the repository declares beside the one that ran, whether the planning envelope was present, and each
  dependency tree's lockfile digest and install state. A version-2 record is refused with an
  instruction to record again. A difference is printed and carried; it does not refuse a release.
- **An installed build names its commit.** The diagnostics bundle's `host` item now shows the commit,
  whether the tree was dirty, and the build mode, or `unknown` for a build that was not made by the
  project's build. `RELEASE.md` describes how to install the exact candidate and compare.
- **Two pages are new.** The [qualification matrix](../release/qualification-matrix.md) lists six
  platform cells and marks five of them unobserved. The
  [advisory dispositions page](../release/advisory-dispositions.md) describes the list.
- **Descriptions now say what each check does.** The license check verifies three structural facts and
  reads no dependency, the workflow-pin check names its three outcomes, and the performance budgets are
  wall-clock, single-worker and unretried. The held-major review test now tests its 90-day boundary
  exactly, and two stale hold reasons were rewritten. A hold review date still moves only with
  registry evidence.

### Bounded and keyboard-accessible webview (FR-R4-F08, 2026-10-31)

A sidebar left open through a long Run now stays responsive, shows the current state when it is revealed,
works from the keyboard, and renders correctly under the content-security policy the extension ships.

- **A failing projection is logged once.** When a catalog or the trust capabilities cannot be resolved, the
  sanitized runtime log now records the failure once, when it starts, and not again until it recovers. Before,
  the log line itself triggered another refresh that failed and logged again, about ten times a second for as
  long as the failure lasted. State is still refreshed on every real change.
- **The live phase log keeps the newest 500 rows.** A running phase's live tail now shows at most 500 rows:
  the newest 499 entries and one line saying how many earlier entries are not shown. While following, the
  newest entry stays in view. While paused, the view stays where it is, and the "new entries" count keeps
  counting after the limit is reached.
- **A hidden sidebar is not sent state, and is updated when it is revealed.** The sidebar no longer receives
  state while it is hidden, and shows the current state as soon as it is revealed. Acknowledgements of your
  commands are unaffected.
- **The Run detail tabs work from the keyboard.** The three tabs are one Tab stop. The arrow keys move between
  them and wrap, Home and End go to the first and the last, and each tab names the panel it controls.
- **Queue Settings keeps focus inside.** Tab and Shift+Tab cycle within the dialog. When it closes, focus
  returns to the control that opened it, or to the Queues view when that control is no longer shown.
- **The webview was checked under its real content-security policy.** The sidebar and the dashboard raised no
  violation, and the Builder's thirteen static inline styles, which the policy reported, now come from
  stylesheet classes with the same appearance. The policy also now sets `base-uri` and `form-action` to
  `'none'`, after every form the webview mounts was shown to work under them. Nothing in the policy was
  loosened.
- **Costs are measured, and no broader change is made.** What a snapshot costs the host and the webview,
  how the stored records grow, and the retention options are recorded in
  [the measurement](webview-snapshot-cost-measurement.md). A per-slice snapshot change is justified by size
  and is left as follow-up work; raw reactive state and list virtualization are not adopted. Nothing is
  deleted.

### Truthful process authoring and safe exchange (FR-R4-F07, 2026-10-31)

Several things the authoring and exchange surfaces said were not what they did. A Workflow condition could be
authored that could never match, the Runs launcher showed settings the Run would not use, a package import
could be refused after half of it had been written, and the catalog writer was described as safer than it was.
This makes each of them say what is true, and closes the gaps behind them.

- **A condition that can never match is refused.** An ordering comparison (`greaterThan`, `lessThan`, and the
  rest) or a comparison against a number or a boolean is now `condition-comparison-unsupported`, because the
  evaluator only compares text. A stored Workflow that uses one shows as invalid and cannot be launched; a Run
  that was already started finishes from its frozen plan. The Builder's operator list offers the four operators
  that can match text (`equals`, `notEquals`, `in`, `exists`), and its condition values are saved as text. Every other Workflow is unaffected.
- **The Runs launcher shows what the Run will use.** For each Phase it shows the backend, the model and effort
  (or "backend default"), and the idle limit, resolved by the host the way execution resolves them, and the Run
  time limit. A Pipeline's authored `executionDefaults` are shown on a separate line labelled advisory and not
  applied: nothing has ever applied them, and the launcher no longer presents them as the settings.
- **Package import validates the whole document before it writes.** One request now carries all the layers, and
  a document with a defect anywhere is refused before any layer is written. If a failure comes part-way, the
  layers already written are drafts and not published, and the result says which.
- **A chosen document is size-checked before it is read.** A file over 1 MiB is refused as too large without its
  contents being read, and a failed read is logged with an error code and no path. Long runs of trailing spaces
  in a document no longer slow the reader down quadratically.
- **A Phase `model` is checked at preview.** A `model` that could not be passed to a backend as its own
  command-line argument (over 128 characters, or not starting with a letter or digit, or outside
  `A-Z a-z 0-9 . _ : / -`) is refused in the plan with the same reason the commit would give, instead of
  previewing clean and failing at the commit.
- **A capability list longer than the four capabilities is refused** as `too-many-members`, before any member is
  looked up. Every such list already held an unknown member or a repeat.
- **Exports quote what the reader would misread.** A sequence item that would read as the start of a key, such
  as the model identifier `ollama:llama3`, is written quoted, and so is a value that opens with a double quote.
  The unquoted form is still refused on import. A document exported by an earlier release that held such an item
  could not be imported and still cannot; re-export it.
- **The catalog writer says what it assumes, and flushes to disk.** Writes through one extension host now run
  one at a time, so two saves of different definitions no longer lose one of them. The writer assumes one
  extension host writes a catalog directory: the primary window. A second process writing the same catalog is
  unsupported, and the last manifest write would win: a definition's pointer update can be lost while its
  version record stays on disk as collectable. Catalog writes are flushed to disk on macOS and Linux (each save
  costs about 15 ms more, measured on APFS; the Linux path has not been run on a Linux host). Windows gets the file flush and no
  directory flush. Network mounts and remote workspaces are not claimed: the flush is attempted and nothing
  here observed it honoured. Power loss has not been observed.
- **Two failures now say why.** A catalog that is not writable logs its error code once, and an export that
  fails to write logs a code and no path.

Compatibility:

- Conditions: a Workflow with an ordering operator or a non-text literal in a condition is invalid after this
  release. Edit the condition to compare text, or leave the Run to finish from its frozen plan.
- The Builder: a stored numeric or boolean condition value still loads, and is then reported as above.
- Capabilities: a list over four members was already invalid; only the reason it is reported under is new.
- Quoting: the format version is unchanged (`apiVersion` is `schegent/v1`). The quoted forms were already
  accepted by the reader.
- Package import: no change to the document or the request shape the host accepts.
- The catalog writer: no storage-layout change and no migration. One host store per directory is enforced inside
  the extension host; a second store for the same directory is refused with a warning.
- The barrier: no format change; an older release reads the same files. A save is slower by the figure above.
- Schema versions: `SIDEBAR_IPC_SCHEMA_VERSION` is unchanged at 3, `AUDIT_SCHEMA_VERSION` is unchanged, and the
  process-YAML `apiVersion` is unchanged.

### Controllable evidence capture and lifecycle (FR-R4-F04, 2026-10-31)

What Schegent keeps of a Run, for how long, and how an operator takes it out or removes it were not under
the operator's control, and the exports left no trace. This changes the capture default, makes deletion
complete, audits exports, replaces the account name in audit rows, and adds a bundle for asking for help.

- **CLI transport is per Run, bounded, and chosen.** The shared `.schegent/cli-transport.log` is no longer
  written. Each Run's stream lines go to `.schegent/sessions/<runId>/transport.log`, kept according to the new
  `schegent.logging.transportCaptureMode` (`inherit`, `off`, `errors-only`, `on`; the default `inherit`
  follows the raw transcript mode, so `errors-only` keeps only a failed or canceled Run's lines). A file is at
  most 5 MiB and the workspace total 20 MiB; an `errors-only` Run waits in a stage in the OS temp area
  until it ends. Files an earlier release left expire whole at the session retention age. The privacy
  profiles set the mode and say so.
- **Delete Run Evidence now removes directories and the checkpoint.** It removes the Run's session directory
  (it used to leave the emptied directories), its failure records and its private recovery checkpoint, for a
  finished Run whose evidence is in this workspace. It keeps the shared audit log, the runtime log, the
  metrics rollup, Run history and any legacy transport file, and says so and when the legacy file ages out.
- **Exports are owner-only and audited.** Export Run Evidence and Export Metadata-Only Audit now record one
  `evidence-exported` row (a count, never a path), refuse a destination that is not a local file or that
  resolves into `.schegent/`, start their dialogs in your home directory and write `0600`. They are now
  mutating, owner-only commands, so an untrusted window or one that does not own the workspace refuses them;
  FR-R3-136 had left them read-only.
- **Audit rows carry a pseudonym, not your account name.** New rows carry a random `pseudonym-` label kept in
  the extension's private workspace storage; `Schegent: Reset Operator Pseudonym` replaces it and records
  that it did, without either value. Older rows and stored overrides may still hold an OS username and are
  not rewritten. An audit file's age is now measured from its oldest usable row, so an existing log whose oldest
  row is older than `schegent.audit.rotation.maxAgeDays` rotates at the first append after you upgrade (its rows
  are kept, in an archive).
- **A diagnostics bundle for asking for help.** `Schegent: Create Diagnostics Bundle` builds one JSON file for
  one Run you pick, up to 10 MiB, showing every included and omitted item first. Raw conversation (the
  transcript, the transport and the verbose diagnostics) is left out unless you include it after a warning.
- **An hourly retention pass, Run context in the runtime log, and a complete inventory.** An idle owner window
  now removes expired inactive evidence once an hour; runtime-log lines for a Run carry its `runId` and
  `phase` (not yet the backend runners' own lines); and the retention disclosure lists every store with its
  bounds, how it is swept and what Delete and Export do with it. It also now says that the CLI sends the
  conversation to the model vendor whatever these settings say.

### Audit continuity and loss detection (FR-R4-F03, 2026-10-31)

The audit log's hash chain could be broken by nothing but ordinary operation, and could not notice the
end of the log being removed. This closes both, and says plainly what it still cannot see.

- **Both legacy transitions verify.** A history whose first chained row links to `genesis` after legacy
  rows, and one whose first row links to the last legacy row, both verify, and a retention prune of the
  transition is accounted for (a version 2 cut record). Verification reports which form it found and how
  many legacy rows retention removed.
- **A rejected append no longer forks the chain, and audit health recovers.** Each row links to the last
  row that landed, computed inside the serialized write step, so a refused, torn or queued write is never a
  predecessor. The audit sink is healthy again once an append lands; a broken link or a loss finding is
  not cleared by that. Permission refusal now reads as `permission-denied`, not `io-error`, and every
  rejected entry produces exactly one notice.
- **Damaged tails are diagnosed.** The owner reads the log's last line as bytes before it links. A final
  line that is not valid JSON is kept exactly as found, terminated, and followed by an
  `audit-integrity-condition` row naming it by file, line, length and digest. Verification reports it as
  diagnosed damage, recorded and not repaired, and it does not fail the audit sink.
- **Only the owner window writes, and nine palette commands are refused elsewhere.** The writer asks the
  workspace lock inside every step, so a window that does not own the workspace records nothing and notices
  each refusal. Nine commands that start or record work (`startQueue`, `restartCanceledTask`, `cancel`,
  `reset`, `pausePhase`, `resumePhase`, `restartPhase`, `deleteRunEvidence`, and the new reset below)
  refuse there, after the trust check, with the existing palette warning.
- **Untrusted activation changes nothing.** Constructing the audit writer is read-only. Archive
  maintenance (prune, narrow, cut record) runs once, after trust, in the owner window.
- **A head checkpoint, seven loss states and a reset command.** A small file in the extension's per-user
  storage, outside the workspace, records the digest and position of the newest landed row. `Schegent:
  Verify Audit Chain` reads the history against it and reports a history that is shorter than it was or
  missing, with the counts; both fail the audit sink. `Schegent: Reset Audit History Checkpoint` retires
  it after a deliberate removal, refuses while any audit file is present, and never deletes or moves
  evidence. `npm run audit:verify` cannot read the checkpoint and says so on every run. This reduces
  undetected loss. It does not stop the same OS user from editing both stores, and it says nothing about
  rows written after the checkpoint.

Compatibility:

- `AUDIT_SCHEMA_VERSION` is unchanged at 3.
- One new event type, `audit-integrity-condition`, with two versioned conditions. An older release preserves
  the row.
- A version 2 cut record is read by an older verifier as a no-op cut, so a form A history still verifies there.
- An older release reads a diagnosed damaged line as `malformed`, which is conservative.
- The checkpoint is new, with no migration of existing data: a workspace with history and no checkpoint
  starts one at the owner's first append, and loss before that is not checked.

### Advisory comparison against an explicit baseline, report-only (FR-R4-F21, 2026-10-30)

A candidate with dependency advisories is not necessarily one that made things worse, and
`npm run security:audit` cannot say which. `npm run security:advisory-diff` now compares a candidate
commit's advisories with those of an explicit base commit, for both npm trees, and reports which are
introduced, worsened, uncertain, pre-existing or resolved. It is a three-step, operator-run command:
`base` prints the base, `capture` audits one tree at one commit and is the only step that contacts the
registry, and `compare` reads the captures offline and prints the report.

- Report-only. It is not part of `npm run gate` or any verify tier, the release or the package, no Phase
  or pipeline runs it, it exits 0 whatever it finds, and it is neither a waiver nor permission to
  integrate. `npm run security:audit` is unchanged and still fails when it finds an advisory.
- An incomplete comparison never reads as clean: a missing, stale, mismatched or failed capture, a base
  that cannot be chosen, or captures that are not comparable is reported with its reason, and the counts
  are stated as not determined rather than zero.
- A disposition list, when one is named, is shown beside each finding and never changes a class or a count.
- `semver` 7.7.4, already resolved in the lockfile, is now declared as a development dependency. Nothing
  new is installed.
- No setting, event, status, field or schema version changed, and there is no migration.

### Skip is refused on a failed run, and the refusal is shown (FR-R4-F20, 2026-10-29)

If a run failed while Skip's confirmation was open, confirming revived the run: its failed task went
back to running, which lifted its queue's halt, and no operator had chosen that. Skip of a failed run
is now refused as `run-failed`. Nothing about the run, its task or the queue changes, and the queue
stays halted on the failed task. The exits for a failed task are Retry, Mark completed and Remove.

- A Skip names the run the operator confirmed. If the queue holds another run by the time the message
  arrives, it is refused as `no-run-in-flight` instead of being applied to the new run, and a Skip
  message without a run id is refused at the boundary.
- On a failed task's view, the disabled Skip control says why, in the sentence its refusal uses: "A
  failed task cannot be skipped: retry it, mark it completed, or remove it." A refused Skip now shows
  its reason beside the control, as Pause, Resume and Restart do.
- If the run fails after the Skip was applied, the Skip is still reported accepted: the skipped phase
  stays skipped, and nothing is revived, resumed or scheduled. Retry resumes the run with that override
  in force.
- Skip of a running or paused phase is unchanged.
- No setting, event, status, field or schema version changed, and there is no migration.

### Finalize commits only the feature's paths, and a new `integrate` Phase moves target branches without touching a checkout (FR-R4-F19, 2026-10-29)

The shipped `finalize` committed everything in the checkout, so another feature's half-done work went
into this feature's commit, and it merged by switching to `develop` in a checkout that other sessions
share. Finalization is now two Phases. `finalize` verifies, repairs and commits only this feature's
paths, in each repository a workspace declares. A new last Phase, `integrate`, merges the committed
work into each repository's target branch without switching, checking out or otherwise touching any
checkout, and reports how far it got.

- A changed path is owned, unrelated or ambiguous. An ambiguous path (claimed by two features, partially
  staged, a file that mixes changes, a rename with one side not owned, or claimed by none) is a
  `[needs-decision]` hand-off: never committed, and it withholds integration in every repository. That
  a path changed never makes it owned.
- `integrate` computes each merge with `git merge-tree --write-tree` (Git 2.38 or later), writes it
  with `git commit-tree`, and moves the target ref only by `git update-ref` with the old value, so a
  target that moved is not overwritten. It refuses, before any ref moves, a detached `HEAD`, a target
  that is not a local branch, a target checked out in another worktree, a conflict, and a Git that
  cannot merge without a working tree. It never fetches, pushes, resets, stashes or switches a branch.
- The guard is kept: every check green in every repository it integrates, and no
  `Status: needs-maintainer` decision. `integrate` runs each check set itself, so the checks run twice
  per feature. It also compares the `HEAD`s the workspace root records with the actual ones.
- It reports `Finalization record:` with one of four states (`integrated`, `partially integrated`,
  `committed, not integrated`, `nothing committed`) and one bullet per repository. After a partial
  integration the record holds the command that restores each ref that moved, and never runs it. Only
  `integrated` ends in `CLEAR`.
- Resuming a halted Run now runs `integrate` again, not `finalize`'s repair loop. Commit a fix you made
  by hand before resuming.
- Each changed or new definition has a version: `finalize` 5, `integrate` 1, and the pipeline
  `speckit-new-feature` 6. Version 6 is the first revision that adds a Phase: an import plans
  `integrate` as an **Import** row, and you publish `integrate`, `finalize` and then the pipeline. The
  steps are in
  [Bring an existing catalog to a revised example](process-yaml.md#bring-an-existing-catalog-to-a-revised-example);
  the behavior is in
  [Finalize and integrate across repositories](process-yaml.md#finalize-and-integrate-across-repositories).
- No setting, event, field, schema version or host behavior changed, and there is no migration. Runs
  already created keep the text they were created with, and an item composed before the publish still
  merges the old way.

### The two review Phases read the repositories a workspace declares (FR-R4-F18, 2026-10-29)

`speckit-code-review` and `speckit-security-review` chose their repository by layout: `repo/` beside
`specs/`, otherwise the workspace root. In a workspace whose code lives in linked repositories that
picked the planning root, so a review could read an envelope diff with no source changes and report
nothing wrong. They now read the repositories a workspace declares, report them first under
`Review scope:`, and treat a scope they cannot resolve as a finding.

- A workspace owner declares the repositories in a section headed `## Implementation repositories`
  in the workspace root's `AGENTS.md`: one bullet per repository, in inline code, with an optional
  `(base: <ref>)` that defaults to `develop`. A declaration is the only source of targets; `CLAUDE.md`,
  plan files and agent memory never choose one. The three layouts, the entry form and what a linked
  repository the declaration omits does are in
  [Choose the repositories the two reviews read](process-yaml.md#choose-the-repositories-the-two-reviews-read).
- A workspace without a declaration keeps today's target in both supported layouts: the workspace
  root for a standalone repository, and `repo/` for the envelope, including a `repo/` that is a linked
  worktree. A planning root with linked repositories needs the declaration.
- An unresolved scope is a counted finding, tagged `[needs-decision]`: a declared path that does not
  exist, is outside the workspace, is not a repository top level or has no base, or a declaration that
  is broken. The review never reports clear while one stands, so the Phase retries to its iteration
  cap, or to the unchanged-metrics stop when `schegent.loop.maxUnchangedComparisons` is set. The
  remedy is the declaration.
- Each changed Phase is a new version: `speckit-code-review` 3, `speckit-security-review` 3, and the
  pipeline `speckit-new-feature` 5. An import skips ids a catalog already holds, so an existing
  catalog gets the new text by publishing the two Phases and composing queued items again; the steps
  are in
  [Bring an existing catalog to a revised example](process-yaml.md#bring-an-existing-catalog-to-a-revised-example).
- No setting, event, field, schema version or host behavior changed, and there is no migration. Runs
  already created keep the text they were created with.

### A retry loop can fail early when its judged figures stop changing, off by default (FR-R4-F17, 2026-10-29)

A loop whose retry condition stayed true and whose figures did not move ran to its iteration cap, one
invocation after another. `schegent.loop.maxUnchangedComparisons` lets an operator fail it sooner. It
ships at `0`, which is off, so no existing run changes on upgrade.

- Set to a value from `1` to `49`, it fails a retry loop after that many consecutive comparisons in which
  the figures its retry condition reads did not change, below the iteration cap. `2` is a suggested
  starting value, not a default. A value outside the range is read as `0`. It applies only where the
  phase's cap outcome is to fail, and never at or past the cap.
- The failed run carries a new cause, `judged_metrics_unchanged`, labelled "Judged metrics unchanged",
  and a notice that says the figures were unchanged and that work the condition does not measure may
  still have happened. It advises resolving what blocks the condition first, and then names "Schegent:
  Resume Paused or Failed Workflow", which runs the phase again at the same iteration with the
  iterations left up to the cap. The cause is on the failed run, its `task-execution-ended` event, the
  metrics rollup, the failure record and History.
- The per-run limits view gains an "Unchanged-metrics stop" row: the value, the layer that set it, and
  whether it applies to the current phase. It reads "not applied" when the phase has no retry condition
  or continues at its cap.
- What it does not do: it adds no status, no audit event type and no `phase-end` cause; it never resumes
  a run by itself; it does not reset the cap; and it does not claim that no work happened. A figure the
  condition does not name, or a change to the working tree, does not reset the count.
- The settings reference, the retry contract's new section "Stopping a loop whose judged metrics stop
  changing" and the closed list of ten causes are in
  [retry-contract.md](retry-contract.md#stopping-a-loop-whose-judged-metrics-stop-changing).

### Removing a row records whether the operator attested it, and a report counts how failed rows were resolved (FR-R4-F16, 2026-10-29)

After an attested row was removed, its audit line said `priorStatus: completed` and nothing more, so
it read as a normal completion. And nothing counted which exit a failed row took. Both are now
recorded, and neither changes what any queue, run or row does.

- Removing a row now writes `completionProvenance` on its `task-removed` audit line: `operator-attested`
  when the operator had marked the row completed, `null` otherwise. A line written before this change
  has no such field, and reads as "provenance not recorded", never as attested.
- "Schegent: Report Failed-Row Exits" counts how each failed row was resolved, by failure cause: resumed,
  started fresh, removed, attested, still failed and the other exits, with an unknown count and its
  reasons beside them. It opens an unsaved Markdown document, writes nothing, works in an untrusted
  window, and states what it cannot see: why a queue ran on under the `continue` policy, rows removed by
  Clear Failed or Clear Done, and why an operator chose an exit.
- It is the evidence for a decision, not the decision: no status, button or event was added, and the
  decision record stays pending.
- How to read the report is in
  [Count how failed rows were resolved](inspect-audit-logs.md#count-how-failed-rows-were-resolved).

### A failed run records its cause and says what to do next (FR-R4-F14, 2026-10-28)

A run that failed at its iteration cap told the operator to run "Schegent: Resume" to retry,
and a resume gave the phase one more attempt that failed the same way. Every failed run now carries
one cause from a closed list of nine, and each failure shows a notice built for that cause.

- The cause is on the failed run, on its `task-execution-ended` audit event and on its metrics rollup
  record. The rollup record is now version 2; version 1 records are still read, and cumulative totals are
  unchanged. A run that failed before this change reads as "Cause not recorded".
- The notices say what stopped and which action is worth taking, by its exact title. A cap failure says
  that "Schegent: Resume Paused or Failed Workflow" gives the phase one more attempt and that it fails the
  same way unless the blocker is resolved first, and names "Mark '…' as completed" for work finished by
  hand. A last-phase failure says to fix the open issues first. No notice offers a button that does not
  exist, and none carries agent output.
- History's run detail shows a failed run's cause as `{label} ({code})`.
- The `schegent.loop.maxIterations` description and the settings reference now say it bounds every phase
  that has a retry condition, and that the run fails at the cap unless the phase or
  `schegent.retry.forceContinueOnCap` says to continue. No behavior changed.
- The metadata-only audit export carries `failureCause`, value-checked against the nine codes.
- The new cause table, and how Resume, Retry and Restart differ, are in
  [When a run fails: its cause and what to do next](retry-contract.md#when-a-run-fails-its-cause-and-what-to-do-next).

### The shipped new-feature pipeline decides, sets aside or reports instead of asking (version 3, 2026-10-28)

An unattended run has nobody to answer a question, and runs of this pipeline have stopped
on one. `speckit-implement` reported a task as needing a maintainer decision, went on
counting it in `pending_tasks`, and re-ran to its iteration cap. `finalize` left failing
dependency-audit checks alone because a lockfile bump was "outside this task" and "needs
your approval". `examples/speckit-new-feature.pipeline.yaml` is now version 3, and both
Phases say what they may settle alone, what they must set aside and what they must report.

- `speckit-implement` ranks the sources it settles a conflict by and records each decision
  in `<feature_dir>/decisions.md`. A task only a maintainer can answer is set aside as
  *blocked* (`Status: needs-maintainer`); a task only a person can finish is a *hand-off*.
  Neither counts toward `pending_tasks`. The Phase gains the metrics `blocked_tasks` and
  `user_run_tasks`, and its loop condition is still `pending_tasks > 0`.
- A task is a hand-off in three cases and no other: its own line carries the `USER-RUN`
  marker (outside inline code); its own line names a person's approval as the condition; or
  every other step is done and the only one left is pushing, opening or merging a pull
  request, watching CI or deploying outside the repository. A task with any implementation
  still undone stays pending, so difficulty, size and a failing test never make a hand-off.
  `speckit-implement` lists each open hand-off with its basis under
  `Hand-off tasks (for the user):`, outside `Remaining issues:`, and reports CLEAR when only
  hand-offs remain.
- `speckit-tasks` now writes the label `[USER-RUN]`, and only on work that needs a person:
  pushing, opening or merging a pull request, watching CI, deploying outside the repository,
  an explicit approval, or work that cannot start until one of those has happened. It splits
  a line that mixes headless work with a person's step, marks only the tasks the skill wrote
  and adds none of its own. `speckit-implement` never adds, removes or edits a marker.
- `finalize` may fix a failing dependency-audit check without asking: a patch or minor bump
  of at most three packages, whose advisory is in a dependency the feature did not change,
  in a `fix(deps)` commit of its own that is reverted if it turns a green check red. A major
  bump, a forced update, an overrides entry and any change to an audit's threshold or
  ignore list stay outside that authority. It merges to `develop` only when every check is
  green and no decision waits on a maintainer.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

**Who is affected**: anyone who runs the shipped pipeline, and whoever maintains a catalog
that holds an earlier copy of it.

**What you may need to do**: nothing for a fresh install. A catalog that already holds
`speckit-tasks`, `speckit-implement`, `finalize` or the pipeline `speckit-new-feature` keeps
its copy, because an import never overwrites an existing id (`FR-024`): save a draft of each
changed definition with the new text and publish it. "Bring an existing catalog to a revised
example" in `docs/operations/process-yaml.md` gives the steps, and says what happens to items
already queued and to Runs already started.

**What happens to Runs you already have**: nothing. A Run keeps the pipeline snapshot it
was created with.

**What you gain, and what you do not**: a blocked task or an out-of-authority advisory no
longer loops the Phase to its cap or waits for an approval nobody can give. The Phase
reports it, and the Run ends at its last Phase with `Remaining issues:` listing what a
maintainer must decide. This reduces the risk of a stalled run; it does not remove it. The
authority is prose the backend follows, and the host does not enforce it.

### A window that loses the primacy election keeps contesting (`FR-032`, 2026-09-12)

Exactly one VS Code window per workspace drives Runs. That window used to be chosen once,
at activation, and a window that lost stayed passive for the rest of its life. When the
window holding primacy exited *without* releasing its lease — a crash, a force quit, a
machine suspended — the record it left behind still reads as live for fifteen seconds, so
a replacement window opened inside that span lost the election correctly and then never
asked again. The reported instance sat for 6h28m with persisted Runs untouched, and the
only recovery was restarting VS Code. A window now contests on every heartbeat until it
wins, and installs its recovery producers at the moment it wins rather than only at
activation.

**Who is affected**: anyone who opens more than one VS Code window on the same workspace,
and anyone whose primary window has ever exited uncleanly.

**What you may need to do**: nothing.

**The accepted consequence — closing the primary window hands the workspace to the
survivor.** With two windows open on one workspace, the second begins driving persisted
Runs within roughly 15–20 seconds of the first ceasing to beat: the fifteen-second
staleness threshold, rounded up to the next five-second heartbeat. This is the intended
behaviour rather than a side effect of the fix. The alternative considered was to contest
only while a Run is pending, and it was rejected because it makes takeover depend on state
the losing window cannot see. Operator decision, 2026-09-12: always contest. There is no
setting that pins a window as non-driving — primacy is a property of the workspace lease,
not a per-window rank.

**What happens to Runs you already have**: nothing changes on disk, and a takeover cannot
double-drive a Run. The resume path claims the queue's execution lease before it marks
anything in flight (`FR-R3-070`), so a window that gains primacy while another is still
executing declines rather than spawning a second process.

**What you gain**: a crashed or force-quit host no longer strands every persisted Run on
that workspace until somebody notices and restarts VS Code.

### BREAKING — a Phase is judged on its exit status by default (`FR-R3-117`, 2026-08-27)

A Phase that declares nothing used to advance on the model's own report of its work. It
is now judged on its process's exit status, and a clean termination token cannot
override a non-zero exit or a timeout.

**Who is affected**: any Phase whose `sideEffects` is other than `none` — and because
`sideEffects` resolves to `workspace` when omitted, that is most Phases. A Phase
declaring `sideEffects: none` is unchanged.

**What you may need to do**: a Phase that legitimately exits non-zero (a linter used as
a probe, a diff check) now stops the Run. Add `hostVerification: model-token` to that
Phase's spec to keep the old behaviour. Nothing else is required.

**What happens to Runs you already have**: nothing. Persisted plan snapshots are
migrated (state schema 13 → 14) carrying the verdict basis they were frozen under, so
an existing Run keeps the meaning it was approved with.

**What you gain**: a failed build, a failed test run or a crashed tool can no longer
report success, and every completed Run's evidence names which basis judged each Phase
(`phase-end.verdictBasis`).

**Shipped documents affected, swept rather than left to discovery**: both example
pipelines — `examples/speckit-new-feature.pipeline.yaml` (nine Phases; six make a
verifiable claim) and `examples/speckit-bugfix.pipeline.yaml` (five Phases) — now write
`hostVerification: exit-code` out explicitly. They would resolve to it anyway; an
example is what an operator copies, so it should say what judges each Phase rather than
let it be inherited invisibly. `examples/model-catalog.yaml` declares no Phases and is
unaffected. No other pipeline or phase document ships in the tree.

Full reasoning: [`docs/architecture/phase-verdict-default.md`](../architecture/phase-verdict-default.md).

### A failed Run keeps a bounded failure record (FR-R4-F15)

- **A record that Remove does not delete.** When a Run fails, Schegent writes one redacted,
  path-free file of at most 32 KiB to `.schegent/failure-records/`, naming the failure cause, the
  phase context and up to 20 issue summaries the agent reported as still open. Remove deletes a
  row's session directory and raw transcript and leaves the record; a Run's Delete Evidence removes
  it, and the Run's evidence export includes it.
- **"Show last error" shows it.** The row's region now lists the cause, the phase and iteration, the
  issues with the agent's own labels, and the last metrics, and says so plainly when the record was
  removed by retention, is unavailable or could not be read.
- **The age setting now covers it.** `schegent.logging.sessionRetentionMaxAgeDays` ages failure
  records out with the session artifacts, and at most the newest 200 records per workspace are kept.
  `schegent.logging.sessionRetentionMaxBytes` does not apply to them.
- **Five phases ask for issue tags.** In the new-feature example (version 4), `speckit-analyze`,
  `speckit-implement`, `speckit-code-review`, `speckit-security-review` and `finalize` ask the agent
  to start each bullet under `Remaining issues:` with `[regression]`, `[pre-existing]`,
  `[environment]`, `[needs-approval]` or `[needs-decision]`, or no tag when none fits. The tags are
  the agent's labels: Schegent records them and does not check them, and no decision depends on
  one. An existing catalog reaches the new text by publishing each changed definition, as
  [Bring an existing catalog to a revised example](process-yaml.md#bring-an-existing-catalog-to-a-revised-example)
  describes; a Run already started keeps the text it began with.
- **The two notices that named no action now point at the panel.** When a record was written, the
  `cap_exhausted` and `last_phase_issues_remain` failure notices end with the sentence
  `"Show last error" lists what was open.`; when none was written they read as before.

No audit event, field or schema version changed, and nothing about halts, counters, the iteration cap
or a Run's status changed. There is no migration. Rolling back leaves the records on disk: delete
`.schegent/failure-records/` by hand if you want them gone.

When adding an entry, name the affected command, setting, workflow, state transition or persisted
artifact exactly as it appears in the product, and state upgrade or rollback limits explicitly. Do
not infer a historical change list from the current code snapshot alone.

For each entry, name the affected command, setting, workflow, state transition, or persisted artifact exactly as it appears in the product. State upgrade or rollback limits explicitly. Do not infer a historical change list from the current code snapshot alone.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/contracts/failure-record.ts -->
<!-- Source: src/services/failure-notice.ts -->
<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

## First release pending — 2026-08-26

**No release has shipped, and this is a dated statement rather than an empty section**
(`FR-R3-101`, FR-030). `release.yml` never ran: no `v*` tag was ever pushed, and the workflow
itself was deleted on 2026-08-26 when Actions were retired by operator decision
([terminal record](../release/actions-terminal-record.md)). So there are no operator-visible
changes to record because there has been no version for an operator to be visible to.

**Owner**: the repository operator, who is the only party who can cut a release.

**What must happen before the first entry exists**: a release goes out through the local path —
`npm run gate:record` then `npm run release`, which refuses unless a recorded gate PASS names
`HEAD` over a clean tree ([`RELEASE.md` §2a](../../RELEASE.md)). At that point this section is
replaced by a `## v<version>` heading with evidence-backed additions, changes, fixes, removals,
migration effects and security notes.

**Two limits worth stating now rather than discovering at release time**: the local path emits
**no SBOM and no attestation** — those were `release.yml`'s, and they went with it; and
verification is single-platform, single-machine, permanently, since the three-OS matrix is gone.
