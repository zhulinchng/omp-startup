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
 */

import { homedir } from "node:os";
import { makeDashboardComponent } from "./dashboard.ts";
import { DEFAULT_CONFIG, loadConfig, type DashboardConfig, type LoadedConfig } from "./config.ts";
import {
	fetchBranch,
	fetchRecentSessions,
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
			stateRef.current.hint = stackedOmpWelcome ? QUIET_ADVISORY : undefined;
		}
		visible = true;
	}

	function unmount(ctx: ExtensionContextSubset): void {
		if (mountMode === "header") ctx.ui.setHeader(undefined);
		else if (mountMode === "widget") ctx.ui.setWidget(WIDGET_KEY, undefined);
		mountMode = null;
		visible = false;
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
		cfgRef.current = loaded ? loaded.cfg : DEFAULT_CONFIG;

		stateRef.current = snapshotInfo(ctx, api);
		void refreshAsync();

		for (const warning of loaded?.warnings ?? []) {
			ctx.ui.notify(`omp-startup: ${warning}`, "warning");
		}

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

		// Inert rule: no config anywhere → leave every native surface untouched.
		if (!loaded) return;
		mount(ctx);
	});

	api.on("before_agent_start", (_event, ctx) => {
		if (!visible || !cfgRef.current.dismiss) return;
		unmount(ctx);
	});

	api.on("session_shutdown", () => {
		visible = false;
		mountMode = null;
	});
}
