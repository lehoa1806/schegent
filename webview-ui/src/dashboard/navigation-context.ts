// FR-R4-F06 (FR-008; contract D, D5) -- the one navigation a launch surface may ask for.
//
// The launch notice tells an operator that an uncontained backend runs with their own
// authority and that the grant is theirs to revoke, and it offers a "Review in Settings"
// link. No route from a launch surface to Settings existed: route state is local to
// `App.svelte`, and `RouteOutlet` passes a route component only `{ snapshot }`. The grant
// controls themselves are already on the Settings route; the link only has to open them.
//
// A CONTEXT, NOT A COMMAND. The spec forbids a new command or acknowledgement (FR-008), and
// a command would also have to enter `MUTATING_COMMANDS` or be proven read-only (hard rules
// 11, 12). Opening a route changes no host state, so it is a webview-local act: `App.svelte`
// publishes this capability with `setContext`, and a surface that wants it reads it with
// `getContext`. Prop-drilling a `navigate` through `RouteOutlet` and `QueueTaskComposer` would have
// edited four components to reach one, and was rejected for that reason (research R9).
//
// The capability is never serialized, posted or persisted, and it names no setting key:
// `tests/lint/webview-posture-derivation.test.ts` forbids the grant key in webview code. When
// the context is absent, which is every mount outside the dashboard, the link is not rendered.

/** The context key `App.svelte` publishes under and a launch surface reads. */
export const DASHBOARD_NAVIGATION = Symbol('schegent.dashboard.navigation');

/** What a launch surface may ask the dashboard shell to do. */
export interface DashboardNavigation {
  /**
   * Open the Settings route on its General tab, with the Backend Health section in view.
   * Changes no host state and posts nothing.
   */
  readonly openBackendSettings: () => void;
}
