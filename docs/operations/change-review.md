# Change Review (`FR-R6-F12`)

**Declared**: 2026-11-11 (`specs/311-change-review-visibility/spec.md`)

This guide is for an operator who reviews the change set of an `FR-R6-F10` integration request
before approving or landing it. A review compares the request's candidate commit with the target
commit the request was frozen against. It lists every changed path once, shows each side's
committed text or a fixed placeholder, and says whether the review still matches the request.

A review never approves, lands, changes a request or writes to the repository. Its approval and
landing eligibility are display only; the F10 operations keep their own checks.

Implemented in:
- [`src/contracts/change-review.ts`](../../src/contracts/change-review.ts)
- [`src/services/change-review/`](../../src/services/change-review/index.ts)
- [`src/headless/change-review-api.ts`](../../src/headless/change-review-api.ts)
- [`src/ui/change-review/`](../../src/ui/change-review/review-editor-binding.ts)

## Production status

The service, the headless port and the editor binding ship in this release. Nothing in
activation constructs them yet: the review reads requests from the F10 integration store, and
production does not open that store in the extension host (the F01-B cutover). The headless port
and the editor binding are the only entries, so a future surface cannot disagree with them.

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

Measured first page of a 1,050-file change set through real Git: p95 122.24 ms against a
500 ms budget (`tests/perf/change-review-first-page.test.ts`).

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

## Not in this release

- The execution drill-down (lanes, handoffs, live logs) and its navigation, hide and reveal
  resynchronisation, and keyboard and announcement rules (`F12-FR-01`, `02`, `10`, `11`, `12`).
  They need host projections the shipped extension does not construct (F01-B).
- Normalized runtime state (`F12-FR-17`), which depends on `FR-R6-F13`.
- The WCAG 2.2 AA journeys for new webview surfaces (`F12-NFR-04`). The review itself uses the
  editor's native diff, changes view, pick list and notifications, so it adds no custom widget.
