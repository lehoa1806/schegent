# VSIX allowlist derivation

**Status**: drift measured, both gates reconciled, generated entries derived
**Opened**: 2026-08-21
**Source finding**: `FR-R3-022` (packaging allowlist and preflight coverage)

## What was observed

`npm run package:smoke` failed with one line:

```
unexpected packaged file extension/dist/webview/chunks/RunLauncher.js
```

That report named one file. The pin was out of date by nine entries across two
generated subtrees, and the gate throws on the first sorted difference, so a
maintainer fixing it by hand would have learned that one name at a time — build,
package, read, edit, repeat.

The same tree, after the reporting change and before the derivation:

```
[policy] 10 differences between the package and the allowlist (8 unexpected, 1 missing, 1 count)
  unexpected packaged file extension/dist/webview/chunks/RunLauncher.js
  unexpected packaged file extension/dist/webview/chunks/empty-catalog-guidance.js
  unexpected packaged file extension/dist/webview/chunks/metrics-ipc.js
  unexpected packaged file extension/dist/webview/chunks/reorder-task.js
  unexpected packaged file extension/dist/webview/chunks/run-composition.js
  unexpected packaged file extension/dist/webview/index12.css
  unexpected packaged file extension/dist/webview/index13.css
  unexpected packaged file extension/dist/webview/index14.css
  missing required packaged file extension/dist/webview/chunks/tick-store.js
  expected exactly 45 files, found 52 — implied by the lines above
```

Ten lines for nine discrepancies: the count line is a consequence of the other
nine rather than a tenth finding, and says so. It is kept rather than suppressed
because once the generated subtrees are derived it is the only thing the count
assertion can still catch — a duplicate archive entry — and a duplicate can
co-occur with a real difference.

The source document for this item described the failure as one unlisted chunk,
and named `empty-catalog-guidance.js` as the reported entry. Both were wrong, and
the second is wrong for a mechanical reason worth keeping: entries are sorted
before comparison, and ASCII puts `R` before `e`.

## The measurements

All figures below come from one `vsce package --no-dependencies` run against the
tree at `e577bf1`, with the resulting archive's central directory read directly.

| | Pinned | Packaged | |
|---|---|---|---|
| Webview chunks | 15 | 19 | 5 emitted-but-unpinned, 1 pinned-but-not-emitted |
| Extracted stylesheets | 10 (`index2`–`index11.css`) | 13 (`index2`–`index14.css`) | 3 emitted-but-unpinned |
| Everything else | 20 | 20 | agrees |
| **Total** | **45** | **52** | 8 unexpected, 1 missing |

Emitted but not pinned: `chunks/RunLauncher.js`,
`chunks/empty-catalog-guidance.js`, `chunks/metrics-ipc.js`,
`chunks/reorder-task.js`, `chunks/run-composition.js`, `index12.css`,
`index13.css`, `index14.css`.

Pinned but no longer emitted: `chunks/tick-store.js`.

### Every difference sat in the one gap the grounding gate declares

`tests/unit/build/vsix-allowlist-grounding.test.ts` already enforced the review
rule the pin's comment asked for — each pinned chunk must name a module under
`webview-ui/src/` — and it was explicit about what it could not reach:

> Vite also emits shared chunks it extracts on its own (`format.js`,
> `WorkflowRun.js`, the `indexN.css` stylesheets), and those are not derivable
> from source without building, so only the archive check sees them.

All nine differences are inside that gap. The five unpinned chunks are shared
chunks Vite extracted on its own: `metrics-ipc.ts`, `reorder-task.ts` and
`run-composition.ts` are `lib/` modules, `RunLauncher.svelte` is statically
imported and hoisted because more than one chunk needs it, and
`empty-catalog-guidance.js` corresponds to no source module at all. The three
stylesheets are the numbered tail.

The stale entry sits in the same gap from the other side.
`webview-ui/src/lib/tick-store.ts` still exists, so the grounding rule passed for
`chunks/tick-store.js` while the build had stopped emitting it. The rule catches
a pin left behind by a *deleted* module; `tick-store.ts` was not deleted, it
stopped being a code-split boundary. Nothing that runs without a build can tell
those two apart.

### The two gates were mutually unsatisfiable

The obvious repair was measured rather than assumed. Editing
`ALLOWED_VSIX_ENTRIES` to exactly the 52 entries the build emits — adding the
five chunks and three stylesheets, removing `tick-store.js` — produced:

```
package:smoke                     exit 0   VSIX policy passed (52 files, 954115 compressed bytes)
vsix-allowlist-grounding.test.ts  FAIL     these chunks are pinned but have no source module:
                                           [ 'empty-catalog-guidance' ]
```

`chunks/empty-catalog-guidance.js` holds a trust banner and is imported by
`RunsSurface.js`, `PipelineBuilder.js` and `dashboard.js`. Its build-assigned
basename matches no module under `webview-ui/src/`; the only file of that name in
the tree is a test.

So the entry the packaging gate demanded was the entry the grounding gate
rejected, and **no hand-edit of the pinned list made both gates green**. The
recorded task "bring the allowlist back to green" aimed at a state that does not
exist. The mutation was reverted; the working tree carried no part of it.

### The pin had gone stale at least five times

| When | What | Recorded as |
|---|---|---|
| feature 096 | `model-catalog.yaml` shipped unpinned | clean-build failure |
| features 081–095 | 9 unpinned chunks and 7 unpinned stylesheets at once | REL-03 |
| 2026-08-12 `8315eb5` | *realign the VSIX content allowlist with the code-split webview* | commit |
| 2026-08-15 `2b1fbaa` | *re-pin VSIX contents and ground the pin in the source tree* | commit |
| 2026-08-18 `e325176` | *resync the VSIX allowlist and qualify tag builds* | commit |
| 2026-08-21 | the nine differences above | this record |

Three resyncs in six days. The file predicted this about itself: "A stale pin
fails closed, which is the safe direction, but it also trains a reader to
regenerate the list rather than review it."

## What changed

Generated content is now enumerated by the build that generated it, and the
review property the pin was carrying is stated as an assertion.

- **Two shape predicates** replace 25 pinned entries. `chunks/<name>.js` at
  exactly one segment below the webview root, and `index<N>.css` at the webview
  root with `N >= 2` contiguous from 2. Admitted by shape, so a `.js.map`, a
  dotfile, a nested directory or a non-JS file under `chunks/` still fails and is
  still named — which is what the pin was really guarding.
- **The correspondence** replaces the grounding test's first assertion. Every
  authored `import('*.svelte')` outside tests must have an emitted chunk — eight
  boundaries today, the six lazily-loaded routes plus `QueueDetailTier` and
  `RunDetailTier`. One-directional: an authored boundary implies an emitted
  chunk, never the reverse, because the reverse is the pin.
- **One report instead of nine runs.** Every review-level difference is collected
  and thrown together. An unsafe archive path stays a separate class, thrown
  first and on its own.
- **Staleness is refused.** Absent or out-of-date build output fails before
  `vsce` is invoked, with one modification-time comparison per build half.
- **The gate is in the preflight.** `ci:fast` gained `build:host && package:smoke`,
  and a lint gate now fails when a CI-reachable script is in neither the preflight
  chain nor a three-entry exclusion list.

### Why the emitted directory, and not a build manifest

The source document recommended deriving from the webview build manifest. Three
reasons this does not:

1. No manifest is emitted — `webview-ui/vite.config.ts` does not set `manifest`.
2. Enabling one writes `dist/webview/.vite/manifest.json`, which `.vscodeignore`
   does not exclude, so the fix for a packaging allowlist would begin by adding a
   file to the package.
3. A manifest is written by the same build run as the chunks, so deriving from it
   carries no review property that deriving from the emitted directory does not.
   The review property lives entirely in the correspondence.

## Reading a failure now

| Message | What it means |
|---|---|
| `unsafe ZIP entry path` | a traversal or absolute entry. Security class, reported alone, before anything else |
| `unexpected packaged file` | an entry matching no pinned literal and no admitted shape. A `.map` or a dotfile lands here |
| `missing required packaged file` | a pinned literal absent from the archive |
| `stylesheet numbering has a gap` | the emitted set skips a number, so a file went missing rather than the count merely changing |
| `no emitted chunk for route <id>` | a route surface either was not built or stopped being a code-split boundary. The message distinguishes the two |
| `could not establish the correspondence` | the route map or the boundary scan yielded nothing. The gate refuses to pass on an empty subject |
| `expected exactly N files, found M` | with both directions asserted, a duplicate archive entry |

Each failure names the stage it came from — packaging, or policy — so a `vsce`
regression does not read as a packaged-content violation.

## What is still hand-maintained

The 20 hand-authored entries: archive metadata, the four shipped documents, the
three assets, the host bundle, the two webview HTML entry points with their entry
scripts, `index.css` and `dashboard.css` (named from their sources rather than
numbered), and the `examples/` catalog — which has been enumerated from the
directory since feature 098 and is the precedent this change follows.

A change to that set is a reviewable diff, and there is deliberately no
`--update` mode to produce one.
