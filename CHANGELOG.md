# Changelog

All notable changes to `omp-startup`. Versions mirror npm (`omp-startup`) and
GitHub Packages (`@zhulinchng/omp-startup`).

## 0.1.10

- Box layout: the left column scales to its content — a long logo or model
  name widens its box instead of truncating (right column yields first).
- Fix: `centerText` truncated exact-fit lines; now keeps them whole like
  `fitToWidth`.
- Coverage 174 → 178.

## 0.1.9

- `refreshAsync` fetches only visible data (branch spawn skipped unless
  `{branch}` appears in an expanded string; session import/scan skipped unless
  the sessions block is laid out) and skips repaints when results match state.
- Unconfigured/yielded advisories primed before first paint; one `homedir()`
  per route; single-syscall config layer reads (`ENOENT`/`ENOTDIR` = absent).
- Coverage 168 → 174.

## 0.1.8

- Concurrent branch + session fetches with a single repaint; cached host
  settings resolution; yielded-marker check before the settings import;
  shadowed `.pi` config stays warning-silent; shared session-route prelude.
- Coverage 160 → 168.

## 0.1.7

- Session-route and renderer bug fixes; coverage 160.

## 0.1.6

- CI (typecheck + tests + smoke on Node 24/26) and GitHub Packages mirror.

## 0.1.5

- Edge-case hardening: explicit empty arrays, claim rollback, marker
  retention on write failure, lone-ESC and wide-glyph truncation, NaN dates,
  detached HEAD, non-TUI toggles.

## 0.1.4

- Quiet latch replaced with the ownership model (`owned`/`yielded` marker);
  uninstall-reset hook; `LEARNINGS.md`.

## 0.1.3

- `replaceNativeWelcome` (default `true`) replaces `replaceHeader` /
  `hideNativeWelcome`.

## 0.1.2

- Opt-in `hideNativeWelcome` to suppress the native welcome on omp.

## 0.1.1

- Review hardening: probe restores the native header, stable quotes,
  warning-preserving config, cell-accurate widths.
