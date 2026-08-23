/**
 * omp-startup entry point.
 *
 * Lifecycle:
 *   - Registered `/dashboard` command always exists (invoking it is an explicit
 *     user action, allowed even without any config file).
 *   - `session_start`: load layered config; if nothing is configured anywhere,
 *     do NOTHING — native welcome screens stay exactly as without the plugin.
 *     Otherwise mount the dashboard (Pi: additive widget above the editor, or
 *     full header replacement under explicit `replaceHeader`; omp: widget).
 *   - `before_agent_start`: dismiss-on-first-prompt when configured.
 *   - `session_shutdown`: release an opt-in `hideNativeWelcome` engagement
 *     (restores the previous `startup.quiet` value; the only settings write
 *     this extension ever performs, and only when explicitly configured).
 */

import { homedir } from "node:os";
import { makeDashboardComponent } from "./dashboard.ts";
import { DEFAULT_CONFIG, loadConfig, type DashboardConfig, type LoadedConfig } from "./config.ts";
import {
	fetchBranch,
	fetchRecentSessions,
	loadHostSettings,
	probeHeaderSupport,
	snapshotInfo,
	WIDGET_KEY,
	type DashboardState,
} from "./host.ts";

/** Dim line rendered inside the widget on non-header hosts (currently omp), where the replica stacks over the built-in welcome. Transient notify channels drop content presented around startup, so the hint lives in the widget itself. */
const QUIET_ADVISORY = "omp-startup: set startup.quiet=true to hide the built-in welcome while this shows";

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
	/**
	 * Opt-in `hideNativeWelcome` capture latch. Holds the pre-existing
	 * startup.quiet value plus whether WE changed it. Lives from mount until
	 * the dashboard unmounts (dismiss/toggle-off) or shutdown, so the user's
	 * original value is captured before our first write and restored exactly
	 * once per engagement. `wrote=false` (user already had quiet on) means
	 * release has nothing to restore.
	 */
	let quietLatch: { previous: unknown; wrote: boolean } | undefined;

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

	function mount(ctx: ExtensionContextSubset): void {
		if (headerCapable && cfgRef.current.replaceHeader) {
			ctx.ui.setHeader(dash.factory);
			mountMode = "header";
			stateRef.current.hint = undefined;
		} else {
			ctx.ui.setWidget(WIDGET_KEY, dash.factory, { placement: "aboveEditor" });
			mountMode = "widget";
			// Non-header host: if we stacked over a built-in welcome, point at
			// the quiet setting. omp exposes VERSION; upstream Pi does not, and
			// its own quietStartup key differs — so gate the hint on VERSION.
			const stackedOmpWelcome = !headerCapable && stateRef.current.version !== "";
			stateRef.current.hint =
				stackedOmpWelcome && !cfgRef.current.hideNativeWelcome ? QUIET_ADVISORY : undefined;
		}
		visible = true;
		void engageQuiet();
	}

	async function engageQuiet(): Promise<void> {
		if (quietLatch || !cfgRef.current.hideNativeWelcome) return;
		if (headerCapable || stateRef.current.version === "") return; // omp family only
		const settings = await loadHostSettings();
		// Re-validate after the await: the dashboard may have been dismissed or
		// toggled off, or config reloaded, while we were importing.
		if (!settings || mountMode !== "widget" || !visible || !cfgRef.current.hideNativeWelcome) return;
		const previous = settings.get("startup.quiet");
		const wrote = previous !== true;
		quietLatch = { previous, wrote };
		if (wrote) {
			try {
				settings.set("startup.quiet", true);
			} catch {
				quietLatch = undefined; // nothing changed; shutdown must not "restore"
				return;
			}
		}
		stateRef.current.hint = undefined; // advisory is obsolete once we own the setting
		dash.refresh();
	}

	async function releaseQuiet(): Promise<void> {
		const latch = quietLatch;
		quietLatch = undefined;
		if (!latch?.wrote) return;
		const settings = await loadHostSettings();
		if (!settings) return;
		try {
			settings.set("startup.quiet", latch.previous === true);
			// set() only arms a debounced save; flushing here keeps the restore
			// from being lost when the host exits right after teardown.
			await settings.flush?.();
		} catch {
			// Best effort only; a stale true self-heals on the next engaged session.
		}
	}

	function unmount(ctx: ExtensionContextSubset): void {
		if (mountMode === "header") ctx.ui.setHeader(undefined);
		else if (mountMode === "widget") ctx.ui.setWidget(WIDGET_KEY, undefined);
		mountMode = null;
		visible = false;
		// Dashboard gone → nothing needs quiet. Restoring mid-session (dismiss
		// or toggle-off) leaves ample runtime for the debounced save; shutdown
		// remains a best-effort fallback for sessions that never unmount.
		void releaseQuiet();
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
		if (!ctx.hasUI || ctx.mode !== "tui") return;
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
		if (!loaded || loaded.explicitKeys.size === 0) return;

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

		mount(ctx);
	});

	api.on("before_agent_start", (_event, ctx) => {
		if (!visible || !cfgRef.current.dismiss) return;
		unmount(ctx);
	});

	api.on("session_shutdown", async () => {
		// Awaited on purpose: the host gives shutdown handlers a bounded window
		// (~2s) before exiting; a detached restore would lose that race.
		await releaseQuiet();
		visible = false;
		mountMode = null;
	});
}
