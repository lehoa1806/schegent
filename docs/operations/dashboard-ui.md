# Dashboard UI

Open the Dashboard with `Schegent: Open Dashboard` (`schegent.openDashboard`). Schegent keeps a single `schegent.dashboard` panel: invoking the command again reveals the existing panel instead of creating a second one. A workspace folder is required.

<!-- Source: package.json -->
<!-- Source: src/commands/open-dashboard.ts -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->

## Routes

| Label | Route | Main purpose |
|---|---|---|
| Queues | `operations` | Queue overview, Queue detail, and Run detail drill-down |
| Runs | `runs` | Run composition and connected Workflow Runs |
| History | `history` | Terminal Run records and rerun entry points |
| Metrics | `metrics` | Projected operational metrics |
| System Log | `system` | System-scoped projected log and audit events |
| Builder | `builder` | Phase, Pipeline, and Workflow catalog authoring |
| Settings | `settings` | General, model, backend, and product settings surfaces |

<!-- Source: webview-ui/src/dashboard/routes.ts -->
<!-- Source: webview-ui/src/dashboard/route-loader.ts -->

`operations` is the default route. Queue detail and Run detail are nested locations rather than top-level navigation entries; Back moves Run → Queue → all Queues.

<!-- Source: webview-ui/src/dashboard/routes.ts -->

## State and commands

The host sends the same `WorkflowSnapshot` projection used by the sidebar. The panel retains the latest snapshot and posts it only while visible. The header reports either `Workspace Connected` or `Read-only Window` from the snapshot's primacy flag.

<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: src/ui/sidebar/state-projector.ts -->
<!-- Source: webview-ui/src/dashboard/App.svelte -->

Every inbound Dashboard message passes through `validateInboundMessage` before it reaches the shared command router. Invalid messages are logged and dropped. Mutating commands then receive the router's workspace-trust and authoritative-window gates; the webview is not an authority boundary by itself.

<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->

The panel permits scripts but restricts local resources to the built webview bundle and extension resources. Its generated content-security policy denies network connections with `connect-src 'none'`.

<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: src/ui/dashboard/dashboard-html.ts -->
<!-- Source: src/ui/sidebar/csp.ts -->

If the Dashboard remains on its loading state, the host has not delivered the first state snapshot. Check the sanitized runtime log for projection or post-message failures; do not interpret the loading skeleton as an empty Queue.

<!-- Source: webview-ui/src/dashboard/App.svelte -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
