/**
 * omp-startup entry point.
 *
 * Lifecycle:
 *   - Registered `/dashboard` command always exists (invoking it is an explicit
 *     user action, allowed even without any config file).
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
import { DEFAULT_CONFIG, loadConfig, type DashboardConfig, type LoadedConfig } from "./config.ts";
import {
	clearQuietOwnership,
	fetchBranch,
	fetchRecentSessions,
	loadHostSettings,
	probeHeaderSupport,
	readQuietOwnership,
	snapshotInfo,
	writeQuietOwnership,
	WIDGET_KEY,
	type DashboardState,
} from "./host.ts";

/** Dim line rendered inside the widget whenever we stack beside the built-in welcome on an omp-family host (takeover off, a manual /dashboard show, or a yielded escape hatch). Transient notify channels drop content presented around startup, so the hint lives in the widget itself. */
const QUIET_ADVISORY = 'omp-startup: set "replaceNativeWelcome": true to replace the built-in welcome';

type MountMode = "header" | "widget" | null;

function initialState(): DashboardState {
	return {
		user: process.env.USER ?? process.env.USERNAME ?? "?",
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

	async function refreshAsync(): Promise<void> {
		const cwd = stateRef.current.cwd;
		try {
			const branch = await fetchBranch(api);
			if (stateRef.current.cwd === cwd) stateRef.current.branch = branch;
			dash.refresh();
		} catch {
			// Branch is decorative; never surface fetch failures.
		}
		try {
			const rows = await fetchRecentSessions(cwd, cfgRef.current.sessions);
			if (stateRef.current.cwd === cwd) stateRef.current.sessions = rows;
			dash.refresh();
		} catch {
			// Sessions block degrades to empty; never fatal.
		}
	}

	/**
	 * Take ownership of `startup.quiet` for the omp-family widget route.
	 * Idempotent across sessions: the marker file, not memory, carries state
	 * between launches. See the module doc comment for the state machine.
	 */
	async function claimQuietOwnership(): Promise<void> {
		if (!cfgRef.current.replaceNativeWelcome) return;
		if (headerCapable || stateRef.current.version === "") return; // omp family only
		const home = homedir();
		const settings = await loadHostSettings();
		// Re-validate after the await: the dashboard may have been dismissed or
		// toggled off, or config reloaded, while we were importing.
		if (!settings || mountMode !== "widget" || !visible || !cfgRef.current.replaceNativeWelcome) return;
		const existing = readQuietOwnership(home);
		if (existing?.state === "yielded") {
			stackAdvisory(); // escape hatch active: native welcome is back for good
			return;
		}
		const previous = settings.get("startup.quiet") === true;
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
		writeQuietOwnership(home, { previous, state: "owned" });
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
		const home = homedir();
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
		if (headerCapable && cfgRef.current.replaceNativeWelcome) {
			ctx.ui.setHeader(dash.factory);
			mountMode = "header";
			stateRef.current.hint = undefined;
			// Pi route on a machine whose global config we may have claimed
			// earlier: hand quiet back while the session is fully alive.
			void giveUpQuietOwnership();
		} else {
			ctx.ui.setWidget(WIDGET_KEY, dash.factory, { placement: "aboveEditor" });
			mountMode = "widget";
			// Stacked over a built-in welcome (omp-family host) without takeover:
			// point at the setting that would replace it. omp exposes VERSION;
			// upstream Pi does not, and its own quietStartup key differs — so
			// gate the hint on VERSION.
			const stackedOmpWelcome = !headerCapable && stateRef.current.version !== "";
			stateRef.current.hint =
				stackedOmpWelcome && !cfgRef.current.replaceNativeWelcome ? QUIET_ADVISORY : undefined;
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

	async function toggle(_args: string, ctx: ExtensionContextSubset): Promise<void> {
		if (visible) {
			unmount(ctx);
			return;
		}
		// Re-probe every time: hosts may fire session_start more than once
		// (upstream Pi: once against the runner's no-op UI, then the real TUI).
		headerCapable = probeHeaderSupport(ctx.ui);

		const loaded = loadConfig(ctx.cwd, homedir());
		cfgRef.current = loaded ? loaded.cfg : DEFAULT_CONFIG;
		for (const warning of loaded?.warnings ?? []) {
			ctx.ui.notify(`omp-startup: ${warning}`, "warning");
		}
		stateRef.current = snapshotInfo(ctx, api);
		void refreshAsync();
		mount(ctx);
	}

	api.registerCommand(DEFAULT_CONFIG.command, {
		description: "Toggle the startup dashboard",
		handler: toggle,
	});

	api.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			void giveUpQuietOwnership();
			return;
		}
		headerCapable = probeHeaderSupport(ctx.ui);

		const loaded: LoadedConfig | null = loadConfig(ctx.cwd, homedir());
		cfgRef.current = loaded?.cfg ?? DEFAULT_CONFIG;

		// Warnings describe the user's own config files (broken JSON, unknown
		// keys, invalid values) — surface them even when nothing is mountable.
		for (const warning of loaded?.warnings ?? []) {
			ctx.ui.notify(`omp-startup: ${warning}`, "warning");
		}

		// Inert rule: no config files anywhere, or none of them carry a
		// recognized key → leave every native surface untouched. (The probe
		// above already restored any header it touched.)
		if (!loaded || loaded.explicitKeys.size === 0) {
			void giveUpQuietOwnership();
			return;
		}

		stateRef.current = snapshotInfo(ctx, api);
		void refreshAsync();

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
			mount(ctx);
		} else {
			void giveUpQuietOwnership();
		}
	});

	api.on("before_agent_start", (_event, ctx) => {
		if (!visible || !cfgRef.current.dismiss) return;
		unmount(ctx);
	});

}
