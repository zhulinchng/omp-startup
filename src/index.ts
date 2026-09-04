/**
 * omp-startup entry point.
 *
 *   - Registered `/dashboard` and `/dashboard-config` commands always exist
 *     (invoking either is an explicit user action, allowed even without any
 *     config file). `/dashboard-config` reports which config files are loaded.
 *   - `session_start`: load layered config; if nothing is configured anywhere,
 *     do NOTHING — native welcome screens stay exactly as without the plugin.
 *     Otherwise take over the native welcome slot (default,
 *     `replaceNativeWelcome: true`): Pi swaps its header component in place so
 *     the dashboard scrolls away like the native header; omp has no stream API,
 *     so it claims ownership of `startup.quiet` and mounts the widget above
 *     the editor. With `replaceNativeWelcome: false` nothing mounts at
 *     startup — the dashboard is manual-only (/dashboard).
 *   - `before_agent_start`: dismiss-on-first-prompt when configured.
 *
 * Quiet ownership (omp family only): while takeover is configured, we keep
 * `startup.quiet = true` across sessions so every launch renders a single
 * dashboard instead of a stacked native+custom pair — omp reads the setting
 * once at boot, before extensions load, so per-session suppression via a
 * global file is impossible. A marker file records what we replaced:
 *   - owned: restore + clear whenever a session starts WITHOUT the takeover
 *     route (config disabled/absent, Pi header host, non-TUI mode). Restores
 *     happen at session start with an awaited flush — never at shutdown,
 *     where writes race teardown and get lost (verified live).
 *   - yielded: the user set `startup.quiet: false` underneath us (escape
 *     hatch); we stand down permanently until they delete the marker.
 * The only harness-settings writes remain quiet=true on claim and the
 * previous value on give-up — both on omp, both gated by the marker.
 */

import { homedir } from "node:os";
import { makeDashboardComponent } from "./dashboard.ts";
import { configFileCandidates, DEFAULT_CONFIG, loadConfig, type DashboardConfig, type LoadedConfig } from "./config.ts";
import {
	clearQuietOwnership,
	detectUser,
	fetchBranch,
	fetchRecentSessions,
	isOmpFamily,
	loadHostSettings,
	probeHeaderSupport,
	readQuietOwnership,
	snapshotInfo,
	writeQuietOwnership,
	WIDGET_KEY,
	type DashboardState,
	type SessionRow,
} from "./host.ts";

/** Dim line rendered inside the widget whenever we stack beside the built-in welcome on an omp-family host (takeover off, a manual /dashboard show, or a yielded escape hatch). Transient notify channels drop content presented around startup, so the hint lives in the widget itself. */
const QUIET_ADVISORY = 'omp-startup: set "replaceNativeWelcome": true to replace the built-in welcome';

type MountMode = "header" | "widget" | null;

function initialState(): DashboardState {
	return {
		user: detectUser(),
		cwd: "",
		dir: "",
		model: "Unknown",
		provider: "Unknown",
		version: "",
		branch: "",
		app: "",
		sessions: [],
		hint: undefined,
	};
}

export default function ompStartup(api: OmpStartupExtensionAPI): void {
	const stateRef: { current: DashboardState } = { current: initialState() };
	const cfgRef: { current: DashboardConfig } = { current: DEFAULT_CONFIG };
	const dash = makeDashboardComponent(stateRef, cfgRef);

	let headerCapable: boolean | null = null;
	let mountMode: MountMode = null;
	let visible = false;
	/** Set by a `before_agent_start` dismissal; suppresses auto-remount on
	 *  later session routes (resume/switch/branch) until an explicit
	 *  `/dashboard` show clears it. Ownership markers are untouched — the
	 *  next launch must still render a single clean dashboard. */
	let dismissed = false;
	/** True when a config file with ≥1 recognized key exists — manual
	 *  /dashboard shows on unconfigured projects must stay fully read-only. */
	let configured = false;
	/** Home dir captured once per route and shared by the config load, marker
	 *  checks, and quiet-ownership flows (one homedir() per route, and a
	 *  consistent view even if the environment shifted mid-route). */
	let routeHome = "";
	/** Ownership-marker state at route time, so mount can prime sync-known
	 *  hints before first paint. claimQuietOwnership keeps its own post-await
	 *  re-read for freshness; this is paint-priming only. */
	let routeYielded = false;

	/** True when any token-expanded string can show the git branch. Shortcut
	 *  labels never expand tokens (rendered raw), so they are excluded. */
	function branchVisible(cfg: DashboardConfig): boolean {
		return (
			cfg.title.includes("{branch}") ||
			cfg.greeting.includes("{branch}") ||
			cfg.info.some(row => row.includes("{branch}")) ||
			cfg.quote.some(row => row.includes("{branch}"))
		);
	}

	/** True when the sessions block renders: named in a visible column with a
	 *  nonzero row count (buildBlock drops it otherwise). */
	function sessionsVisible(cfg: DashboardConfig): boolean {
		return cfg.sessions > 0 && (cfg.left.includes("sessions") || cfg.right.includes("sessions"));
	}

	function sameSessions(a: SessionRow[], b: SessionRow[]): boolean {
		return (
			a.length === b.length &&
			a.every((row, index) => row.name === b[index]?.name && row.timeAgo === b[index]?.timeAgo)
		);
	}

	async function refreshAsync(): Promise<void> {
		const cwd = stateRef.current.cwd;
		const cfg = cfgRef.current;
		// Fetch only what the frame can show: a git spawn plus a host-package
		// import and session-dir scan on every launch is pure waste when the
		// results have nowhere to render. Neither leg blocks first paint
		// (mount already happened); skipping them also skips their repaint.
		const wantBranch = branchVisible(cfg);
		const wantSessions = sessionsVisible(cfg);
		if (!wantBranch && !wantSessions) return;
		// The two fetches are independent (git spawn vs session listing) — run
		// them concurrently instead of sequentially, then paint once. Each leg
		// keeps its own failure isolation so one bad source can't drop the other.
		const branchPromise = wantBranch ? fetchBranch(api) : Promise.resolve(undefined);
		const sessionsPromise = wantSessions ? fetchRecentSessions(cwd, cfg.sessions) : Promise.resolve(undefined);
		let branch: string | undefined;
		let rows: SessionRow[] | undefined;
		try {
			branch = await branchPromise;
		} catch {
			// Branch is decorative; never surface fetch failures.
		}
		try {
			rows = await sessionsPromise;
		} catch {
			// Sessions block degrades to empty; never fatal.
		}
		if (stateRef.current.cwd !== cwd) return; // stale route: a newer route owns the frame
		let changed = false;
		if (branch !== undefined && branch !== stateRef.current.branch) {
			stateRef.current.branch = branch;
			changed = true;
		}
		if (rows !== undefined && !sameSessions(stateRef.current.sessions, rows)) {
			stateRef.current.sessions = rows;
			changed = true;
		}
		// Steady state (branch "" outside a repo, empty session list) used to
		// repaint an identical frame on every route — skip it.
		if (changed) dash.refresh();
	}

	/**
	 * Take ownership of `startup.quiet` for the omp-family widget route.
	 * Idempotent across sessions: the marker file, not memory, carries state
	 * between launches. See the module doc comment for the state machine.
	 */
	async function claimQuietOwnership(): Promise<void> {
		if (!cfgRef.current.replaceNativeWelcome) return;
		if (headerCapable || !isOmpFamily(stateRef.current.version, stateRef.current.app)) return; // omp family only
		if (!configured) {
			// Unconfigured project: the inert contract wins even for explicit
			// toggles. Stacking is permanent here (nothing will ever own quiet),
			// so say so instead of silently duplicating the welcome. Mount
			// already primed this hint pre-paint; skip the second refresh.
			if (stateRef.current.hint !== QUIET_ADVISORY) stackAdvisory();
			return;
		}
		// Home captured at route time: the marker decision reflects this route's view.
		const home = routeHome;
		// Yielded escape hatch first: it resolves from the marker file alone,
		// so yielded users skip the host-package import on every launch.
		if (readQuietOwnership(home)?.state === "yielded") {
			// Escape hatch active: native welcome is back for good. Pre-primed
			// by mount; skip the redundant repaint when it is.
			if (stateRef.current.hint !== QUIET_ADVISORY) stackAdvisory();
			return;
		}
		const settings = await loadHostSettings();
		// Re-validate after the await: the dashboard may have been dismissed or
		// toggled off, or config reloaded, while we were importing.
		if (mountMode !== "widget" || !visible || !cfgRef.current.replaceNativeWelcome) {
			return;
		}
		if (!settings) {
			stackAdvisory(); // cannot suppress anything on this host — be honest
			return;
		}
		const existing = readQuietOwnership(home);
		let previous: boolean;
		try {
			previous = settings.get("startup.quiet") === true;
		} catch {
			stackAdvisory(); // settings unreadable — same as unavailable, but never write
			return;
		}
		if (previous && !existing) {
			// quiet was on before we ever engaged — the user's own preference,
			// not our residue. Ride along visually but never own it, so an
			// uninstall can never strip their choice.
			return;
		}
		if (previous) return; // owned and already true: steady state, no write
		if (existing) {
			// Marker says owned but quiet reads false — the user reset it
			// deliberately. Yield instead of fighting them every launch.
			writeQuietOwnership(home, { previous: false, state: "yielded" });
			stackAdvisory();
			return;
		}
		try {
			settings.set("startup.quiet", true);
			// Durable immediately: shutdown-time writes lose a race with host
			// teardown (verified live), so nothing is deferred to exit.
			await settings.flush?.();
		} catch {
			stackAdvisory(); // could not take over; be honest about the stacking
			return;
		}
		// Rollback beats marker-first: an orphan owned-marker would trip the
		// permanent escape hatch, while quiet-without-marker is recoverable.
		if (!writeQuietOwnership(home, { previous, state: "owned" })) {
			try {
				settings.set("startup.quiet", previous);
				await settings.flush?.();
			} catch {
				// Both writes broken; the advisory below still tells the truth.
			}
			stackAdvisory(); // no owned marker, so the claim must not stand
			return;
		}
		stateRef.current.hint = undefined;
		dash.refresh();
	}

	function stackAdvisory(): void {
		stateRef.current.hint = QUIET_ADVISORY;
		dash.refresh();
	}

	/**
	 * Restore `startup.quiet` and drop the marker when a session starts
	 * without the takeover route (config disabled/absent, Pi header host,
	 * non-TUI mode). Runs at session start — never at shutdown — so the
	 * awaited flush always completes while the process is fully alive.
	 */
	async function giveUpQuietOwnership(): Promise<void> {
		const home = routeHome;
		const existing = readQuietOwnership(home);
		if (!existing) return;
		if (existing.state === "owned") {
			const settings = await loadHostSettings();
			if (!settings) return; // keep marker; a later session or the uninstall script resets
			try {
				settings.set("startup.quiet", existing.previous);
				await settings.flush?.();
			} catch {
				return; // keep marker for retry / uninstall script
			}
		}
		clearQuietOwnership(home);
	}

	function mount(ctx: ExtensionContextSubset): void {
		// Stacked over a built-in welcome (omp-family host) without takeover:
		// point at the setting that would replace it. omp exposes VERSION
		// (older builds may omit it — then the "omp" binary heuristic in
		// isOmpFamily still matches); upstream Pi exposes neither, and its
		// own quietStartup key differs — so gate the hint on omp-family.
		const stackedOmpWelcome = !headerCapable && isOmpFamily(stateRef.current.version, stateRef.current.app);
		// Sync-known advisories resolved BEFORE the factory is handed out, so
		// even a synchronous first render paints them: takeover-off stacking
		// (as before), plus the unconfigured and yielded cases claim used to
		// attach one refresh later with identical pixels.
		const widgetHint =
			stackedOmpWelcome && (!cfgRef.current.replaceNativeWelcome || !configured || routeYielded)
				? QUIET_ADVISORY
				: undefined;
		if (headerCapable && cfgRef.current.replaceNativeWelcome) {
			stateRef.current.hint = undefined;
			ctx.ui.setHeader(dash.factory);
			mountMode = "header";
			// Pi route on a machine whose global config we may have claimed
			// earlier: hand quiet back while the session is fully alive.
			void giveUpQuietOwnership();
		} else {
			stateRef.current.hint = widgetHint;
			ctx.ui.setWidget(WIDGET_KEY, dash.factory, { placement: "aboveEditor" });
			mountMode = "widget";
		}
		visible = true;
		void claimQuietOwnership();
	}

	function unmount(ctx: ExtensionContextSubset): void {
		if (mountMode === "header") ctx.ui.setHeader(undefined);
		else if (mountMode === "widget") ctx.ui.setWidget(WIDGET_KEY, undefined);
		mountMode = null;
		visible = false;
		// Ownership persists across dismissals by design: restoring has no
		// visual effect mid-session (omp read the setting at boot), and the
		// next launch should still render a single clean dashboard.

	}

	/**
	 * Shared session-route prelude: probe, load, warn. Returns undefined when
	 * the surface can't show UI (ownership already handed back), null when no
	 * config file exists — toggle mounts either way (explicit user action),
	 * automatic routes mount only on a real LoadedConfig.
	 */
	function prepareRoute(ctx: ExtensionContextSubset): LoadedConfig | null | undefined {
		// One home read per route, shared by the config load, the marker check
		// below, and the ownership flows (all run at route time or capture it).
		routeHome = homedir();
		if (!ctx.hasUI || ctx.mode !== "tui") {
			void giveUpQuietOwnership();
			return undefined;
		} // same surface rule as session routes, plus ownership bookkeeping
		// Re-probe every time: hosts may fire session_start more than once
		// (upstream Pi: once against the runner's no-op UI, then the real TUI).
		headerCapable = probeHeaderSupport(ctx.ui);

		const loaded: LoadedConfig | null = loadConfig(ctx.cwd, routeHome);
		cfgRef.current = loaded?.cfg ?? DEFAULT_CONFIG;
		configured = !!loaded && loaded.explicitKeys.size > 0;
		// Sync marker read for pre-paint hint priming in mount (claim keeps
		// its own post-await re-read for freshness).
		routeYielded = readQuietOwnership(routeHome)?.state === "yielded";

		// Warnings describe the user's own config files (broken JSON, unknown
		// keys, invalid values) — surface them even when nothing is mountable.
		for (const warning of loaded?.warnings ?? []) {
			ctx.ui.notify(`omp-startup: ${warning}`, "warning");
		}
		return loaded;
	}

	function snapshotAndRefresh(ctx: ExtensionContextSubset): void {
		stateRef.current = snapshotInfo(ctx, api);
		void refreshAsync();
	}

	async function toggle(_args: string, ctx: ExtensionContextSubset): Promise<void> {
		if (prepareRoute(ctx) === undefined) return;
		if (visible) {
			unmount(ctx);
			return;
		}
		dismissed = false; // explicit show overrides any earlier dismissal
		snapshotAndRefresh(ctx);
		mount(ctx);
	}

	/**
	 * `/dashboard-config`: report which config files feed the merge. Read-only
	 * by construction — loads and describes, never mounts, warns, or writes.
	 * Warnings are deliberately NOT re-emitted here: every session route
	 * already surfaced them, and the command always runs after session_start.
	 */
	async function showConfigPath(_args: string, ctx: ExtensionContextSubset): Promise<void> {
		// Same surface rule as the toggle: outside the TUI, notify is a
		// verified no-op (runner/session stubs) or an unknown sink — stay silent.
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		const home = homedir();
		const loaded = loadConfig(ctx.cwd, home);
		if (!loaded) {
			const candidates = configFileCandidates(ctx.cwd, home);
			ctx.ui.notify(
				`omp-startup: no config file found (checked ${candidates.projectOmp}, ${candidates.projectPi}, ${candidates.user})`,
				"info",
			);
			return;
		}
		const sources: string[] = [];
		if (loaded.files.project !== undefined) sources.push(`project: ${loaded.files.project}`);
		if (loaded.files.user !== undefined) sources.push(`user: ${loaded.files.user}`);
		const keyCount = loaded.explicitKeys.size;
		const detail =
			keyCount > 0
				? `${keyCount} recognized key${keyCount === 1 ? "" : "s"}${sources.length > 1 ? "; project wins per key" : ""}`
				: "no recognized keys — dashboard stays inert";
		ctx.ui.notify(`omp-startup config loaded from ${sources.join(" + ")} (${detail})`, "info");
	}

	function handleSessionRoute(_event: HostEvent, ctx: ExtensionContextSubset): void {
		const loaded = prepareRoute(ctx);
		if (loaded === undefined) return;

		// Inert rule: no config files anywhere, or none of them carry a
		// recognized key → leave every native surface untouched. (The probe
		// above already restored any header it touched.)
		if (!loaded || loaded.explicitKeys.size === 0) {
			void giveUpQuietOwnership();
			return;
		}

		// A `before_agent_start` dismissal persists across later automatic
		// routes (revived sessions, switch/branch/tree) until an explicit
		// `/dashboard` show clears it. Ownership is untouched: the next
		// launch must still render a single clean dashboard.
		if (dismissed) return;

		snapshotAndRefresh(ctx);

		// Config may rename the command; try to register an alias (best effort —
		// late registration is not guaranteed on every host; /dashboard remains).
		if (cfgRef.current.command !== DEFAULT_CONFIG.command) {
			try {
				api.registerCommand(cfgRef.current.command, {
					description: "Toggle the startup dashboard",
					handler: toggle,
				});
			} catch {
				// Alias unavailable; the default /dashboard command still works.
			}
		}

		// replaceNativeWelcome:false means the native welcome owns startup; the
		// dashboard is manual-only (/dashboard). Any quiet we claimed in an
		// earlier session is returned now, while the process can still flush.
		if (cfgRef.current.replaceNativeWelcome) {
			// A later route may disagree with the earlier probe (Pi runner-era
			// widget vs real-TUI header, or vice versa): overwriting alone
			// would leave the other surface installed, so clear first.
			if (visible) unmount(ctx);
			mount(ctx);
		} else {
			void giveUpQuietOwnership();
		}
	}

	api.registerCommand(DEFAULT_CONFIG.command, {
		description: "Toggle the startup dashboard",
		handler: toggle,
	});

	// Fixed name by design: the `command` config key renames only the toggle
	// above, so this diagnostic is always where /help says it is.
	api.registerCommand("dashboard-config", {
		description: "Show which omp-startup config files are loaded",
		handler: showConfigPath,
	});

	api.on("session_start", handleSessionRoute);
	api.on("session_switch", handleSessionRoute);
	api.on("session_branch", handleSessionRoute);
	api.on("session_tree", handleSessionRoute);

	api.on("before_agent_start", (_event, ctx) => {
		if (!visible || !cfgRef.current.dismiss) return;
		unmount(ctx);
		dismissed = true;
	});
}
