# License review and release packaging

Schegent's source distribution is licensed under the MIT License. The
repository license grants the usual MIT permissions, requires preservation of
the copyright and permission notice in copies or substantial portions, and
disclaims warranties and liability. The root package manifest declares
`"license": "MIT"`.

<!-- Source: LICENSE.md -->
<!-- Source: package.json -->

This project license does not replace third-party licenses. JavaScript bundled
into the host or webview, development and packaging tools, examples, and
authored assets remain subject to their own terms. Treat license review as a
release input, not as a conclusion inferred from Schegent's MIT declaration.

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package-lock.json -->

## What the automated gate proves

Run:

```bash
npm run license:check
```

The current gate proves exactly three structural facts:

1. `LICENSE.md` exists.
2. This operations document exists.
3. `package.json` has a non-empty `license` field.

On success it prints the manifest identifier, currently `MIT`. It does **not**
enumerate dependency licenses, parse SPDX expressions, inspect license text,
check notice obligations, compare the webview manifest, or decide whether a
dependency may be distributed in the VSIX.

<!-- Source: scripts/check-licenses.mjs -->
<!-- Source: package.json -->

`license:check` is a step of `npm run gate`, and of `verify:all` and `verify:push`
besides. Nothing runs any of them for you — the workflows that used to were retired
2026-08-26 by operator decision (`FR-R3-099`) — so a maintainer running the gate before
merging is the whole of the enforcement. A passing gate proves the three facts above and
no broader legal compatibility claim.

<!-- Source: package.json -->
<!-- Source: ../release/actions-terminal-record.md -->

## Dependency records in scope

Review both dependency trees:

| Tree | Manifest | Resolution record |
| --- | --- | --- |
| Extension host, build, tests, and packaging | `package.json` | `package-lock.json` |
| Svelte webview, build, and tests | `webview-ui/package.json` | `webview-ui/package-lock.json` |

Both lockfiles use npm lockfile version 3 and record license metadata on package
entries where the package supplies it. The metadata includes simple SPDX IDs,
compound `AND`/`OR` expressions, and package-specific text such as
`SEE LICENSE IN ...`; it is an inventory lead, not a substitute for reading the
referenced license. The private webview package has no project-level license
field and is not checked by `license:check`.

<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package-lock.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: scripts/check-licenses.mjs -->

The root and webview manifests currently declare development dependencies
rather than runtime dependency sections, but the build bundles selected
library code into `dist/extension.js` and `dist/webview/`. A dependency's
`devDependency` classification therefore does not by itself prove that none of
its code ships.

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: esbuild.config.mjs -->

## Review a dependency change

Use this procedure whenever either manifest or lockfile changes:

1. Identify every added, removed, or upgraded package in both lockfiles,
   including transitive changes.
2. Read each changed entry's `license` value and inspect the package's actual
   license and notice files in the resolved package. Do not collapse an SPDX
   `AND` expression into either side or assume an `OR` expression chooses a
   branch automatically.
3. Determine whether the package's code or assets enter the host bundle,
   webview bundle, examples, branding, or release tooling. Review transitive
   code reached by bundling, not only direct manifest rows.
4. Record any attribution, source-offer, copyleft, patent, trademark, or notice
   obligation. If the VSIX must carry another file, update the package policy
   and its tests before release; the current allowlist admits only the project
   `LICENSE.md`, not a general notice directory.
5. Run `npm run license:check`, the relevant build, and
   `npm run package:smoke`. Inspect the produced archive policy before merging.
6. Escalate unclear, non-SPDX, source-available, copyleft, dual-license, or
   attribution-heavy terms for a human legal decision. Do not encode a new
   allowlist by guesswork in this document.

<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package-lock.json -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: package.json -->

The repository does not contain a dependency-license allowlist or a checked-in
license-scanner command. If maintainers adopt one, add it as a pinned project
dependency or reproducible workflow step, document its exact policy, and make
the structural gate verify its output rather than relying on an unpinned global
tool.

<!-- Source: package.json -->
<!-- Source: scripts/check-licenses.mjs -->
<!-- Source: ../release/actions-terminal-record.md -->

## Pull-request dependency controls

Nothing runs on a pull request. A pinned `actions/dependency-review-action` used
to refuse newly introduced `high`-severity dependencies, and it was retired with
every other hosted control on 2026-08-26 (`FR-R3-099`). It never carried an
`allow-licenses` or `deny-licenses` policy, so its withdrawal cost this page
nothing in license coverage — but it did remove the only automatic check on a
new dependency, and the manual review below is now the whole of it.

<!-- Source: ../release/actions-terminal-record.md -->

Dependabot opens weekly root and webview npm update pull requests and groups
several related toolchains; major updates are ignored for manual handling. It is
GitHub-native and needs no workflow, so it survived the retirement — but nothing
checks what it opens. What it opens is merged into `develop` only from a commit that
carries a passing `npm run gate:record` record naming that commit, and that is a rule
the operator follows, not a check ([gate recording](gate-recording.md)). The weekly `npm audit --audit-level=low` against both
lockfiles was retired with the workflows; the same audit is now
`npm run security:audit`, operator-invoked, on no schedule and outside the
attested gate. These address dependency freshness and known vulnerabilities.
They complement, but do not perform, the manual license review above.

<!-- Source: .github/dependabot.yml -->
<!-- Source: ../release/actions-terminal-record.md -->

## What ships

The VSIX content policy explicitly includes `extension/LICENSE.md` and rejects
unexpected archive entries. Source, tests, implementation docs, lockfiles, and
`node_modules` are excluded from the extension package. As a result, this
operations page is a maintainer runbook and does not ship inside the VSIX; the
MIT text itself does.

<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->

Releasing is local: `npm run release` refuses to proceed without a recorded gate
run, then prepares the candidate. Preparation emits a CycloneDX SBOM beside the
VSIX and inside it, and writes a local release record that names the candidate's
SHA-256 (`FR-R4-F09`). No digest file is published — the hosted job that
produced one was retired on 2026-08-26 (`FR-R3-099`) and nothing replaced that. The
SBOM is a dependency inventory artifact; its existence does not waive or satisfy
a license or notice obligation by itself. What the release path does and does not
produce is derived from the tree into
[current release controls](../release/current-release-controls.md).

<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: scripts/package-vsix-smoke.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->

The archive also carries `extension/THIRD-PARTY-NOTICES.md` (`FR-R5-F21`). It is
generated from the same module graphs as the SBOM, by `npm run notices`. It
lists each third-party package whose code the bundles carry, with its license id,
the bundle it is in, and the license and notice text that package ships. Every
packaging path writes it: `npm run package`, `package:smoke`, and the release
driver, which refuses with `notices-failed` when the script fails. The script
fails when a bundled package has no license id or no license text, or when a
bundled virtual module cannot be attributed to an installed package.

<!-- Source: scripts/third-party-notices.mjs -->
<!-- Source: scripts/release-candidate.mjs -->
<!-- Source: package.json -->

## License review 2026-11-06

This is a review of the third-party code the extension ships, as of the
dependency resolution in both lockfiles at commit
`f73e222623aa6ddcf2b651d6b785c990ad521ace`. The command was `npm run build`,
then `npm run sbom`, then `npm run notices`, under Node 24.19.0.

| Package | Version | License | Bundled in | Basis |
| --- | --- | --- | --- | --- |
| `esm-env` | 1.2.2 | MIT | webview | bundled, from the module graph |
| `svelte` | 5.56.10 | MIT | webview | bundled, from the module graph |
| `vite` | 7.3.6 | MIT | webview | two virtual helpers, `vite/modulepreload-polyfill.js` and `vite/preload-helper.js` |

The host bundle carries no third-party package. All three are MIT, which asks
that the copyright and permission notice travel with the code; the notices file
carries each package's text as shipped, so the archive meets that.

Its limits:

- It covers bundled code only. The rest of the 692 components the SBOM lists
  from both lockfiles, the development, build and test inventory, was not
  reviewed, and this record does not claim it is legally compatible with
  anything.
- The license texts are the files each package ships, unedited. `vite`'s
  `LICENSE.md` also carries the licenses of vite's own dependencies, so the
  notices include text for packages whose code the extension does not ship.
- The license ids are the ones each package declares. Nobody compared a
  declared id with the text beside it.
- It is not legal advice.

`npm run license:check` is unchanged by this review: it still checks only the
project's own license documents.

<!-- Source: scripts/third-party-notices.mjs -->
<!-- Source: scripts/generate-sbom.mjs -->
<!-- Source: scripts/check-licenses.mjs -->

## Release checklist

Before publishing a dependency-bearing release, confirm:

- `LICENSE.md` still matches the intended project license and the manifest
  still declares `MIT`;
- every changed root and webview dependency has a recorded license review;
- `extension/THIRD-PARTY-NOTICES.md` is in the exact archive that will ship,
  generated by `npm run notices` from that build, and a bundled package added
  since the last dated license review above has had its own review;
- `npm run license:check` and `npm run package:smoke` pass; and
- the generated release SBOM describes the same dependency resolution used for
  the release build.

<!-- Source: LICENSE.md -->
<!-- Source: package.json -->
<!-- Source: scripts/check-licenses.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: ../release/actions-terminal-record.md -->
