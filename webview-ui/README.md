# Schegent Webview UI

Svelte 5 + Vite 7 app that renders both the Schegent **sidebar** and the **dashboard** inside VS Code webviews. A single Vite build produces two HTML entry points; the host's renderer wires each into its own webview panel.

## Ownership

| Surface | Entry | Purpose |
|---|---|---|
| Sidebar | `webview-ui/src/App.svelte` (mounted via `index.html`) | Compact, non-scrolling **status view** in the redesign's sidebar layout: a header with the connection dot, then four zones. Status Row ("Current run": status chip, feature, elapsed time, secondary-window badge), Stats Strip ("Progress": active phase line and step bar, done/pending/failed rows, stream pressure, health), Current Task ("Activity": freshness and the last run event, with the CLI monitor and process lines folded under "Process details"), and a single **Open Dashboard** button in the footer. |
| Dashboard | `webview-ui/src/dashboard/App.svelte` (mounted via `dashboard.html`; route components live under `webview-ui/src/components/`) | Full-window operator console: queue management across up to twenty queues, pending-task edit/reorder, history rerun, monitor tail, audit drill-in, controls (cancel / resume / retry-active-run), phase tiles. All previously-sidebar capabilities live here. Its `runs` route owns the **launch surface** — the one place a run is started (spec 102). |

The Dashboard's default route (`operations`) is itself three drill-down tiers (see "Drill-down locations under `operations`" below). Feature 097 deleted `Dashboard.svelte` and its subtree and redistributed its content: tier 2 (`drilldown/QueueDetailTier.svelte`) now owns the task list (`QueueDetailRows.svelte`), queue controls (`QueueControls.svelte`), the on-demand task composer, and the scheduled-start indicator (`QueueIdlePendingPanel.svelte`); tier 3 (`drilldown/RunDetailTier.svelte`) now owns a single run's phase progression, phase log feed, and outputs.

Both webviews subscribe to the same host `WorkflowSnapshot` projected by `src/ui/sidebar/state-projector.ts`. The dashboard renders the full operator surface; the sidebar projects a strict subset of the same `WorkflowSnapshot` (see `contracts/sidebar-view-contract.md` in the active spec for the testid contract).

## Layout

```
webview-ui/
├── src/
│   ├── App.svelte        — sidebar root (compact 4-zone layout)
│   ├── main.ts           — sidebar entry
│   ├── dashboard/        — dashboard entry, routes, and dashboard shell CSS
│   ├── components/       — shared Svelte 5 components (StatusBar, StatsStrip,
│   │                       CurrentTask, DashboardLink, plus dashboard-only:
│   │                       HistorySection, ConfirmDeleteDialog, etc.
│   │                       Feature 030 removed the multi-queue
│   │                       QueueManagementPanel and QueueDeleteModal
│   │                       surfaces; Feature 092 reinstated multi-queue
│   │                       operation as OperationsSurface + drilldown/,
│   │                       not by restoring either removed component.
│   │                       FR-R3-140 deleted PhaseTracker, ControlPanel,
│   │                       QueueList and MonitorPill, which this list still
│   │                       named after they had stopped being reachable
│   │                       from either entry point.)
│   │   ├── drilldown/    — QueuesTier / QueueDetailTier / RunDetailTier,
│   │   │                   the three tiers OperationsSurface routes between
│   │   └── Runs/         — the launch surface RunsSurface mounts: the two
│   │                       Launchable* components, WorkflowTriggerForm, and
│   │                       the pure launch-selection state (spec 102)
│   └── lib/
│       ├── derive-stats.ts — pure helper: deriveSidebarStats / deriveActivePhase
│       ├── deletion-confirmation.ts — status-aware destructive confirmation copy
│       ├── messages.ts   — re-exports from src/contracts/sidebar-ipc.ts
│       ├── snapshot-store.svelte.ts — latest WorkflowSnapshot + pending-correlation ids
│       ├── snapshot-types.ts — re-exports of host-projected types
│       ├── vscode-api.ts — typed postCommand / onHostMessage
│       ├── theme.css     — --schegent-* tokens with --vscode-* fallback
│       └── sg/           — redesign stylesheets, every rule scoped under .sg
│                           (see "Redesign design language")
├── index.html            — sidebar HTML shell (CSP placeholders)
└── dashboard.html        — dashboard HTML shell (CSP placeholders)
```

## Redesign design language

The two redesign mockups, `schegent_redesign_surfaces.html` and `workflow_builder_redesign.html`, are ported into the webview in three parts. The planning workspace keeps the mockups under its `docs/mockup/` directory.

- **Tokens**: the "Redesign tokens" section at the end of `webview-ui/src/lib/theme.css`.
- **Rules**: the stylesheets under `webview-ui/src/lib/sg/`.
- **Contract**: `webview-ui/src/lib/__tests__/sg-stylesheets.test.ts`, which checks the sheets, the entry points and the token section against the rules below.

Every rule sits under the class `sg`, and both shells carry it on their root element: `main.sg.sidebar` in `App.svelte` and `div.sg.dash` in `dashboard/App.svelte`. Inside either shell a component gets the sheets' element rules (headings, the focus ring, `summary`, `fieldset` and `legend`) and the tokens `.sg` redefines. It takes the rest of the design by using the mockups' class names.

### Scope and loading

On the element that carries it, `sg` does two things. It makes the rules in the `sg/` sheets apply to that subtree. It also gives that subtree the mockups' corner radii, control heights and type ramp, because the `.sg` rule in `theme.css` redefines those tokens. The same tokens keep the product's values at `:root`, so nothing outside an `sg` element changes. Content rendered outside the element, such as a popover appended to `document.body`, gets neither the rules nor the redefined values.

| Sheet | Holds | Loaded by |
|---|---|---|
| `sg-core.css` | The scope base, utilities, buttons, inputs, the segmented control, status chips and tags, the attention banner, kind icons and form primitives | Both entries |
| `sg-sidebar.css` | The sidebar frame, header, sections, progress bar, rows and footer | `webview-ui/src/main.ts` |
| `sg-pages.css` | The dashboard shell, page header, toolbar, tables, menus, cards, tabs and the detail drawer | `webview-ui/src/dashboard/main.ts` |
| `sg-run-detail.css` | The step list and the log of the run detail page | No importer yet |
| `sg-metrics.css` | Stat tiles, the bar chart and its tooltip | `webview-ui/src/components/MetricsDashboard/MetricsDashboard.svelte` |
| `sg-settings.css` | The settings navigation, the setting rows and the backend grid | `webview-ui/src/components/SettingsSurface.svelte` |
| `sg-builder.css` | The workflow list, editor header, palette, canvas, outline, inspector and step picker, and the phase editor form | `webview-ui/src/components/PipelineBuilder.svelte` |

The last four sheets are route sheets. Each is meant to be imported by the root component of the route that uses it, so that its bytes load with the route. The Metrics page imports `sg-metrics.css` this way, the Settings page `sg-settings.css` and the Builder `sg-builder.css`. The run page does not import `sg-run-detail.css`, for the reason given under "Run page" below.

A route sheet stays in the document once its route has loaded, so its rules also reach every page opened after it. For that reason `sg-builder.css` writes its rules for the badge, the note and the status line under the part that holds each one in the mockup (`.node .badge`, `.inspector .note` and `.editor .status-line`), because other pages use those class names for their own elements.

The contract test enforces these rules:

- **Every selector starts at `.sg`.** No rule can match outside the scope.
- **Colour comes only from `--schegent-*` tokens.** A sheet holds no raw colour and no `--vscode-*` variable, so `theme.css` stays the one place that reads a VS Code colour.
- **An entry imports its sheets before its component tree.** A scoped component selector and an `.sg .x` selector have the same specificity, so the later rule wins. With the sheets first, a component style wins a tie.
- **An entry never imports a route sheet.** `tests/unit/ui/sidebar/bundle-size.test.ts` caps the startup stylesheets.
- **No sheet name contains `dashboard`.** `webview-ui/vite.config.ts` emits any stylesheet whose source name contains that word as `dashboard.css`, and the packaging policy in `scripts/check-vsix-smoke.mjs` admits only the stylesheet names it expects.
- **`!important` appears once**, on the rule that keeps a `hidden` element hidden.

### Mockup variable to token

A sheet never reads a mockup variable. Each one maps to a token:

| Mockup variable | Token |
|---|---|
| `--vscode-editor-background` | `--schegent-bg` |
| `--vscode-foreground` | `--schegent-fg` |
| `--vscode-descriptionForeground`, `--idle` | `--schegent-muted-fg` |
| `--vscode-sideBar-background` | `--schegent-shell-bg` |
| `--vscode-editorWidget-background` | `--schegent-surface` |
| `--vscode-input-background` | `--schegent-input-bg`, with `--schegent-input-fg` and `--schegent-input-border` |
| `--vscode-list-hoverBackground` | `--schegent-list-hover` for a hover state, `--schegent-surface-subtle` for a static fill |
| `--vscode-list-activeSelectionBackground` | `--schegent-selection-bg`, always with `--schegent-selection-fg` |
| `--vscode-widget-border` | `--schegent-border` |
| `--vscode-button-background`, `-foreground`, `-hoverBackground` | `--schegent-button-bg`, `--schegent-button-fg`, `--schegent-button-hover` |
| `--vscode-button-secondaryBackground`, `-secondaryForeground` | `--schegent-button-secondary-bg`, `--schegent-button-secondary-fg` |
| `--vscode-focusBorder` | `--schegent-focus-border` |
| `--vscode-textLink-foreground` | `--schegent-link-fg` |
| `--ok`, `--err`, `--warn`, `--run`, and the builder's `--vscode-charts-green`, `-red`, `-yellow`, `-blue` | For a mark: `--schegent-color-completed`, `-error`, `-warning`, `-active`. For text: `--schegent-status-completed-text`, `-error-text`, `-warning-text`, `-active-text` |
| `--purple`, `--vscode-charts-purple` | `--schegent-color-workflow` for a mark, `--schegent-workflow-text` for text |
| `--series-1` | `--schegent-chart-series-1` |
| `--grid` | `--schegent-chart-grid` |
| `--canvas-dot` | `--schegent-canvas-dot` |
| `--shadow-pop` | `--schegent-shadow-popover` |
| `--font` | Inherited from `body`, which uses `--sch-font-primary` |
| `--mono` | `--schegent-mono-font` |
| `--radius`, `--radius-sm` | `--schegent-radius`, `--schegent-radius-sm`, with the mockups' values under `.sg` |
| Pixel font sizes | `--schegent-text-micro` to `--schegent-text-display`, in rem so that they follow `--vscode-font-size` |
| Pixel spacing | `--schegent-space-*`, including the half steps the port added |

The surfaces mockup also defines `--vscode-activityBar-background`. None of its rules reads it, so it has no token.

### Status colour

A status class such as `.s-ok` or `.run-fail` sets two things. `color` is a text colour that holds WCAG AA. `--sg-status-color` is the saturated colour, and the dot, icon or ring beside the text draws with it. The text never does. The text tokens follow `--schegent-error-text`: each mixes its saturated colour toward the foreground. The contract test reads the mix from `theme.css` and computes the contrast on each surface the sheets put status text on, for both mockup palettes.

### Where the port departs from the mockups

Each difference below is deliberate. Before restoring a mockup value, check the reason given with it.

Contrast and state:

- **Status text uses the mixed text token.** The saturated colours fall below 4.5:1 as small text on some of the surfaces. Marks keep the saturated colour.
- **A selected item sets the selection foreground with the selection background.** The mockups set only the background. Text and marks inside a selected row, step, option or navigation item inherit the selection foreground, because a status or link colour has no known contrast against a theme's selection background.
- **A selected table row does not change on hover.** In the mockups the hover background replaces the selection background.
- **The navigation count badge writes in `--schegent-bg`.** The mockups use white, which is below 4.5:1 on the dark palette's error colour.
- **`.kbd` has no opacity.** The mockup's opacity lowers the contrast of its text.
- **The focus ring is the product's**: 2px with a 2px offset, where the mockups draw 1px. It is inset on a control that fills a container which clips it.
- **A disabled `.btn` is dimmed like a disabled `.icon-btn`**, and the button hover rules skip a disabled button. The mockups style only the disabled icon button.
- **A menu item that is off stays in reach of the arrow keys.** It is off through `aria-disabled`, not `disabled`, so a keyboard user can land on it and read it, or the reason inside it. `SgMenu` refuses a click, Enter or Space on it before the item's own handler runs, and stays open. The item is drawn in `--schegent-disabled-fg` with no hover highlight, and under focus it takes `--schegent-list-hover` in place of the selection. The mockups draw no disabled menu item; the builder mockup marks a palette entry that cannot be added the same way.
- **Inputs use `--schegent-input-border`**, the theme's own input border. The mockups use the widget border.
- **A selected edge label keeps the foreground text colour** and shows selection with its border and ring. The mockup colours the text with the focus colour, which is below 4.5:1 on the dark palette.
- **A `.btn` draws the theme's button border** (`--schegent-button-border`, transparent when the theme sets none). The mockups' border is always transparent, which leaves a button with no edge in a high contrast theme.
- **A selection drawn as a fill also draws a 1px inset outline**, `--schegent-selection-outline`. It is transparent except in a high contrast theme, where the list selection background is undefined or the page's own black, so the fill alone would not show. There it takes the theme's `contrastActiveBorder`, as the theme's own lists do. A pressed `.seg` button, a selected step, a selected queue page row and a selected table row draw it. The table row draws it as an outline set 1px inside its edge, because a table row does not reliably paint an inset shadow.

Theme:

- **The chart series colour comes from the theme's blue chart colour.** The mockups' `--series-1` is a fixed colour for each theme.
- **Badge text is the caption step.** The mockup's 10.5px is not a step of the type ramp.

Frame and structure:

- **Frame rules are left out**: the mockup window, the sidebar's width and border, viewport heights and minimum heights, the fixed canvas size, and the rule that hides the sidebar at a narrow width. The webview is the frame.
- **The drawer is not hidden at a narrow width.** Hiding it would remove the detail view and leave no other way to reach it. The component decides what a narrow layout does.
- **The edge label and the insert button centre with `translate`.** The mockup centres them with `transform`. `theme.css` sets `transform` on a pressed button, which would replace the centring for as long as the press lasts.
- **The step list clips its corners**, so that a selected step's background does not paint over the rounded border.
- **Table rules apply to `table.t` only.** The builder mockup styles bare `table`, `th` and `td`, which under `.sg` would restyle every table in an adopted surface. The binding table therefore has no row hover.
- **The menu's offset follows the control height.** The mockup uses a fixed distance.
- **A `.btn` centres its label.** The mockups' buttons are only as wide as their label, so their rule leaves the label at the start. A product container that stretches a button, such as the builder inspector's column of port buttons, would otherwise draw the label against the left edge.
- **Where the two mockups define one class differently** (`.chip`, `.seg`, `.menu`, `.tab`), the surfaces mockup is the definition and the builder's variant is a contextual rule.
- **The page header's action rule matches only its own `.actions` child** (`.phead > .actions`). The mockup's descendant rule also restyles an `.actions` group a component puts inside it, such as `QueueItemActions` in the run page's header.
- **The table wrapper is positioned** (`position: relative`), so an absolutely positioned part of a cell, such as a visually hidden column header, scrolls and clips with the table. The mockup's wrapper is not positioned, and on a narrow window such a part widens the page.

Sidebar:

- **The sidebar fills the view and grows past it** rather than opening a scroll region of its own. The sidebar view contract (`specs/006-sidebar-compact-status-bar/contracts/sidebar-view-contract.md`) has the view fit by showing less, never by scrolling inside itself.
- **Its sections are headed "Current run", "Progress" and "Activity".** The mockup's "Now running" contradicts the status chip when the run is idle, paused or over, and its "Today" would say the counts are for one day, which they are not.
- **The progress bar is a native `<progress>`.** The mockup sizes a span with an inline width. A `style:` directive would add Svelte's style helper to the sidebar's startup bundle, which `tests/unit/ui/sidebar/bundle-size.test.ts` caps, and the native element carries the progressbar role and its values itself.
- **The progress section's counts use the sprite's check, dot and cross, drawn inline**, and anything short of healthy is the attention banner (`.attn`), whose accent draws the frame and the tint while the words keep the text colour.
- **The current run's process details are folded**, as the mockup's "Process details" are, and shown only while there is a process to describe.

Queues:

- **A task that has not started is "Pending"**: in the queues table, the queue page's status chips and filter, the add-task drawer and the order hint. The mockup says "Waiting". "Pending" is the product's status label, so a row and the run it opens name the status the same way.
- **The header's add button says "Add work".** It is the name the `schegent.schedule` command's message, the `schegent.defaultWorkflowId` setting and the docs send the operator to. The mockup's says "Add task". The drawer the button opens is headed "Add task to" and the queue's name, and its submit button says "Add task".
- **A queue page row is a button on a grid the rows share, not a table row.** The button opens the run. The controls that act on the task (the drag handle, the move select and the row menu) sit beside it, never inside it (BUG-003).
- **Start queue is a secondary button in the header**, like Pause and Resume, because adding a task is the page's one primary action. In the notice that says a queue is waiting to be started, Start queue is primary, because it is what resolves the notice.
- **The queue's "More queue actions" menu holds Rename…, Clear completed tasks…, Clear everything… and Delete queue…** The mockup's Start later… and Queue settings… live elsewhere in the product: a scheduled start is chosen in the notice that offers the start, and queue settings are workspace-wide, opened from the queues list.
- **Clear completed tasks… ends in an ellipsis** because it asks before acting, which is what the mockups' own rule says a trailing ellipsis means.
- **The incompatible-state notice has no icon.** Both views mount it, and the sidebar does not load the icon sprite.
- **Below 860px the add-task drawer takes the page's whole width**, where the mockup hides it (see "Frame and structure").

Add-task drawer:

- **Add task sits at the foot of the form, not in the drawer's footer.** The form owns the submission and says under the button what became of it. The drawer's footer keeps Cancel.
- **Picker rows are toggle buttons (`aria-pressed`), not radios.** Pressing the chosen row again clears the choice, which a radio cannot do.
- **The form's sections are not numbered.** A section's name is also its region's accessible name.
- **The instructions hint is the product's.** It also says that split tasks share the declared inputs, attachments and output targets.
- **The instructions box resizes vertically only**, so dragging its corner cannot widen it past the drawer.
- **The declared inputs keep their section, "Workflow contract", and its note.** The mockup's "3. Inputs" shows one field. Each box has a caption under it with the input's declared type in the code font and its description, and the box names that caption as its description (`aria-describedby`).
- **A required input says "(required)" after its name**, muted the way the mockup writes "(optional)". A definition declares which inputs are required, not which are optional.
- **Output targets are fields, under "Output targets"**, drawn like the inputs. The mockup only names outputs in its "Start point, outputs and run limits" disclosure. An output written outside the workspace asks for its checkbox under its box, and "Replace and run" is a small secondary button.
- **Attachments are a disclosure the mockup does not have**, "Attachments & references (optional)", drawn as its `details.diag`. It opens by itself when one of its fields holds a value or an error.
- **The workspace-trust banner and the launch authority notice are the warning banner** (`.attn.warn`), which the mockup's drawer does not show. "Review in Settings" is a link under the sentence it belongs to.

Run page:

- **The crumb has one level**: a link back to where the run was opened from, named after that queue or workflow. The mockup shows "Queues / Default". The tier has one way back, its `onBack` prop, and a second level would need a new one.
- **The meta line is the product's**: the pipeline, the elapsed time, the phase of the total, the iteration from the second on, and the run id's first ten characters in the code font. The mockup shows when the run started and its spend so far, and puts the run id in the diagnostics with a copy button.
- **The header keeps the task's icon buttons** (`QueueItemActions`: cancel, edit, remove, retry, mark completed, restart), drawn as the mockup's borderless icon buttons. The mockup has Pause and a "More run actions" menu. Tests pin the buttons, their text glyphs and their accessible names.
- **The run's limits are a card above both columns**, two pairs to a row while the page is wide. The mockup shows "Limits for this step" in the Details tab; spec 240 (D11) puts the limits above the columns.
- **The step list is headed "Phases", and the phase controls sit under that heading as small buttons**, Delete last in the danger style. The mockup has an "Actions for step" menu in the selected step's title row, which the product does not draw. A control the gate refuses keeps its place, dimmed by `aria-disabled`.
- **The step being viewed is marked by `aria-pressed` and the selection colours.** `aria-current="step"` stays on the step that is executing; the mockup puts it on the viewed step. A selected step's text and ring take the selection foreground, and the other steps show the list hover, which the mockup lacks.
- **The rings show more states.** A paused step, one waiting to retry and a scheduled breakpoint use the warning colour; a disabled step uses the disabled colour, with its name struck through.
- **A step's count comes before its time**, and each note (halted at a breakpoint, the retry countdown, the phase message) takes its own line under the name.
- **The run page does not import `sg-run-detail.css`.** The step list and the log are drawn by their components' own styles: the sheet's `[aria-current='step']` rule would paint the executing step as the selected one, and the product's log is a list of entries, not the mockup's rows of `div`s.
- **The tabs keep the product's names**, "Phase log", "Run outputs" and "Context", the names the docs use. The mockup's are Log, Outputs and Details. A "Streaming" status chip ends the bar while the log tails.
- **The Context tab holds the product's readings**: activity and progress, the live feed line, then the diagnostics. It has no Limits or Runner card: the limits card sits above the columns, and the runner is the tag in the log's toolbar.

Run log:

- **The toolbar is the iteration stepper, the trail, a "Live" button and the copy icon.** The mockup has a button per attempt, a "Filter log" field and a "Follow live output" checkbox.
- **The stepper is a `.seg` of older, the iteration shown, and newer**, first in the row and hidden while there is one iteration. A loop can run more iterations than a row of buttons holds.
- **There is no filter field.** The product has no log filter, and adding one is new behaviour, not a restyle.
- **"Live" is a ghost button, not a checkbox.** It jumps to the executing phase, and with nothing in flight a click arms Live Mode for the next one (FR-008). It holds no checked state for a checkbox to show.
- **The trail (queue › task › phase, with the runner tag) stays**, muted, with the phase in the foreground. The phase keeps its name when the row is tight.
- **Each line's kind is one word.** Kinds the mockup does not draw take the nearest word, and the log's own notices (hidden head, ended tail, coverage gap) read "note".
- **Times are local, as HH:MM:SS.** The full stamp stays in `datetime` and the tooltip, and one that does not parse shows as it came.
- **The time and kind columns are sized in `ch`** from the mockup's 70px and 74px, so they follow the editor font.
- **A tool call's block arguments** (several lines, an object, a list) take lines of their own under their key.
- **The log keeps the product's height cap**, `min(60vh, 480px)`, where the mockup's is 360px; its "Live" chip above the list and its "new entries" button stay too.
- **Parts the mockup does not draw**, the audit completion card, the metadata strip and multi-line code blocks, are built from its pieces: status chips, caption type and the log's frame.

Run outputs:

- **The outputs table's columns are Output, Status and Where.** The product's record has no "From" step for an output. It says instead whether the output was written, as a done chip or, for one the phases never produced, a warning chip.
- **Where is the path as text in the code font, not a link.** The IPC contract has no command that opens an output.
- **The table has no title**, because the tab names it.
- **The empty note depends on whether the run executes**, since outputs reach the page only while it does.

Diagnostics:

- **The disclosure opens itself** when a handoff waits on this window's approval, whose button is nowhere else, or when it has a notice. It never closes itself, so an approval's result stays shown. The mockup's disclosure starts closed.
- **The readings are Hierarchy, Evidence, Live log, Recovery and ACP state** as key and value rows, with Refresh at the end of their row. The panel's own heading, sub line and section label are gone, because the summary line names it.
- **Its actions are small secondary buttons, Approve handoff included.** The mockup draws no handoff.
- **The change review is a card**: Lane, Candidate, Integration and Comparison revision, then Freshness, Approval, Landing and Files as key and value rows, each file as its kind tag and its path in the code font.
- **History's run detail mounts the same panel**, so all of the above applies there too.

History:

- **The columns are Run, Queue, Status, Duration and Updated.** A history row carries no cost, so there is no Cost column; the drawer reads the cost for the one run it shows. No column sorts: the list is newest first by last update (FR-005), and "Updated" carries `aria-sort` and the chevron.
- **The line under a run's name always has three parts**, the definition, the version and how the run started, "Standalone" included, and says when a part was not recorded (FR-011). The mockup shows the origin only for a workflow run.
- **The outcomes are All, Running, Paused, Completed, Failed and Canceled**, the product's run statuses.
- **The pills are Any time, Definition, Version, Queue and Kind.** The mockup's are "Last 7 days", Workflow, Queue and Started as. Definition covers Pipelines and Workflows, and Version appears once a definition is chosen (FR-018). Kind is named after its options, "All kinds", "Standalone" and "Workflow member"; the row and the drawer call the same value "Started as". The time pill shows as chosen only once a window or a custom range is picked. Each pill is a native select, transparent over the pill's face, so the platform's own picker opens where the pill is, and the pill draws the select's focus ring.
- **The search field says "Search by run ID, queue, or description"**, the product's placeholder, and is `calc(19em + 40px)` wide so the placeholder fits. The mockup's is "Search runs", 260px.
- **The filters stay one group, "History filters", drawn with `display: contents`**, so each control wraps on its own beside the search. On a toolbar 30em wide or less, the outcome control becomes a grid of three, two or one across, and a label wraps inside its cell.
- **A row's menu holds Run again…, Open audit log and Open details.** Run again… is disabled while the run is not finished and says so. The mockup's "Open audit events" is the product's audit log, and its "Copy run ID" is in the drawer's footer.
- **The count line reads "N of M runs"** (FR-052). The mockup's names a total and a time window.
- **Escape closes the drawer**, and the rerun form first when it is open. When focus was in the drawer, it goes back to the control that opened it, or to the run's name when that control has gone, such as an item of a menu that has closed.

History drawer:

- **The Run list is the product's record**: Definition and Version on separate rows, Started as, Queue, Started, Ended, Duration, Cost and Phases. Phases reads "N total, N completed, N skipped". Cost and Phases read "Reading…" while the record loads, and "Not reported" or "Could not be read" when there is nothing to show.
- **"Why it failed." shows for every failed run**, with the code in parentheses after the cause, or a sentence that says no cause was recorded or that it could not be read.
- **The run's text is headed "Description"**, not "Instructions", and says when none was kept.
- **Evidence is the product's evidence panel.** It warns, as a warning banner, that the raw transcript is kept unredacted and names the commands that delete or export it. It has no links under it: the row's menu opens the audit log, and the product has no event list.
- **Diagnostics holds the Run ID only.** The version is in the Run list.
- **Copy run ID swaps its icon for a check** and reads "Copied", or "Copy blocked" when the clipboard refuses. Its accessible name keeps the run ID.
- **Run again… opens "Repeat this run" inside the drawer**, which the mockup does not draw: a Close button, the product's notices about the version, workflow and queue the run will use, and the launch form. The form sits on the drawer's gutter, because the panel removes the launcher's own padding. Opening another run replaces the form.

Metrics:

- **The tabs are Overview and Reports.** The mockup's Steps tab is the Steps table on Overview.
- **The header's switch is the run detail scope, "Live log" or "With archives"**, where the mockup's is a time range. The audit read takes no time range. The one scope it takes is whether the run detail reaches into the archived logs. The switch and Refresh show on Overview only, because a report sets its own window.
- **The tiles are the all-time totals, with the product's context lines**: "All time", "of N · N failed · N canceled", "N backend calls", and whether every run reported a cost. The mockup compares runs with the previous 30 days and gives a median per run, which the totals do not record. A cost that some runs did not report ends in "+". The line under the tiles says what the durable rollup covers.
- **The run detail keeps its own window line and strip of totals** (Completed, Run time, Cost and Backend calls). It is folded from the retained audit log, which retention prunes, so it can cover fewer runs than the tiles.
- **Cost per day is labelled with its first and last day**, not "Last 30 days". The axis climbs in three equal steps of 1, 2, 2.5, 5 or 10 times a power of ten. A bar is at most 48px wide. Past 120 days the chart samples the days, while the table lists every day.
- **Each bar takes focus, and the arrow keys, Home and End move between bars.** The tip sits over the bar and gives the day, its cost and the cost to date. The line under the chart says the same in words for a screen reader. The mockup's tip follows the pointer and shows the day's cost only. The chart is a group named after its range and its highest day.
- **"Show as table" has no `aria-pressed`.** Its label changes to "Show chart", which already says which view shows. The table's columns are Day, Cost and Cumulative, with each day as its ISO date. The mockup's are Day, Runs and Cost, but the timeline has no run count for a day.
- **The Steps table shows all eleven columns**: Step, Runs, Median, p90, p99, Longest, Shortest, Average, Total time, Backend calls and Cost. It has no Columns menu, search or sorting, and Overview has no "Slowest steps" table. The mockup's Steps tab shows seven of the eleven, sortable and with a search.
- **The Runs table and each run's phase detail stay** under the Steps table, which the mockup does not draw. The columns are Run, Started, Finished, Duration, Steps, Cost and Status, and they sort. A run's phases are behind its expand button, and a pager with Previous and Next ends the table.
- **While the overview loads, "Scanning audit history…" shows above four blank tiles**, each as tall as a loaded tile at any font size.

Metrics reports:

- **The form keeps the product's fields**: Report and Window, then Workflow ID and Outcome (or Backend for "Usage and cost"), then Sort by. Workflow ID, Outcome and Backend are text fields, because the product has no list of workflows or outcomes to offer. The mockup's Workflow and Outcome are selects, and its window is the page's time range.
- **A status line under the form says what the last action did**, such as how many rows loaded and at which cutoff. It is the form's live region. While a report runs, its button reads "Running…" and Cancel shows beside it.
- **The results heading is the report's name**, and the line beside it reads "N row(s) · as of" and the cutoff as "YYYY-MM-DD HH:MM UTC". The mockup's heading adds the window, and its line gives the time only.
- **The columns follow the kind of row the report returns**: runs, attempts, groups or usage. A run row has the mockup's Run, Workflow, Status, Attempts, Duration and Details, with the run and the workflow as IDs in the code font, because a report row carries no names. A group with no key reads "All runs".
- **The headers are not sort buttons.** The rows come in the form's Sort by order, and the first column's `aria-sort` states it.
- **"Details" opens the run's drill-down**, and its accessible name is "Details for" and the run ID. "Load next page" follows the table while the report has more rows.
- **The Export button stays enabled while a save or an export is in flight, and its items are disabled instead.** A button disabled while it holds focus drops the focus.
- **"What this report covers" holds the product's coverage list**: the cutoff with its time basis, Runs, Attempts, Unknown durations and Accounting revision. Each omission and the note on what a CSV export holds follow it. The mockup writes one sentence.
- **The drill-down is a card under the results**, which the mockup does not draw. Its title row holds "Root execution" with the run ID, the outcome chip and a close button. Its facts are a key and value list. The attempts, the pinned usage accounting, the artifact and ACP metadata and the stated omissions follow them.
- **A report's status chip says the store's word, capitalised**, such as "Succeeded", "Cancelled" or "Timed out", in the tone and mark History gives the same state. The Outcome field matches the store's spelling, so the chip tells the reader what to type there.
- **Saved reports list Report ID, Report and Cutoff.** A saved report has no name and no last-run time. A row's menu holds the mockup's Run now, Check it still matches and Delete…. Delete… asks again in the row, with "Confirm delete" and "Keep", before it acts.
- **On a narrow window the form's fields wrap at their fixed widths**, and each table scrolls inside its wrapper.

System:

- **The heading stays "System Log"**, the route's name in the nav and in the status line. The purpose line under it is the mockup's.
- **There is no search, level filter, event filter or "Open log file".** The product has no log filter and no command that opens the log file, and adding either is new behaviour, not a restyle.
- **Each log is a list drawn as the mockup's table.** Tests pin a log as an `ol` of `li` rows, so the list and its rows are subgrids of one grid (`components/system-shared.css`), and the header row is hidden from assistive technology, which reads each row by its label. A log scrolls inside its frame on a narrow window, and an empty one drops the table's 640px width.
- **The Time column gives the date with the time**, where the mockup's gives the time only.
- **A level chip shows the log's own word with its first letter capitalised**: Debug, Info, Warn and Error, where the mockup writes "Warning". The tones are the mockup's.
- **The Event column keeps the category's glyph** before the word for it, such as "Backend call" or "Step change". A category the webview does not know shows the system glyph and its name as recorded. The outcome sits under the event in its status colour, or a dash when the entry has none.
- **The Task column replaces Run**: the task ID in the code font with the phase under it, as text. An audit entry carries no run title, and the tab has no way to open a run.
- **"Invocation details are intentionally omitted." sits under each backend call's summary**, in place of the mockup's line under the table.
- **Refresh is an icon button at the end of the Runtime tab's status row**, where the mockup puts it in the page header for every tab. The runtime panel owns its read, and the logs arrive with each snapshot, so they have nothing to refresh.
- **The telemetry chip shows the delivery state**: "Healthy" with a check, "Retrying" in the warning colour, "Degraded" in the error colour and any other state in the active one, or "Off" while export is off. The lanes chip is "On" with a check, or "Off".
- **The sentence under "Telemetry export" is the host's export disclosure** (`previewSummary`). The mockup's gives the reason export is off. The posture carries that reason as a code, which Diagnostics shows after the state, as the mockup does.
- **There is no "Allow in Settings".** Export is enabled by the VS Code setting `schegent.telemetry.export.enabled`, and the dashboard has no control for it and no command that opens it.
- **The cards keep the product's readings and words**: Authorization, sizes in KiB and MiB, "2 / 4 active lane(s)", "N awaiting verification, review, or landing" and "N total", and in Diagnostics the ledger as "N exported · N pending · N dropped", the spool's batches and the series with their overflow. Tests pin "Authorized", "14 exported" and the lane count. The posture has no run title for "Waiting to merge" and no count for a month.
- **While the posture loads, and when the runtime store cannot be read, a boxed note takes the cards' place.**

Settings:

- **The sections are two tabs, General and Fatal Signatures**, drawn as the mockup's section list but kept as a vertical tab list (`role="tablist"` with `aria-selected`), where the mockup's is a `nav` marked with `aria-current`. The mockup's seven sections fold into General's four groups (backend and process environment; execution, queues and retry; audit, transcripts and runtime logging; UI and trust) and the Fatal Signatures tab. There is no Queues section, because queue settings open from the queues list (see "Queues").
- **Each group is an open disclosure** whose summary is set as a section heading with the native marker, and General shows all four in one scroll. The mockup shows one section at a time.
- **The section list stops sticking below 860px**, where it stacks above the rows. The mockup's stays sticky there, and since it has no background of its own, the rows scroll under its buttons.
- **Below 560px a row's control drops under its label**, and a backend card's check drops under the backend's name. The mockup's two row columns need 420px side by side and would widen the page.
- **There is no search, and the page header has no Revert or Save.** Only the General tab drafts edits, so its header holds "Unsaved changes", Reset All and Save All Changes. Each row also saves on its own, with Save and Reset at the end of its scope line. The chip has no count. The Fatal Signatures tab has a Reset and Save of its own (see "Fatal Signatures").
- **A row's scope line reads "Scope:" and the scope's name**, such as "Scope: Default". The mockup's reads "Applies to:" and who the setting applies to. A row with an unsaved edit has the mockup's dot beside its label. The section list has no dot, because the draft lives inside the tab and the list does not see it.
- **A short control description shows as a line under its row's scope line, and a longer one as a popover** (see "Settings hover-text primitive (spec 018)"). The mockup has no control descriptions.
- **The evidence privacy profile is a row in the General header**, with the mockup's segmented control, where the mockup gives it a section of its own. Its buttons carry `aria-pressed`, and a "Current profile" line under them names the profile the settings match, or the nearest one and how the settings differ. The session line under it keeps the product's words, "Unredacted local session artifacts:", where the mockup's reads "Stored locally:".
- **The two trust rows come after the UI toggles**, where the mockup puts its trust row first, under the product's line on why they cannot be switched here. Each shows its effective value as the mockup's status chip where a control would be: "Allowed" with a check or "Denied" with a cross. The setting's key and a "Change in Settings" button sit under the chip, in place of the mockup's "Applies to: VS Code workspace trust".

Settings backends:

- **The backend list keeps the heading "Backend health"** and the product's line under it. The mockup's heading reads "Installed backends".
- **A backend card keeps the product's tags**: "In use", then "Discovered" or "Not found", where the mockup's second tag reads "Found". The last check is the mockup's status chip, such as "Healthy · 120 ms", with a dot while the check runs and the warning mark when the backend is unavailable.
- **The check is "Ping", a secondary button at the card's right**, where the mockup's is "Test". There is no "…" menu, Details link or "Set path…" button. The path is not a line under the name: it stays the editable path row in the card, after the "not found" sentence when there is one, and the backend's own settings follow it.
- **The line under the name is the containment posture**: "Containment:" and "Mechanism:", each value in the code font. The mockup's reads "Sandboxed · Details".
- **"Allow uncontained" is a danger button and "Revoke uncontained permission" a secondary one**, with the refusal the host sends under them.
- **"Process environment" is a heading inside the group, as in the mockup**, over the product's rows: Environment mode, Environment allowlist, Inherit host environment (legacy) and Backend probe timeout, then the effective policy line. The allowlist is a list of names, each with a cross button that removes it, above an entry field and an Add button. The mockup's is a text area with one name per line. The list refuses a name that does not match the setting's pattern when it is added, so it never holds an invalid entry, which a text area could not promise.

Fatal Signatures:

- **The built-in list comes first**, as spec 011's contract requires ("Built-ins always render first", `specs/011-webui-config-editor/contracts/fatal-signatures.md`). The mockup puts the operator's additions first.
- **The headings and the lines under them are the product's**: "Fatal Signatures", "Built-in registry" and "Operator additions". The mockup's are "Built in" and "Your additions", with one line for the whole page. The built-in heading carries the mockup's "read-only" tag, which marks the list once, so a row no longer carries its own "Built-in" badge.
- **The tab header holds "Unsaved changes", Reset and Save**, as the General header does. The mockup saves from the page header.
- **The additions are the mockup's table**: a "Text to match" column of inputs in the code font, and a remove column with a visually hidden header ("Remove") and a cross button in each row, named "Remove fatal signature" and the row's number. The add button reads "Add", which the empty list's line names ("Click + Add to create one"). The mockup's reads "Add text".
- **The warnings and the save status are small lines under the add button**: a warning in the warning tone, "Saved." in the success tone and a rejected save in the error tone.

Builder:

- **The Workflows tab is the workflow builder mockup's editor**, with the departures listed under "Workflow editor", "Workflow canvas" and "Workflow inspector" below. The surfaces mockup's Workflows tab is a card that links to it.
- **The Phases list cannot be sorted.** Its rows keep the catalog's authored order, which a row's Move up and Move down buttons change, and a sorted view would hide the order those moves act on. The mockup's Phase, Used by and Modified headers sort.
- **The status filter reads All, Active, Draft and Invalid**, the words of the product's state chip. The mockup's reads "Published" where the product says "Active".
- **The Status column holds the product's two chips.** The state chip reads "Draft", "Active" or "Active with draft", in the mockup's tones, and shows only when the host sent the Phase's lifecycle. The validity chip reads "effective" or "invalid" in lowercase, with a check or a warning mark, on every row, because FR-015 keeps the word as it was. The mockup's column reads "Published vN" (with "Draft changes" beside it when a draft sits on top), "Draft" or "Invalid · N issue". A row with an unsaved edit also carries an "Unsaved changes" chip, and a Phase whose model is not available a "model unavailable" chip in the error tone, which the mockup shows in its Runs on cell instead.
- **A row shows only the Phase's name, its id, its chips and two buttons, Move up and Move down, as the list did before the redesign.** FR-003 of feature 186 lets a row in a definition list show only the definition's name, id, and state and validity badges, so the mockup's description line, its Runs on, Used by and Modified columns and its row menu are not drawn. The name opens the Phase's editor page, which shows what the Phase runs on, what uses it and when it changed, and holds Duplicate, Export… and Deactivate…. The mockup's row menu holds Open, Duplicate, Export…, Deactivate… and Delete….
- **Moves are refused while a search or a status other than All is set.** The filter only hides rows, and every write still addresses the whole list by position.
- **While an edit is pending, the toolbar shows "Unsaved changes", Undo, Redo and Save, and New phase and the moves wait until it is saved.** A move is the list's own edit. A Phase's other edits are made, undone and saved on its editor page. The mockup's toolbar holds only Import… and New phase.
- **"Import…" is in the import region under the list**, headed "Import a Phase, Workflow, or Model Catalog document". The region shows what an import would change and commits it only with its own "Confirm import", which a toolbar button has no room for. The mockup's "Import…" is in the toolbar. The Models tab shows the same region under its editor.

Phase editor:

- **The header's chip reads "Unsaved changes" with no count**, as on the Settings page. The mockup's reads "2 unsaved changes".
- **Undo and Redo are titled "Undo" and "Redo".** The editor binds no keyboard shortcut, so the mockup's "(Ctrl/Cmd+Z)" would name one that does nothing.
- **Save is the primary button, and the header has no Publish or Version history.** Both are in the summary's lifecycle panel, the one every definition shows: Publish when the state allows it, and History, which opens the version history. The mockup puts Publish beside Save and Version history in the menu.
- **The "More phase actions" menu adds Move up and Move down, and has no Delete…**: the catalog deactivates a Phase rather than deleting it. Export… is disabled for a Phase with errors and shows the reason inside the item. Revert unsaved changes is disabled while there is nothing to revert. The mockup's menu holds Edit as JSON, Duplicate, Export…, Version history, Revert unsaved changes, Deactivate… and Delete….
- **Basics keeps the Phase's other fields**: the ID, read-only once the Phase is saved, the Version, always read-only, and the Loopable and Required checks. The Description has two lines. The mockup's Basics holds the Name, a one-line Description and the ID hint.
- **A skill is typed into a text input in the code font.** The webview has no list of the skills a backend offers. The mockup's Skill is a select.
- **The Backend's first option reads "Default backend"**, where the mockup's reads "Workflow default (claude)". No run applies a Workflow's execution defaults, so a Phase does not take its backend from the Workflow that runs it: a Phase that sets none runs on the default backend, the one the Backend setting selects, or on Claude when it writes Git metadata. The option does not name which, but the Model list and the Effort limits follow the backend the Phase will run on. A Phase step's card reads "Default backend" too when the Phase sets no backend, model or effort. A backend that is not available is marked "(Unavailable)".
- **The Effort's first option reads "Backend default"**, the Model's word, where the mockup's reads "Inherit". A Phase that sets no effort passes the backend none, as with an unset model, so the backend's own default applies: nothing is inherited from the Workflow that runs it.
- **The time limit is in seconds, from 1 to 3600**, because the Phase stores `timeoutSeconds`. The mockup's reads "45 min".
- **Retries keeps the product's condition editor and outcome labels.** The condition is the retry condition editor the queue settings also use. The outcome, "When retries run out", reads "Fail the task", "Continue with a warning" or "Continue, marked unverified": each label says what the run does, and the third records that the condition was never satisfied. The mockup's condition rows, its "Valid. Write as an expression" line and its "When attempts run out" with "Fail the run", "Continue with a warning" and "Continue" are not ported.
- **There is no Attempts field.** A Phase stores no attempt count, so adding one is new behaviour, not a restyle.
- **The summary shows Used by, then the lifecycle panel**: Created, Modified and Active version continue Used by's key and value list, on one key column; a draft's changed fields follow under "Publishing would change:"; then the actions as small buttons. The changed fields take the place of the mockup's "Publishing changes" list, and the mockup's "Published v2 · Nov 7" and "Draft · Edited 3 min ago" lines are not ported. Issues follows, as in the mockup, and lists every saved defect, which the panel does not repeat.

Builder models:

- **The toolbar has no unsaved chip, and Save is always enabled.** The editor holds the catalog being edited and no saved copy to compare it with. The mockup's toolbar shows "1 unsaved change".
- **Export… keeps the accessible name "Export Model Catalog"**, which `docs/operations/process-yaml.md` and the editor's tests name.
- **A section's heading holds the backend's name only.** The count and the Detect and Add model buttons sit beside it in the section head, so the heading's accessible name is the name alone. The mockup's `h2` holds all three. The count reads "no models", "1 model" or "N models".
- **An empty section reads "No codex models yet"**, with the backend's name, and a line that says how to fill it: Detect adds the models the backend reported, or Add model takes an id. The editor learns only what each backend's CLI reported, and a CLI that cannot list its models reports nothing, so it cannot tell a backend that is not installed from one that listed none. The mockup's card reads "agy is not installed" with "Set path in Settings".
- **There is no Used by column, and every row has Remove.** The editor is given no Phases to count. Each row is a catalog entry, whether Detect or the operator added it, so each can be removed. The mockup offers Remove only for a model "Added by you".
- **A model id is an input with no border until it is hovered or focused**, and the rows are keyed by position, so editing an id keeps focus. The mockup's ids are text.
- **Add model opens a form under the section head, one section at a time.** Cancel, Escape, choosing Add model again or opening another section's form closes it and drops the draft, and focus returns to the button. A duplicate id is refused with an alert under the input, tied to it by `aria-describedby`. The mockup's Add model opens nothing.
- **With no backend to list, the tab shows a "No backends available" card.** The mockup has no such state.

Workflow editor:

- **The root crumb "Workflows" is a button that opens the switcher's list**, with focus on the open Workflow's row, or on the first row. There is no list page: the switcher's list is the list view, and it keeps each row's purpose, Pipeline sequence, ports, validation state and lifecycle badges. The mockup's root is a link to a list page.
- **The head's chips are the product's**: the state chip, and the validity chip in lowercase with a check or a warning mark, as on the Phases list (FR-015). "Unsaved draft" marks a Workflow that has never been saved, and "Unsaved changes" an unsaved edit, with no count. The mockup's chips read "Published v3" and "3 unsaved changes".
- **Undo and Redo are titled "Undo" and "Redo".** The Builder binds no undo key, so the mockup's "(Ctrl/Cmd+Z)" would name one that does nothing.
- **Save is the head's primary button, with no ⌘S, and the head has no Publish.** No save key is bound. Publish and History are in the lifecycle panel under the Workflow's Status, the one every definition shows. The mockup's Save is a secondary button with ⌘S, beside a primary Publish.
- **The "More workflow actions" menu holds New workflow, Duplicate, Export YAML…, Revert unsaved changes and Deactivate…** The catalog deactivates a Workflow rather than deleting it, so there is no Delete workflow…, and Version history is the lifecycle panel's History. A disabled Export YAML… shows the reason inside the item. The mockup's menu holds Duplicate, Export YAML…, Version history, Revert unsaved changes, Deactivate and Delete workflow….
- **Export YAML… opens a panel first**, whose Include select sets how much of the Workflow's dependencies the document carries (FR-013). The mockup's exports at once.
- **What the canvas does is said on the dashboard's status line**, not on a line of the editor's own. A selection reads "Selected" and the step's title or the branch's name, and selecting nothing reads "Nothing selected. Showing the Workflow." An add from the palette, from either `+`, from Split or from the inspector's "Add a branch from this step" reads "Added" and what it added; an add that is refused adds nothing and says nothing. A delete reads "Deleted", the name and "Undo restores it.", and focus moves to Undo, as in the mockup. A move reads "Moved", the step's title and its position in the saved step order, then "The canvas places the steps a run can reach by their connections, not by this order.", because the card most often stays where it was; a move that changes nothing says nothing. The mockup's line ends its empty selection with "workflow summary.", says an add "would" happen, and ends a delete with "Press Ctrl/Cmd+Z to undo." Its opening hint and its zoom, fit, tidy, outline and picker messages belong to controls left out (under "Workflow canvas"), and its "would run here" stands in for menu items that here do run. Its "Control changed." and "Kept the … settings." are not ported: Switch and Keep send focus back to the Control choice, whose checked option says what the step now does.

Workflow canvas:

- **The canvas is laid out rather than placed.** The mockup gives each card coordinates and draws its edges in an SVG. Here the steps stand in lanes and each edge is a CSS line, so no position is computed. The edge geometry is the mockup's: a plain edge spans 46px with its `+` halfway down, a labelled one 88px with its chip's centre at 42% and its `+` at 80%, and the stroke is 1.4px, 2.2px when selected.
- **Steps are drawn in the order the flow offers them**, from each start down, with a fork's arms in equal columns. Steps no start reaches go in a lane below, in authored order, under a note that says why they block a save: "Not reachable from a start. Connect these or remove them before saving."
- **An arm into a step drawn elsewhere is dashed and ends in a chip that names the step**, with the loop mark, so a diamond reads without drawing a step twice. The mockup dashes only its loop back.
- **A Workflow with a Candidate Block opens its canvas with a banner**, above the steps, that states the block's selection mode, availability policy, return path and exits, and lists its candidates in order. The mockup's Workflow has none.
- **A card is a box holding one button.** The selected card's toolbar and a child Workflow's preview line are controls of their own, and a button cannot hold another. The button carries the selection, `aria-pressed` and the card's description, and a card with a defect gets the error border and an issue badge. The mockup's card is itself the button.
- **A plain arm's line is its button**, 24px wide. On a touch screen the line keeps 24px above and below its `+`, which grows to 44px. The mockup's plain edge has a visually hidden button.
- **The palette's Logic group holds Split alone**, which adds a branch from the selected step and is disabled until one is selected. A condition and an approval are a branch's settings, Condition and the manual handoff, as in the mockup's own branch inspector, and Repeat and For each are a child Workflow step's Control. The host refuses a cycle (`graph-cycle`), so there is no Loop back; Repeat is how a step runs again. The mockup's Logic group lists Condition, Approval, Loop back, Repeat until and For each as steps.
- **The palette's other groups are the mockup's, Phases and child Workflows**, never the open one. Pipelines are accepted but not offered: they are transitional, and count only toward whether the catalog is empty. The palette also styles states the mockup does not show: a disabled item, a long identifier, the notes 'No step matches "…".' and "No effective Phases or Workflows", and a collapsed head whose toggle fits the 40px rail.
- **A `+` adds a step at once**: the first Phase, or the first Pipeline when there is no Phase, and the Step tab changes what it runs. The mockup's `+` opens a picker titled for where the step goes.
- **The selected card's toolbar holds Move earlier, Move later and Delete.** The moves are the product's: they change the step's place in the authored list, the order its definition saves. The canvas draws that order only among the steps no start reaches, so a moved card most often stays where it was, and the status line says where the step went. Of the mockup's other buttons, Add after is the `+`, Open definition is the Step tab's Definition link and a child Workflow's preview line, and Replace… and Duplicate have no operation behind them yet; a button that does nothing is worse than none. On a touch screen 560px wide or less, the buttons stack. In a fork, a card with an arm to its right has its toolbar over its top-right corner, because beside the card it would cover that arm's card; on a touch screen that toolbar stands beside the card with its buttons stacked, at any width, and the fork's arms stand 64px apart to hold it. Its buttons are a group named for the step, each a Tab stop of its own as every control on the canvas is; a `toolbar` role would promise arrow keys between them. The mockup's toolbar holds Add after, Replace…, Duplicate, Open definition and Delete and declares the `toolbar` role without the arrow keys, and the mockup draws no fork side by side.
- **Delete and Backspace delete the selected step only while focus is on its card**: the card's own button, its toolbar or its preview line. They take the toolbar's Delete path, so the status line names the step and focus moves to Undo. A key held with Ctrl, Cmd, Alt or Shift is left to whatever binds it, a key held down deletes one step, and a read-only Workflow deletes nothing. The mockup listens on the whole page and skips only its text fields. Here the panel also holds the inspector's fields, the toolbar and the other cards, and a key meant for one of them must not delete a step the operator is not on.
- **Escape and a press on the canvas's ground show the Workflow again**, as in the mockup: the ground is anywhere on the canvas but a card or a control. Escape is left to whatever nearer answers it first, an open menu, the export panel, the open Workflow list or a confirmation dialog, and does nothing outside the editor. Focus on the inspector's fields, which go with the selection, goes back to the card or the arm that was selected.
- **A child Workflow's steps are listed on request.** Its preview line offers the list and a link that opens the definition. Listing walks every nested call down to its depth limit, work a closed card does not need. The mockup always lists the child's steps under its card.
- **Zoom, Fit, Tidy, the Outline view and the picker are not ported.** A laid-out canvas grows with its content and scrolls, so Fit has nothing to fit and Tidy nothing to tidy, and the webview zooms with the editor window. The cards are buttons in reading order, so the keyboard and a screen reader already meet the steps as an outline. The `+` takes the picker's place.
- **Below 761px the panes stack** and the page scrolls: the palette, at most 200px tall, over the canvas, and the inspector under it. A fork keeps its columns and the canvas scrolls sideways, as the mockup's does. The mockup's only narrow rule, a 200px palette and a 280px inspector below 1101px, is kept.

Workflow inspector:

- **Each mode's head stays put while its body scrolls**, and a step's or a branch's head has a "Back to the Workflow" button, so the Workflow's settings are one press away from any selection. The mockup's step and branch heads have no way back but Escape and a press on the canvas's ground, which go back here too (under "Workflow canvas"). The back button sends focus to the card or the arm that was selected.
- **The Workflow's summary and settings share one page**: Status (State, Steps, Used by, then the lifecycle panel), Issues, then sections that open and close: General, open first, Inputs and outputs, Execution defaults, and Candidate block, open when the Workflow carries one. Every field stays one scroll away, and the execution defaults, with Recommended next, are fields rather than a list. The mockup gives the summary and the settings a page each, joined by a "Workflow settings" button. Steps gives the count and, as in the mockup, how many of the steps no start reaches ("4 (2 not reachable)"), the steps the canvas sets apart in its detached lane. The mockup's Defaults line, "claude · model and effort from each Phase", is not drawn: it says what the steps take from the Workflow, and no run applies a Workflow's execution defaults to its steps, which is why the Run form shows them as advisory.
- **The open tab carries over to the next step, except Control on a step that cannot loop**, which opens on Step, because there Control offers only Once. The mockup keeps Control open.
- **The Step tab picks what a step runs with two selects**, its type (Phase or Child Workflow) and its target, and holds "Add a branch from this step". A Phase step shows no Execution list: a step stores no execution settings of its own to override. The mockup's Runs is one picker, and its Execution list offers "Override for this step…".
- **The Data tab is read-only.** It shows where each input comes from, as the host counts it: a binding, a connection into the input, or the step's own For each item. Bindings are edited in the Workflow's Inputs and outputs, so this tab is not a second editor for them. The mockup edits a step's bindings in its Data tab.
- **The Advanced tab holds the step's identifier.** A step stores no retry settings or notes, and a Phase's retries are set in the Phase editor, which has no attempt count. The mockup's Advanced tab also shows the Phase's attempts and what happens at the cap, and a Notes field.
- **A branch's head reads "Branch" and its number**, with the two steps it joins under it. The mockup's reads "Branch", or "Loop back" for its else arm.
- **A branch's body adds Comes from**, a select over the steps and their ports, so a branch's source can change as its target can and can never name something that does not exist (FR-042). Its other sections are the mockup's: Goes to, Condition, with "Always taken." when there is none, and Handoff. It ends as the mockup's does, with "Delete this branch" on a line of its own, at the left. Above it stand Move earlier and Move later, the product's: they move the branch within the Workflow's saved list of branches, whose order breaks a tie in priority among the branches from one step. Every control that decides what a condition means is a select over a closed set (FR-021), and the one free-text control is the literal compared against (FR-024).

### Left to the component

- **Inline styles.** The mockups set positions, widths and one-off spacing in `style` attributes. `tests/lint/no-static-inline-style.test.ts` forbids a static `style` attribute. A computed value, such as the depth of a step in a child Workflow's preview or a popover's position, goes through a `style:` directive. There are two exceptions: the sidebar's progress bar is a native `<progress>` (above), and a fork's arm count is a `style` attribute that sets `--wf-arms`, the one dynamic attribute the test counts. A one-off variant goes in the component's own style block.
- **Mockup chrome.** The annotation bar, the numbered pins, the legend and the rules page are not ported.
- **Icons.** The mockups' icon symbols are `components/sg/SgSprite.svelte`, which the dashboard shell renders once. A call site is `<svg class="i" aria-hidden="true"><use href="#i-name" /></svg>`. The sidebar does not load the sprite, because its startup bundle has no room for it, so it draws its four icons (the logo and the three counter marks) inline with the sprite's paths.
- **Two class names are the port's own.** `sg` is the scope. `fit` lets a `table.t` shrink below its minimum width.
- **Class values are quoted.** Write `class="x {y}"`, never `class={expr}`. Svelte passes a bare expression through its `clsx` helper, and the helper then lands in the chunk the sidebar loads at startup, which `tests/unit/ui/sidebar/bundle-size.test.ts` caps.

## IPC contract

Webview → host commands and host → webview snapshots are typed in `src/contracts/`:

- Webview → host: `SidebarCommand` (discriminated union) — see `src/contracts/sidebar-ipc.ts`.
- Host → webview: `WorkflowSnapshot` — see `src/ui/sidebar/snapshot.ts` and the mirrored webview types in `webview-ui/src/lib/snapshot-types.ts`.
- Validation: `MessageRouter` validates every inbound command via `src/contracts/runtime-validators.ts`. Unknown shapes are rejected and audited as `audit.invalid_command`.
- Acknowledgement: `CommandAckMessage` carries `status: 'accepted' | 'rejected'` and, since feature 193, an optional `outcome` narrowing what `rejected` meant — see `src/contracts/command-outcome.ts`.

The webview's command literal types are re-exported from `src/contracts/`. There is no separate webview-side definition.

`CommandAckMessage.outcome` is one of four words — `accepted`, `no-op`, `refused`, `failed` — and it
is **optional on the wire**: a handler that does not populate it posts the `status` field alone, and
that is the legacy-tolerant reading every consumer must keep. Five routes populate it, and they are
the five feature 193 (`FR-R3-154`) corrected: `CMD_PAUSE_PHASE`, `CMD_RESUME_PHASE`,
`CMD_RESTART_PHASE`, `CMD_RETRY_PHASE_NOW`, and `CMD_START_QUEUE`. Each used to acknowledge
`accepted` the moment it had dispatched, so a refusal the host had already decided arrived as a
success; each now acknowledges the host command's own answer.

No component narrows on `outcome` today, and that is by design rather than by omission. Every
lifecycle surface calls `lifecycleMessage(result)` in
[`lib/lifecycle-control-ipc.ts`](src/lib/lifecycle-control-ipc.ts), which returns `null` for an
acceptance and one operator sentence for everything else — so `toLifecycleResult` is the one place
the four outcomes are discriminated, and a component that wants "was this refused or did it break?"
should read the field there rather than growing a second reading of the envelope. That sentence is
webview copy resolved from the reason **code** by `lifecycleRefusalText`, not text the host wrote;
an unmapped code degrades to `The host refused: <code>` rather than showing nothing. `refused` and
`no-op` are both `status: 'rejected'`; a `no-op` is not an error, and a surface that treats
`rejected` as failure will say so wrongly. A non-accepting `reason` is always a code, never an error
message.

Spec 102 adds `WorkflowSnapshot.launchables` in that direction and nothing new
in the other: the launch surface starts runs through the command shapes that
already existed. `lib/workflow-run-ipc.ts`'s `launchWorkflow()` shipped in spec
088 with no caller and now has one — `components/Runs/WorkflowTriggerForm.svelte`.
The payload it sends carries **no `catalogVersion`**; provenance is resolved
host-side inside `validateRunRequest()` and a payload asserting its own is
refused (`tests/contract/catalog-version-not-accepted.test.ts`), so this is a
field the webview never learns to send rather than one the host strips.

### Dynamic pipelines (spec 009)

The phase-tracking IPC shape was widened to support operator-defined pipelines:

- `PhaseName` is `string` (was a fixed literal union of the eight built-in phases). Webview components must not assume any specific phase id list.
- `PhaseTile.order` is `number` (was a 1..7 tuple). Tiles render in catalog order, with vertical scroll when the active pipeline exceeds ~10 phases.
- `PhaseTile.loopable?: boolean` is now optional, mirroring the per-phase `PhaseDef.loopable` setting.
- `WorkflowSnapshot.activePipeline?: { id: string; name: string }` is optional. When present, the dashboard header renders `Phase Progression — Pipeline: <name>`; when absent, no Pipeline is named.

Feature 098 removes the fallback these bullets used to describe. There is no built-in Pipeline left to imply and no built-in phase-id list to fall back to, so absence now means absence: the webview renders what the projection carries and infers nothing from a missing field. `snapshot-types.ts` lost `BUILT_IN_PHASE_NAMES`, `PHASE_NAMES`, and `BuiltInPhaseName` with the layer they mirrored (T040) — `PhaseName` stays `string` on both sides of the boundary, which is the parity the file exists to hold. `IDLE_GENERAL_SETTINGS.defaultPipelineId` is `''` for the same reason (T048): the empty string is how "no default" is spelled across the boundary, not a missing field, and the host default, the manifest contribution, and this idle snapshot all agree on it.

### Per-queue snapshot, `schemaVersion` 4 (spec 092)

`WorkflowSnapshot.schemaVersion` advanced `3 → 4`. A queue is no longer a
singleton, so "the" Run is no longer a thing the root can publish:

- **`queues: readonly QueueRuntime[]`** — one entry per registry entry, in
  position order. Each carries its own `lifecycle`, `phases`,
  `phaseOverrides`, `manualPause`, `phaseBreakpoints`, `pendingCount`,
  `tasks`, its own `scheduledStartAt`/`scheduledStartSource` (FR-R3-152 —
  sourced only from that queue's own persisted entry), and an
  `inFlightRun: InFlightRunProjection | null` holding the run-scoped readings
  (`runId`, `status`, `feature`, `pipeline`, `elapsedMs`, `liveActivity`,
  `delayedRetry`, `resumeTargetPhaseId`, `outputs`).
- **The v3 top-level per-run singulars were deleted, not deprecated.** There
  is no compatibility shim and no fallback: a webview reading `snapshot.status`
  or `snapshot.phases` fails to compile, which is the point — the compiler
  locates every consumer that still assumes one Run.
- **`isPrimary` stays at the root.** It is a property of this window against
  the workspace, not of any queue.
- **`auditTail` and `debugLogTail` stay at the root too, unpartitioned.** A
  line with no Run — a state migration, a queue mutation — belongs to no
  queue and must not be dropped. Per-queue scoping is a read-side join on
  `inFlightRun.runId`, not N partitioned copies.
- **A queue with no Run publishes `inFlightRun: null`** — the empty
  projection, never a borrowed neighbour's.

Read seams for that shape live in `webview-ui/src/lib/`:
`queue-runtime-view.ts` (`findQueueRuntime` — a caller must still name which
queue's Run it means), `queue-run-rows.ts` (folds a connected run into one
row per FR-047), and `queue-lifecycle-label.ts`.

Seven queue mutation commands feature 030 removed were reinstated in
`src/contracts/sidebar-ipc.ts` by feature 092; five still stand —
`CMD_CREATE_QUEUE`, `CMD_RENAME_QUEUE`, `CMD_DELETE_QUEUE`,
`CMD_SAVE_QUEUE_SETTINGS`, `CMD_MOVE_TASK`. The other two,
`CMD_SET_QUEUE_SCHEDULE` and `CMD_CLEAR_QUEUE_SCHEDULE`, were deregistered
again by feature 097 — not merely hidden — so neither has a
`COMMAND_AUTHORITY` entry, a validator, or a handler any more. Every
one of the five standing commands is a member of `MUTATING_COMMAND_TYPES`
(`src/contracts/sidebar-command-metadata.ts`), so every one is primary-host
gated, and every one has a host handler under `src/ui/sidebar/commands/`.
`CMD_REORDER_TASK` still drives drag-and-drop *within* a queue, while the
row menu's **Move up** and **Move down** post `CMD_MOVE_QUEUE_ITEM_UP` and
`CMD_MOVE_QUEUE_ITEM_DOWN`; `CMD_MOVE_TASK` is the across-queues move.

All five now have webview call sites. Feature 092 shipped them with
none — handler, validator, refusal codes and audit events on the host, and
nothing in any tier that posted them — and feature 095 added the controls:

| Command | Control | Component |
|---|---|---|
| `CMD_CREATE_QUEUE` | New Queue | `drilldown/QueuesTier.svelte` |
| `CMD_RENAME_QUEUE` | Settings | `drilldown/QueueDetailTier.svelte` |
| `CMD_DELETE_QUEUE` | Delete | `drilldown/QueueDetailTier.svelte` |
| `CMD_SAVE_QUEUE_SETTINGS` | Queue Settings | `QueueConfigModal.svelte` |
| `CMD_MOVE_TASK` | Move to… | `drilldown/QueueDetailTier.svelte` |

The commands feature 095 wired post from **one** module,
`webview-ui/src/lib/queue-control-ipc.ts`, on the same correlated-request terms
as `phase-log-ipc.ts` and `save-general-settings.ts`. The two that already had
call sites keep them; relocating working code to make the rule uniform would be
a diff with no requirement behind it.
`tests/lint/queue-command-reachability.test.ts` derives the mutating
queue-command set from `COMMAND_AUTHORITY` and fails the build if any
member has no non-test call site — the gap is now checked rather than recorded.

Only one schedule mechanism remains. Feature 092's `CMD_SET_QUEUE_SCHEDULE`
wrote `QueueRegistry.entries[].schedule`, was paired with no lifecycle, and
surfaced in `QueueDetailTier` as Arm/Re-arm/Disarm controls; feature 097
removed it and its controls entirely. The feature 065 **lifecycle** scheduled
start — which writes `QueueState.scheduledStartAt`, is paired with
`queueLifecycle === 'idle-pending'`, and surfaces in
`ScheduledStartIndicator.svelte` (relocated onto tier 2, inside
`QueueIdlePendingPanel.svelte`, by feature 097) — is now the only way to arm a
future start.

Per-queue **pause and resume** are not part of the five: `CMD_PAUSE_QUEUE` /
`CMD_RESUME_QUEUE` take an optional `queueId`. `drilldown/QueueDetailTier.svelte`
posts them scoped to its own `queueId`, and that is now the only sender.
`QueueGlobalActions.svelte` posted them unscoped; FR-R3-140 deleted it, so the
optional `queueId` currently has no caller that omits it — the host contract
still accepts one, and the parameter stays optional rather than being narrowed
on the strength of a single deletion.

### Per-queue Run projection (spec 093)

`schemaVersion` stays at **4**. Feature 092 gave the snapshot a shape with room
for one Run per queue while the engine still had exactly one Run to put in it;
093 made the Runs genuinely distinct and the wire shape needed no change. That
no component was edited to consume N Runs is the evidence 092's shape was the
right one — the churn is entirely on the host side of the boundary:

- **Attribution is a keyed lookup, not a scan.** `queue-runtime-composer.ts`
  used to ask each queue "do you hold a row whose id is `run.featureId`?"; it
  now calls `runOf(queueId)`, because the Run record is itself keyed by queue.
  With N Runs the old scan would have run N times per queue for an answer the
  key already holds.
- **The row-projection context is per queue, run-scoped readings included.**
  092 substituted only each queue's `inFlightId` and scheduled-start into one
  shared context, so every queue's in-flight row inherited the window Run's
  phase and pause cause. Harmless with one Run; a visible cross-queue leak with
  several. `rowContextFor(queueId, state)` is now built per queue.
- **`runOf` is memoized per snapshot.** Two callers ask for the same queue — the
  runtime list and the row projections — and `decoratePhases` mutates the tiles
  it is handed, so an unmemoized second build would hand out a second set of
  tile objects free to disagree with the first.
- **`snapshot.queue` is still the default queue's compat projection**
  (`projectQueue(queue, rowContextFor(DEFAULT_QUEUE_ID, queue))`). Anything
  reading it reads `default`, whatever else is executing. That is why
  `resolveLiveSelection` in `lib/activity-feed-selection.svelte.ts` follows the
  default queue's Run: follow-live tracks one Run by construction, and the
  drill-down tiers are the surface for watching a specific one among several.
- **Every lifecycle control names its queue.** `lib/phase-control.ts` and
  `lib/phase-breakpoint-ipc.ts` take a required `queueId` — the host refuses an
  unaddressed control at the IPC boundary, so a component that cannot say which
  Run it is acting on has no business posting the command. Retry-now stays out
  of the lib module: its `postCommand` must share a scope with the `useConfirm`
  that gates it, which needs component-level context. It was dispatched inline
  in `PhaseTracker.svelte`, which FR-R3-140 deleted as unreachable, so no
  webview component sends it today — the rule for where it would live is
  unchanged, and only the example is gone.
- **`PhaseControlMenu.svelte` targets two different props by design
  (FR-R3-151).** Pause, Resume, Restart, Skip, and Retry-now are inherently
  about the Task's *current* Phase and always dispatch `currentPhase`,
  regardless of which tile the operator has clicked. Disable, Enable, and
  Delete instead dispatch `selectedPhase` — the Feature 028 US3 prop that
  already carried breakpoint targeting — so an operator who selects a
  future or completed tile acts on that tile, not silently on whatever is
  active. A `null` `selectedPhase` disables those three controls; it never
  falls back to `currentPhase` (that silent fallback was the defect this
  feature closed). Disable and Enable also grey out unless the selected
  tile's *projected* state (`selectedPhaseState`, from `phase-projector.ts`)
  matches the host's eligibility for that operation — future for Disable,
  disabled-overridden for Enable — since these commands are fire-and-forget
  (no ack is awaited) and a refusal would otherwise reach nowhere visible.
  That is button affordance, not enforcement: the host — see
  `src/controller/phase-control-decision.ts` — is still the sole
  authoritative gate, and remains correct even if this mirrored check ever
  drifted from it.

**The aggregate status bar is a host surface, not this app's `StatusBar`.**
`src/ui/status-bar.ts` owns the VS Code window status bar item and, since 093,
summarizes across Runs: a plural count (`schegent: 2 runs`, `3 stalled`) when
several share a state, `running` outranking `stalled` outranking `paused` when
they differ, and one tooltip line per live Run with its phase and iteration. It
names no queue. `components/StatusBar.svelte` is the sidebar's own Status Row
zone and is unchanged — the two are different surfaces with the same word in
their names, so check which one a task means before editing.

### Sidebar outbound surface

The compact sidebar emits **only** `CMD_OPEN_DASHBOARD`. Any other operator-initiated mutation (cancel, resume, queue actions, history rerun, retry-active-run) is sent from the Dashboard webview or the VS Code Command Palette. This narrow surface is enforced by `tests/integration/sidebar-activation.host.test.ts`, which scans the sidebar bundle and asserts the four allowed `data-testid` containers (`sidebar-status-row`, `sidebar-stats-strip`, `sidebar-current-task`, `sidebar-open-dashboard-button`) plus `app-root` and rejects any reappearance of removed sidebar testids.

### Top-level routes (spec 012 / spec 064)

The Dashboard exposes seven peer top-level routes from
`dashboard/App.svelte` (the legacy two-tier `Operations / Settings` parent
with inner tabs is gone; Feature 064 added `System` as a sibling between
`Pipeline Builder` and `Settings`, and Feature 091 added `Runs` directly
after `Operations`). The route ids and their nav labels are declared in
`dashboard/routes.ts`:

| Route (id) | Nav label | Component | Purpose |
|---|---|---|---|
| `operations` | Queues | `components/OperationsSurface.svelte` | The three drill-down tiers (spec 092). Tier 2 (`drilldown/QueueDetailTier.svelte`) renders the task list, queue controls, an on-demand composer, and the scheduled-start indicator; tier 3 (`drilldown/RunDetailTier.svelte`) renders one run's phase progression, phase log feed, and outputs. Feature 097 deleted `components/Dashboard.svelte`, which tier 2 embedded until then. |
| `runs` | Runs | `components/RunsSurface.svelte` | The launch surface — Pipelines and Workflows, each listing only Active definitions, with an explicit select → Trigger → fulfil inputs → Run flow — plus connected composed runs and the Run composer. See "Connected-run surfaces" and "The launch surface" below. |
| `history` | History | `components/HistoryDashboard.svelte` | Completed-run history and rerun. |
| `metrics` | Metrics | `components/MetricsDashboard/MetricsDashboard.svelte` | On-demand audit-log rollup (spec 073). |
| `system` | System Log | `components/SystemTab.svelte` | **System-scoped audit entries** (lifecycle, queue/task control, scheduling, audit pipeline housekeeping). See "Audit surfaces" below. |
| `builder` | Builder | `components/PipelineBuilder.svelte` | Phases, Workflows, and Models editor with `RetryConditionEditor` / `RawJsonPhaseEditor` wiring. |
| `settings` | Settings | `components/SettingsSurface.svelte` | Two sub-tabs: **General** and **Fatal Signatures**. |

`DEFAULT_DASHBOARD_ROUTE` stays `operations` through every such addition —
a new surface earns its place in the nav, not on someone's landing page.
Every route but the default is lazily loaded through the `routeLoaders`
dynamic-import map. `operations` is the exception because it is where the
dashboard lands, so `OperationsSurface` makes the same bargain one level down:
tier 1 is synchronous, and tiers 2 and 3 — which between them pull in
the phase log feed and the `WorkflowRun` topology view — are imported on
descent. An operator who never drills in never loads them.

Single subscription to `snapshotStore` is in `dashboard/App.svelte`
(`$derived(snapshotStore.snapshot)`); every route receives the snapshot
as a `{snapshot}` prop (the System route reads `auditTail` directly
from the store).

### Drill-down locations under `operations` (spec 092)

The three tiers are **sub-locations beneath one route**, not nav peers.
`DashboardRoute`, `DASHBOARD_ROUTES` and `DEFAULT_DASHBOARD_ROUTE` are
unchanged by feature 092 — promoting a single-queue view and a single-run view
to siblings of Settings would put tier-2 and tier-3 surfaces in tier-1's nav.
`dashboard/routes.ts` gains a second, independent union:

| Location | Fields | Tier |
|---|---|---|
| `QueuesLocation` | `route: 'queues'` | 1 — every queue |
| `QueueDetailLocation` | `route: 'queue-detail'`, `queueId` | 2 — one queue |
| `RunDetailLocation` | `route: 'run-detail'`, `queueId`, `runId` | 3 — one Run |

`DashboardLocation` is their union; `DEFAULT_DASHBOARD_LOCATION` is tier 1.
Constructors (`queueDetailLocation`, `runDetailLocation`) return their own
member rather than the union, and `parentLocation` gives the tier a back
navigation lands on — tier 1 is its own parent, so callers need no
"anywhere left to go" check. A location carries exactly the ids its tier
displays: tier 3 keeps `queueId` alongside `runId` so back-navigation is a
field read rather than a lookup that can fail.

`components/OperationsSurface.svelte` is the only holder of a
`DashboardLocation`, and owns two things nothing else does:

- **Resolution.** A location is operator state and the snapshot is host
  state, so a destination can stop existing between snapshots. The rendered
  tier is *derived* from both — `resolveLocation` walks up to the nearest
  surviving tier — rather than the location being mutated, so there is no
  write-during-update and a destination that reappears resolves again on its
  own.
- **Position.** One scroll container for all three tiers with the offset
  remembered per location key, so walking back lands where the operator was.
  Selection is passed back down the same way; the tiers store none of it.

Each tier receives `isPrimary` from the snapshot root and offers no mutating
control without it. Travel between tiers stays available in a non-primary
window — reading is not a mutation.

### Connected-run surfaces (spec 091)

`components/RunsSurface.svelte` mounts the two components specs 087 and 088
shipped complete and that nothing outside their own tests imported:

| Component | Role |
|---|---|
| `components/WorkflowRun/WorkflowRun.svelte` | One connected run — identifiers, per-node states with actions, run status, and the continuation composer for a picked node. |
| `components/RunLauncher/RunLauncher.svelte` | Compose a new run against a Pipeline picked from `availablePipelines`. |

`RunsSurface` adds **no IPC command and no store subscription**. Everything it
renders was already in the projection — `connectedRuns`, `queue.orderedItems`,
`availablePipelines` — and the webview simply never read it. Both children read
zero stores and take everything as props, so the wrapper stays the thinnest
thing that can mount them: no derived state beyond what the markup branches on,
and no second opinion about behaviour the children already own.

Two non-decisions are load-bearing. A hydrating run is passed straight through
rather than filtered — `WorkflowRun` renders the loading state, and pre-filtering
would show the operator a run vanishing instead of a run loading. And the
composer stays closed until asked for, with the picker shown only when the
catalog has something to pick, because a live compose control over an empty
catalog is a control whose only outcome is a refusal.

Feature 098 revises the second of those in one direction and leaves it standing
in the other. The picker still appears only when there is something to pick, but
the **Start a Run** zone now stays mounted with nothing imported and shows the
empty-catalog guidance in place of the choices
(`data-testid="runs-surface-empty-catalog"`). Hiding the whole zone was right
when an empty catalog was a transient state of a product that shipped Pipelines;
it is wrong now that it is the state every install starts in, because it left the
operator no visible route from an empty catalog to a non-empty one and left
`RunLauncher.svelte` reachable from nowhere. The text comes from
[`src/contracts/empty-catalog-guidance.ts`](../src/contracts/empty-catalog-guidance.ts),
imported rather than restated, and both call sites go through
`emptyCatalogGuidance(count)`, which returns the guidance only when the count is
zero — so the empty state is derived from the projection and never stored as a
second flag to keep in step.

**This zone is the only instance, full stop.** It used to be only the only
*operator-visible* one: `PhaseTracker.svelte` rendered the same text from the
same source (`data-testid="phase-tracker-empty-catalog"`) while sitting in the
reachability `ALLOWLIST` as *"Superseded by RunDetailTier's phase list"*,
retired before feature 098 and imported by no panel root. FR-R3-140 deleted the
component and emptied that allowlist, so the qualifier has nothing left to
exclude. The live phase
strip is `drilldown/RunDetailTier.svelte`, which reads `runtime?.phases` and is
reachable only once a run exists, so it has no empty-catalog case to answer. The
host side is what makes the idle surface honest: `buildPhasesFromRun(null)`
returns **zero tiles** rather than the seven placeholders `buildEmptyPhases()`
used to invent (T055), so an idle tracker no longer claims a catalog that is not
there.

**A shipped `.svelte` view with no import path from a panel root now fails a
test.** `tests/lint/svelte-surface-reachability.test.ts` walks from the two
panel entry points, `src/main.ts` and `src/dashboard/main.ts`, across four
specifier shapes — `from
'…'`, bare `import '…'`, `import('…')`, and extension-less specifiers resolved
by trying `.ts`, `.svelte.ts`, `.svelte`, `/index.ts` — through `.ts` files as
well as `.svelte` ones, since two real edges (`lib/use-confirm.ts` →
`ConfirmDialog.svelte`, `hover-text-anchor-action.ts` → `HoverTextPortal.svelte`)
pass through TypeScript. `__tests__/` is skipped as both node and edge, so a
component reachable only from its own test counts as unreachable. Deliberately
retired components sit in a 10-entry `ALLOWLIST`, each with a recorded reason;
`WorkflowRun.svelte` and `RunLauncher.svelte` may never be added to it.

### The launch surface (spec 102)

Runs is now where work is **started**, and the only place it is started.
`components/Runs/` is a new owned directory under `RunsSurface`:

| Module | Role |
|---|---|
| [`LaunchableSection.svelte`](src/components/Runs/LaunchableSection.svelte) | One section — Pipelines or Workflows — listing only definitions with an active version |
| [`LaunchableRow.svelte`](src/components/Runs/LaunchableRow.svelte) | One offered definition and its **Trigger** control |
| [`LaunchableDetail.svelte`](src/components/Runs/LaunchableDetail.svelte) | The selected definition's trigger panel |
| [`WorkflowTriggerForm.svelte`](src/components/Runs/WorkflowTriggerForm.svelte) | Fulfil a Workflow's derived inputs, then Run — the first call site `launchWorkflow()` has ever had |
| [`LaunchAuthorityNotice.svelte`](src/components/Runs/LaunchAuthorityNotice.svelte) | The host's sentences about what a launch will have authority to do (an uncontained backend, a Phase whose capability set leaves something open or cannot be enforced), rendered as text, with a link to Settings. Mounted by `LaunchableDetail.svelte` and `RunLauncher.svelte`; it composes and derives nothing |
| [`launch-selection.ts`](src/components/Runs/launch-selection.ts) | Pure selection state: which definition is picked, across both sections |

The flow is explicit at every step — select, Trigger, fulfil inputs, Run — and
nothing starts on a click that was not the last one. The two sections read
`snapshot.launchables`, which the host projects (see ARCHITECTURE.md, "Launch
projection"); the webview derives no second list of its own, and a **missing**
`launchables` is the loading arm rather than an empty catalog.

Two contract facts the webview does not get to bend. A launch payload carries
**no `catalogVersion`** — provenance is resolved host-side inside
`validateRunRequest()`, and a payload arriving with one is refused rather than
sanitized. And a Workflow's trigger inputs are the host's derived ports,
recomputed per open and never persisted, so a form opened after a node's
Pipeline changed shape asks for the new ports and not the old ones.

The restructure moved both older components rather than retiring them.
`WorkflowRun.svelte` and `RunLauncher.svelte` are still mounted from
`RunsSurface.svelte` and still absent from the reachability `ALLOWLIST` — a
restructure that quieted the gate by allowlisting them would have deleted the
surfaces in every sense but the file listing.

### Settings sub-tabs (spec 012 reduction)

| Sub-tab | Component | Purpose |
|---|---|---|
| General | `components/settings/GeneralSettingsTab.svelte` | Renders every scalar `schegent.*` key from `snapshot.generalSettings` with adaptive form controls (boolean → checkbox, string → text, number → number, enum → dropdown, optional integer → number-with-clear) and a scope indicator (workspace / user / default). Save goes through the shared `lib/save-general-settings.ts` helper. |
| Fatal Signatures | `components/settings/FatalSignaturesTab.svelte` | Two sections: the read-only **Built-in registry** (rendered from the parity mirror at `lib/fatal-signature-registry.ts`) and the editable **Operator additions** list (text inputs with + Add / Remove controls). Save goes through the shared helper with the unprefixed key `fatalSignatures`. |

Feature 030 (US3) removed the **Queue** sub-tab and its
`QueueSettingsTab.svelte` / `save-queue-settings.ts` plumbing, on the
grounds that `MAX_QUEUES = 1` made a per-queue cap and a default-queue
selector meaningless. Feature 092 raised `MAX_QUEUES` back to 20 but did
**not** restore the sub-tab: per-queue configuration is reachable from the
Queue Detail tier (FR-064), and the workspace-wide concurrency cap — ranged
`1..20`, default `1` — is authored in `QueueConfigModal.svelte`, which submits
it together with the default-queue selection over `CMD_SAVE_QUEUE_SETTINGS`.
It is **not** on **General** and is not a `schegent.*` configuration key at
all: its value is workspace state, so it reaches the webview in its own
snapshot projection rather than in `snapshot.generalSettings`.

The Phases, Workflows, and Models editors are not in
`SettingsSurface` — they live in Builder, as its three tabs
(Phases / Workflows / Models, per spec 083, spec 096, spec 180 and spec 264).
This co-locates configuration with the workflows that consume it.

### Settings hover-text primitive (spec 018)

Every focusable control in the Settings sub-tabs is annotated by
the shared [`use:hoverTextAnchor`](src/components/hover-text/hover-text-anchor-action.ts)
Svelte 5 action (the primary call shape). The action picks the surface
deterministically from `description.body.length`:

- **≤ 80 chars** → renders an inline `<p id="desc-${controlId}">`
  beneath the control with a permanent `aria-describedby` link. No
  popover, no hover state.
- **> 80 chars** → wires `mouseenter` / `mouseleave` / `focus` /
  `blur` / `keydown(Escape)` listeners on the control itself and
  lazy-portals a `role="tooltip"` popover to `document.body` on
  hover/focus. The popover anchors to the control (no separate `(?)`
  trigger), opens after a 400 ms hover delay or instantly on focus,
  and respects a 100 ms mouseleave grace ("hover bridge") so the
  pointer can transit into the popover without flickering it shut.

The cutoff is enforced at action-attach time so a single description
payload can shift surface as the copy is tuned. The action is the only
form. `<HoverText>` was the advanced/secondary component this paragraph
used to point at, and FR-R3-140 deleted it: no shipping call site
imported it from either bundle entry point, so the old advice that "most
call sites should use the action" was already describing a tree where
every call site did. What remains under
[`components/hover-text/`](src/components/hover-text/) is the action's own
machinery — the anchor action, the positioning helper, the shared types,
and
[`HoverTextPortal.svelte`](src/components/hover-text/HoverTextPortal.svelte),
which the action mounts to render the popover.

Descriptions live in per-tab sibling modules —
`GeneralSettingsTab.descriptions.ts` and
`FatalSignaturesTab.descriptions.ts` — each frozen with
`as const satisfies { readonly [K in ControlId]: ControlDescription }`
so missing or stale keys fail the webview typecheck. Descriptions are
static webview state: the IPC contract is unchanged, no new host
roundtrip, no snapshot fields added. Coverage is enforced by the
parameterized structural test at
[`components/settings/__tests__/hover-text-coverage.test.ts`](src/components/settings/__tests__/hover-text-coverage.test.ts),
which mounts each tab, walks every focusable element, and asserts both
sides of the mapping (every control has either an inline
`aria-describedby` or a `data-hover-text-anchored="true"` marker, and
no description is orphaned).

### Shared `save-general-settings.ts` helper (spec 012)

[`webview-ui/src/lib/save-general-settings.ts`](src/lib/save-general-settings.ts) is the **single call site**
for `CMD_SAVE_GENERAL_SETTINGS` in the webview (FR-031). Every component
that wants to persist a scalar `schegent.*` setting (`GeneralSettingsTab`,
`FatalSignaturesTab`, …) calls `await saveGeneralSettings(updates)`. The
helper:

1. Generates a UUIDv4 correlation id.
2. Posts the envelope through `postCommand`.
3. Awaits the matching `CMD_ACK` (5-second timeout → `{ status:
   'rejected', reason: 'timeout' }`).
4. Concurrent saves are correlated by id and never cross-resolve.

A repo-grep regression test at
[`tests/lint/no-inline-save-general-settings.test.ts`](../tests/lint/no-inline-save-general-settings.test.ts)
fails the build if any new component references `CMD_SAVE_GENERAL_SETTINGS`
directly.

### Feature 017 queue and phase-task IPC

Feature 017 adds dashboard-only mutating commands for phase controls
(`CMD_PAUSE_PHASE`, `CMD_RESUME_PHASE`, `CMD_RESTART_PHASE`,
`CMD_SKIP_PHASE`, `CMD_DISABLE_PHASE`, `CMD_ENABLE_PHASE`), queue
pause/resume (`CMD_PAUSE_QUEUE`, `CMD_RESUME_QUEUE`), pending tasks
(`CMD_MODIFY_TASK`, `CMD_REORDER_TASK`, `CMD_REMOVE_QUEUE_ITEM`).
Feature 030 (US3) removed the multi-queue mutators
(`CMD_CREATE_QUEUE`, `CMD_RENAME_QUEUE`, `CMD_DELETE_QUEUE`,
`CMD_MOVE_TASK`, `CMD_SAVE_QUEUE_SETTINGS`, `CMD_SET_QUEUE_SCHEDULE`,
`CMD_CLEAR_QUEUE_SCHEDULE`) along with the per-queue schedule
surface. Feature 092 reinstated all seven; feature 097 deregistered two of
them again (`CMD_SET_QUEUE_SCHEDULE`, `CMD_CLEAR_QUEUE_SCHEDULE`), so five
stand today (see "Per-queue snapshot" above). Feature 092 also gave
`CMD_PAUSE_QUEUE` / `CMD_RESUME_QUEUE` an optional `queueId`; the unscoped
call still carries no payload at all.

Feature 022 widens deletion commands:

- `CMD_REMOVE_QUEUE_ITEM` requires `{ id, confirmed: true }` and can remove
  any task status after `ConfirmDeleteDialog.svelte` confirmation. FR-R3-161
  left it with exactly **one** host-side implementation. The router used to
  declare a second capability alongside the typed one — a boolean
  `queueRemover.remove(id)` reached by a fallback branch when no typed surface
  was wired — which dropped the row without cancelling the task's run or
  releasing its lease, and collapsed "no such task" and "not removable" into a
  bare `false`. The capability, the branch and the wiring that supplied it are
  all removed. An unwired host is now a structured refusal
  (`queue-ops-unavailable`, the same one the sibling task commands answer
  with), never a weaker deletion; the webview contract for the command is
  otherwise unchanged.
- `CMD_REMOVE_TASK_PHASE` requires `{ taskId, phaseId, confirmed: true }` and
  removes a task-scoped phase override without changing the global pipeline.

The new-task compose box and position selector `Dashboard.svelte` used to own
now live in `drilldown/QueueDetailTier.svelte`'s on-demand composer; its
per-queue controls (Pause / Resume / Clear Done / Clean All) live in
`QueueControls.svelte`, mounted in the same tier. `Dashboard.svelte` itself
was deleted by feature 097. `QueueItemActions.svelte` owns task
edit/delete confirmation. `QueueItem.svelte` owns the up/down reorder
arrows in the sidebar list (drag-and-drop + arrows route through the
shared helper at `webview-ui/src/lib/reorder-task.ts`).
`PhaseProgression.svelte` owns phase controls, phase deletion
confirmation, and phase-message metadata rendering only, never
message values. `webview-ui/src/lib/deletion-confirmation.ts` owns
the status-aware copy for both task and phase deletion; components
should not inline destructive copy or post deletion IPC without the
shared confirmation dialog.

### IPC additions (spec 011)

Two new mutating commands ride the existing `CMD_*` discriminated union:

- `CMD_SAVE_GENERAL_SETTINGS` — payload `{ updates: Record<key, value> }`. Host validates every key against `ALLOWED_KEYS` in `src/config/general-settings.ts` before writing and uses compensating rollback if a later workspace write fails. Webview pre-validates for UX but the host is the source of truth.
- `CMD_RETRY_PHASE_NOW` — payload `{ runId: string }`. Host cancels the watchdog timer, resets `delayedRetryCount`, optionally unpauses the queue (only when `pausedReason` matches `retry-cap-exhausted:<runId>`), and re-runs the phase within ~1 s.

Both commands are members of `MUTATING_COMMANDS` in `src/ui/sidebar/message-router.ts`. The primary-only gate rejects mutations from secondary VS Code windows with reason `secondary-window-readonly`.

**Feature 056 Track 1 (FR-001..FR-005)** reclassified the three catalog
saves (`CMD_SAVE_PIPELINES`, `CMD_SAVE_PHASES`, `CMD_SAVE_MODELS`) and
the general-settings save (`CMD_SAVE_GENERAL_SETTINGS`) as mutating:
they all write VS Code workspace configuration and must follow the
same primary-only gate. Secondary windows now receive `status:
'rejected'`, `reason: 'secondary-window-readonly'` for every catalog
save attempt; the regression coverage lives at
[`../tests/unit/ui/sidebar/save-commands-primary-gate.test.ts`](../tests/unit/ui/sidebar/save-commands-primary-gate.test.ts).
Read-only commands stay outside `MUTATING_COMMANDS` but still apply
their own primary-host handler gate (`reason: 'not-primary-host'`) —
that path is unchanged.

### Parity-mirror pattern

Three webview modules MUST stay byte-equivalent to their host counterparts:

| Webview mirror | Host source | Parity test |
|---|---|---|
| `webview-ui/src/lib/retry-condition.ts` | `src/lib/retry-condition.ts` | `tests/parity/retry-condition-parity.test.ts` (SC-011) — broad expression fixture; webview's verdict must match host on every input. |
| `webview-ui/src/lib/fatal-signature-registry.ts` | `src/lib/fatal-signature-registry.ts` (`FATAL_SIGNATURES`) | `tests/parity/fatal-signatures-parity.test.ts` — byte-identical literal. |
| `webview-ui/src/lib/generated/action-keys.ts` | `src/contracts/action-keys.ts` (`ACTION_KEYS`) | `tests/parity/action-key-parity.test.ts` — set equality plus a file-identity check, so a regression that collapses to reading one authority twice fails too. Also enforced by `npm run contracts:check`, which regenerates the mirror and names it when stale. |

All three open with the same `// GENERATED FILE — do not edit.` banner naming their source and
`npm run contracts:generate`. (This line used to describe a `// Mirror of ... — Do not modify without
updating both.` banner, which is a hand-maintenance instruction and no longer what any of the three
carries — they are generator output, and the banner says so.) CI fails the merge on any drift.

The third row is the one that earned the pattern. Before feature 193 the confirmation keys were **not**
mirrored: `src/state/confirm-suppression.ts` held the host allowlist, the webview declared its own
`ActionKey` union, and a comment on each side asserted the two matched. The webview offered sixteen
keys against eleven the host accepted, so five confirmation dialogs wrote a "don't ask again" the
host rejected as `unknown-action-key` — and the operator was asked again next time, with no error to
explain it. Two hand-maintained lists with comments claiming parity is the shape this table exists to
prevent.

The webview `WorkflowSnapshot` projection includes three new 011 fields with `undefined`-safe defaults: `delayedRetryCount`, `pendingRetryAt`, `pendingRetryCause`, and the new `generalSettings: GeneralSettings` payload. Components fall back to `IDLE_GENERAL_SETTINGS` when the host omits the field (legacy-tolerance per the contract).

Feature 019 adds two scalar keys to `generalSettings`: `runtimeLogLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'` (default `'INFO'`) and `runtimeLogFilePath: string` (default `''`, which the host resolves to `<workspaceRoot>/.schegent/syslog`). Both flow through the existing `CMD_SAVE_GENERAL_SETTINGS` channel via the shared `save-general-settings.ts` helper — no new IPC, no new snapshot envelope. `IDLE_GENERAL_SETTINGS` and the `scopes` map both gained matching entries (`'default'` scope for an unset value, `'workspace'` once an override is saved).

### IPC additions (spec 020)

Feature 020 introduces a **read-only** IPC surface for the Dashboard's
Phase Log Feed (Queue → Task → Phase → Iteration drill-in over
per-phase `stream.jsonl` files):

- `CMD_READ_PHASE_LOG` — payload `{ runId, queueId, pipelineId, phaseId, iteration? }`. Host validates the selection tuple against the current snapshot (queue known + task match across in-flight/pending/recent/history + phase membership in the pipeline catalog), reads the matching `stream.jsonl`, applies project → truncate (4096 UTF-8 bytes per body field) → sanitize at the IPC boundary, and returns a manifest of displayable entries plus `iterations` (most-recent-first, descending), `selectedIteration`, `skippedLines`, and `truncatedCount`.
- `CMD_START_PHASE_LOG_TAIL` — payload `{ runId, queueId, pipelineId, phaseId, iteration }`. Starts a `fs.watch` (or polling fallback) session for the selected iteration. **Cap of 1**: a new start tears down any existing session before the new one binds. Initial existing bytes are pushed, then new appends flow as they land.
- `CMD_STOP_PHASE_LOG_TAIL` — payload `{ }`. Tears down the active session.

Host → webview push channel:

- `MSG_PHASE_LOG_ENTRY` — `{ kind: 'entry' | 'tail-ended', entry?, reason? }`. Carries either a single projected/sanitized entry or a synthetic terminal `tail-ended` notice (`reason` ∈ `webview-stop` | `webview-dispose` | `phase-complete`).

All three commands were read-only and outside `MUTATING_COMMANDS`, so a secondary VS Code window could browse logs. `FR-R4-F05` gates them, because each appends an audit row: `COMMAND_AUTHORITY` declares them gated and not serialized, so an untrusted workspace and a secondary window are refused (see "What a refused command shows" in `docs/reference/api-and-cli.md`). They flow through the shared helper at [`webview-ui/src/lib/phase-log-ipc.ts`](src/lib/phase-log-ipc.ts) (single call site); a repo-grep regression test at [`../tests/lint/no-inline-phase-log-ipc.test.ts`](../tests/lint/no-inline-phase-log-ipc.test.ts) fails the build on any drift. No new snapshot envelope keys; no `AUDIT_SCHEMA_VERSION` or `STATE_SCHEMA_VERSION` bump (logs are derived from the existing diagnostics directory).

### Scoped Phase catalog manager (spec 081)

[`PipelineBuilder.svelte`](src/components/PipelineBuilder.svelte) carries
per-phase **Effort** and **Model** dropdowns plus a precedence badge
("shadowed by workspace" etc.) on each row. The Pipeline Builder
(reached via the top-level **Builder** route) remains the canonical
phase-editing surface; SettingsSurface intentionally does **not** carry
a Phases tab (spec 012 reduction).

The component reads the authoritative `snapshot.phaseCatalog` source-record
projection. It renders built-in, user, and workspace rows separately with
effective/shadowed/invalid status, bounded errors, revisions, and unavailable
models. `availablePhases` remains the effective runtime-only list. Built-ins are
read-only; drafts select user or workspace scope explicitly.

`webview-ui/src/lib/save-phases.ts` was the **single call site** for
`CMD_SAVE_PHASES` in the webview (FR-021 + research Decision 1). Feature 101
deleted it along with the command it wrapped (see the feature 101 amendment
below); what survives is the single-call-site property, now held by
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts). The behavior it
described, for the record: components called
`await savePhases({ scope, expectedRevision, mutation, phases })` rather than
constructing the envelope inline. The helper preserved structured accepted and
rejected acknowledgement details and mirrored the correlation behavior of
[`save-general-settings.ts`](src/lib/save-general-settings.ts), which
`catalog-lifecycle.ts` still follows step for step:

1. Generates a UUIDv4 correlation id.
2. Posts the envelope through `postCommand`.
3. Awaits the matching `CMD_ACK` (5-second timeout → typed timeout
   reject).
4. Concurrent saves are correlated by id and never cross-resolve.

Saves contained exactly one create/edit/duplicate/remove/reset intent and the
complete target layer. Delete additionally awaited
`useConfirm('catalog.remove-phase', ...)`. The UI remains pending until a
snapshot publishes the accepted revision.

**Amended by feature 100 (FR-R3-016), T509b.** `CMD_SAVE_PHASES` is retired, so
`no-inline-save-phases.test.ts` is gone with it and the single-call-site property
moved to
[`../tests/lint/catalog-lifecycle-dispatch.test.ts`](../tests/lint/catalog-lifecycle-dispatch.test.ts),
which pins all six lifecycle commands to one dispatch module,
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts). `save-phases.ts` still
exists and still exports `savePhases`, but it is now a **translation rather than
a transport**: it keeps the request shape this Builder already builds and hands it
to that module. A whole-layer save becomes a one-layer `CMD_PUBLISH_PACKAGE`
gated on the same `expectedRevision`; the `mutation` tag no longer travels,
because intent is declared by being the command it is — it is still read *here*
for the one thing a publish cannot express, since a `remove` is an omission from
a whole-array write and omitting a definition from a package leaves it exactly as
it was, so a removal routes to `deactivateDefinition` instead. The translation
exists so this surface keeps working while the store changes underneath it;
FR-R3-017 replaces the surface with one that speaks the lifecycle directly and
deletes `save-phases.ts`, `save-pipelines.ts`, and `save-workflows.ts` with it.

**Amended by feature 101 (FR-R3-017).** That replacement happened. The three
translation shims are **deleted**: `save-phases.ts`, `save-pipelines.ts`, and
`save-workflows.ts` no longer exist, and the editors call
[`catalog-lifecycle.ts`](src/lib/catalog-lifecycle.ts) directly —
`saveDefinitionDraft` per definition, quoting that definition's
`expectedDraftVersion` rather than a whole-layer revision. `save-models.ts` is
untouched: the Model Catalog is configuration, not a versioned definition, and it
stays outside the lifecycle (FR-041).

Everything a definition's lifecycle looks like on screen now lives under
[`src/components/Builder/`](src/components/Builder/): `DefinitionLifecycleRow`
(the state badge and the validity badge), `DefinitionLifecyclePanel` (the open
definition's created, modified and active-version cells, the saved defects the
Issues list below it leaves out, and the three parts named next),
`DefinitionActions` (the four operations, one dispatch
path), `DefinitionHistoryPanel` (the version list and one body at a time),
`ChangedFieldSummary` (what publishing would change), and `CatalogEmptyState`
(the empty-catalog front door, whose words come from the shared
`empty-catalog-guidance` constant so this surface and the Runs surface cannot
drift). Since feature 186 (D-1) the row holds only its two badges: the Phase
catalog list and the Workflow Library list mount it beside each item, and the
Phase editor beside its title. The panel mounts once, on the surface that
shows the open definition: the Phase editor page and the Workflow settings
inspector. The tab shell mounts nothing per-definition. The directory is a
scan root of
[`../tests/lint/no-html-interpolation-in-activity-feed.test.ts`](../tests/lint/no-html-interpolation-in-activity-feed.test.ts)
with an empty allowlist, because every string on it is document-sourced.

The scope vocabulary in the three sections below (built-in / user / workspace
layers, `shadowed` status, per-layer revisions) describes the pre-099 store and
is stale; feature 099 left one layer and feature 101 left the rows lifecycle
state where the scope badge used to be.

### Retired Pipeline catalog manager (spec 082, retired by FR-R5-F05 / spec 264)

`FR-R5-F05` retired the separate Pipelines Builder tab and its 14 `Pipeline*` editor components (`PipelineCatalogEditor.svelte`, `PipelineFlowBuilder.svelte`, `PipelineFlowCanvas.svelte`, `PipelineFlowNode.svelte`, `PipelineFlowTopBar.svelte`, `PipelineInspector.svelte`, `PipelineLibraryList.svelte`, `PipelinePhasePalette.svelte`, `PipelinePortsEditor.svelte`, `PipelineToolbar.svelte`, `PipelineFieldErrors.svelte`, `pipeline-catalog-state.ts`, `pipeline-catalog-store.svelte.ts`, `pipeline-flow-view.ts`). Ordered Phase sequences, public input/output ports, bindings, execution defaults, and `recommendedNext` are now authored directly inside the unified **Workflows** tab (`WorkflowCatalogEditor.svelte`).

### Unified Workflow catalog manager and Graph Builder (spec 083, spec 264)

A **Workflow definition** is a reusable acyclic graph of Phase nodes (`kind: 'phase'`) and child Workflow nodes (`kind: 'workflow'`) — distinct from the run-side `WorkflowRun`, whose surfaces this section does not touch. Both senses are recorded in [`../docs/reference/glossary.md`](../docs/reference/glossary.md).

The editor reads the authoritative `snapshot.workflowCatalog` source-record projection and `snapshot.phaseCatalog` — effective or invalid status, bounded field errors, revision, and warnings. A Workflow's public `inputs` and `outputs` can be authored explicitly alongside `bindings`, `executionDefaults`, and `recommendedNext`.

`PipelineBuilder.svelte` mounts it behind the **Workflows** tab (the Builder's tab bar is Phases / Workflows / Models) and supplies the `trusted` verdict, derived from `snapshot.resolvedTrust.workflowOverrides` under the workspace-trust ceiling.

Ownership, given the per-component LOC budget `PipelineBuilder.svelte` sits under, which is
`MAX_LINES` in [`tests/lint/svelte-component-loc-budget.test.ts`](../tests/lint/svelte-component-loc-budget.test.ts):

| File | Owns |
|---|---|
| [`WorkflowCatalogEditor.svelte`](src/components/PipelineBuilderEditors/WorkflowCatalogEditor.svelte) | The Library, drill-down navigation stack, draft lifecycle, revision handshake, and the save |
| [`WorkflowLibraryList.svelte`](src/components/PipelineBuilderEditors/WorkflowLibraryList.svelte) | The row list, each row's Phase/child-Workflow node sequence, and its input/output ports |
| [`WorkflowFlowTopBar.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowTopBar.svelte) | The head's left half: the breadcrumb, the switcher that opens `WorkflowLibraryList.svelte`, and the state, validity and unsaved chips |
| [`WorkflowToolbar.svelte`](src/components/PipelineBuilderEditors/WorkflowToolbar.svelte) | The action bar, the "no effective Phase" explanation beside the control it disables, and Export |
| [`WorkflowFlowBuilder.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowBuilder.svelte) | The three panes, the selection that ties them together and the Escape that clears it, and what the dashboard's status line says the canvas selected, added, moved or deleted |
| [`WorkflowActionPalette.svelte`](src/components/PipelineBuilderEditors/WorkflowActionPalette.svelte) | The "Add steps" palette: Phases, child Workflows and Split, the search that `/` focuses, and the collapse to the rail |
| [`WorkflowFlowCanvas.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowCanvas.svelte) | The graph surface: one subtree per start, plus the separate lane for nodes no start reaches; a press on its ground shows the Workflow |
| [`WorkflowFlowSubtree.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowSubtree.svelte) | One card and everything below it, rendering itself per arm so a fork nests instead of flattening |
| [`WorkflowFlowNode.svelte`](src/components/PipelineBuilderEditors/WorkflowFlowNode.svelte) | One step card: the box, the one button that selects it, its badges and its visually hidden defect list, then `WorkflowNodeToolbar.svelte` while it is selected and `WorkflowChildPreview.svelte` on a child Workflow step. While selected, the box takes Delete and Backspace from its own buttons |
| [`WorkflowNodeToolbar.svelte`](src/components/PipelineBuilderEditors/WorkflowNodeToolbar.svelte) | The selected card's Move earlier, Move later and Delete |
| [`WorkflowChildPreview.svelte`](src/components/PipelineBuilderEditors/WorkflowChildPreview.svelte) | A child Workflow card's preview line: the child's steps, listed on request, and the link that opens its definition |
| [`WorkflowInspector.svelte`](src/components/PipelineBuilderEditors/WorkflowInspector.svelte) | Which inspector shows: a branch, a step, or, with neither selected, the Workflow |
| [`WorkflowSettingsInspector.svelte`](src/components/PipelineBuilderEditors/WorkflowSettingsInspector.svelte) | The Workflow: status, with how many steps no start reaches, dependent parent Workflows, issues, identity, `WorkflowPortsAndBindingsEditor.svelte`, execution defaults, `recommendedNext`, and the Candidate Block |
| [`WorkflowNodeInspector.svelte`](src/components/PipelineBuilderEditors/WorkflowNodeInspector.svelte) | One step, in four tabs: Step (what it runs, its label, whether the Workflow may begin there, and adding a branch), Data, Control and Advanced |
| [`WorkflowNodeControlChoice.svelte`](src/components/PipelineBuilderEditors/WorkflowNodeControlChoice.svelte) | How a step runs, once, Repeat or For each, asking before a switch discards a control's settings |
| [`WorkflowNodeControlEditor.svelte`](src/components/PipelineBuilderEditors/WorkflowNodeControlEditor.svelte) | The settings of the Repeat or For each a child Workflow step carries |
| [`WorkflowPortsAndBindingsEditor.svelte`](src/components/PipelineBuilderEditors/WorkflowPortsAndBindingsEditor.svelte) | Public Workflow `inputs`, `outputs`, and node `bindings` |
| [`CandidateBlockEditor.svelte`](src/components/PipelineBuilderEditors/CandidateBlockEditor.svelte) | The Candidate block section's body (FR-R5-F32): turning the block on and off, its availability policy, dispatch cap, monitoring window and spend ceiling, then its ordered candidates, each with its Phase, priority, attempts, retry delay and counted trial, and that Phase's runner, model and instruction shown read-only |
| [`WorkflowBranchInspector.svelte`](src/components/PipelineBuilderEditors/WorkflowBranchInspector.svelte) | One branch — its endpoints, handoff mode (`auto`/`manual`), and its condition, through `WorkflowConditionFields.svelte` |
| [`WorkflowConditionFields.svelte`](src/components/PipelineBuilderEditors/WorkflowConditionFields.svelte) | A branch's condition: closed-set selects for everything that decides its meaning (FR-021), and the one free-text literal (FR-024) |
| [`workflow-flow-layout.ts`](src/components/PipelineBuilderEditors/workflow-flow-layout.ts) | Pure layout — placement, arm order, and the `isJump` verdict that terminates the recursion; pinned by [`workflow-flow-layout.test.ts`](src/components/__tests__/workflow-flow-layout.test.ts) |
| [`workflow-flow-view.ts`](src/components/PipelineBuilderEditors/workflow-flow-view.ts) | What the canvas components pass between themselves, where the selection goes after a move, and the words the status line gives a selection and a move; pinned by [`workflow-flow-view.test.ts`](src/components/__tests__/workflow-flow-view.test.ts) |
| [`workflow-node-control.ts`](src/components/PipelineBuilderEditors/workflow-node-control.ts) | The three ways a step runs, and the default Repeat and ForEach controls (FR-R5-F33 / FR-R5-F34) |
| [`workflow-node-data.ts`](src/components/PipelineBuilderEditors/workflow-node-data.ts) | Where each input of a step comes from, for the Data tab, read the way the host decides an input is bound |
| [`workflow-field-words.ts`](src/components/PipelineBuilderEditors/workflow-field-words.ts) | The words the inspector shows for contract values; every select keeps the value it saves |
| [`WorkflowRowDefects.svelte`](src/components/PipelineBuilderEditors/WorkflowRowDefects.svelte) | Field-associated defect regions (`aria-describedby` → `role="alert"`) |
| [`workflow-catalog-state.ts`](src/components/PipelineBuilderEditors/workflow-catalog-state.ts) | Pure draft logic — the rules an edit applies, as pure functions of a draft row. [`WorkflowCatalogEditor.svelte`](src/components/PipelineBuilderEditors/WorkflowCatalogEditor.svelte) records every edit in one place, `applyRowEdit`, which field edits reach through `patchSelected` and graph edits through `applyGraphEdit` |
| [`workflow-catalog-actions.ts`](src/components/PipelineBuilderEditors/workflow-catalog-actions.ts) | The destructive writes, each with its confirmation in the same scope as the mutation it authorises |

Connections address a node by its stable `nodeId`, never by index — the inverse
of a Pipeline binding's `phaseIndex`, which must be remapped on every reorder.
A connection **condition** is structured data (`{ left, operator, right? }`)
compared field-wise against closed enums; there is no string form, parser,
evaluator, or sandbox, and there must never be one.

`webview-ui/src/lib/save-workflows.ts` was the **single call site** for
`CMD_SAVE_WORKFLOWS` — deleted by feature 101 with the rest of the whole-array
save path (see the feature 101 amendment above) — with the same UUIDv4
correlation, `snapshotStore.markPending`, one-shot ack listener, and 5-second
timeout as `save-pipelines.ts`. It does not reuse `save-catalog-command.ts`
because that helper discards `ack.result`, and a `stale-catalog` or
`workflow-validation` rejection carries the structured payload the Builder
needs to anchor a host defect to a field path. The request is forwarded
verbatim: authored node and connection order is part of the payload's meaning
(FR-049), so nothing client-side sorts, dedupes, or normalizes the graph.
[`../tests/lint/no-inline-save-catalog.test.ts`](../tests/lint/no-inline-save-catalog.test.ts)
fails the build if a component posts the command inline;
[`../tests/lint/destructive-actions.lint.test.ts`](../tests/lint/destructive-actions.lint.test.ts)
covers the `catalog.remove-workflow` and `catalog.reset-workflows` confirmations.

The UI stays pending after a save until a snapshot arrives whose
`revisions[scope]` differs from the one submitted, or a rejection is received —
waiting on the revision rather than the ack, since the ack only says the host
accepted the write. With an empty or wholly invalid effective Pipeline catalog
the editor explains the prerequisite and disables save rather than offering a
control that cannot succeed; a refreshed snapshot carrying a newly valid
Pipeline re-enables it without a reload.

### Process document exchange (specs 084 / 085 / 086 / 263)

The Phase and Workflow catalog managers can hand a definition to another installation as
a YAML document, and take one back (`FR-R5-F04` retired `kind: Pipeline` exchange). The Model Catalog (spec 096) joins the same
**Import…**/**Export** buttons and file dialogs with a structurally separate
shape rather than a catalog-manager subsection of its own — see the
ownership table and "A third arm, structurally apart" below, and
[Inspect an import](../docs/operations/process-yaml.md#inspect-an-import) and
[Confirm the plan](../docs/operations/process-yaml.md#confirm-the-plan) for the
operator-facing procedure, which covers a Model Catalog document too. The webview owns the operator's decisions;
the host owns the file. **No filesystem path crosses this boundary in either
direction** — the webview names no path, receives none, and no plan row, payload,
or message may carry one. Export reports only whether a document was written, and
a write failure reports generically, because an adapter's own error text can name
the location it tried to write.

| File | Owns |
|---|---|
| [`process-yaml-ipc.ts`](src/lib/process-yaml-ipc.ts) | The **single call site** for the whole exchange family: `exportPhaseYaml`, `exportWorkflowYaml`, `exportModelCatalogYaml`, `preflightProcessYaml` |
| [`ProcessExportButton.svelte`](src/components/ProcessImport/ProcessExportButton.svelte) | The per-Phase Export item of the Phase editor's "More phase actions" menu, and its disabled reason |
| [`WorkflowToolbar.svelte`](src/components/PipelineBuilderEditors/WorkflowToolbar.svelte) | The Workflow Export control **and its two-mode inclusion list** (`references-only` / `include-closure`) |
| [`ModelCatalogEditor.svelte`](src/components/PipelineBuilderEditors/ModelCatalogEditor.svelte) | The Model Catalog's own Export control — unconditional, since a Model Catalog document always resolves, even an empty one (FR-007) |
| [`ProcessImportPreflight.svelte`](src/components/ProcessImport/ProcessImportPreflight.svelte) | The import flow shell and the one-request package commit, branching to `runModelCatalogImportCommit` for a Model Catalog plan |
| [`ProcessImportPlanTable.svelte`](src/components/ProcessImport/ProcessImportPlanTable.svelte) / [`ProcessImportResultsTable.svelte`](src/components/ProcessImport/ProcessImportResultsTable.svelte) | Plan rows before the confirm, result rows after it — a Model Catalog row's fields (`backend`, `modelId`) replace the shared `resourceId`/`name` shape |
| [`process-import-state.ts`](src/components/ProcessImport/process-import-state.ts) | Pure projection — row labels, reason lines, `confirmBlockedReason`, `commitOutcome`, and `buildImportPackage`/`runImportCommit` (the one package request and its per-layer result); `modelCatalogImportRows`, `isModelCatalogPlan`, and `runModelCatalogImportCommit` are the Model Catalog's structurally separate, single-write counterparts |
| [`save-models.ts`](src/lib/save-models.ts) | `saveModelsImport` — the Model Catalog's own `CMD_SAVE_MODELS` call site for a confirmed import; kept apart from the pre-existing `saveModels` manual add/remove path rather than widening that function's signature |
| [`process-exchange-entry.ts`](src/components/ProcessImport/process-exchange-entry.ts) | The three preconditions a manager must decide before offering the controls |

**A third arm, structurally apart.** A Model Catalog plan never mixes with
Phase/Workflow rows in the same plan (FR-015), so it does not fit the
definition-package shape described next: there is no inclusion-depth
choice on export (`ModelCatalogEditor.svelte`'s button always produces the
whole catalog, every backend, as one document) and no multi-layer package on
import — a confirmed Model Catalog plan writes once, through
`saveModelsImport` (`save-models.ts`), never through the
`buildImportPackage`/`runImportCommit` path the rest of this section
describes. See
[Inspect an import](../docs/operations/process-yaml.md#inspect-an-import) for the
plan-row outcomes.

**Two definition export arms.** A Phase has no dependencies,
so `exportPhaseYaml` takes an id and nothing else. A composable Workflow (`FR-R5-F04`)
may reference Phases and child Workflows to arbitrary bounded depth, so its
control offers two modes (`references-only`, `include-closure`). The vocabularies are
declared per kind in `src/contracts/sidebar-ipc/process-yaml.ts` and both runtime
validators route through the single `admitsExportInclusion(resourceKind,
inclusion)` gate — one function rather than a copy per validator, because two
copies drift and a mode then compiles but is rejected at run time.

The inclusion choice lives in the toolbar's local state: it describes how *this
operator* is handing the definition over, not a property of the Workflow, so it
survives changing the selection rather than resetting under someone exporting
several rows in a row. Nothing is persisted, and the default is the smallest
document.

Only one export precondition is decided webview-side — an **unsaved draft**,
because export reads the catalog and a draft is not in it yet. Nothing else is
pre-checked: a stored Workflow whose Phases or child Workflows are missing from
the effective catalog is still exportable in `references-only` mode with its
graph intact, and whether a closure resolves is the host's decision, since only
the host reads the effective catalog.

**Plan rows name the dependency's kind, and chain to the root cause.** A blocked
row reads its dependency's `kind` (`'phase' | 'workflow'`) from the reason rather
than assuming one — a Workflow node may wait on a Phase or a child Workflow.
When the dependency is *itself* blocked, the row renders two lines: what this row
waits on, and the chain through to what would unblock it. Every identifier in
those lines is the host's already-sanitized, already-bounded value and is never
re-bounded — a second cap would disagree with the first and truncate an id the
operator has to find in the catalog.

**The commit is one package request, not several writes.** A confirmed package
commits through `runImportCommit`: `buildImportPackage` yields one request with a
layer per kind that has `import` rows (Phase, Workflow), each layer
carrying the `expectedRevision` its plan was computed against, and
`publishDefinitionPackage` (`CMD_PUBLISH_PACKAGE`) sends it once. The host
validates the whole document before it writes anything, then drafts the layers and
publishes them in dependency order — Phases first, then child Workflows before
parent Workflows (feature 254, feature 260, feature 263). Import adds **no**
mutating IPC command of its own, so it inherits the package publish's
revision-before-trust ordering unchanged, and what the operator sees is that one
acknowledgement read layer by layer (`layerResultsOf`).

The host **never compensates with a delete**: whichever prefix landed stays
written, and the outcome is reported as `partial` rather than repaired. The
recovery is two steps, because a package publish publishes only what its own
operation wrote and the next preflight counts a draft as present: publish any draft
the import left from the Builder, then inspect the same document again. Rows
already in the catalog, drafts included, plan as `skip`, so the second import
writes only what is still missing.

### New built-in pipeline: `speckit-bugfix` (spec 026)

The new-task pipeline selector, relocated by feature 097 to
`QueueInputForm.svelte` (mounted in `drilldown/QueueDetailTier.svelte`'s
on-demand composer; see "Feature 017 queue and phase-task IPC" above), listed two built-in
pipelines (`speckit-new-feature`, `speckit-bugfix`) and defaulted to the
first. Feature 098 ships neither: the selector lists whatever
`availablePipelines` carries, which is empty until the operator imports a
document. `defaultSelectedPipelineId` preselects `defaultPipelineId` when it
names a Pipeline in the list and the first available one otherwise; `''` names
none, so an unset default preselects the first row rather than an id the
operator cannot see. There was a second, shortcut form in
`ControlPanel.svelte` that did NOT include the selector and fell back to the
controller's default pipeline (research Decision 6). FR-R3-140 deleted that
component as unreachable, so the selector-less path is gone with it. Feature
285 deleted `QueueInputForm.svelte` too: the Queue detail tier always mounts
[`QueueTaskComposer.svelte`](src/components/QueueTaskComposer.svelte), which
lists Workflows only and is the form that starts a task.

### IPC additions (spec 028 — Advanced phase pausing)

Feature 028 adds two new **mutating** IPC commands for future-phase
breakpoints:

- `CMD_SET_PHASE_BREAKPOINT` — payload `{ runId, phaseId }`. Host validates
  per Decision 10 (run in-flight, phase exists in the immutable pipeline,
  not active, not completed, no override action, not already armed),
  appends a one-shot `PhaseBreakpoint` to `WorkflowRun.phaseBreakpoints`,
  persists, and emits `phase-breakpoint-set`.
- `CMD_CLEAR_PHASE_BREAKPOINT` — payload `{ runId, phaseId }`. Filters
  the matching entry out of `WorkflowRun.phaseBreakpoints` and emits
  `phase-breakpoint-cleared { cause: 'operator' }`.

Both commands are members of `MUTATING_COMMANDS` (primary-host gated).
They flow through the shared helper at
[`webview-ui/src/lib/phase-breakpoint-ipc.ts`](src/lib/phase-breakpoint-ipc.ts)
(single call site); the repo-grep regression at
[`../tests/lint/no-inline-phase-breakpoint-ipc.test.ts`](../tests/lint/no-inline-phase-breakpoint-ipc.test.ts)
fails the build on any drift.

The existing `queue-paused` and `queue-resumed` audit events now carry
a required `source: 'operator' | 'cascade'` field so a snapshot reader
can distinguish operator-driven queue pauses from cascade-driven ones.
Three new audit event types are additive (no `AUDIT_SCHEMA_VERSION`
bump): `phase-breakpoint-set`, `phase-breakpoint-cleared`,
`phase-breakpoint-fired`. All payloads route through the existing
single-sanitization point in `audit-log-writer.ts`.

Snapshot envelope additions:

- `WorkflowSnapshot.phaseBreakpoints: readonly { phaseId: string }[]`
  — projected from `WorkflowRun.phaseBreakpoints`, sorted by `setAt`.
- `WorkflowSnapshot.resumeTargetPhaseId: string | null` — mirrors the
  run field; non-null iff `manualPauseCause === 'breakpoint-paused'`.
- `WorkflowSnapshot.activeRunId: string | null` — the in-flight run id
  (distinct from `activeTaskId`); the webview needs this to address
  the two new IPC commands.
- `QueueItemSnapshot.pauseCause` union extended with `'breakpoint'` so
  the task-level pause badge can render "Paused (breakpoint)".
- `WorkflowSnapshot.manualPauseCause` union extended with
  `'breakpoint-paused'`.

`STATE_SCHEMA_VERSION` is bumped 4 → 5 to carry `phaseBreakpoints`,
`resumeTargetPhaseId`, and `QueueRegistryEntry.pauseSource`. The
forward migrator defaults `phaseBreakpoints: []`, `resumeTargetPhaseId:
null`, and `pauseSource: 'operator'` for already-paused queues.

### IPC additions (spec 063 — Clean All + universal confirmations)

Feature 063 collapses the old "Clear completed" + "Clear failed" pair
into a single **Clean All** button and gates every destructive postCommand
site behind a universal confirmation prompt. Two new **mutating** IPC
commands:

- `CMD_CLEAR_ALL` — payload `{}`. Routes to `QueueManager.clearAll()` on
  the primary host, which performs an atomic reset of five surfaces in one
  state transaction: (1) every queue entry, (2) the active `WorkflowRun`,
  (3) the queue pause state, (4) any `ScheduleWatchdog` backoff window,
  (5) all watchdog-pending timers. Emits one `queue-cleared-all` audit
  event with the pre-clean counts. Replaces the legacy
  `CMD_CLEAR_COMPLETED` and `CMD_CLEAR_FAILED` commands (both removed).
- `CMD_SET_CONFIRM_SUPPRESSION` — payload `{ actionKey, suppressed }` where
  `actionKey` is one of the 11 destructive `ActionKey` members. Persists
  the per-action "Don't ask again" choice into webview-scoped settings.

Both commands are members of `MUTATING_COMMANDS` (primary-host gated).

FR-R3-150 retired `CMD_CLEAR_ALL` as a sidebar-postable command: Clean All now
posts the queue-scoped `CMD_CLEAR_QUEUE` (`{ queueId }`) instead, and the
workspace-wide reset above survives only as the Command Palette's
`schegent.clearAll`. `CMD_CLEAR_COMPLETED` also gained a required `queueId`
in the same feature. See `docs/reference/api-and-cli.md` for the current
payload shapes; the two paragraphs above describe feature 063's original
shape and are not kept current after this.

Every destructive postCommand site flows through the shared confirmation
helper at
[`webview-ui/src/lib/use-confirm.ts`](src/lib/use-confirm.ts) —
`useConfirm(actionKey, options)` returns `Promise<boolean>`. The helper
short-circuits in three cases: (a) the global `schegent.ui.confirmations.enable`
setting is `false`, (b) the per-action suppression flag is set, (c) another
modal already owns the single-modal lock. Otherwise it imperatively
mounts the `ConfirmDialog` component and resolves on Confirm/Cancel.
Static copy for every `ActionKey` lives in
[`webview-ui/src/lib/action-copy.ts`](src/lib/action-copy.ts) (title, body
template, confirm label, danger flag); several entries substitute runtime
context via `renderActionBody` — Clean All (`pendingCount`,
`inflightTitle`, etc.) and, as of FR-R3-153, `queue.remove-item`, whose
context carries the task's `status` alongside `taskTitle` so the rendered
body names that status's real deletion consequence (pending/in-flight/
paused/terminal each read differently) rather than one generic sentence.
As of FR-R3-150 the two queue-cleanup entries (`queue.clean-all`,
`queue.clear-done`) also carry `queueId`/`queueName`, so the body names
the queue being wiped instead of "the queue", and Clean All's context
carries `hasSchedule` — a queue whose only leftover state is an armed
scheduled start still has something to clear (LC-Q-05), so the prompt
says so rather than reading as a no-op. Those two templates substitute in
a **single regex pass** over the original template rather than a chain of
`.replace()` calls: queue names and task titles are operator-authored with
no character restriction, and a chain re-scans text a prior call just
substituted in, so a queue named `{pauseSummary}` or a task titled `$&`
would be re-matched and corrupted by a later call in the chain.
The repo-grep regression at
[`../tests/lint/destructive-actions.lint.test.ts`](../tests/lint/destructive-actions.lint.test.ts)
fails the build on any destructive `postCommand(...)` call that is not
preceded by a matching `useConfirm(...)` await.

One new audit event type is additive (no `AUDIT_SCHEMA_VERSION` bump):
`queue-cleared-all { removedPending, removedInFlight, pauseStateCleared,
runnerState, watchdogBackoffCleared, scheduleCleared }`. `scheduleCleared` is
the newest field (FR-R3-150 T1619c, additive) and reports whether the reset
disarmed at least one queue's scheduled start; it is a bare boolean because
this event is the workspace-wide one and the per-queue record of a disarm is
`scheduled-start-canceled`, which the coordinator emits per queue id. The
earlier six-field `{ pendingCount, completedCount, failedCount, canceledCount,
hadActiveRun, hadCascadePause }` shape recorded here never matched
`QueueClearedAllPayload` in
[`../src/contracts/audit-events.ts`](../src/contracts/audit-events.ts), which
is the source of truth for it.

FR-R3-150 adds a second, likewise additive: `queue-cleared { queueId,
removedPending, removedCompleted, removedFailed, removedCanceled,
removedInFlight, pauseCleared, scheduleCleared, runnerState }`, emitted once
per confirmed, non-no-op `CMD_CLEAR_QUEUE`. It is deliberately distinct from
`queue-cleared-all` rather than a variant of it with a `queueId` field: the
two record different operator decisions, and an audit reader answering "was
this whole workspace reset?" must not have to inspect a payload field to find
out. The payload carries the queue **id** and never its operator-authored
name, matching `queue-created`/`queue-deleted`.

### IPC additions (spec 064 — System tab and task-scoped Activity Feed)

Feature 064 adds **no new IPC commands** and **no new audit event types**.
It is a pure presentation-layer split powered by two additive fields on
each `AuditTailEntry`:

- `runId: string` — copied byte-for-byte from `AuditEntry.runId` by the
  projector. The Activity Feed uses it to gate visibility on the live-run
  reference set (`activeRunId ∪ queue.inFlight.id ∪ queue.pending[*].id
  ∪ queue.recent[*].id ∪ history[*].runId`).
- `scope: 'task' | 'system'` — produced by `classifyAuditEvent(eventType)`
  in [`../src/contracts/audit-events.ts`](../src/contracts/audit-events.ts).
  The closed `SYSTEM_SCOPED_EVENT_TYPES` set is the single source of
  truth; a TS `never` exhaustiveness assertion in
  [`../tests/unit/audit-events/event-classification.test.ts`](../tests/unit/audit-events/event-classification.test.ts)
  fails `tsc` if a new `AuditEventType` literal is added without being
  classified. Unknown event types default to `'task'` (FR-011), preserving
  the existing "Never drop unknown audit event types from the parser"
  invariant.

Both fields are added inside the existing frozen-object return of
[`projectAuditEntry`](../src/ui/sidebar/audit-tail-projector.ts). No
`AUDIT_SCHEMA_VERSION` bump (additive fields on a projected shape only),
no `STATE_SCHEMA_VERSION` bump. Legacy snapshots without `scope` are
treated as `'task'` per FR-013 (the AuditTail/SystemTab tests pin both
legacy-tolerance directions).

The `SystemTab.svelte` component is owned by Feature 064 and lives at
[`src/components/SystemTab.svelte`](src/components/SystemTab.svelte).
It is the dashboard's exclusive surface for system-scoped audit entries
and is **never** gated by runId reachability — `queue-cleared-all` and
other lifecycle/housekeeping events always render here (FR-015).

### IPC additions (spec 068 — Enhance System Log)

Feature 068 adds **no new IPC commands** and **no new audit event types**.
It extends `AuditTailEntry` with four optional fields populated by the
existing `projectAuditEntry`:

- `taskId?: string` — first-non-empty of `payload.taskId`,
  `payload.taskID`, `payload.queueItemId`.
- `phaseId?: string` — first-non-empty of `payload.phaseId`,
  `payload.phase`, envelope `entry.phase` (when not `'done'`).
- `outcome?: 'success' | 'error' | 'pending'` — normalized from the
  envelope `outcome` field; envelope `'failure'` → projected `'error'`.
- `command?: string` — populated only when `entry.eventType ===
  'cli-invocation'`; carries the spawned argv joined with spaces. The
  field flows through the existing audit-writer `logger.sanitizeRecord()`
  path before persistence (no new redaction).

All four are additive on the frozen projection (no `AUDIT_SCHEMA_VERSION`
bump). Legacy entries that lack any of these fields render with the
explicit-absence marker `—` per FR-009. The on-disk JSONL format is
unchanged; the only new payload field is `cli-invocation.command` and the
existing parser tolerates it.

The System tab also restores its tail on cold-start by reading
`.schegent/audit.log` once at snapshot bootstrap (see
[`../src/ui/sidebar/audit-tail-coldstart.ts`](../src/ui/sidebar/audit-tail-coldstart.ts)).
The filter is widened so `cli-invocation` entries cross-list in the
System tab regardless of `scope` (FR-011).

### IPC additions (spec 065 — Enqueue/Start separation)

Feature 065 separates enqueue from start. Tasks land in the queue
without auto-promotion; the operator (or a scheduled-start timer)
explicitly chooses when the queue begins draining. The webview owns
three new surfaces and one cross-component shared store:

**Components** (owned by feature 065):

- [`src/components/StartModeChooser.svelte`](src/components/StartModeChooser.svelte)
  — non-modal inline chooser surfaced when the operator triggers a Start
  on an `idle-pending` queue. Exposes "Start now" and "Start in
  HH:MM:SS" affordances. Emits an `onCommit(startIntent)` callback the
  parent translates into `CMD_START` or `CMD_START_QUEUE` with the
  optional `startIntent` payload. The chooser carries a
  `mode: 'idle-pending-restart' | 'empty-enqueue'` prop that selects
  whether the "Cancel schedule" affordance is available.
- [`src/components/ScheduledStartIndicator.svelte`](src/components/ScheduledStartIndicator.svelte)
  — countdown surface rendered when `queue.scheduledStartAt != null`.
  Renders 1-second cadence when expanded in the sidebar and the
  status-bar projection (`SchegentStatusBar.showTransient`) handles the
  3–5s transient indicator on schedule-fire per FR-017a / SC-009.
  Exposes Cancel, Change, and "Start now" actions that emit the same
  `startIntent` shape via the existing `CMD_START_QUEUE` channel.
- [`src/components/SystemTab.svelte`](src/components/SystemTab.svelte)
  audit filter set extended (additive) for `scheduled-start-*`,
  `idle-pending-*`, and `automation-enqueue-no-start-mode` event types.

**Shared store**:

- [`src/lib/tick-store.ts`](src/lib/tick-store.ts) — a single `setInterval`-
  backed Svelte store that fans out one timer tick per second to every
  visible `ScheduledStartIndicator`. Mounting N indicators consumes one
  timer (not N) per FR-017's per-renderer cost constraint. The store is
  reference-counted so it idles when no indicator is on screen.

**Helpers**:

- [`src/lib/start-mode.ts`](src/lib/start-mode.ts) — pure helpers that
  parse the chooser's `HH:MM:SS` input into a `scheduledStartAt`
  timestamp and validate the lockstep invariant (a `'later'` mode
  always carries a positive offset; a `'now'` mode never carries one).
- [`src/lib/remote-lifecycle-change-store.svelte.ts`](src/lib/remote-lifecycle-change-store.svelte.ts)
  — track multi-window queue-state churn so the chooser closes silently
  in the losing window during cross-window contention (Q13 / scenario 13).

**IPC shape (additive, no new commands beyond `CMD_DISMISS_MIGRATION_NOTICE`)**:

`CMD_START` and `CMD_START_QUEUE` accept an optional `startIntent`
field:

```ts
type StartIntent = {
  startMode: 'now' | 'later';
  scheduledStartAt?: number; // epoch ms, required when startMode === 'later'
  source:
    | 'operator-restart'
    | 'operator-chooser'
    | 'programmatic'
    | 'migration-default';
};
```

`startIntent` is optional for backwards compatibility (FR-024). A
command without a `startIntent` field is treated as `startMode: 'now'`
from the existing source attribution. The new `CMD_DISMISS_MIGRATION_NOTICE`
is the **only** new command type; it is deliberately excluded from
`MUTATING_COMMAND_TYPES` because the dismiss is non-destructive UX
state per FR-020.

No `AUDIT_SCHEMA_VERSION` bump (event types are additive within the
existing envelope). `STATE_SCHEMA_VERSION` is bumped to 7 by the
v6 → v7 migrator that introduces `queueLifecycle`, `scheduledStartAt`,
`scheduledStartSource`, and `migrationNotice` on the persisted queue
record. See
[`docs/operations/single-task-queue-migration.md`](../docs/operations/single-task-queue-migration.md)
for the migration walkthrough.

### IPC additions (spec 073 — Metrics dashboard)

Feature 073 adds a rollup surface for the Dashboard's Metrics tab,
derived from the existing `.schegent/audit.log` (FR-R3-009 later added
`.schegent/metrics-rollup.jsonl` for its all-time totals). It is not
read-only: the first read in a session appends a `metrics-view-opened`
row to the audit log, which is why its one command is gated (see the
note after the list):

- `CMD_READ_METRICS` — payload
  `{ includeArchives?: boolean, runIds?: string[] }`. `includeArchives`
  defaults to `false`; feature 103 added `runIds`, at most 64 run ids,
  to ask for those runs' summaries. Returns `{ tasks,
  phaseTypeAggregates, costTimeline, oldestIncludedTimestamp?,
  cumulative, coverage, runSummaries?, meta: { includesArchives,
  totalScannedEntries, parseWarnings } }` inside the standard `CMD_ACK`
  envelope, with `runSummaries` present only when the request carried
  `runIds`. There is no push-message counterpart — unlike the Phase Log
  Feed, Metrics has no live tail.

`CMD_READ_METRICS` was read-only and outside `MUTATING_COMMANDS`,
like the spec 020 phase-log commands above, so a secondary VS Code host
could dispatch it. `FR-R4-F05` gates it with them, because it appends a
`metrics-view-opened` row once per session: `COMMAND_AUTHORITY` declares
it gated and not serialized, so an untrusted workspace and a secondary
window are refused, and the handler keeps its own primacy check. The
single call site is
[`webview-ui/src/lib/metrics-ipc.ts`](src/lib/metrics-ipc.ts); a
repo-grep regression at
[`../tests/lint/no-inline-read-metrics-ipc.test.ts`](../tests/lint/no-inline-read-metrics-ipc.test.ts)
fails the build on any drift. No new snapshot envelope keys; no
`AUDIT_SCHEMA_VERSION` or `STATE_SCHEMA_VERSION` bump.

[`MetricsDashboard.svelte`](src/components/MetricsDashboard/MetricsDashboard.svelte) renders
the tab. Its Overview shows the all-time totals as four tiles, the
retained run detail's totals, an inline-SVG bar chart of cost per day
with the running total in its tip and its table view (no new charting
dependency), the Steps table of phase-type analytics, and a
sortable, paginated Runs table with expandable per-phase detail. Its
Reports tab is `HistoricalReportsPanel.svelte`.
Under normal application-generated audit logs, `TaskRecord.description` is
always an internally-generated `taskId` or `runId` — never
operator-authored free text. Rendering safety does not depend on that
assumption holding, though: every component in the folder uses Svelte's
default auto-escaping, with no `{@html}` usage anywhere (FR-017), so a
hand-edited or adversarial log entry still can't inject markup.

### IPC additions (spec 101 — Builder surface)

One command, and it only reads.
[`src/lib/catalog-history-ipc.ts`](src/lib/catalog-history-ipc.ts) is the
**single call site** for `CMD_READ_DEFINITION_VERSION`, pinned by
[`../tests/lint/no-inline-catalog-history-ipc.test.ts`](../tests/lint/no-inline-catalog-history-ipc.test.ts).
`readDefinitionVersion({ kind, id, versionId })` correlates the request the same
way the lifecycle senders do — UUIDv4 id, one-shot ack listener, 5-second
timeout — and resolves to a closed result: `{ outcome: 'success', body }` or
`{ outcome: 'failure', reason }`, never a body and a reason together. The panel
that consumes it holds a three-state view (`pending | ready | error`), so a
failed read cannot render as an empty body.

The version *list* is not fetched: it rides the snapshot on each definition's
`lifecycle.versions`, and only the body an operator actually opens costs a round
trip. Reads carry no `expectedDraftVersion` — there is nothing to be stale
against — and a response arriving after the operator has opened a different
version is discarded rather than merged, which is a webview-side sequence check
rather than a cancellation the host knows about.

### Audit surfaces

The Dashboard exposes the audit tail through **one surface**, reading
`snapshot.auditTail`:

| Surface | Component | Visibility filter | Empty-state copy |
|---|---|---|---|
| **System tab** (peer route) | [`src/components/SystemTab.svelte`](src/components/SystemTab.svelte) | `entry.scope === 'system'` (no runId gate) | "No system events yet." |

There were **two complementary surfaces**. The second was an **Activity Feed**
under Operations, rendered by `AuditTail.svelte`, filtering
`entry.scope === 'task' && knownRunIds.has(entry.runId)` with the legacy
tolerance `scope ?? 'task'`, and telling an empty tail "No active task activity.
System events appear in the System tab." FR-R3-140 deleted it: no route or panel
imported it, only its own tests did, so the operator had no way to reach the
feed the empty-state copy was pointing away from. Nothing replaced it — the
task-scoped half of the split is currently unrendered. `PhaseLogFeed.svelte`
also reads `snapshot.auditTail`, but only to recover which runner started a
phase; it is not an audit surface.

The surface orders entries newest-first. The on-disk
`.schegent/audit.log` is untouched — the split is purely the webview's
read-side classification of an existing append-only log. The
disk-integrity regression at
[`../tests/integration/clean-all-disk-integrity.test.ts`](../tests/integration/clean-all-disk-integrity.test.ts)
hashes the log before/after a Clean All cycle and asserts the prefix is
byte-identical (SC-005). The `AUDIT_TAIL_MAX = 50` ring-buffer cap is
unchanged (FR-012).

### Activity Feed navigation (spec 021)

The Dashboard's Activity Feed selection is local webview state. Queue rows,
task rows, phase progression steps, and the compact Activity Feed selectors
all write through the same selection tuple
`{ queueId, taskId, pipelineId, phaseId, iterationN }`, backed by
[`webview-ui/src/lib/activity-feed-selection.svelte.ts`](src/lib/activity-feed-selection.svelte.ts)
and the existing `PhaseLogStore`.

Selection is not persisted and introduces no host IPC command. Once the tuple
is complete, the existing read-only phase-log helper above performs the host
read/tail operation. Queue/task selection resolves children with an
active-then-recent cascade; "Jump to current phase" restores live-following
after manual navigation.

### Activity Feed render pipeline (spec 029 — Human-readable activity logs)

Feature 029 adds a **view-only** transformation layer that turns sanitized
`PhaseLogDisplayEntry` records into structured, human-readable UI. No new IPC,
no new audit event, no host module: everything below is webview-local and
operates on already-sanitized strings. The on-disk `stream.jsonl` is never
mutated (SC-005); the integration regression at
[`../tests/integration/phase-log-on-disk-immutability.test.ts`](../tests/integration/phase-log-on-disk-immutability.test.ts)
hashes the file before/after a manifest read + tail-session lifecycle and
asserts the SHA-256 is unchanged.

**Pure projection helpers** (TS, no DOM, no Svelte runtime):

- [`webview-ui/src/lib/activity-feed/classify-arg-value.ts`](src/lib/activity-feed/classify-arg-value.ts)
  — maps a `ToolArgumentValue` to one of `{ kind: 'scalar' | 'multiline' |
  'object' | 'array' }`. A string is classified as **multiline** when the
  key is in `LONG_FORM_KEYS = { content, code, body, text, patch, diff,
  query }` OR the value contains a newline OR is ≥200 chars. Arrays are
  capped at 50 items (overflow surfaced via `truncatedAt`); object values
  recurse one level shallowly.
- [`webview-ui/src/lib/activity-feed/parse-tool-arguments.ts`](src/lib/activity-feed/parse-tool-arguments.ts)
  — extracts the typed `body.toolArguments` tree first (host-supplied;
  recursive sanitization already applied). Falls back to JSON-parsing
  `body.toolInput` when the typed field is absent, and to a raw-text
  branch (`{ ok: false, rawText }`) when JSON parsing fails (truncated /
  streaming chunks). Honours the host-side `{__elided:true}` /
  `{__truncated:true,originalBytes:N}` sentinels.
- [`webview-ui/src/lib/activity-feed/detect-metadata-line.ts`](src/lib/activity-feed/detect-metadata-line.ts)
  — splits sanitized `systemSummary` / `resultSummary` strings into typed
  `MetadataLine` records. Recognised keys: `cwd`, `session_id`,
  `duration_ms`, `cost` / `total_cost_usd`, `tools`, `model`, `num_turns`.
- [`webview-ui/src/lib/activity-feed/detect-audit-footer.ts`](src/lib/activity-feed/detect-audit-footer.ts)
  — locates the audit block the way the host's parser does, with the open
  marker, the close marker and the token rule all taken from
  [`src/contracts/phase-output-contract.ts`](../src/contracts/phase-output-contract.ts)
  (a marker counts at the start of a line, not as a partial of a wider
  equals fence). The last complete open/close pair is the block, and the
  status is `CLEAR` exactly when a line of the region from that close
  marker to the end passes the host's token rule, `UNKNOWN` otherwise.
  Returns the matched block plus prefix/suffix so the renderer can render
  `prefix → AuditCompletionCard → suffix`, with whatever follows the close
  marker shown after the card, and gracefully handles the streaming case
  where the close marker has not yet arrived.

**Component family** under [`webview-ui/src/components/PhaseLogFeed/parts/`](src/components/PhaseLogFeed/parts/):

- [`MultiLineCodeBlock.svelte`](src/components/PhaseLogFeed/parts/MultiLineCodeBlock.svelte)
  — renders multi-line text inside `<pre><code>` with horizontal scroll,
  a Copy affordance, and an Expand toggle for blocks over 800 lines.
- [`ToolCallCard.svelte`](src/components/PhaseLogFeed/parts/ToolCallCard.svelte)
  — replaces the inline `▶ Tool {json}` for `tool-use` entries with a
  structured key-value card. Scalar arguments render inline; multi-line
  string arguments embed a `MultiLineCodeBlock`; arrays render as
  capped lists with a `+K more` overflow pill; depth-1 objects render
  as a nested `<dl>`. Carries a "truncated" pill when the host clipped
  `toolArguments` at `perFieldBytes`.
- [`MetadataStrip.svelte`](src/components/PhaseLogFeed/parts/MetadataStrip.svelte)
  — collapsed-by-default sticky strip at the top of
  [`PhaseLogReadingPane.svelte`](src/components/PhaseLogFeed/PhaseLogReadingPane.svelte).
  Aggregates `MetadataLine` records detected across the iteration's
  `system` / `result` entries; **latest-value-wins** dedup; expand
  toggle reveals the full ordered detection list.
- [`AuditCompletionCard.svelte`](src/components/PhaseLogFeed/parts/AuditCompletionCard.svelte)
  — renders a colored status badge (CLEAR / UNKNOWN) wrapping
  the audit-log block body inside `MultiLineCodeBlock`. Rendered inline
  from [`PhaseLogEntry.svelte`](src/components/PhaseLogFeed/PhaseLogEntry.svelte)
  when the `assistant-text` body matches the audit footer.

**Security invariants** (enforced by automated regressions, not review):

- **No `{@html}` for operator-influenced strings (FR-017).** The lint
  regression at
  [`../tests/lint/no-html-interpolation-in-activity-feed.test.ts`](../tests/lint/no-html-interpolation-in-activity-feed.test.ts)
  greps every `.svelte` file under
  [`webview-ui/src/components/PhaseLogFeed/`](src/components/PhaseLogFeed/)
  for the literal `{@html` token and fails the build on any match.
- **Single sanitization point.** String leaves under
  `PhaseLogDisplayEntry.body.toolArguments` flow through the recursive
  walker in [`../src/services/phase-log/phase-log-reader.ts`](../src/services/phase-log/phase-log-reader.ts),
  which delegates each leaf to the injected `SanitizedLogger.sanitize`.
  No webview-side sanitizer is permitted; double-sanitization is
  forbidden.

### Queue failure policy and `CMD_SET_QUEUE_FAILURE_POLICY` (spec 195, FR-R3-156)

One new mutating command, `CMD_SET_QUEUE_FAILURE_POLICY`, payload
`{ queueId: string; policy: QueueFailurePolicy | null }`. `policy: null` means
"follow the workspace default" and removes the queue's stored override rather
than writing a concrete value. It joins `MUTATING_COMMAND_TYPES`
(`src/contracts/sidebar-command-metadata.ts`), so it is primary-host gated the
same as every other mutating queue command, and its handler
(`src/ui/sidebar/commands/cmd-set-queue-failure-policy.ts`) acks the host's own
`CommandOutcome` — `accepted`, `no-op`, or `refused` with a reason — rather
than an unconditional `accepted`. The webview posts it from
`webview-ui/src/lib/queue-control-ipc.ts`'s `setQueueFailurePolicy()`, on the
same correlated-request terms as the five queue commands above; the control
lives in `QueueConfigModal.svelte`, offering the three choices
`halt-on-failure`, `continue`, and follow-the-default, reading the two
non-default values from the generated mirror `lib/generated/queue-failure-policy.ts`
rather than restating them.

One existing snapshot field widened rather than a new one added:
`QueueRuntime.startFailure` (already the "why this queue did not start"
projection) is now a discriminated union — the pre-existing admission-refusal
shape plus a `halted` variant carrying the failed task's id and sanitized
name, projected through the same `sanitizeAndCap` the pre-existing `summary`
field already used. `QueueControls.svelte` renders the halted task's name and
its retry/remove actions (via the existing `QueueItemActions` dispatch) in the
queue header; `drilldown/QueueStartFailureNotice.svelte` and
`drilldown/QueuesTier.svelte` render the same reason on the queue's detail
surface and its row in the list. No new `accepted` acknowledgement is
introduced on any path that refuses because of a halt —
`webview-ui/src/lib/__tests__/queue-control-ipc.test.ts` asserts it.

### Retry-cap outcome: `QueueItem.degradedPhases` and the phase-editor control (spec 199, FR-R3-157)

No new command. One new **read-only** snapshot field and one new **authoring**
control, and the two are worth reading together because they sit on opposite
sides of this package's import rule.

`QueueItem.degradedPhases?: readonly DegradedPhaseEntry[]` — each entry a
`{ phaseId, condition }` pair naming a Phase whose retry condition was still
unsatisfied when its iteration cap ran out and which was authored to advance
anyway. The host derives it once (`src/ui/sidebar/task-degradation.ts`,
capturing off the Run at the moment it ends via `src/queue/terminal-capture.ts`)
and the webview only renders it. `drilldown/QueueTaskRow.svelte` collapses an
absent key and an empty list to the same answer — not degraded — in one
`$derived`, deliberately once rather than in the markup: two spellings of
nothing reaching two renderings is the distinction the projection exists to
prevent. Nothing in the webview infers degradation from a warning tag, a cause
literal, or an iteration count; a webview test feeds a row carrying the
forced-continue warning with no `degradedPhases` and asserts it renders clean.

`PipelineBuilderEditors/RetryCapOutcomeEditor.svelte` is the authoring half —
three choices beside the retry-condition editor, labelled by what the run does
rather than by the field's values. It is the one editor on that card whose
**displayed** value is not the phase's own value: a phase that states nothing,
or states the deprecated boolean, still does something definite at the cap. So
it imports `resolveRetryCapOutcome` and `statesRetryCapOutcome` from
`src/contracts/retry-cap-outcome.ts` — real value imports across the boundary,
which `webview-host-import-direction.test.ts` permits only from `src/contracts/`
— instead of restating the precedence here. A local copy would be individually
correct and would disagree with the controller on exactly one input, a phase
carrying both spellings, which is precisely where this control is telling an
operator something they cannot otherwise check. `RawJsonPhaseEditor.svelte`
validates `onRetryCap` against `RETRY_CAP_OUTCOMES` from
`src/contracts/process-definitions.ts` — the same host-side list, imported the
same way, that it already uses for every other closed-vocabulary phase field.

## Build

```bash
npm run build:webview   # vite build — emits dist/webview/{sidebar.js,dashboard.js,sidebar.html,dashboard.html} (and index.html)
```

The host calls this transitively via `npm run build`. Output lands in `dist/webview/`. The host's `src/ui/sidebar/html.ts` and `src/ui/dashboard/dashboard-html.ts` swap `__CSP__` and `__NONCE__` placeholders and rewrite asset URLs through `webview.asWebviewUri`.

## CSP

Both webviews load with strict CSP, identical policy:

```
default-src 'none';
img-src ${cspSource} data:;
script-src ${cspSource} 'nonce-${nonce}';
style-src ${cspSource} 'unsafe-inline';
```

There are no remote `script-src` permissions. Inline scripts are nonced. CSP regression is covered by `tests/integration-host/csp.host.test.ts` (sidebar) and `tests/unit/ui/dashboard/dashboard-csp.test.ts` (dashboard).

## Constraints

- **Bundle budget**: each entry's emitted JS ≤ 200 KB (enforced by `tests/unit/ui/sidebar/bundle-size.test.ts`).
- **No inline scripts** bypass the nonce — host renderers inject the nonce, host `csp.ts` denies `unsafe-inline` for `script-src`.
- **Read-only on host state**: the store is driven exclusively by `STATE_SNAPSHOT` messages from the host. The webview never mutates run/queue/lock state directly. To request a state change, send a typed `WebviewCommand`.
- **No `{@html ...}`** unless the source is a host-sanitized string. User-controllable strings (`lastErrorSummary`, `pausedReason`, audit summaries) are sanitized at the host before they cross the IPC boundary.

## Tests

Vitest + jsdom + @testing-library/svelte. Component and integration tests cover:

- Sidebar zones: `StatusBar`, `StatsStrip`, `CurrentTask`, `DashboardLink` (one test file each, plus `App.compact.test.ts` and `App.empty-state.test.ts` for the wiring).
- `derive-stats.ts` pure-helper math (counter formulae, active-phase rule).
- Dashboard components: phase tile rendering, queue list reorder + status badges, history section, monitor pill, control panel, queue actions.
- Activity feed sanitization (host-provided sanitized strings only).
- Snapshot store reactivity.
- a11y/theme audit (every `.svelte` component uses theme tokens, no hardcoded hex/rgb/named colors).

Run with `npm test` from the repo root (delegates to webview-ui via the `postinstall`-installed dependencies).

## Architecture context

For the host-side picture (workflow controller, runner, queue, monitor, audit pipeline, IPC, persistence), see [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
