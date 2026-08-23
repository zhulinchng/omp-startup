# omp-startup — Architecture

Technical reference for the codebase in this repository. Every behavioral claim
here is enforced by the test suite (`npm test`, 85 assertions across 4 suites)
or by the live host verifications summarized at the end.

## 1. What this is

`omp-startup` is a single-codebase extension that renders a customizable
startup dashboard in two coding-agent hosts:

| Host | Package | Extension manifest key |
|---|---|---|
| Oh My Pi (omp) | `@oh-my-pi/pi-coding-agent` (fork) | `omp.extensions` |
| upstream Pi | `@earendil-works/pi-coding-agent` | `pi.extensions` |

The dual manifest in `package.json` means one copy of the sources serves both
hosts. Both load TypeScript directly; there is **no build step and no runtime
dependency** (`typescript`/`@types/node` are dev-only).

Core product contract, enforced in code and tests:

1. **Inert until configured** — with no `dashboard.json` anywhere, no host UI
   surface is touched.
2. **Unconfigured elements keep native defaults** — `DEFAULT_CONFIG` mirrors
   the native omp `WelcomeComponent`; only explicitly configured keys change
   the render.
3. **The plugin never writes harness settings** — it only renders an advisory.

## 2. Module map

```mermaid
flowchart LR
    subgraph Host["Host runtime (omp or Pi)"]
        API["ExtensionAPI<br/>(pi: passed to factory)"]
        CTX["ExtensionContext<br/>(ui, mode, hasUI, cwd, model)"]
    end

    subgraph Sources["src/"]
        IDX["index.ts<br/>default export:<br/>lifecycle + routing"]
        CFG["config.ts<br/>loadConfig / expandTokens"]
        HST["host.ts<br/>probe / snapshot / fetches"]
        DSH["dashboard.ts<br/>renderDashboard /<br/>makeDashboardComponent"]
    end

    IDX -->|"loadConfig(cwd, home)"| CFG
    IDX -->|"probe, snapshot,<br/>fetchBranch/Sessions"| HST
    IDX -->|"mount(factory)"| CTX
    IDX -->|"stateRef, cfgRef"| DSH
    HST -.->|"dynamic import<br/>(feature-detected)"| PKG["@earendil-works/<br/>pi-coding-agent"]
    DSH -->|"render(width) → string[]"| CTX

    TYP["types.d.ts<br/>ambient declarations"] -.typecheck only.-> Sources
```

- `src/index.ts` — default-exported factory `(api: OmpStartupExtensionAPI) => void`.
  Registers `/dashboard`, subscribes to `session_start`, `before_agent_start`,
  `session_shutdown`, owns mount state.
- `src/config.ts` — layered JSON loader with explicit-key tracking (drives the
  inert rule), per-key coercion with warnings, token expansion.
- `src/host.ts` — everything host-shaped: capability probe, info snapshot,
  git branch fetch, recent-sessions fetch (dynamic import of the host package).
- `src/dashboard.ts` — pure renderer: ANSI-aware width math, gradient painter,
  block builders, box/plain assembly, component factory.
- `types.d.ts` — ambient declarations for the used API subset; consumed only
  by `tsc --noEmit`, never at runtime.
- `tests/*.test.ts` — Node built-in runner (`node --test`), which executes
  TypeScript via type stripping on Node ≥ 23.

There are **no static imports of either host package**. The single dynamic
import (`src/host.ts`) is feature-detected and failure-tolerant; on omp the
loader rewrites the specifier onto its bundled copy, so the same file resolves
on both hosts.

## 3. Capability probe (the heart of cross-host compatibility)

The two hosts expose different header capabilities:

| Host | `ctx.ui.setHeader` behavior |
|---|---|
| upstream Pi | wired to `setExtensionHeader`, which calls `factory(tui, theme)` synchronously and swaps the mounted header |
| omp | declared in types, implemented as `setHeader: () => {}` |

`probeHeaderSupport(ui)` exploits that difference without version sniffing:

```ts
const sentinel = (_tui, _theme) => {
    invoked = true;          // flag flips at FACTORY-CALL time
    return { render: () => [] };
};
try { ui.setHeader(sentinel); } catch { return false; }
return invoked;
```

Setting the flag inside the factory call (not inside `render()`) matters:
Pi's `setExtensionHeader` invokes the factory but defers painting. The probe
is re-run on every `session_start` and every `/dashboard` show, because hosts
may emit `session_start` more than once against *different* UI contexts
(installed Pi 0.84.2 fires it once, before its built-in header exists — so the
probe correctly reports "no header capability" there and the plugin falls back
to the additive widget).

Routing decision:

```mermaid
flowchart TD
    A["session_start"] --> B{"ctx.hasUI && ctx.mode === 'tui'?"}
    B -- no --> Z["return (print/rpc/json untouched)"]
    B -- yes --> C["probe setHeader capability"]
    C --> D["loadConfig(cwd, home)"]
    D --> E{"loaded != null?"}
    E -- no --> Z2["INERT: nothing mounted"]
    E -- yes --> F{"headerCapable && cfg.replaceHeader"}
    F -- yes --> G["ui.setHeader(dashboard)<br/>(full takeover, opt-in)"]
    F -- no --> H["ui.setWidget('omp-startup', …, aboveEditor)"]
    H --> I{"!headerCapable && VERSION present?<br/>(omp-family)"}
    I -- yes --> J["embed quiet-setting hint in widget"]
    I -- no --> K["no hint"]
```

## 4. Lifecycle and state machine

Per-session state lives in the factory closure: `headerCapable`, `mountMode`
(`"header" | "widget" | null`), `visible`. Events transition it as follows:

```mermaid
stateDiagram-v2
    [*] --> Loaded : extension loaded
    Loaded --> Visible : session_start with config in TUI mode
    Loaded --> Loaded : session_start without config means inert
    Visible --> Hidden : before_agent_start when dismiss enabled
    Hidden --> Visible : dashboard toggle command
    Visible --> Hidden : dashboard toggle command
    Hidden --> Done : session_shutdown
    Visible --> Done : session_shutdown
    Done --> [*]
```

- `/dashboard` is always registered, even with no config file — invoking it is
  an explicit user action, and unconfigured invocation shows the
  native-equivalent defaults.
- If the config renames `command`, the alias is registered best-effort during
  `session_start`; the default `/dashboard` remains.
- Late data (git branch, recent sessions) mutates the shared state ref and
  calls `refresh()` → the component's captured `tui.requestRender()`.

### Async data flow

```mermaid
sequenceDiagram
    participant S as session_start handler
    participant R as renderer component
    participant X as refreshAsync
    S->>S: snapshotInfo writes stateRef
    S->>X: void refreshAsync non-blocking
    S->>R: mount via setWidget or setHeader
    X->>X: git branch via api.exec
    X->>R: dash.refresh triggers tui.requestRender
```

## 5. Configuration pipeline

Layers, later winning per key: built-in defaults ← user
`~/.config/dashboard/config.json` ← project `<cwd>/.omp/dashboard.json`
(falling back to `.pi/`). Only keys present in a file enter `explicitKeys`;
the inert rule is `explicitKeys.size === 0 → loadConfig returns null`.

```mermaid
flowchart LR
    D["built-in defaults"] --> M["merged per key"]
    U["user layer ~/.config/dashboard/config.json"] --> M
    P["project layer .omp or .pi dashboard.json"] --> M
    M --> Q{"any recognized key?"}
    Q -- no --> N["null = plugin inert"]
    Q -- yes --> V["coerce each present key"]
    V --> O["cfg + explicitKeys + warnings"]
```

Coercion rules worth knowing (all unit-tested):

| Key | Rule |
|---|---|
| `width` | clamped to [20, 500], rounded |
| `sessions` | clamped to [0, 12], rounded |
| `layout` | `"box" \| "plain"` else default |
| `logo` | `"pi" \| "none" \| string[]` else default |
| `left`/`right` | unknown block names dropped (warning); all-invalid → default list |
| `shortcuts` | `[key,label]` pairs or `{key,label}` objects; invalid entries dropped |
| `command` | must match `^[\w-]+$` |
| absent keys | keep defaults, never validated, never warn |

Token expansion (`expandTokens`) supports `{user} {cwd} {dir} {model}
{provider} {version} {branch} {app} {date} {time}`; unknown tokens pass
through unchanged. `{app}` uses a binary-name heuristic
(`basename(process.execPath)` ∈ {`omp`,`pi`}, else empty). `{version}` reads
`api.pi.VERSION ?? api.pi.version` — omp exports it, upstream Pi currently
does not (title degrades gracefully; see §7).

## 6. Renderer design

`renderDashboard(cfg, state, theme, termWidth)` is pure — no host imports,
theme applied through a 2-method duck type (`fg(color,text)`,
`bold(text)`). Block builders emit lines with inline style markers
(`"\x01color\x02text"` spans); `applyTheme()` resolves them against the real
theme last, keeping builders theme-free and snapshot-testable.

Geometry replicates the native omp welcome (`welcome.ts #renderLines`):
max width from config, left column preferred 26/min 12, right column min 20,
35% split heuristic, single-column fallback below the breakpoint, rounded
border with embedded title and column tee (`┬`). All box rows share one total
visible width (asserted per row in tests).

Placement semantics: **the list that references a block decides where it
renders.** A block named in both lists renders once, on the left. `plain`
layout stacks left-order blocks centered, then right blocks as headed groups,
with borders removed.

ANSI safety: `visibleWidth` strips SGR before counting; `fitToWidth`
preserves escape runs while truncating visible content (native algorithm);
gradient paints per-character truecolor SGR along a bottom-left → top-right
diagonal across 5 stops (hot pink → violet → periwinkle → cyan → mint),
single resting frame.

## 7. Known deviations from pixel-perfect native parity

Documented deliberately; none affect the inert rule.

1. The host's random tip line below the box and live-keybinding hint labels
   are not exposed to plugins; the `shortcuts` block mirrors their content
   statically.
2. LSP-server rows are unavailable through public APIs.
3. Gradient renders the resting frame only (no intro sweep).
4. On hosts exposing neither `{app}` nor `{version}` (upstream Pi today), the
   default title degenerates to a lone "v"; the renderer skips it entirely in
   that case.
5. Installed Pi 0.84.x emits `session_start` before its header exists, so
   `replaceHeader` cannot engage there — the additive widget route runs
   instead. Verified empirically; newer builds where the header exists first
   will flip the probe automatically.

## 8. Verification strategy

| Layer | Mechanism |
|---|---|
| Unit | `node --test tests/*.test.ts` — 85 assertions: inert rule, layers, coercion, tokens, geometry invariants, delta rendering, probe classification, lifecycle routing against omp-style and pi-style mocks, non-TUI guards, dismiss/toggle/shutdown hygiene |
| Smoke | `scripts/smoke.ts` — 35 host-free assertions (inert rule, render delta, probe routing, tokens, snapshot info) |
| Types | `tsc --noEmit` strict, including `tests/` |
| Live | PTY-driven omp 18.0.1 and pi 0.84.2 sessions (inert frame, configured frame, prompt-dismissal, `/dashboard` re-show, hint visibility) |

Live results recorded for the shipped build:

- omp: stock welcome untouched when unconfigured; replica widget with
  `Ahoy!` + advisory hint when configured; dismissed after first prompt;
  `/dashboard` restored it; recent-sessions rows populated from the host API.
- pi: additive widget above the editor, native chrome untouched, no
  omp-specific hint, dismissal and `/dashboard` identical.
