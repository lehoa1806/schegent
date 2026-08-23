# Visual asset report

The repository currently contains three image assets in the scanned `assets/`, `public/`, and `docs/` trees. `README.md` embeds `assets/logo.png`, so it is intentionally excluded from the unembedded list below. No `public/` image and no physical image below `docs/` exists in the current working tree.

<!-- Source: assets/logo.png -->
<!-- Source: README.md -->

## Assets not embedded in Markdown

| Asset | Physical format and dimensions | Existing product use | Suggested manual placement |
|---|---|---|---|
| `assets/banner.png` | JPEG data in a `.png`-named file, 1024×538 | No manifest reference and no Markdown embed. | Place immediately after the `# Schegent` heading in `README.md` if a wide marketplace-style hero is desired. Keep the existing square logo or remove one of the two so the page does not open with duplicate branding. |
| `assets/sidebar-icon.svg` | SVG | Manifest icon for the `schegent` Activity Bar container and `schegent.sidebar` view. | Place under `## 1. Open the dashboard` in `docs/tutorials/user-quickstart.md` only if the goal is to teach readers which Activity Bar glyph to select; add a caption such as “Schegent Activity Bar icon.” |

<!-- Source: assets/banner.png -->
<!-- Source: assets/sidebar-icon.svg -->
<!-- Source: package.json -->
<!-- Source: docs/tutorials/user-quickstart.md -->

## Embedded asset

| Asset | Placement | Note |
|---|---|---|
| `assets/logo.png` | First line of `README.md` | JPEG data in a `.png`-named file, 1024×1024; also the extension manifest's `icon`. |

<!-- Source: assets/logo.png -->
<!-- Source: README.md -->
<!-- Source: package.json -->

The `.png` names for the banner and logo do not match their detected JPEG encoding. That mismatch is reported rather than repaired because renaming or transcoding visual assets is outside this documentation task and would require updating manifest and Markdown references.

<!-- Source: assets/banner.png -->
<!-- Source: assets/logo.png -->
<!-- Source: package.json -->
