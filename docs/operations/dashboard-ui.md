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

The sidebar follows the same rule: it posts the state snapshot only while it is visible, and posts the current one once each time it is revealed, so a hidden sidebar does no snapshot work. Acknowledgements and every other message are posted as they always were. A projection that keeps failing, such as a catalog or the trust capabilities that cannot be resolved, is written to the sanitized runtime log once when the failure starts and not again until it recovers; the state itself is still projected on every change.

<!-- Source: src/ui/sidebar/sidebar-view-provider.ts -->
<!-- Source: src/ui/sidebar/projection-failure-episodes.ts -->

Every inbound Dashboard message passes through `validateInboundMessage` before it reaches the shared command router. Invalid messages are logged and dropped. Mutating commands then receive the router's workspace-trust and authoritative-window gates; the webview is not an authority boundary by itself.

<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: src/contracts/runtime-validators.ts -->
<!-- Source: src/ui/sidebar/message-router.ts -->

The panel permits scripts but restricts local resources to the built webview bundle and extension resources. Its generated content-security policy denies network connections with `connect-src 'none'` and sets `base-uri` and `form-action` to `'none'`.

<!-- Source: src/ui/dashboard/dashboard-panel.ts -->
<!-- Source: src/ui/dashboard/dashboard-html.ts -->
<!-- Source: src/ui/sidebar/csp.ts -->

If the Dashboard remains on its loading state, the host has not delivered the first state snapshot. Check the sanitized runtime log for projection or post-message failures; do not interpret the loading skeleton as an empty Queue.

<!-- Source: webview-ui/src/dashboard/App.svelte -->
<!-- Source: src/ui/dashboard/dashboard-panel.ts -->

## Phase log

The Activity Feed's live tail keeps at most 500 rows: the newest 499 entries and one marker that counts the entries it has dropped, the same shape a capped read has. Each field of each entry is capped at the live tail's per-field byte cap, so the memory the tail holds is bounded by its rows times that cap. While following, the newest entry stays in view. While paused (scrolled away from the bottom), the view is left where it is and the "new entries" count includes every entry that has arrived since, including entries the cap has since dropped.

<!-- Source: src/contracts/phase-log-bounds.ts -->
<!-- Source: webview-ui/src/lib/phase-log-window.ts -->
<!-- Source: webview-ui/src/components/PhaseLogFeed/PhaseLogReadingPane.svelte -->
<!-- Source: src/activation/phase-log-tail-wiring.ts -->

## Keyboard

The Run detail tabs (Phase log, Run outputs, Context) are one stop in the Tab order. Left and Right arrows move between them and wrap, Home and End go to the first and the last, and each tab names the panel it controls. Queue Settings keeps Tab inside its dialog: Tab on its last control goes to its first, Shift+Tab on its first goes to its last, and focus that is outside the dialog is pulled in. Escape and Cancel close it, and focus returns to the control that opened it or, when that control is no longer shown, to the Queues view.

<!-- Source: webview-ui/src/components/drilldown/RunDetailTier.svelte -->
<!-- Source: webview-ui/src/components/QueueConfigModal.svelte -->
<!-- Source: webview-ui/src/components/drilldown/QueuesTier.svelte -->
