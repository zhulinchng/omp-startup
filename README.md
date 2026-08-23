# omp-startup

A customizable welcome/startup dashboard for [Oh My Pi (omp)](https://github.com/can1357/oh-my-pi) and upstream [Pi](https://github.com/earendil-works/pi) — the startup.nvim / snacks.dashboard of coding agents.

**Core contract:** inert until configured. With no `dashboard.json` anywhere,
both hosts behave exactly as without this plugin. Once you configure
*anything*, only what you configured changes — every other element keeps its
native look, because the defaults replicate omp's built-in welcome box. The
plugin never writes harness settings.

## Install

From npm (recommended — both hosts ship native installers):

```sh
omp plugin install omp-startup      # Oh My Pi, user-level (~/.omp/plugins)
pi install npm:omp-startup          # upstream Pi, user-level; add -l for project-local
```

Rerun the same command to update to the latest published version.
`omp plugin uninstall omp-startup` / `pi remove omp-startup` removes it.

Manual alternative from a source checkout:

```sh
# symlink tracks your checkout:
ln -s /path/to/omp-startup ~/.omp/agent/extensions/omp-startup   # omp, user-level
ln -s /path/to/omp-startup ~/.pi/agent/extensions/omp-startup    # Pi, user-level
```

Configure by dropping a JSON file:

```json
{ "greeting": "Ahoy, {user}!", "info": ["{model} · {provider}", "{branch} | {dir}"] }
```

| Layer | File |
|---|---|
| Project | `<cwd>/.omp/dashboard.json` or `<cwd>/.pi/dashboard.json` (first that exists) |
| User | `~/.config/dashboard/config.json` |

Every option with its default value — copy what you need; keys you omit
always keep these values:

```json
{
  "layout": "box",
  "title": "{app} v{version}",
  "width": 100,
  "logo": "pi",
  "gradient": true,
  "greeting": "Welcome back!",
  "left": ["greeting", "blank", "logo", "blank", "info"],
  "right": ["shortcuts", "sessions"],
  "info": ["{model}", "{provider}"],
  "shortcuts": [
    { "key": "#", "label": "for prompt actions" },
    { "key": "/", "label": "for commands" },
    { "key": "!", "label": "to run bash" },
    { "key": "$", "label": "to run python" }
  ],
  "sessions": 4,
  "quote": [],
  "dismiss": true,
  "command": "dashboard",
  "replaceHeader": false
}
```


`/dashboard` toggles it at any time. On first submitted prompt it hides
(`"dismiss": true`). Full option list, tokens, recipes, troubleshooting:
**[docs/USAGE.md](docs/USAGE.md)**.

## Host behavior

| Host | Route | Native welcome |
|---|---|---|
| omp | replica widget above the editor | untouched unless you set `startup.quiet: true`; while stacked, the widget shows a one-line hint pointing there |
| Pi | additive widget above the editor | native header stays; `replaceHeader: true` swaps it (dismiss restores) |

Routing is decided at runtime by probing whether `setHeader` actually works —
no version sniffing; if either host changes, the plugin adapts.

## Documentation

- **[docs/USAGE.md](docs/USAGE.md)** — install paths, full config reference,
  token table, recipes per layout, host behavior matrix, troubleshooting.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module map, capability
  probe design, lifecycle state machine, renderer pipeline, compatibility
  notes, and the live-host verification log.
- **[docs/PUBLISHING.md](docs/PUBLISHING.md)** — release checklist for
  maintainers (version bump, prepublish gate, `npm publish`) and the
  deployment matrix for consumers.

## Development

```sh
npm install         # dev-only tooling
npm run typecheck   # strict tsc --noEmit (src + scripts + tests)
npm run smoke       # 40 host-free render/probe/token assertions
npm test            # 95-assertion suite on node:test
```

Zero runtime dependencies; hosts load the TypeScript sources as-is.
