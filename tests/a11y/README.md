# `tests/a11y/` — the automated accessibility scan

## The conformance target

**WCAG 2.1 Level AA**, over every shipped dashboard route in every shipped theme.

The level is not chosen freshly here. The product already claims AA in `PRODUCT.md` and
*"WCAG 2.1 AA minimum"* in `docs/prd-metrics-dashboard.md`; adopting 2.2 would raise the claim above
what the product states and create a third authority on one subject. 2.1 AA versions the vague
statement and makes the two agree — and `a11y-policy-parity.test.ts` is what keeps them agreeing.

## The surface

Seven routes plus the sidebar surface, × three themes = **24 combinations**.

- Routes come from `webview-ui/src/dashboard/routes.ts`, so a new route is a compile-time error here
  rather than a silently unscanned surface.
- Themes come from the visual suite's `ThemeName`: `light`, `dark`, `high-contrast`. Contrast
  findings are theme-specific and the product renders in the host's theme, so one theme is not a
  sample of three.
- The pages are served by `tests/visual/serve-built-webviews.mjs` — the harness the visual suite
  already uses. A second way to build and serve the app would be a second authority on how the app
  boots.

## An automated scan is not conformance

Automated tooling catches a minority of real barriers. This scan finds what a rule engine can see in
a rendered tree; it says nothing about whether a screen-reader user can complete a task. That is what
`docs/release/accessibility-at-matrix.md` is for, and where a platform is untested it is recorded as
untested rather than reported as met.

Reading a green scan as conformance would make this the same kind of false assurance the evaluation
corpus was before FR-R3-061 wrote its scope note.

## The baseline is a count **and** a list

`a11y-baseline.json` records each accepted finding by route, theme, rule id and selector. A count
alone can say something got worse; only a list can say **which** finding is new. That is the defect
`D5` found in the duplicate-authority gate and the one the webview lint baseline still had.

It ratchets in both directions: above the record is a regression, below it is a stale record that
must be rewritten in the same change.

## Exclusions are printed

Every excluded route carries a reason in the scan configuration, and the exclusion list is printed on
every run — including when it is empty. An undeclared limit gets read as full coverage.
