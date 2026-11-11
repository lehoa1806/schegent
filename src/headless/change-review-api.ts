// FR-R6-F12 (contracts/change-review.md section 1; FR-013, FR-016, SC-005, NFR-005) — the headless
// change review port.
//
// Every operation checks its exact key set and each value's grammar before the service sees it,
// and refuses `invalid-input` otherwise, so a path, a URI, markup or any other hostile text never
// reaches a store or Git read. Shape comes first, trust second: every operation that reads is
// refused `workspace-untrusted` while the injected check says no; `closeReview` and `cancelOpen`
// only release host memory and work regardless. Trust is read at each call.
//
// `openReview` and `refreshReview` share one view: a second call supersedes the first, which
// resolves `superseded` at once, and `cancelOpen` answers without waiting for a pending Git read.
// No operation approves, lands or changes a request. This module imports no editor host API
// (rule 13). It performs no I/O of its own.

import {
  reviewOk,
  reviewRefused,
  type ReviewDescriptor,
  type ReviewOpened,
  type ReviewPage,
  type ReviewResult
} from '../contracts/change-review';
import { createViewRequestGate, type ChangeReviewService } from '../services/change-review/index';

export interface ChangeReviewApiOptions {
  /** Whether the workspace is trusted now; read at each call that reads. */
  readonly isWorkspaceTrusted: () => boolean;
}

export interface ChangeReviewApi {
  openReview(input: unknown): Promise<ReviewResult<ReviewOpened>>;
  readPage(input: unknown): ReviewResult<ReviewPage>;
  classifyReview(input: unknown): Promise<ReviewResult<ReviewDescriptor>>;
  refreshReview(input: unknown): Promise<ReviewResult<ReviewOpened>>;
  closeReview(input: unknown): ReviewResult<{ readonly closed: boolean }>;
  cancelOpen(input: unknown): ReviewResult<{ readonly canceled: boolean }>;
}

type Shape = Readonly<Record<string, (value: unknown) => boolean>>;

const REVIEW_VIEW = 'change-review';
const INVALID = reviewRefused('invalid-input');
const UNTRUSTED = reviewRefused('workspace-untrusted');

const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const REVISION_PATTERN = /^cr1-[0-9a-f]{64}$/;
const REVIEW_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const matching =
  (pattern: RegExp) =>
  (value: unknown): boolean =>
    typeof value === 'string' && pattern.test(value);

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

/** True when `input` holds every required key, only known keys, and each value fits its check. */
function fits(input: unknown, required: Shape, optional: Shape = {}): input is Record<string, unknown> {
  if (!isPlainRecord(input)) return false;
  for (const key of Object.keys(required)) {
    if (!Object.hasOwn(input, key)) return false;
  }
  return Object.entries(input).every(([key, value]) => {
    const check = Object.hasOwn(required, key) ? required[key] : Object.hasOwn(optional, key) ? optional[key] : undefined;
    return check !== undefined && check(value);
  });
}

const OPEN_REQUIRED: Shape = Object.freeze({ requestId: matching(REQUEST_ID_PATTERN) });
const OPEN_OPTIONAL: Shape = Object.freeze({ expectedRevision: matching(REVISION_PATTERN) });
const REVIEW_SHAPE: Shape = Object.freeze({ reviewId: matching(REVIEW_ID_PATTERN) });
const CURSOR_SHAPE: Shape = Object.freeze({ cursor: matching(CURSOR_PATTERN) });

interface OpenInput {
  readonly requestId: string;
  readonly expectedRevision?: string;
}

const isOpen = (input: unknown): input is OpenInput => fits(input, OPEN_REQUIRED, OPEN_OPTIONAL);
const isReview = (input: unknown): input is { readonly reviewId: string } => fits(input, REVIEW_SHAPE);
const isCursor = (input: unknown): input is { readonly cursor: string } => fits(input, CURSOR_SHAPE);
const isEmpty = (input: unknown): boolean => fits(input, {});

/** Creates the headless change review port over a change review service. */
export function createChangeReviewApi(service: ChangeReviewService, options: ChangeReviewApiOptions): ChangeReviewApi {
  const gate = createViewRequestGate();

  function trusted<T>(run: () => ReviewResult<T>): ReviewResult<T> {
    return options.isWorkspaceTrusted() ? run() : UNTRUSTED;
  }

  function trustedAsync<T>(run: () => Promise<ReviewResult<T>>): Promise<ReviewResult<T>> {
    return options.isWorkspaceTrusted() ? run() : Promise.resolve(UNTRUSTED);
  }

  function inView(work: (signal: AbortSignal) => Promise<ReviewResult<ReviewOpened>>): Promise<ReviewResult<ReviewOpened>> {
    return gate.run(gate.begin(REVIEW_VIEW), work);
  }

  return {
    openReview: (input) => {
      if (!isOpen(input)) return Promise.resolve(INVALID);
      const request = { requestId: input.requestId, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) };
      return trustedAsync(() => inView((signal) => service.openReview(request, signal)));
    },
    readPage: (input) => (isCursor(input) ? trusted(() => service.readPage(input.cursor)) : INVALID),
    classifyReview: (input) => (isReview(input) ? trustedAsync(() => service.classifyReview(input.reviewId)) : Promise.resolve(INVALID)),
    refreshReview: (input) => {
      if (!isReview(input)) return Promise.resolve(INVALID);
      return trustedAsync(() => inView((signal) => service.refreshReview(input.reviewId, signal)));
    },
    closeReview: (input) => (isReview(input) ? reviewOk(service.closeReview(input.reviewId)) : INVALID),
    cancelOpen: (input) => (isEmpty(input) ? reviewOk({ canceled: gate.cancel(REVIEW_VIEW) }) : INVALID)
  };
}
