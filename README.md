# omp-startup

A customizable welcome/startup dashboard for [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) and upstream [Pi](https://github.com/earendil-works/pi) — the startup.nvim / snacks.dashboard of coding agents.

**Core contract:** the plugin is **inert until configured**. With no `dashboard.json` anywhere, both hosts behave exactly as without it. Once you configure *anything*, only what you configured changes; every other element keeps its native look (the default template is a replica of omp's built-in welcome box). The plugin never writes harness settings — it only *advises*.

## Install

The repo ships a dual-host manifest; discovery works from any standard extension location.

```sh
# user-level (both hosts), pick one:
ln -s /path/to/omp-startup ~/.omp/agent/extensions/omp-startup
ln -s /path/to/omp-startup ~/.pi/extensions/omp-startup

# or project-level:
mkdir -p .omp/extensions && ln -s /path/to/omp-startup .omp/extensions/omp-startup
```

Or clone directly into the extensions directory. No build step and no runtime dependencies: hosts load the TypeScript sources as-is. (`npm install` is only needed to run `npm run typecheck` / `npm run smoke` yourself.)

## Configure

Two layers, later wins per key:

| Layer | File |
|---|---|
| Project | `<cwd>/.omp/dashboard.json` or `<cwd>/.pi/dashboard.json` (first that exists) |
| User | `~/.config/dashboard/config.json` |

If neither file exists — or they contain no recognized keys — the plugin does nothing. Example:

```json
{
  "greeting": "Ahoy, {user}!",
  "info": ["{model} · {provider}", "{branch} | {dir}", "{date} {time}"],
  "quote": ["Ship small, ship often."]
}
```

### Options

| Key | Default | Meaning |
|---|---|---|
| `layout` | `"box"` | `"box"` (native-style bordered two-column) or `"plain"` (stacked, borderless) |
| `title` | `"{app} v{version}"` | Label embedded in the top border; `""` removes it |
| `width` | `100` | Max box width in columns (20–500) |
| `logo` | `"pi"` | `"pi"` (native π art) · `"none"` · custom `string[]` ASCII art |
| `gradient` | `true` | Diagonal multi-stop truecolor gradient on the logo |
| `greeting` | `"Welcome back!"` | Left-column headline |
| `left` | `["greeting","blank","logo","blank","info"]` | Block order (left column / plain layout) |
| `right` | `["shortcuts","sessions"]` | Block order (right column, box layout only) |
| `info` | `["{model}","{provider}"]` | Token rows under the logo; `""` renders blank |
| `shortcuts` | native hints | `[key, label]` pairs under the "Tips" header |
| `sessions` | `4` | Recent-session rows; `0` hides the block |
| `quote` | `[]` | Random pick rendered dim/italic below the box |
| `dismiss` | `true` | Hide after the first submitted prompt |
| `command` | `"dashboard"` | Slash-command name for manual toggle |
| `replaceHeader` | `false` | Pi only: replace the whole native header instead of adding a widget |

Block names: `greeting`, `logo`, `blank`, `info`, `shortcuts`, `sessions`.

### Tokens

`{user}` `{cwd}` `{dir}` `{model}` `{provider}` `{version}` `{branch}` `{app}` `{date}` `{time}` — usable in `greeting`, `title`, `info`, and `quote`. Unknown tokens pass through untouched.

## Host behavior

| Host | Route | Native welcome |
|---|---|---|
| omp | widget above the editor (replica base) | Untouched unless you set `startup.quiet=true`; the plugin suggests this once per session because its widget stacks over the built-in box |
| Pi | additive widget above the editor | Header stays; with `replaceHeader:true` the dashboard replaces it (dismiss restores) |

`/dashboard` toggles the dashboard at any time, config or not (unconfigured → native-equivalent defaults).

### Known deviations from pixel-perfect native parity

- The host's random tip line below the box and live-keybinding hint labels are host internals not exposed to plugins; the shortcuts block mirrors their content statically.
- LSP-server rows are not available via public APIs.
- The gradient renders the resting frame only (no intro sweep).

## Verify

```sh
npm install
npm run typecheck
npm run smoke
```
