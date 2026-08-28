# VSIX content policy and allowlist derivation

Use the VSIX smoke check whenever a packaging change adds, removes, or renames a
shipped file. The check is deliberately fail-closed: a package passes only when
its archive is structurally safe, its contents match the reviewed policy, and
its manifest still identifies an installable Schegent extension.
<!-- Source: scripts/check-vsix-smoke.mjs -->

## Run the gate

From the repository root:

```bash
npm run build
npm run package:smoke
```

`package:smoke` refuses stale or missing build output before invoking the
repository's installed `@vscode/vsce` entry point. It packages with
`--no-dependencies` into a temporary directory, inspects that VSIX, and removes
the temporary directory afterward.
<!-- Source: scripts/package-vsix-smoke.mjs -->
<!-- Source: scripts/check-build-freshness.mjs -->
<!-- Source: package.json -->

The ordinary `npm run package` command also passes `--no-dependencies`, but it
does not run the repository's archive policy itself. Use `package:smoke` for a
qualification check, or run the checker against an already-produced artifact:

```bash
node scripts/check-vsix-smoke.mjs path/to/schegent.vsix
```

<!-- Source: package.json -->
<!-- Source: scripts/check-vsix-smoke.mjs -->

## What the content policy derives

The allowed archive is the union of three deliberately different categories.

### Reviewed, stable entries

The checker pins stable files by exact archive path. These include the VSIX
metadata files, the shipped license and release/security documents, the
extension manifest, three assets, the host bundle, and the named webview entry
HTML, JavaScript, and CSS files. A missing pin and an additional unrecognized
file are both policy failures.
<!-- Source: scripts/check-vsix-smoke.mjs -->

`.vscodeignore` is the packaging-side boundary. It excludes source, tests,
internal documentation, contracts, scripts, dependency trees, local Schegent
state, test scratch roots, TypeScript, and source maps while retaining the
compiled JavaScript and CSS under `dist/`. The exact archive allowlist remains a
second check: changing an ignore pattern cannot silently authorize a new file.
<!-- Source: .vscodeignore -->
<!-- Source: scripts/check-vsix-smoke.mjs -->

### Example files

Everything under `examples/` is derived recursively into an
`extension/examples/` archive entry, except `.DS_Store`, which the packaging
ignore file also excludes. This makes adding or removing an operator-importable
example a directory change rather than a second hand-maintained list edit. A
separate grounding test independently walks the same directory and compares the
result with the policy.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-allowlist-grounding.test.ts -->
<!-- Source: .vscodeignore -->

### Generated webview files

Vite-assigned webview files are admitted by narrow shape rather than literal
generated names:

- `extension/dist/webview/chunks/<name>.js` must be one file directly under
  `chunks/`, must not be a dotfile, and must use the `.js` extension.
- `extension/dist/webview/index<N>.css` is admitted only for integer `N >= 2`.
  If numbered stylesheets exist, their sequence must be contiguous from 2.

Source maps, nested chunk paths, dotfiles, other extensions, zero-padded CSS
numbers, and gaps in the CSS sequence therefore fail instead of being absorbed
by a broad directory glob.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-derivation.test.ts -->

The checker also scans authored `.ts` and `.svelte` files under
`webview-ui/src/` for runtime `import('*.svelte')` boundaries. Every such
boundary must have a same-basename emitted chunk; route-loader boundaries are
named by route in failures. The scan, route set, and emitted chunk set must all
be non-empty, and duplicate component basenames are rejected as ambiguous.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: webview-ui/src/dashboard/route-loader.ts -->
<!-- Source: tests/unit/build/vsix-allowlist-grounding.test.ts -->

The correspondence is intentionally one-way. An authored dynamic boundary must
emit a chunk, but a generated shared chunk does not need to match a source
module name. Vite may extract and name shared code itself, so imposing the
reverse rule would turn a build detail back into a manual allowlist.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-derivation.test.ts -->

## Archive and manifest checks

Before comparing names, the checker rejects absolute paths, backslashes, and
`..` traversal components. Duplicate entries, an absent ZIP end record, an
invalid central-directory header, and compression methods other than stored or
deflate are also rejected. Path-safety failures are reported separately so they
cannot be buried in a longer content-difference report.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-archive-assertions.test.ts -->

The archive must be at most 2 MiB compressed and 5 MiB in total declared
uncompressed size. Its embedded `extension/package.json` must have name
`schegent`, main entry `./dist/extension.js`, and the
`workspaceContains:.specify/` activation event.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-archive-assertions.test.ts -->

Ordinary content differences are aggregated into one stable report. Read the
summary classes first, then address every listed line:

- `unexpected`: an entry is neither pinned nor admitted by a generated shape;
- `missing`: a stable or derived required entry is absent;
- `numbering`: generated stylesheet numbering has a gap;
- `correspondence`: the source-to-chunk relationship could not be established;
- `count`: the archive cardinality disagrees with the pins plus derived entries.

`[packaging]` identifies failure to create a VSIX; `[policy]` identifies a
failure while inspecting its archive or contents.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-content-policy.test.ts -->

## Change the policy intentionally

For a new stable shipped document, asset, or runtime entry, update the exact
entry list in `scripts/check-vsix-smoke.mjs`, make the corresponding
`.vscodeignore` decision explicit, and add positive and negative policy tests.
Do not add an automatic “accept current package” mode: stable pins are the
reviewed decision the gate is meant to preserve.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->
<!-- Source: tests/unit/build/vsix-content-policy.test.ts -->

For a new example, add the file under `examples/`; the script and independent
grounding test derive its archive entry. For a new dynamically imported Svelte
surface, preserve a runtime `import()` that the boundary scanner can observe and
verify that the built VSIX contains the corresponding chunk. A type-only
`typeof import()` is deliberately ignored because it emits no runtime chunk.
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: tests/unit/build/vsix-allowlist-grounding.test.ts -->

For a genuinely new generated-file category, narrow the predicate to the
smallest safe path and extension shape, then add rejection tests for maps,
dotfiles, nesting, alternate extensions, malformed numbering, and empty-input
cases as applicable. Do not broaden `chunks/` or `dist/webview/` to a directory
glob.
<!-- Source: tests/unit/build/vsix-derivation.test.ts -->
<!-- Source: scripts/check-vsix-smoke.mjs -->

## Verification scope

The focused unit suites exercise allowlist differences, derived shapes,
source-tree grounding, and malformed ZIP/manifest assertions. The real-package
smoke check is still required because only a build and `vsce` reveal the actual
archive:

```bash
npx vitest run \
  tests/unit/build/vsix-content-policy.test.ts \
  tests/unit/build/vsix-derivation.test.ts \
  tests/unit/build/vsix-allowlist-grounding.test.ts \
  tests/unit/build/vsix-archive-assertions.test.ts
npm run build
npm run package:smoke
```

<!-- Source: tests/unit/build/vsix-content-policy.test.ts -->
<!-- Source: tests/unit/build/vsix-derivation.test.ts -->
<!-- Source: tests/unit/build/vsix-allowlist-grounding.test.ts -->
<!-- Source: tests/unit/build/vsix-archive-assertions.test.ts -->
<!-- Source: scripts/package-vsix-smoke.mjs -->

`npm run gate` reaches `package:smoke` through `ci`, and that is now the only
caller: the pull-request, CI and release jobs that also invoked it were retired
on 2026-08-26 (`FR-R3-099`). The checker no longer runs against a single VSIX
selected for publication, because nothing publishes one — a release is packaged
locally, so the artifact a recipient gets is the one the smoke package checked
only if the operator ran the gate on the same tree.
<!-- Source: ../release/actions-terminal-record.md -->
