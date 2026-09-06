# The CSP supply-chain policy: what it decided, and what enforces it

**Decided**: 2026-05-10 (`007-principal-review-remediation`, FR-042) ·
**Enforced**: 2026-09-06 (`FR-R3-169`, T1730) ·
**Gates**: `repo/tests/unit/ui/sidebar/no-remote-refs.test.ts` is the assertion the policy chose;
`repo/tests/lint/webview-build-precedes-host-suite.test.ts` is why it has a bundle to read;
`repo/tests/lint/dated-review-records.test.ts` reads the date below.

<!-- csp-supply-chain-review-date: 2027-03-06 -->

The policy was adopted on 2026-05-10 and its build-time half was not written until 2026-09-06. The
runtime half — the CSP the webview is served under — went in with the decision and has been live and
tested since. This record exists because the retired policy document was a plan, and a plan is not a
control. What follows is the decision, the thing that now enforces it, and the conditions under
which it should be revisited.

<!-- Source: src/ui/sidebar/csp.ts -->

## The decision, and why that option

Three options were considered: **reject-at-build**, **assert-by-test**, **accept-with-rationale**.
Assert-by-test was chosen, because the assertion is the same shape as the existing CSP tests, its
failure is a readable vitest message naming the offending file, it runs unconditionally in
`npm run ci` and `ci:fast` with no opt-out, and tightening to reject-at-build later is a strict
refinement that keeps the assertion as a backstop.

Accept-with-rationale was rejected because Schegent needs no remote asset and the threat model
treats the webview as a sandboxed view over local data. Reject-at-build was deferred, not dismissed;
it is reversal condition 3 below.

The build-time check exists because the runtime CSP denies a remote fetch **silently**. A malicious
or careless dependency that stages a remote URL produces a blank pane and a console entry nobody is
watching, rather than a red build. The two halves fail in different places on purpose.

## What the gate asserts, and why it matches syntax rather than URLs

The gate walks the built bundle at `dist/webview` and extracts every **reference** — a position from
which a client would fetch something. It then fails if any target is absolute (`https:`, `http:`, or
protocol-relative `//`). Measured on 2026-09-06: 39 artifacts (21 JS, 16 CSS, 2 HTML), 85 references,
**0 remote**.

**It matches reference syntax, not URL substrings, and that is the load-bearing choice.** The same
bundle contains 16 absolute-URL string literals, and every one is benign: 15 Svelte runtime
error-documentation links baked into thrown `Error` messages, plus the XHTML namespace URI passed to
`createElementNS`. A gate that searched for `https://` would have to carry 16 named allowances on the
day it was written, and the policy's own rule is that a named literal with a reason is a decision
while a regex exclusion is a hole. A gate that asks *"is this a script `src`, a link `href`, a CSS
`@import`, or a JS import?"* needs zero allowances, because none of those 16 sit in one of those
positions.

**Four reference forms are matched, not the policy's three.** The adopted text enumerated HTML
`src`/`href`, CSS `@import` and dynamic `import()`. It omitted static `import … from` and the
re-export `export … from`, which is 67 of the bundle's 85 references against dynamic `import()`'s 8.
Implementing the enumeration as written would have produced a gate that read a fifth of what it
claimed to.

**The floors are part of the assertion.** `expect(remote).toEqual([])` passes just as cheerfully
against an empty directory, so the gate separately asserts a minimum artifact count, a minimum count
per file kind, a minimum reference count, and that no artifact carries an extension the matcher
cannot read. A bundle that is absent, truncated, or has grown a new asset type is a red build with a
message that says which, rather than a green one that read nothing.

<!-- Source: tests/unit/ui/sidebar/no-remote-refs.test.ts -->
<!-- Source: tests/lint/webview-build-precedes-host-suite.test.ts -->

## What would reverse this

The three conditions the policy recorded, unchanged. Any one of them, and the decision above is
re-taken rather than inherited:

1. **A feature genuinely requiring a remote font, stylesheet or script.** The reviewer must update
   the policy and the runtime CSP in lockstep.
2. **The webview leaving VS Code's `vscode-webview://` origin.** `cspSource` semantics change and the
   directive table must be re-derived.
3. **A maintained reject-at-build Vite plugin making the stricter option cheap.** The assertion then
   becomes the backstop and reject-at-build becomes primary.

## Out of scope, and staying so

**Subresource Integrity**: every bundled asset is local, so there is no remote source to
integrity-check. Adding SRI would be ceremony over same-origin files. **CSP for the Speckit hooks**:
owned by [the operator threat model](threat-model.md). **The npm supply chain**: owned by
`npm audit`. This gate is about what the build *emits*, not about what produced it.

## What this record cannot see

The gate reads reference syntax in built artifacts. That is a narrow thing to be able to see, and
naming the edges matters more than the coverage does:

- **A fetch assembled at runtime.** A dependency that builds a URL by concatenation, or calls
  `fetch()` with a computed argument, emits no reference this gate can match. That case belongs to
  `connect-src 'none'` in the runtime CSP — a different mechanism, tested elsewhere, and deliberately
  not restated here. Conflating the build-time and runtime halves is how the build-time half went
  unwritten for four months.
- **Whether the runtime CSP still denies what it denied.** This gate asserts nothing about the CSP
  header, by requirement. If the directive table were weakened tomorrow, nothing in this file would
  notice.
- **A maintained reject-at-build Vite plugin appearing.** Reversal condition 3 is a fact about the
  npm ecosystem. No gate in a repository can observe it; the review date below is the only mechanism
  that makes anyone look.
- **What a new asset type means.** If the build starts emitting an extension outside `.html`, `.js`
  and `.css`, the gate fails and names it — but it can only report the extension, not decide whether
  that file can reference anything. A human extends the matcher or records why it need not be.
- **Obfuscation.** A reference deliberately hidden from a regex will not be found. This gate is aimed
  at a dependency that adds a CDN link, which is the realistic supply-chain shape, and not at an
  adversary who already has commit access to the bundle.

**This record is reviewed on or before 2027-03-06**, and
`repo/tests/lint/dated-review-records.test.ts` fails from that day until someone re-reads it. Six
months, matching the horizon the other event-triggered declines in this repository carry: nothing
here changes on its own, and all three reversal conditions are events rather than dates.

The gate watches the **date**. It cannot see a Vite plugin being published, a designer asking for a
web font, or the webview being ported off `vscode-webview://`. Saying so is the point — a record
that implied its gate watched all three conditions would be the same overclaim as a policy that
implied it was enforced.

The retired policy text, and the audit trail for why it sat half-built, are in
[the round-3 index](../../../docs/features/round_3/INDEX.md) under `csp-supply-chain-policy`.
