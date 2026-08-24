# Engineering Learnings — omp & Pi host behavior

Findings from live PTY verification and source archaeology that future
changes to this plugin (or similar extensions) will need again. Everything
here was verified against the installed **omp 18.0.3** binary unless marked
otherwise; the oh-my-pi git checkout is often *newer* than the binary — trust
the binary for what ships today.

## 1. `startup.quiet` is a boot-time, global, file-backed switch

- The composer reads `startup.quiet` exactly once during
  `InteractiveMode.init()` — **before** extensions load and before any
  `session_start` handler can run (`composer.setPreferences({ quiet })`,
  `composer.updateWelcome(...)`).
- Consequence: no extension can suppress the native welcome for the *current*
  session by writing settings. Any suppression scheme must persist the value
  for the *next* process. This is why omp-startup owns the key across
  launches instead of flipping it per session.
- `resuming` (from `--continue` / `--resume` / `--fork`) only feeds
  `suppressWelcomeIntro` — i.e., it skips the intro *animation*. The welcome
  box itself renders identically on fresh and resumed sessions.
- The value lives in the user-global `~/.omp/agent/config.yml`; every running
  omp on the machine sees it. Concurrent sessions in other projects are
  affected while it is set.

## 2. Extension-visible events: what fires when

- `session_start` fires for fresh **and** resumed launches (emitted from
  `initHooksAndCustomTools()` after the first paint). It carries **no
  payload** in omp (`{ type: "session_start" }`) — unlike upstream Pi, whose
  event includes `reason: "startup" | "reload" | "new" | "resume" | "fork"`.
  There is therefore **no supported way to detect resume** in an omp
  extension; `session_switch` (reason `"new" | "resume" | "fork"`) only fires
  for in-process switches (`/resume`, `/new`, fork), never at process launch.
- `session_shutdown` is fire-and-forget teardown: the host does not wait for
  handlers to finish before exiting. **Never perform durable writes there.**
  Verified live: an awaited restore inside `session_shutdown` regularly lost
  the race against process exit and left `startup.quiet: true` behind.
  All durable writes now happen at `session_start` with an awaited flush.

## 3. Settings singleton gotchas

- The SDK exports `settings` with `get(path)` / `set(path, value)` and an
  async `flush()`. `set()` only arms a **100 ms debounced save**; anything
  that must survive exit needs `await settings.flush()`.
- Feature-detect the export defensively (`typeof get/set === "function"`).
  `in` checks are unreliable against bundled module namespaces; validate by
  `typeof` on destructured members instead.
- If you wrap the singleton, **pass `flush` through**. The original wrapper
  silently dropped it, which is how the shutdown-race leak went unnoticed:
  `settings.flush?.()` was always `undefined` and restores relied solely on
  the debounce.

## 4. Plugin/extension loading and uninstall

- npm-installed plugins live in `~/.omp/plugins/node_modules/<pkg>` and load
  **in every project** (user scope). A dev symlink in `<project>/.omp/extensions`
  loads *in addition*, so test machines can easily run two copies of this
  plugin at once — watch for doubled warnings/duplicated widgets.
- `.omp/plugin-overrides.json` `{"disabled": ["omp-startup"]}` did **not**
  silence the installed copy under binary 18.0.3 (the project-overrides code
  exists in newer source, not in the shipped binary). For airtight isolation,
  run the binary with a sandboxed `$HOME` (see §7).
- Uninstall runs `bun uninstall <name>` inside the plugins dir (or deletes
  marketplace files). **No extension-authored hook fires**; bun may skip npm
  lifecycle scripts entirely, so `postuninstall` coverage is best-effort.
  Upstream gap tracked in oh-my-pi issue #5531 ("Add plugin uninstall
  lifecycle hook"). Anything the plugin persists outside its own directory
  needs a self-heal path at next load *and* a documented manual reset.
- omp has no `config set`-style CLI; manual settings fixes mean editing
  `~/.omp/agent/config.yml`.

## 5. Rendering/layout facts worth remembering

- The native welcome is a composer *header* component; extension widgets with
  `placement: "aboveEditor"` render between the transcript and the editor.
  On resume, that puts the dashboard directly above the input line while the
  native welcome stays at the top of the screen.
- `DEFAULT_CONFIG` intentionally mirrors the native `WelcomeComponent`
  (greeting "Welcome back!", π-art logo, Tips/sessions columns). In
  diff-repaint logs our box and the native box look near-identical — use
  distinguishing markers (host tip lines like "Ctrl+D can be used to exit",
  bullet glyphs `•` vs `()`, or our quote line) rather than eyeballing.
- The header "retires" once the transcript fills the viewport; on long
  resumed sessions the welcome box is legitimately absent from repaints even
  when `quiet` is false.

## 6. Reading PTY session logs

- Daemon output logs live at
  `~/.omp/run/daemons/<host-id>/daemons/<run-name>/output.log`. They are
  **append-only diff-repaint streams**: frames overlay each other, stale rows
  linger, and naive tails mislead. Force a full repaint with
  `kill -WINCH <pid>` before copying the log, then read the *tail* as the
  current frame and prefer unique-string probes over visual inspection.
- Quit via the PTY (`/exit` + Enter); SIGTERM skips graceful paths. Exit code
  0 confirmed for `/exit`.
- Readiness patterns double as behavior probes: a fresh launch with
  `quiet=true` and no dashboard paints **no `╭` at all**, so a `╭` readiness
  match on a plugin-free run means the welcome rendered (and vice versa).

## 7. Sandboxed `$HOME` isolation recipe (works)

1. `cp -a ~/.omp /tmp/omp-su-home/.omp` (sockets warn and skip — fine), then
   delete copied daemon run dirs; seed `agent/config.yml` as needed.
2. Remember the copy **includes installed plugins** — remove
   `.omp/plugins/node_modules/<pkg>` from the sandbox or you test two copies.
3. Launch with `env HOME=/tmp/omp-su-home`. Node's `os.homedir()` honors
   `$HOME` on macOS/Linux; all state (settings writes, auth, sessions) then
   lands in the sandbox and the real config is untouched (verify by md5
   before/after).
4. Credentials copied with `.omp` kept model calls working in the sandbox.

## 8. Testing hooks in this repo

- `$HOME` redirect at the top of `tests/lifecycle.test.ts` keeps user-config
  leakage out; the ownership marker helpers read/write inside that fake home.
- `makeFakeSettings()` tracks `get`/`set` calls and flush counts — assert on
  `flushed()` whenever durability matters.
- `setHostSettingsForTest(null)` clears the override so the real
  feature-detect path degrades to `undefined` in host-free test runs.
- Keep assertions behavioral (which writes happened, which UI surfaces were
  touched), never source-textual.
