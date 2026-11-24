# Change Review & Execution Visibility (`FR-R6-F12`)

**Declared**: 2026-11-11 (`specs/311-change-review-visibility/spec.md`) | **Reconciled**: 2026-11-23 (`specs/331-feature-hardening-310-314/spec.md`)

This guide is for an operator who inspects execution visibility (attempts, evidence availability,
live-log coverage, recovery posture, normalized ACP activity, and phase handoffs) and reviews the
change set of an `FR-R6-F10` integration request before approving or landing it. A review compares
the request's candidate commit with the target commit the request was frozen against. It lists
every changed path once, shows each side's committed text or a fixed placeholder, and states
whether the review still matches the request.

A review never approves, lands, changes a request, or writes to the repository. Its approval and
landing eligibility are display only; the F10 operations keep their own host checks.

Implemented in:
- [`src/contracts/change-review.ts`](../../src/contracts/change-review.ts)
- [`src/contracts/sidebar-ipc/execution-visibility.ts`](../../src/contracts/sidebar-ipc/execution-visibility.ts)
- [`src/services/change-review/index.ts`](../../src/services/change-review/index.ts)
- [`src/headless/change-review-api.ts`](../../src/headless/change-review-api.ts)
- [`src/headless/execution-visibility-api.ts`](../../src/headless/execution-visibility-api.ts)
- [`src/ui/change-review/review-editor-binding.ts`](../../src/ui/change-review/review-editor-binding.ts) and [`review-opener.ts`](../../src/ui/change-review/review-opener.ts)
- [`src/ui/sidebar/commands/cmd-open-change-review.ts`](../../src/ui/sidebar/commands/cmd-open-change-review.ts) and [`cmd-read-execution-visibility.ts`](../../src/ui/sidebar/commands/cmd-read-execution-visibility.ts)
- [`src/activation/round6-visibility-wiring.ts`](../../src/activation/round6-visibility-wiring.ts) and [`sidebar-router-wiring.ts`](../../src/activation/sidebar-router-wiring.ts)
- [`webview-ui/src/lib/execution-visibility-ipc.ts`](../../webview-ui/src/lib/execution-visibility-ipc.ts)
- [`webview-ui/src/components/ExecutionVisibilityPanel.svelte`](../../webview-ui/src/components/ExecutionVisibilityPanel.svelte), [`ChangeReviewPanel.svelte`](../../webview-ui/src/components/ChangeReviewPanel.svelte), [`drilldown/RunDetailTier.svelte`](../../webview-ui/src/components/drilldown/RunDetailTier.svelte), and [`HistoryRunDetail.svelte`](../../webview-ui/src/components/HistoryRunDetail.svelte)

## Production status

Host activation wires both execution visibility and immutable candidate change review through
`createRound6VisibilityWiring` (`src/activation/round6-visibility-wiring.ts`) and `MessageRouter`
(`src/activation/sidebar-router-wiring.ts`):

- **Execution visibility (`CMD_READ_EXECUTION_VISIBILITY`)**: read-only webview IPC backed by
  `createExecutionVisibilityApi`. Mounted in active Task and connected Workflow drill-downs
  (`RunDetailTier.svelte`, passing `inFlightRun.runId` for active Tasks and `connectedRun.connectedRunId`
  for connected Workflows) and in historical run details (`HistoryRunDetail.svelte`, propagating
  live window primacy rather than hardcoding primary). Supports stable `rootExecutionId`,
  `invocationId`, and `attemptId` scoping, exact `:`-delimited `live_log_streams` matching without
  SQL `LIKE` wildcards, non-numeric availability phrasing (`F12-FR-03`), hide/reveal
  resynchronisation (`document.visibilitychange` and `snapshotStore.resyncCount`), monotonic
  stale-response guards, and normalized ACP runtime posture derived from durable
  `acp_observation_ledger` lifecycle records (`permission-requested`, `permission-resolved`,
  `turn-canceled`, `turn-uncertain`, `transport-disconnected`, `turn-started`, `turn-completed`,
  `display:*`, `usage`) correlated with `acp_authorization_receipts`.
- **Candidate change review (`CMD_OPEN_CHANGE_REVIEW`)**: registered in `MessageRouter` as
  `gatedConcurrent` (not a separate VS Code Command Palette command). Registers the read-only
  `schegent-review` `TextDocumentContentProvider` and opens either native `vscode.changes` or
  single-diff `vscode.diff` fallback. Exposes `open`, `refresh`, `classify`, `page`, `close`, and
  `cancelOpen` via `ChangeReviewPanel.svelte` with monotonic stale-response guards, hide/reveal
  freshness re-checks, keyboard-scrollable file lists, and explicit secondary-window read-only
  explanations.

### Trust and primacy boundary (sidebar IPC vs headless port)

- **Headless `ChangeReviewApi`**: every operation that reads (`openReview`, `readPage`,
  `classifyReview`, `refreshReview`) is refused `workspace-untrusted` while the workspace is
  untrusted. `closeReview` and `cancelOpen` only release host memory and remain permitted when
  untrusted.
- **Sidebar IPC (`CMD_OPEN_CHANGE_REVIEW`) & host wiring**: `CMD_OPEN_CHANGE_REVIEW` stays
  classified as `gatedConcurrent` so mutating/Git-spawning webview commands fail closed when a
  workspace is untrusted (`untrusted-workspace`) or a window is secondary
  (`secondary-window-readonly`). To ensure active leases never linger when workspace trust or
  window primacy drops mid-session, `round6-visibility-wiring.ts` tracks active review IDs and
  invokes `closeAllActiveReviews()` automatically on trust loss, primacy loss, or wiring disposal,
  while `dynamicChangeReviewService.readContent` re-checks live trust and primacy on every read
  and returns `placeholderRead('unavailable')` for any already-minted document handle.

## States

| State | Meaning |
|-------|---------|
| `current` | The review matches its request and the target tip. Eligibility is computed. |
| `stale` | The review no longer matches. It stays readable; nothing is eligible. |
| `uncertain` | The target tip, the request or its receipt could not be read, so the match could not be checked. Nothing is eligible. |
| `unavailable` | No review could be built. No partial list is ever shown. |

The first matching rule decides the state:

| Order | Condition | State and reason |
|-------|-----------|------------------|
| 0 | The request or its receipt could not be read from the store. | `uncertain`, `record-unreadable` |
| 1 | The request is gone, `landed` or `canceled`. | `stale`, `request-closed` |
| 2 | The request's candidate commit changed, or it was frozen again. | `stale`, `candidate-changed` |
| 3 | The request's target ref or frozen target commit changed. | `stale`, `target-advanced` |
| 4 | The request's profile revision or digest changed. | `stale`, `profile-changed` |
| 5 | The target tip could not be read. | `uncertain`, `target-unreadable` |
| 6 | The target tip moved past the frozen commit. | `stale`, `target-advanced` |
| 7 | None of the above. | `current` |

A review cannot be built (`unavailable`) when the request record is malformed (`record-invalid`),
the store cannot read the request (`record-unreadable`), a commit is not in the repository
(`commit-missing`), the target is no longer an ancestor of the candidate (`target-diverged`), the
change listing fails (`inventory-failed`), exceeds its 10-second deadline (`inventory-deadline`),
or produces more than 16 MiB of output (`inventory-oversized`).

A stale review keeps reading the content it was built from. Refreshing it builds a new review
with a new id; the old one stays open until it is closed or evicted.

## Eligibility

| Operation | Not eligible when | Reason |
|-----------|-------------------|--------|
| Approval | the review is not `current` | `review-not-current` |
| | the request is not `awaiting-review` | `request-state` |
| | a review receipt already exists | `already-approved` |
| Landing | the review is not `current` | `review-not-current` |
| | the request is not `awaiting-review` | `request-state` |
| | no review receipt exists | `receipt-missing` |
| | the receipt does not match the request | `receipt-mismatch` |
| | the receipt already has an outcome | `receipt-settled` |

## Change kinds

Every changed path appears once, in a stable order, with one of six kinds: `added`, `modified`,
`deleted`, `renamed` (with its similarity), `type-changed` (for example a file replaced by a
symbolic link) and `submodule`. A binary file keeps its kind and is marked binary. A side that
does not exist (the old side of an added file, the new side of a deleted one) has no handle.

## Bounds

| Bound | Value |
|-------|-------|
| Entries per page | 200 |
| Entries loaded per review | 1,000; the total is still reported and the review is marked truncated |
| Bytes shown per side | 1 MiB |
| Open reviews held | 8; opening a ninth evicts the oldest |
| Change listing output | 16 MiB |
| Git deadline per read | 10 seconds |
| Display name | 120 characters |
| Page cursor | 128 characters |

Measured first page of a generated **1,050-file** Git candidate repository through real Git:
p95 122.24 ms against a 500 ms budget (`tests/perf/change-review-first-page.test.ts`; 3 warm-up
and 20 measured takes, bounding loaded entries to 1,000 across five 200-entry pages). Because the
F03 reference workloads contained no Git integration candidate repository, NFR-002 is measured on
this dedicated 1,050-file generated Git candidate fixture rather than an F03 workload bundle.

## Placeholders

A side that cannot show its text shows one fixed sentence instead:

| Reason | Sentence |
|--------|----------|
| `binary` | Binary content is not shown. |
| `oversized` | This file is larger than 1 MiB and is not shown. |
| `submodule` | Submodule entry: there is no file content to show. |
| `missing` | This content is no longer in the repository. |
| `unavailable` | This review has been closed or replaced. Open the review again. |
| `read-failed` | This content could not be read. |

## Opening a review in the editor

When the editor offers a multi-file changes view, the review opens there with every loaded entry
in index order. Otherwise the fallback shows a fixed notice that gives counts and names no path,
then a pick list of the entries, then one diff for the picked entry. An `unavailable` review
opens nothing.

Every path is shown inert: bidirectional and control characters become a replacement character,
and a pick label cannot form an icon. A document address carries only an opaque content handle
and the inert display name, never a repository path.

## Headless port

`createChangeReviewApi(service, { isWorkspaceTrusted })` offers `openReview`, `readPage`,
`classifyReview`, `refreshReview`, `closeReview` and `cancelOpen`.

- Every input is checked for its exact keys and each value's grammar first. Anything else,
  including a path, a URI or markup, is refused `invalid-input` before any store or Git read.
- Every operation that reads is refused `workspace-untrusted` while the workspace is untrusted.
  `closeReview` and `cancelOpen` only release memory and work regardless.
- `openReview` and `refreshReview` share one view. A second call supersedes the first, which
  answers `superseded` at once; `cancelOpen` answers `canceled` without waiting for a pending
  Git read. A result that arrives after either is dropped.

## Qualification scope and remaining limits

- **Editor and platform coverage**: Real Extension Host tests (`tests/integration/change-review-native.host.test.ts`)
  exercise a 3-file Git fixture (`deleted`, `modified`, `added`) across both the native
  `vscode.changes` multi-file view and the `vscode.diff` single-file fallback (by wrapping
  `createVscodeEditorPort()` with `hasCommand: () => false`) on the minimum supported editor floor
  (`VS Code 1.107.0`) on one local `darwin/arm64` machine. This provides single-platform risk
  reduction; newer/current VS Code releases, Linux, and Windows hosts remain unobserved.
- **Performance fixture scope**: `NFR-002` first-page latency (p95 122.24 ms vs 500 ms target) is
  measured on the generated 1,050-file Git candidate fixture (`tests/perf/change-review-first-page.test.ts`),
  because F03 reference workloads did not include a Git integration candidate.
- **Accessibility and assistive technology (WCAG 2.2 AA)**: Automated Playwright axe, keyboard,
  focus-order, and live-region checks cover `ExecutionVisibilityPanel` and `ChangeReviewPanel`,
  while human assistive-technology screen-reader observations (VoiceOver, NVDA, JAWS) remain
  `UNTESTED` / `not observed`. Human AT procedures and status are tracked in
  [`docs/release/accessibility-at-matrix.md`](../release/accessibility-at-matrix.md) and
  [`docs/operations/interactive-verification-register.md`](interactive-verification-register.md).
