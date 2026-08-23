# Repository Guidelines

Practical guide for AI coding assistants working in this repository.

## Project Overview

`omp-startup` is a customizable welcome/startup-dashboard extension that runs on
two hosts: **Oh My Pi (omp)** and upstream **Pi** (`@earendil-works/pi-coding-agent`).
One codebase serves both via a dual manifest in `package.json`
(`"omp": {"extensions": ["./src/index.ts"]}` / `"pi": {"extensions": ["./src/index.ts"]}`);
hosts load the TypeScript sources directly — **no build step, zero runtime dependencies**.

Core contract (user-mandated, enforced by tests):
1. No config file anywhere → plugin completely inert (no host UI calls).
2. Partial config → only configured keys change; everything else renders
   native-equivalent defaults (`DEFAULT_CONFIG` mirrors omp's `WelcomeComponent`).
3. The plugin writes no harness settings, except one explicit opt-in: with
   `hideNativeWelcome: true` on an omp-family host it sets `startup.quiet`
   via the host SDK while mounted and restores the latched previous value on
   `session_shutdown`. Without that key the `startup.quiet` hint stays advisory text only.

## Architecture & Data Flow

| Module | Responsibility |
|---|---|
| `src/index.ts` | Sole entry. Default export `ompStartup(api: OmpStartupExtensionAPI)`. Registers `/dashboard` unconditionally; subscribes `session_start` / `before_agent_start` / `session_shutdown`; owns mount state (`headerCapable`, `mountMode`, `visible`) plus the `quietLatch` opt-in capture (engageQuiet/releaseQuiet). |
| `src/config.ts` | Layered JSON loader: project `<cwd>/.omp/dashboard.json` else `.pi/` (first found) → user `~/.config/dashboard/config.json` → `DEFAULT_CONFIG`. Exports `loadConfig(cwd, home): LoadedConfig \| null` — `null` only when **no config file exists anywhere**; files that exist but carry nothing recognized return defaults with empty `explicitKeys` plus warnings. Also `expandTokens(text, snap)`. Per-key coercers return the default + warning for invalid values **only when the key is present in a file**. |
| `src/host.ts` | Host abstraction, failure-tolerant: `probeHeaderSupport(ui)` (behavioral capability probe), `snapshotInfo(ctx, api)`, `fetchBranch(api)`, `fetchRecentSessions(cwd, count)`, `loadHostSettings()` (feature-detected host settings singleton; `setHostSettingsForTest` seam), `detectAppName()`, constant `WIDGET_KEY = "omp-startup"`. |
| `src/dashboard.ts` | Pure renderer, no host imports: `renderDashboard(cfg, state, theme, termWidth)`, `makeDashboardComponent(stateRef, cfgRef)` → `{factory, refresh}`. ANSI-safe width math, 5-stop diagonal gradient, box/plain assembly. |
| `types.d.ts` | Ambient declarations for the used host-API subset (`OmpStartupExtensionAPI`, `ExtensionUiSubset`, …). Typecheck-only; consumed at runtime by nothing. |

Data flow on `session_start`: guard `ctx.hasUI && ctx.mode === "tui"` → probe
`setHeader` capability (restoring the native header immediately after a
positive probe) → `loadConfig`; if null or `explicitKeys.size === 0` → return
before any mount (inert; warnings about the user's own files are still shown).
Otherwise: surface warnings once via `ctx.ui.notify(…, "warning")`, snapshot info,
fire-and-forget `void refreshAsync()` (git branch + recent sessions mutate
`stateRef`, then `dash.refresh()` → captured `tui.requestRender()`), then route:
header-capable && `cfg.replaceHeader === true` → `ui.setHeader(factory)`
(opt-in takeover); otherwise → `ui.setWidget(WIDGET_KEY, factory, {placement:"aboveEditor"})`.
On non-header hosts exposing `VERSION` (omp-family signal; upstream Pi exports none),
a dim quiet-advisory line is embedded in the widget render (suppressed while
`hideNativeWelcome` has engaged quiet).
Opt-in quiet takeover (omp widget route only, `hideNativeWelcome`):
`void engageQuiet()` after mount; `unmount()` (dismiss or toggle-off) fires
`void releaseQuiet()` — restoring mid-session so the debounced settings save
lands while the process lives. The `session_shutdown` handler additionally
awaits `releaseQuiet()` as a fallback for sessions that exit still-mounted;
that late write races host teardown and may not persist (documented caveat).
Latch = one capture per engagement; `wrote=false` (user already had quiet on)
means release never writes.

## Key Directories

- `src/` — all runtime code (4 modules above).
- `tests/` — 4 suites mirroring module names + shared `tests/helpers.ts`.
- `scripts/smoke.ts` — host-free assertion pass (39 checks).
- `docs/` — `USAGE.md` (operator manual), `ARCHITECTURE.md` (maintainer reference).

## Development Commands

```sh
npm install         # devDeps only: typescript ^5.6, @types/node ^24
npm run typecheck   # tsc --noEmit over src/, scripts/, tests/ — must be clean
npm test            # node --test tests/*.test.ts — expect 102 passing
npm run smoke       # node scripts/smoke.ts — expect 39 "ok" lines, exit 0
```

There are no build/lint/format scripts — do not add a build step. Canonical
verification order after changes: `typecheck && npm test && npm run smoke`.

## Code Conventions & Common Patterns

- **Tabs** for indentation; strict TS with `noUncheckedIndexedAccess` — every
  indexed access needs a guard (`GRADIENT_STOPS[i] ?? fallback`,
  `if (!picked) return []`).
- **Imports carry explicit `.ts` extensions** (`from "./config.ts"`): required by
  Node's native TS type-stripping + `allowImportingTsExtensions`.
- **No static imports of host packages — ever.** All host contact flows through
  the `api` argument plus ambient types from `types.d.ts`. The single exception is
  the feature-detected dynamic `await import("@earendil-works/pi-coding-agent")`
  inside `listViaHostPackage` in `src/host.ts`, wrapped so failure degrades to `[]`.
- **Error handling**: bare `catch {}` returning a benign fallback (`""` branch,
  `[]` sessions, `false` probe) with a one-line why-it's-safe comment. Never
  rethrow out of an event handler.
- **State-in-closure**: mutable boxes `stateRef` / `cfgRef` passed by reference
  into `makeDashboardComponent`, so re-renders read current values without
  remounting. Async writes to `stateRef` are stale-guarded
  (`stateRef.current.cwd === cwd`).
- **Theming via inline markers**: builders emit `"\x01color\x02text"` spans
  (`MARKER_OPEN`/`MARKER_CLOSE`); `applyTheme(line, theme)` resolves them last,
  keeping builders pure and snapshot-testable.
- **Capability probe flags at factory-call time**, not render time — Pi invokes
  the factory synchronously while deferring paint; omp's `setHeader` is a no-op.
  Re-probed on every `session_start` and `/dashboard` show.
- **Absent config keys stay untouched**: `pick(key)` short-circuits before
  coercion; defaulted keys must never be validated or warned about.

## Important Files

- `src/index.ts` — lifecycle entry (`ompStartup`), mount/unmount/toggle routing,
  `QUIET_ADVISORY` gating.
- `src/config.ts` — `DEFAULT_CONFIG` (native-parity values; docs' option table in
  `docs/USAGE.md` must equal it — guarded by `tests/config.test.ts`),
  `KNOWN_KEYS`, coercion functions.
- `src/dashboard.ts` — geometry constants mirroring omp `welcome.ts`
  (preferredLeftCol 26, minLeftCol 12, minRightCol 20, 35% split), block
  builders, gradient stops.
- `package.json` / `tsconfig.json` / `types.d.ts` — dual manifest, strictness
  flags, ambient API subset.
- `tests/helpers.ts`, `scripts/smoke.ts` — fixtures and verification harnesses.

## Runtime/Tooling Preferences

- **Node ≥ 23 required** — runs `.ts` natively via type stripping. All commands
  use `node --disable-warning=ExperimentalWarning`.
- **bun is NOT installed**; ignore older plan mentions of bun.
- Package manager: npm. Dev dependencies only; adding any runtime dependency
  breaks the design (hosts load sources directly).
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`,
  `moduleResolution: bundler`, `noEmit`, `"types": ["node"]` — ambient globals
  come from `types.d.ts`, not package imports.

## Testing & QA

- Runner: `node:test` `describe`/`it` with `node:assert/strict`. Zero third-party
  test deps. New file `tests/<module>.test.ts` matching a src module name is
  picked up automatically by the glob.
- Suite map: `config.test.ts` (23 — inert rule, layers, coercion, tokens),
  `dashboard.test.ts` (34 — parity, delta rendering, geometry sweep),
  `host.test.ts` (19 — probe/fetch/settings-seam classification),
  `lifecycle.test.ts` (26 — omp vs pi routing through mock hosts, quiet
  takeover engage/restore). Total 102.
- Fixtures from `tests/helpers.ts`: `makeState(overrides?)` snapshot builder,
  `render(cfgOverrides, state, width?)` with `PLAIN_THEME` (identity theme),
  `withDirs({project?, projectSubdir?, user?})` scratch dirs with `dispose()`,
  `makeMockApi(version?)` / `makeMockCtx({mode?, hasUI?, headerMode?, version?, model?})`
  where `headerMode` mimics omp (`noop`), Pi (`sync` — records AND synchronously
  invokes the factory), or unsupported (`throw`). For lifecycle tests reuse the
  local `boot()` harness pattern from `lifecycle.test.ts`.
- Prefer **delta assertions**: render base vs modified config against the same
  snapshot and assert exactly which lines changed — this is how the core
  partial-config contract is defended.
- After changing rendering or defaults, keep the verified-docs convention:
  doc claims (defaults, counts, paths) must match code; update `docs/*.md` in
  the same change. Live E2E (PTY-driven omp/Pi) is only needed for lifecycle or
  routing changes.
