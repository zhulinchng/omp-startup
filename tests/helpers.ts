/**
 * Shared test fixtures and mock factories.
 *
 * Mocks replicate each host's *verified* runtime contract:
 *   - upstream Pi invokes a header factory synchronously when installing it
 *     (`setExtensionHeader` → `factory(this.ui, theme)`);
 *   - omp declares `setHeader` but implements it as a no-op;
 *   - both accept widget content as `(tui, theme) => { render(width): string[] }`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { renderDashboard } from "../src/dashboard.ts";
import type { DashboardState } from "../src/host.ts";

/** Theme stub that passes text through untouched (no SGR wrapping). */
export const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Strip SGR escape sequences for content assertions. */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Theme stub for rendering widget content returned by captured factories. */
export const INLINE_THEME = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

export function stripAll(lines: string[]): string[] {
	return lines.map(stripAnsi);
}

export function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
	return {
		user: "zhu",
		cwd: "/tmp/demo",
		dir: "demo",
		model: "claude-opus-4-6",
		provider: "anthropic",
		version: "1.2.3",
		branch: "",
		app: "omp",
		sessions: [
			{ name: "refactor auth", timeAgo: "5m ago" },
			{ name: "fix flaky test", timeAgo: "2h ago" },
		],
		hint: undefined,
		...overrides,
	};
}

export function render(
	cfgOverrides: Partial<DashboardConfig> | undefined,
	state: DashboardState,
	termWidth = 100,
): string[] {
	const cfg: DashboardConfig = { ...DEFAULT_CONFIG, ...cfgOverrides };
	return renderDashboard(cfg, state, PLAIN_THEME, termWidth);
}

export interface ConfigFixtureResult {
	cwd: string;
	home: string;
	dispose(): void;
}

/** Create a scratch cwd/home pair with optional project (.omp/.pi) and user config files. */
export function withDirs(options: {
	project?: Record<string, unknown>;
	projectSubdir?: ".omp" | ".pi";
	user?: Record<string, unknown>;
}): ConfigFixtureResult {
	const dir = mkdtempSync(join(tmpdir(), "omp-startup-test-"));
	const home = join(dir, "home");
	mkdirSync(home, { recursive: true });
	if (options.project !== undefined) {
		const sub = options.projectSubdir ?? ".omp";
		mkdirSync(join(dir, sub), { recursive: true });
		writeFileSync(join(dir, sub, "dashboard.json"), JSON.stringify(options.project));
	}
	if (options.user !== undefined) {
		mkdirSync(join(home, ".config", "dashboard"), { recursive: true });
		writeFileSync(join(home, ".config", "dashboard", "config.json"), JSON.stringify(options.user));
	}
	return {
		cwd: dir,
		home,
		dispose() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// Lifecycle mocks (host API + context)
// ---------------------------------------------------------------------------

export interface RecordedUiCalls {
	setWidget: Array<{ key: string; content: unknown; options: unknown }>;
	setHeader: Array<{ factory: unknown }>;
	notify: Array<{ message: string; type: string }>;
}

export interface MockContextOptions {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	/** "sync" mimics upstream Pi (invokes factory during setHeader); "noop" mimics omp. */
	headerMode?: "noop" | "sync" | "throw";
	version?: string;
	model?: { name?: string; provider?: string } | null;
}

export function makeMockApi(version?: string) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
	const commands: Array<{ name: string; description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void }> = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const api = {
		pi: version === undefined ? undefined : { VERSION: version },
		on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void },
		) {
			commands.push({ name, description: options.description, handler: options.handler });
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			return { stdout: "", stderr: "", code: 128 };
		},
	};
	return {
		api: api as unknown as OmpStartupExtensionAPI,
		handlers,
		commands,
		execCalls,
		handlerFor(event: string) {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler registered for ${event}`);
			return handler as (event: { reason?: string; prompt?: string }, ctx: ExtensionContextSubset) => void | Promise<void>;
		},
		commandHandlerNamed(name: string) {
			const cmd = commands.find(c => c.name === name);
			if (!cmd) throw new Error(`command /${name} not registered`);
			return cmd.handler as (args: string, ctx: ExtensionContextSubset) => Promise<void>;
		},
	};
}

export function makeMockCtx(options: MockContextOptions = {}) {
	const calls: RecordedUiCalls = { setWidget: [], setHeader: [], notify: [] };
	const ui = {
		notify(message: string, type?: "info" | "warning" | "error") {
			calls.notify.push({ message, type: type ?? "info" });
		},
		setWidget(key: string, content: unknown, opts?: { placement?: string }) {
			calls.setWidget.push({ key, content, options: opts });
		},
		setHeader(factory: unknown) {
			// omp's no-op is physically unobservable: don't record probe/restore
			// traffic in noop mode. sync/throw modes record real installs.
			if (options.headerMode !== "noop") calls.setHeader.push({ factory });
			if (options.headerMode === "sync") {
				const f = factory as ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
				f?.({ requestRender() {} }, PLAIN_THEME);
			}
			if (options.headerMode === "throw") throw new Error("unsupported");
		},
	};
	return {
		ctx: {
			ui,
			mode: options.mode ?? ("tui" as const),
			hasUI: options.hasUI ?? true,
			cwd: "/tmp/demo",
			model: options.model === null ? undefined : options.model ?? { name: "test-model", provider: "test-provider" },
		} as ExtensionContextSubset,
		calls,
	};
}
