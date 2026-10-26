# llm-usage

A GNOME Shell extension that shows your AI subscription usage in the top panel — one place to watch quotas from **OpenAI Codex**, **Google Antigravity**, **GitHub Copilot** and **Mistral** (including the student plans).

Click the panel indicator for the full breakdown, scroll the mouse wheel over it to switch providers, or pick one from the **Provider** submenu.

> Fork of [kevinpita/codex-usage-extension](https://github.com/kevinpita/codex-usage-extension) (MIT), itself a fork of [Haletran/claude-usage-extension](https://github.com/Haletran/claude-usage-extension) (MIT). Menu/UI inspired by ClaudeCodeUsage (GPL) — **no GPL code or assets were copied**.

## Features

- Panel percentage + progress bar + ring for the selected provider
- Per-provider sections with every quota window (e.g. Antigravity shows all its quota groups and both the weekly and 5-hour windows)
- Request counters where the plan is metered by requests (Copilot Premium Interactions: `4 / 200 requests`)
- Euro-denominated monthly pools for Mistral (`€1.33 / €12.75`)
- Reset countdowns per window
- Mouse-wheel cycling between providers (like GNOME workspace switching)
- Provider submenu with checkmark on the active provider
- Provider icons (drop your own in `icons/`)
- Manual refresh + auto-refresh interval
- Proxy support

## Providers

| Provider | Source | Requirements |
|---|---|---|
| **Codex** | `chatgpt.com` backend (`wham/usage`), reads the local Codex CLI session (`~/.codex/auth.json`) | [Codex CLI](https://developers.openai.com/codex/cli/) signed in |
| **Antigravity** | `agy` CLI usage report in JSON print mode (`agy -p /usage --output-format json`) | Antigravity CLI (`agy`) ≥ 1.1.11, signed in |
| **Copilot** | GitHub Copilot user quota endpoint (`api.github.com/copilot_internal/user`) using your GitHub CLI token | [GitHub CLI](https://cli.github.com/) (`gh`) signed in |
| **Mistral** | `admin.mistral.ai/subscription` page, fetched with your existing Firefox session (opt-in) — or manual monthly EUR entry | Firefox signed in to admin.mistral.ai, or nothing (manual) |

Codex, Antigravity and Copilot are read-only public/user endpoints; nothing is ever posted anywhere.

### The Mistral workaround (why it is special)

Mistral's official usage API (Admin API) is **Enterprise-only** — a Pro Student key (or any standard API key) cannot read usage, and the numbers only exist in the web console. This extension works around that in an opt-in way:

1. The bundled Python script (`tools/mistral_web.py`) copies your Firefox `cookies.sqlite` to a private temp directory (mode `0600`, deleted right after reading — it lives for about a second).
2. It reads the `admin.mistral.ai` session cookie **in memory only** and performs one GET of the subscription page.
3. The two independent monthly pools (API/Studio and Vibe Code, both EUR) are parsed from the server-rendered HTML and shown as meters with an automatic "resets on the 1st" date.

The cookie is **never** stored, logged or written to GSettings. If you don't want any browser reading, leave the toggle off and use the manual monthly entry instead — both paths never mix, and the extension always shows an honest state (never fake zeros).

Supported for the automatic fetch: native/Flatpak/Snap Firefox, Zen and LibreWolf. Chromium-family browsers encrypt their cookies and are not supported — use manual entry there.

## Privacy & security

- **No credentials are ever stored.** Codex and Copilot tokens are read from the CLIs you already trust (`~/.codex/auth.json`, `gh auth token`) and used in memory for a single request.
- **The Mistral Firefox cookie** lives in memory for one request and is then discarded; the temporary copy of `cookies.sqlite` is `chmod 0600`, in a private temp dir, deleted immediately after reading (see above).
- **GSettings contains no secrets** — only UI preferences and, if you use manual mode, the four EUR amounts you typed yourself.
- Nothing is telemetry'd, uploaded, or shared. The extension makes no requests other than the usage endpoints listed in the table above.
- Errors are honest and actionable: signed out, quota page changed, provider disabled — each with advice on how to fix it.

## Requirements

- GNOME Shell **46–50**
- `python3` (only for the Mistral Firefox fetch; stdlib only, no pip packages)
- Per provider: `codex`, `agy` and/or `gh` CLIs signed in (all optional — each provider can be toggled off in preferences)

## Install

⚠️ GNOME Shell only loads extension code at session start — installing requires **logging out** once.

### With the script

```bash
./install
```

This copies the extension to `~/.local/share/gnome-shell/extensions/llm-usage@LuizGabrielTeixeira/`, compiles the schemas and logs you out.

### Manually

```bash
cp -r . ~/.local/share/gnome-shell/extensions/llm-usage@LuizGabrielTeixeira
cd ~/.local/share/gnome-shell/extensions/llm-usage@LuizGabrielTeixeira/schemas
glib-compile-schemas .
# then log out and back in
```

On **X11** you can avoid the logout: after copying, press `Alt+F2`, type `r`, press Enter (restarts the Shell in place). Not available on Wayland.

Enable it in the **Extensions** app (or `gnome-extensions enable llm-usage@LuizGabrielTeixeira`).

> **Migrating from codex-usage?** This is a different UUID (`llm-usage@LuizGabrielTeixeira`), so both can coexist — just disable/remove the old one and re-set your preferences once (the schema path is new).

## Uninstall

```bash
rm -rf ~/.local/share/gnome-shell/extensions/llm-usage@LuizGabrielTeixeira
# log out and back in
```

## Testing

```bash
python3 -m unittest discover -s tests -v   # full suite (JS contract + smoke suites run via gjs)
gjs -m tests/js/run.js                     # contract/normalization suite
gjs -m tools/validate-sources.js           # real one-shot fetch of all enabled providers, sanitized output
```

`validate-sources.js` exercises the exact same coordinator path the Shell uses. It prints statuses and percentages only — never tokens or cookies.

## Icons

Place `icons/<provider>.svg` or `icons/<provider>.png` (`codex`, `antigravity`, `copilot`, `mistral`) to override the panel icon per provider; `icon-22.png` is the fallback. Transparent PNG at 32px or a normal SVG works best; see `icons/README.md`.

## Credits & license

- MIT — see [LICENSE](LICENSE). Copyright © 2026 Haletran, Kevin Pita, Luiz Gabriel Teixeira.
- Fork chain: [Haletran/claude-usage-extension](https://github.com/Haletran/claude-usage-extension) → [kevinpita/codex-usage-extension](https://github.com/kevinpita/codex-usage-extension) → **llm-usage**.
- Menu/UX inspiration: [ClaudeCodeUsage](https://github.com/dvdstelt/claude-code-usage) (GPL — used as inspiration only; no code or assets copied).

**Not affiliated** with OpenAI, Google, GitHub or Mistral. Provider names and icons are trademarks of their respective owners; the bundled icons are simple placeholders — replace them with your own if you plan to redistribute.
