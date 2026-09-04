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
3. The plugin writes no harness settings, except the welcome takeover on omp:
   with `replaceNativeWelcome: true` (the default) it claims `startup.quiet`
   via the host SDK — set + flushed immediately, kept `true` across launches so
   only the dashboard renders at startup — recording ownership in
   `~/.config/dashboard/.ownership.json`. The previous value is restored
   whenever a session starts without the takeover route (takeover off, config
   deleted/inert, Pi header host, non-TUI); exit-time writes are never used
   (they lose a race with host teardown). A user who manually sets
   `quiet: false` is detected and permanently yielded to. Setting
   `replaceNativeWelcome: false` makes every other code path read-only.

## Architecture & Data Flow

| Module | Responsibility |
|---|---|
| `src/index.ts` | Sole entry. Default export `ompStartup(api: OmpStartupExtensionAPI)`. Registers `/dashboard` + `/dashboard-config` unconditionally (fixed names; only the toggle honors the `command` rename as a best-effort alias); subscribes `session_start` / `session_switch` / `session_branch` / `session_tree` (one shared route handler) plus `before_agent_start`; owns mount state (`headerCapable`, `mountMode`, `visible`, `dismissed`) plus the quiet-ownership flow (claimQuietOwnership/giveUpQuietOwnership; state persists in a marker file, not memory). `/dashboard-config` is read-only: one `info` toast naming the loaded `files` (or every checked candidate path), silent outside the TUI. |
| `src/config.ts` | Layered JSON loader: project `<cwd>/.omp/dashboard.json` else `.pi/` (first found) → user `~/.config/dashboard/config.json` → `DEFAULT_CONFIG`. Exports `loadConfig(cwd, home): LoadedConfig \| null` — `null` only when **no config file exists anywhere**; files that exist but carry nothing recognized return defaults with empty `explicitKeys` plus warnings. `LoadedConfig.files` names the existing layers (`{project?, user?}`); `configFileCandidates(cwd, home)` is the single source of truth for the three probed paths. Also `expandTokens(text, snap)`. Per-key coercers return the default + warning for invalid values **only when the key is present in a file**. |
| `src/host.ts` | Host abstraction, failure-tolerant: `probeHeaderSupport(ui)` (behavioral capability probe; a throwing restore routes to the widget instead of leaving a blank header), `isOmpFamily(version, app)` (VERSION present, or `omp` binary when older builds omit it), `snapshotInfo(ctx, api)`, `fetchBranch(api)`, `fetchRecentSessions(cwd, count)`, `mapSessionInfos` (nameless pathless rows degrade to `untitled`), `loadHostSettings()` (feature-detected host settings singleton incl. flush passthrough; `setHostSettingsForTest` seam), quiet-ownership marker helpers (`read/write/clearQuietOwnership`), `detectAppName()`, constant `WIDGET_KEY = "omp-startup"`. |
| `src/dashboard.ts` | Pure renderer, no host imports: `renderDashboard(cfg, state, theme, termWidth)`, `makeDashboardComponent(stateRef, cfgRef)` → `{factory, refresh}`. ANSI-safe width math, 5-stop diagonal gradient, box/plain assembly. Plain right-column rows truncate like box cells; quote/hint split on embedded newlines; empty `info` expansions are skipped (unlike `blank` blocks). |
| `types.d.ts` | Ambient declarations for the used host-API subset (`OmpStartupExtensionAPI`, `ExtensionUiSubset`, …). Typecheck-only; consumed at runtime by nothing. |

Data flow on each session route (`session_start`, `session_switch`, `session_branch`, `session_tree` — one shared handler): guard `ctx.hasUI && ctx.mode === "tui"` → probe
`setHeader` capability (restoring the native header immediately after a
positive probe; a throwing restore routes to the widget instead) → `loadConfig`; if null or `explicitKeys.size === 0` → return
before any mount (inert; warnings about the user's own files are still shown).
If a `before_agent_start` dismissal set `dismissed`, return with ownership untouched (explicit `/dashboard` clears it).
Otherwise: surface warnings once via `ctx.ui.notify(…, "warning")`, snapshot info,
fire-and-forget `void refreshAsync()` (git branch + recent sessions mutate
`stateRef`, then `dash.refresh()` → captured `tui.requestRender()`), then route:
`cfg.replaceNativeWelcome === false` → mount nothing at startup (manual-only
via `/dashboard`); header-capable && true → `ui.setHeader(factory)` (in-place
header replacement, dismiss restores); otherwise → `ui.setWidget(WIDGET_KEY,
factory, {placement:"aboveEditor"})`, unmounting the previous surface first so a changed probe can't leave both installed. On omp-family hosts (`VERSION` present, or `omp` binary for older builds; upstream Pi exposes neither), a dim quiet-advisory line is
embedded in the widget render whenever we stack beside the native welcome
(takeover off, e.g. a manual show).
Quiet ownership (omp widget route only):
`void claimQuietOwnership()` after mount — sets and flushes `startup.quiet=true`
unless already true; marker records `{previous,state}`. No exit-time writes.
`giveUpQuietOwnership()` runs at session start whenever the takeover route is
NOT taken (inert config, takeover false, Pi header route, non-TUI): restore +
clear marker with an awaited flush. quiet true WITHOUT a marker = the user's
own choice → never claimed, never rewritten. Marker owned + quiet false =
user override → rewrite marker as `yielded` and stand down until they delete
it. npm uninstalls additionally run `scripts/uninstall-reset.js`
(postuninstall) which resets an owned `quiet:true` in `~/.omp/agent/config.yml`.

## Key Directories

- `src/` — all runtime code (4 modules above).
- `tests/` — 5 suites: four mirroring src modules plus
- `scripts/smoke.ts` — host-free assertion pass (53 checks).
- `scripts/uninstall-reset.js` — zero-dep postuninstall hook restoring owned `startup.quiet`; scoped to the `startup:` block of `~/.omp/agent/config.yml`.
- `docs/` — `USAGE.md` (operator manual), `ARCHITECTURE.md` (maintainer reference),
  `LEARNINGS.md` (verified omp/Pi host-behavior facts and E2E recipes),
  `PUBLISHING.md` (release runbook).
- `.github/workflows/` — `ci.yml` (typecheck + tests + smoke on Node 24/26
  for pushes and PRs) and `publish-gpr.yml` (gated mirror of each release to
  GitHub Packages as `@zhulinchng/omp-startup`).

## Development Commands

```sh
npm install         # devDeps only: typescript ^5.6, @types/node ^24
npm run typecheck   # tsc --noEmit over src/, scripts/, tests/ — must be clean
npm test            # node --test tests/*.test.ts — expect 199 passing
npm run smoke       # node scripts/smoke.ts — expect 53 "ok" lines, exit 0
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
- **Capability probe flags at factory-call time**, not render time — Pi invokes
  the factory synchronously while deferring paint; omp's `setHeader` is a no-op.
  A throwing restore reports incapable (widget route) instead of leaving a blank
  header. Re-probed on every session route (`start`/`switch`/`branch`/`tree`) and `/dashboard` show.

## Important Files

- `src/index.ts` — lifecycle entry (`ompStartup`), mount/unmount/toggle routing,
  `QUIET_ADVISORY` gating.
- `src/config.ts` — `DEFAULT_CONFIG` (native-parity values; docs' option table in
  `docs/USAGE.md` must equal it — guarded by `tests/config.test.ts`),
  `KNOWN_KEYS`, coercion functions.
- `src/dashboard.ts` — geometry constants mirroring omp `welcome.ts`
  (preferredLeftCol 26, minLeftCol 12, minRightCol 20, 35% split) plus a
  content-fit left minimum (widest laid-out left line), block builders,
  gradient stops.
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
- Suite map: `config.test.ts` (42 — inert rule, layers, coercion incl.
  explicit-empty arrays and degenerate values, non-object top levels, tokens,
  shadowed-project silence, injected clock, untraversable-path silence, EISDIR warning, file provenance incl. shadowed/invalid/directory layers),
  `dashboard.test.ts` (53 — parity, delta rendering, geometry sweep incl. narrow-terminal fit and the sub-minimum floor, content-fit left column and
  centerText exact-fit, multiline quote/hint splitting, info-emptiness skips, sessions height stability, lone-ESC
  and wide-glyph truncation, emptied-column frames, gradient-memo stability, frame-clock date),
  `host.test.ts` (37 — probe/fetch/settings-seam classification incl. restore-throw routing and the omp-family predicate,
  detached-HEAD fetch, session-shape drift incl. pathless rows and future dates, ownership-marker round-trip incl. boolean write seam, settings-cache/seam reset),
  `lifecycle.test.ts` (59 — omp vs pi routing through mock hosts incl. switch/branch/tree routes, route-change clearing, dismiss persistence, quiet
  claim/steady-state/escape-hatch/give-up incl. failure paths (`get` throw) and non-TUI
  toggles, concurrent-refresh single repaint and branch landing, gated async
  fetches, conditional repaint, primed first-paint advisory, dashboard-config path reporting incl. layered/shadowed/absent/broken layers, arg tolerance, non-TUI silence, mount purity, toggle-rename survival),
  `uninstall-reset.test.ts` (8 — postuninstall restore outcomes incl.
  write-failure marker retention). Total 199.
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
