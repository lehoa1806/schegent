# Diagnose built webview routes

Schegent serves the sidebar and dashboard from the compiled
`dist/webview/` tree. Diagnose route failures against that tree: editing Svelte
source does not change what VS Code, Playwright, or the package smoke test sees
until the webview is rebuilt.

<!-- Source: webview-ui/vite.config.ts -->
<!-- Source: src/ui/sidebar/sidebar-view-provider.ts -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->

## Establish a current artifact

Build both entry points, then run the browser route walk:

```bash
npm run build:webview
npm run test:visual
```

The webview build empties `dist/webview/`, emits `index.html` and
`dashboard.html`, emits stable entry names such as `index.js` and
`dashboard.js`, and places lazy JavaScript in `chunks/`. Its Vite base is `./`
so dynamically discovered route assets remain relative to the loaded module.
`test:visual` rebuilds the webview before starting Playwright.

<!-- Source: package.json -->
<!-- Source: webview-ui/vite.config.ts -->

Before packaging, `package:smoke` independently dates two build halves:
`dist/extension.js` against non-test files under `src/`, and the newest file
under `dist/webview/` against non-test files under `webview-ui/src/`. Missing,
unscannable, or older output is refused with the exact rebuild command. The
freshness check never repairs output itself.

<!-- Source: scripts/check-build-freshness.mjs -->
<!-- Source: scripts/package-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/build-freshness.test.ts -->

## Identify the failing layer

Use the first row whose observation matches:

| Observation | Likely layer | Next check |
| --- | --- | --- |
| `index.html`, `dashboard.html`, or an entry script is absent | Build output | Run `npm run build:webview`; inspect the Vite error rather than copying an old artifact. |
| HTML still contains local relative asset references in a VS Code webview | Host HTML rewriting | Exercise the sidebar/dashboard render integration tests. |
| Browser requests a chunk or stylesheet and receives 404 | Vite output/base or stale HTML | Confirm the referenced file exists under `dist/webview/` and that `base: './'` remains configured. |
| Route stays on its loading surface with no failed request | Import, mount, or render | Capture `pageerror` and `console.error`; a synchronous mount exception can leave previously rendered loading markup visible. |
| Route renders `dashboard-route-error` | Route outlet | Read the displayed error and test Retry; the outlet handles rejected imports and mount failures. |
| One declared route is never exercised | Browser coverage map | Run the visual-route coverage lint test and compare `DASHBOARD_ROUTES` with `ROUTE_MOUNT_TARGETS`. |

<!-- Source: webview-ui/src/dashboard/RouteOutlet.svelte -->
<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: tests/visual/webview.visual.spec.ts -->
<!-- Source: tests/lint/visual-route-coverage.test.ts -->

Do not infer that a dynamic import is pending merely because loading markup is
still present. The visual suite records both page exceptions and console errors
before asserting mount targets, which distinguishes network/load rejection from
a component that loaded and then threw during its first render.

<!-- Source: tests/visual/webview.visual.spec.ts -->
<!-- Source: webview-ui/src/dashboard/RouteOutlet.svelte -->

## Verify host URI rewriting

VS Code webviews cannot consume ordinary filesystem references directly. The
sidebar renderer reads `dist/webview/index.html`; the dashboard renderer reads
`dist/webview/dashboard.html`. Each replaces relative `src` and `href`
references with `webview.asWebviewUri(...)`, injects a CSP nonce, and removes
`crossorigin`, which is incompatible with the webview iframe. Production passes
real `vscode.Uri.file(...)` values rather than duck-typed filesystem objects.

<!-- Source: src/ui/sidebar/html.ts -->
<!-- Source: src/ui/dashboard/dashboard-html.ts -->
<!-- Source: src/ui/sidebar/sidebar-view-provider.ts -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->

Run focused route-host checks when this layer is suspect:

```bash
npx vitest run tests/integration/dashboard-render.test.ts
npx vitest run tests/integration/dashboard-activation.host.test.ts
npx vitest run tests/integration/sidebar-activation.host.test.ts
```

These tests check CSP presence, real-URI compatibility, rebased Vite assets,
shared chunks/styles, and the built entry content. A skipped built-file assertion
means the prerequisite bundle was absent; rebuild and rerun before treating the
test as evidence.

<!-- Source: tests/integration/dashboard-render.test.ts -->
<!-- Source: tests/integration/dashboard-activation.host.test.ts -->
<!-- Source: tests/integration/sidebar-activation.host.test.ts -->

## Inspect browser delivery

The visual harness serves only `dist/webview/` at `127.0.0.1:4173`, disables
cache, and returns 404 for missing files. Playwright opens `index.html` for the
sidebar and `dashboard.html` for dashboard surfaces. On failure, preserve the
trace, screenshot, console errors, page errors, and the request URL/status for
every entry, chunk, CSS file, and dynamically loaded route.

<!-- Source: tests/visual/serve-built-webviews.mjs -->
<!-- Source: playwright.config.ts -->
<!-- Source: tests/visual/webview.visual.spec.ts -->

For a route-specific failure, verify all of these in order:

1. The route appears in `DASHBOARD_ROUTES`.
2. Its navigation control is present and clickable.
3. Its emitted chunk is requested successfully.
4. No `pageerror` or `console.error` occurs during mount.
5. The route's unique `data-testid` mount target becomes visible.
6. The loading and error branches are no longer visible after success.

<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: tests/visual/webview.visual.spec.ts -->
<!-- Source: tests/lint/visual-route-coverage.test.ts -->

The route-coverage gate checks both directions: every declared route must have
a browser mount target, no target may name a retired route, and two routes may
not share one target. It also refuses an unparseable or empty route list rather
than passing vacuously.

<!-- Source: tests/lint/visual-route-coverage.test.ts -->

## Close the diagnosis

After correcting the responsible layer, rebuild from source and run:

```bash
npm run test:visual
npm run package:smoke
```

The first command proves real-browser route mounting against the new build.
The second proves both build halves are current and that the resulting VSIX
content satisfies the packaging policy. Do not update screenshot baselines to
hide a route that failed to mount; a baseline change is appropriate only after
the intended rendered change is understood and reviewed.

<!-- Source: package.json -->
<!-- Source: scripts/package-vsix-smoke.mjs -->
<!-- Source: playwright.config.ts -->
