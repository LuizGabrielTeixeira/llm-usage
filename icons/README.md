# Provider icons (optional)

The panel icon swaps automatically when you change providers. Each provider
can have its own icon file in this directory:

| Provider    | Files accepted (first match wins) |
|-------------|----------------------------------|
| Codex       | `codex.svg` or `codex.png`       |
| Antigravity | `antigravity.svg` or `antigravity.png` |
| Copilot     | `copilot.svg` or `copilot.png`   |
| Mistral     | `mistral.svg` or `mistral.png`   |

If no file exists for a provider, the panel simply shows no icon for that
provider (the icon slot is hidden — everything else keeps working). There is
no extension-level fallback icon.

## What GNOME Shell accepts

The icon is loaded through GLib/GIO and rendered by St, which supports:

- **PNG with transparency** — the safest choice; ship it at 32x32 or 44x44
  so it stays sharp on HiDPI screens (it is displayed at 16px).
- **SVG** — also fully supported (rendered via librsvg, which ships with
  GNOME); scales to any size with no quality loss and tends to be smaller.
- **Symbolic SVG** — a single-color SVG whose fill follows the theme's
  foreground color (like system tray icons). Good if you want the icon to
  recolor with light/dark themes automatically.
- JPEG technically loads, but it has no transparency and looks bad on the
  panel — avoid it.

Recommendation: **SVG or transparent PNG**. The `Monochrome` icon-style
preference keeps working — it applies a desaturate effect to whatever icon
is showing.

## Notes

- `llm-usage.png` in this directory is the repository/README logo only —
  the extension does not read it.
- Current files: `codex.svg` and `copilot.svg` are all-white versions
  (root `fill="#ffffff"`); `mistral.svg` keeps the brand gradient;
  `antigravity.png` is a direct 32px render of the original 2.4 MB SVG
  (which contained 10 embedded base64 PNGs and was moved to
  `private/antigravity-original-2.4MB.svg` to keep the install light).
  The 32px PNG is pixel-identical to the SVG at HiDPI panel size and
  measured visually equivalent at 16px.
- Restart GNOME Shell (log out and back in, or run the `install` script)
  after adding files here.
- Brand logos are trademarks of their owners; use assets you are licensed
  to use. Do not copy assets from GPL-licensed projects (see the warning in
  the repository README).
