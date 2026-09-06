// FR-R3-169 — the build-time half of the CSP supply-chain policy.
//
// On 2026-05-10 this repository adopted a CSP supply-chain policy and chose
// ASSERT-BY-TEST over reject-at-build, on terms it stated plainly: *"The check
// runs unconditionally as part of `npm run ci` and `npm run ci:fast`. There is no
// opt-out."* It then named its enforcement mechanism — a test at
// `tests/unit/ui/sidebar/no-remote-refs.test.ts` — and named it as not yet
// existing. 118 days later it still did not. This module is its matcher.
//
// WHY SYNTAX AND NOT SUBSTRINGS. The obvious gate greps the bundle for `https://`.
// Measured on this tree, that finds SIXTEEN hits and not one of them is a
// reference: fifteen `https://svelte.dev/e/<code>` error-documentation links
// inside Svelte's runtime `throw new Error(...)` constructors, and one
// `http://www.w3.org/1999/xhtml` passed to `createElementNS`. A substring gate is
// red the day it is written and needs sixteen named allowances to go green — a
// list that churns with every framework upgrade, training its maintainer to edit
// a security gate until it passes. Matching REFERENCE POSITIONS instead needs
// zero allowances, which is why `no-remote-refs.test.ts` carries none.
//
// The same sweep also matched `//g,` — the tail of a JavaScript regex literal.
// Free-text scanning of minified output for `//` produces junk, so the
// protocol-relative form is recognised only inside the four reference positions
// below, never in running text.
//
// FOUR FORMS, NOT THE POLICY'S THREE. The policy enumerated `<script>`/`<link>`,
// CSS `@import`, and DYNAMIC `import()`. Measured, this bundle carries 8 dynamic
// import targets and 20 STATIC `import ... from` targets. Static import is how a
// `type="module"` bundle ordinarily loads code and is what a dependency's own
// `import` statement compiles to, so gating the dynamic form alone would gate the
// smaller hole. Covering both is a superset of the adopted policy, recorded in
// `specs/208-csp-no-remote-refs/research.md` R2 rather than taken silently.
//
// WHAT THIS DOES NOT CLAIM. It sees the EMITTED form. A dependency that
// concatenates (`import("htt" + "ps://...")`), encodes, or assembles a URL at
// runtime is not detected. The modelled threat is the policy's — a dependency that
// stages a remote URL into the bundle — not an adversary writing around a gate it
// knows about. An unstated limitation reads as a claim, so it is stated here, in
// the spec's non-claims, and in the contract.

/** One built webview file the gate read. */
export interface Artifact {
  /** Repo-relative, so the failure message is the same on every machine. */
  readonly path: string;
  readonly kind: 'html' | 'js' | 'css';
  readonly content: string;
}

/**
 * Which syntax matched.
 *
 * Carried rather than discarded because it is what makes the failure message say
 * *which kind* of load was staged, and what lets the floors count forms apart so
 * one broken extractor cannot hide behind three working ones.
 */
export type ReferenceForm =
  | 'html-script-source'
  | 'html-link-href'
  | 'css-import'
  | 'dynamic-import'
  | 'static-import';

/** One place an artifact asks the runtime to load something. */
export interface Reference {
  readonly path: string;
  readonly form: ReferenceForm;
  /** Verbatim. A normalised target is a target the maintainer cannot grep for. */
  readonly target: string;
}

export interface ScanResult {
  readonly artifacts: readonly Artifact[];
  /**
   * Every reference found, remote or not.
   *
   * Returned alongside `remote` because an empty `remote` is the pass condition
   * AND the vacuous-pass condition. An extractor that stopped matching yields
   * `remote: []` and `references: []`; a floor on the second is what tells the two
   * apart.
   */
  readonly references: readonly Reference[];
  readonly remote: readonly Reference[];
}

/**
 * Absolute (`https:`, `http:`) or protocol-relative (`//host/...`).
 *
 * A same-origin absolute path (`/x.js`) is neither relative nor remote and is NOT
 * matched: it names no remote host, so it is not the thing the supply-chain policy
 * is about. Vite emits none in this bundle — all 38 measured targets begin `./` or
 * `../` — so this is a boundary being stated, not a case being excused.
 */
const REMOTE = /^(?:https?:)?\/\//i;

/** Extensions the extractors understand. FR-020 asserts the bundle holds no others. */
export const COVERED_EXTENSIONS: readonly string[] = ['.html', '.js', '.css'];

// Floors, each measured on this tree at 2026-09-06 and set below it with headroom
// for legitimate refactoring. `expect(remote).toEqual([])` passes on a broken
// extractor, an empty walk and an empty bundle alike; these are what separate a
// clean bundle from no bundle. No floor is set for `css-import`, which measures
// zero — a floor on a class with no instances fails the day it is written, and
// that form is exercised by the in-memory fixtures instead.
/** Total artifacts read. Measured: 39. */
export const MIN_ARTIFACTS = 20;
/** HTML artifacts. Measured: 2 — `index.html`, `dashboard.html`. */
export const MIN_HTML = 2;
/** JavaScript artifacts. Measured: 21. */
export const MIN_JS = 10;
/** Stylesheets. Measured: 16. */
export const MIN_CSS = 5;
/** References of any form. Measured: 38. */
export const MIN_REFERENCES = 15;

/**
 * `<script … src="X">`. Any attribute order; `src` need not be last.
 *
 * `(?<![\w-])` rather than `\b` before the attribute name, for the reason given
 * at `KEYWORD` below: `\b` would let `data-src=` and `data-href=` match as the
 * real attributes, and a `data-*` attribute is inert content, not a fetch. This
 * bundle emits neither today, so the guard changes no current count; it is here
 * because the JS half proved that `\b` around a keyword is not a boundary.
 */
const HTML_SCRIPT_SRC = /<script\b[^>]*?(?<![\w-])src\s*=\s*(["'])(.*?)\1/gi;

/**
 * `<link … href="X">`, for EVERY `rel`.
 *
 * The policy enumerated `modulepreload`, `preload` and `stylesheet`, and this
 * bundle emits only the first two of those. Restricting to a `rel` allowlist would
 * change nothing today while leaving `rel="icon"`, `rel="preconnect"` and
 * `rel="manifest"` as positions a remote URL could sit in and be read straight
 * past. A `rel` allowlist is an exclusion pattern in standards-compliant clothing;
 * matching every `href` is a superset with a measured false-positive count of zero.
 */
const HTML_LINK_HREF = /<link\b[^>]*?(?<![\w-])href\s*=\s*(["'])(.*?)\1/gi;

/** `@import "X"`, `@import url("X")`, and `@import url(X)` unquoted. */
const CSS_IMPORT = /@import\s+(?:url\(\s*(["']?)([^"')]*)\1\s*\)|(["'])([^"']*)\3)/gi;

/**
 * A keyword boundary stricter than `\b`.
 *
 * `\b` is satisfied by a preceding quote, and that is not a hypothetical. This
 * app has `from`/`to` date filters and pipeline edges, so the minified bundle is
 * full of the STRING LITERAL `"from"` — and `\bfrom\s*(["'])` matches the `from`
 * inside it, takes the literal's own CLOSING quote as the opening quote of the
 * target, and captures everything up to the next quote. Measured on 2026-09-06
 * against the real bundle, `F("from",ee.currentTarget.value)),J("change"…` was
 * read as an import of `,ee.currentTarget.value)),J(`. Twelve of 97 apparent
 * references were this artefact; with the boundary corrected the bundle reports
 * 85, and every remaining target is a relative path.
 *
 * `\b` also treats `-` and `.` as boundaries. In HTML that is a live defect —
 * `data-src=` and `data-href=` match as the real attributes, and the fixtures in
 * `no-remote-refs.test.ts` show it. In JS it is not reachable today, because a
 * `-` or `.` before the keyword is always followed by `=` or `(` rather than the
 * quote these patterns require; the two characters stay in the class as a
 * boundary that is actually a boundary, not because a case was measured.
 *
 * None of those false targets is remote, so the gate's verdict was never wrong in
 * the direction that matters. Two things were: a reference COUNT mostly made of
 * noise cannot support a floor that claims the scanner read the bundle, and a
 * failure naming `,ee.currentTarget.value)),J(` as a reference sends a reader
 * looking for an import that does not exist. The count is load-bearing here —
 * FR-020 is the reason this file has one — so the boundary has to be real.
 */
const KEYWORD = '(?<![\\w$.\\-"\'])';

/** `import("X")` / `import('X')`. A non-literal argument is not a target this can read. */
const JS_DYNAMIC_IMPORT = new RegExp(`${KEYWORD}import\\s*\\(\\s*(["'])([^"']*)\\1\\s*\\)`, 'g');

/**
 * `import … from "X"` and `export … from "X"`.
 *
 * Keyed on `from` rather than on `import`, which catches the re-export form the
 * bundler emits heavily without a second pattern.
 */
const JS_FROM = new RegExp(`${KEYWORD}from\\s*(["'])([^"']*)\\1`, 'g');

/**
 * Bare `import "X"` — a side-effect import with no bindings.
 *
 * Cannot collide with `JS_DYNAMIC_IMPORT`: that form has `(` where this one
 * requires a quote.
 */
const JS_BARE_IMPORT = new RegExp(`${KEYWORD}import\\s*(["'])([^"']*)\\1`, 'g');

/**
 * One capture group, typed as what a regex match actually yields.
 *
 * TypeScript models a match as `string[]`, so `match[4]` reads as `string` and any
 * fallback for it reads as dead code — `@typescript-eslint/no-unnecessary-condition`
 * says so, and given that type it is right. The type is what is wrong: a group that
 * did not participate in the match is `undefined` at runtime, which is not
 * hypothetical here because `CSS_IMPORT` is an alternation where exactly one arm
 * participates and the other arm's group is always absent. Reading through a
 * signature that admits `undefined` makes the `??` chains below real fallbacks
 * instead of guards the linter has to be argued out of.
 *
 * `readonly (string | undefined)[]` rather than a cast: `RegExpMatchArray` is
 * assignable to it, so nothing is asserted, only stated less confidently than the
 * lib does.
 */
function captured(match: readonly (string | undefined)[], index: number): string | undefined {
  return match[index];
}

/** Every capture-2 match of `pattern` in `content`, as references of `form`. */
function collect(
  path: string,
  content: string,
  pattern: RegExp,
  form: ReferenceForm,
  group = 2
): Reference[] {
  const out: Reference[] = [];
  for (const match of content.matchAll(pattern)) {
    const target = captured(match, group) ?? '';
    if (target !== '') out.push({ path, form, target });
  }
  return out;
}

/** `<script src>` and `<link href>`, for any `rel`. */
export function extractHtmlReferences(path: string, content: string): Reference[] {
  return [
    ...collect(path, content, HTML_SCRIPT_SRC, 'html-script-source'),
    ...collect(path, content, HTML_LINK_HREF, 'html-link-href')
  ];
}

/** `@import`, in all three spellings. `url()` outside `@import` is not a module reference. */
export function extractCssReferences(path: string, content: string): Reference[] {
  const out: Reference[] = [];
  for (const match of content.matchAll(CSS_IMPORT)) {
    // Two alternatives, so the target is in group 2 (the `url(...)` arm) or group
    // 4 (the bare-string arm); exactly one of them participates per match, and the
    // other is the `undefined` `captured` exists to keep visible.
    const target = captured(match, 2) ?? captured(match, 4) ?? '';
    if (target !== '') out.push({ path, form: 'css-import', target });
  }
  return out;
}

/** Dynamic `import()`, static `import`/`export … from`, and bare `import "…"`. */
export function extractJsReferences(path: string, content: string): Reference[] {
  return [
    ...collect(path, content, JS_DYNAMIC_IMPORT, 'dynamic-import'),
    ...collect(path, content, JS_FROM, 'static-import'),
    ...collect(path, content, JS_BARE_IMPORT, 'static-import')
  ];
}

/** True when a target names a remote host. See `REMOTE`. */
export function isRemote(target: string): boolean {
  return REMOTE.test(target);
}

/**
 * Pure. No filesystem, no network, no clock, no environment.
 *
 * That is what makes the in-memory fixtures in `no-remote-refs.test.ts` a test of
 * the gate's own logic rather than of a parallel implementation, and it is why the
 * gate needs no configurable bundle root — a root that can be pointed somewhere
 * harmless is the opt-out FR-008 forbids, wearing a different hat.
 */
export function scanArtifacts(artifacts: readonly Artifact[]): ScanResult {
  const references: Reference[] = [];
  for (const artifact of artifacts) {
    const { path, kind, content } = artifact;
    if (kind === 'html') references.push(...extractHtmlReferences(path, content));
    else if (kind === 'css') references.push(...extractCssReferences(path, content));
    else references.push(...extractJsReferences(path, content));
  }
  return { artifacts, references, remote: references.filter((ref) => isRemote(ref.target)) };
}

/** `path (form): target` — the one rendering both the message and the evidence use. */
export function renderReference(reference: Reference): string {
  return `${reference.path} (${reference.form}): ${reference.target}`;
}
