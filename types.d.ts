/**
 * Ambient type declarations for the host API subset used by omp-startup.
 *
 * The extension deliberately has zero static imports of either host package:
 * omp rewrites `@earendil-works/pi-coding-agent` onto its bundled copy at load
 * time, and upstream Pi ships that specifier natively. Only the dynamic import
 * in `src/host.ts` touches the package (feature-detected, failure-tolerant).
 * These declarations exist purely for local `tsc --noEmit`; hosts never see
 * them and pass richer objects, which remain structurally compatible.
 */

/** Minimal TUI handle exposed to component factories. */
declare interface DashboardTUI {
	requestRender(): void;
}

/** A duck-typed TUI component: both hosts accept `{ render(width): string[] }`. */
declare interface DashboardComponent {
	render(width: number): string[];
	invalidate?(): void;
	dispose?(): void;
}

/** Component factory signature shared by widget content and (Pi) headers. */
declare type DashboardComponentFactory = (tui: DashboardTUI, theme: DashboardTheme) => DashboardComponent;

/** Theme color tokens present on both hosts. */
declare type ThemeColorName =
	| "accent"
	| "muted"
	| "dim"
	| "text"
	| "borderMuted"
	| "borderAccent"
	| "success"
	| "warning"
	| "error";

/** Minimal theme surface used by the renderer. */
declare interface DashboardTheme {
	fg(color: ThemeColorName, text: string): string;
	bold(text: string): string;
}

/** Widget/header entry points on the host UI context. */
declare interface ExtensionUiSubset {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setWidget(
		key: string,
		content: string[] | DashboardComponentFactory | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	setHeader(factory: DashboardComponentFactory | undefined): void;
}

/** Fields of a session model the dashboard displays. */
declare interface ExtensionModelSubset {
	name?: string;
	provider?: string;
}

/** Runtime mode of the host UI. */
declare type HostMode = "tui" | "rpc" | "json" | "print";

/** Event-handler context subset. */
declare interface ExtensionContextSubset {
	ui: ExtensionUiSubset;
	mode: HostMode;
	hasUI: boolean;
	cwd: string;
	model?: ExtensionModelSubset | undefined;
}

/** Shape of host events this extension listens to. */
declare interface HostEvent {
	type?: string;
	reason?: string;
}

/** Result of `pi.exec` (field name verified against omp `exec/exec.ts`). */
declare interface ExecResultSubset {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * The ExtensionAPI subset consumed by omp-startup's default-export factory.
 * Both omp and upstream Pi hand the full API object; extra fields are ignored.
 */
declare interface OmpStartupExtensionAPI {
	/** Host SDK namespace; only VERSION is read. */
	pi?: { VERSION?: string; version?: string } & Record<string, unknown>;
	on(event: string, handler: (event: HostEvent, ctx: ExtensionContextSubset) => void | Promise<void>): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler(args: string, ctx: ExtensionContextSubset): void | Promise<void>;
		},
	): void;
	exec(command: string, args: string[], options?: Record<string, unknown>): Promise<ExecResultSubset>;
}

/** Session rows as returned by either host's listing API (field names differ). */
declare interface HostSessionInfoRow {
	title?: string;
	name?: string;
	path: string;
	modified: Date;
}

/**
 * Feature-detected exports of the host package used for the recent-sessions
 * block. Every member optional; absence degrades to an empty block.
 * - omp exports `getRecentSessions` + static `SessionManager.getDefaultSessionDir`.
 * - upstream Pi exposes `SessionManager.list(cwd)` with `{name, path, modified}`.
 */
declare module "@earendil-works/pi-coding-agent" {
	export function getRecentSessions(
		sessionDir: string,
		limit?: number,
	): Promise<Array<{ name: string; timeAgo: string }>>;

	export const SessionManager:
		| {
				getDefaultSessionDir?(cwd: string): string;
				list?(cwd: string): Promise<HostSessionInfoRow[]>;
		  }
		| undefined;

/** omp only: global settings singleton (`get`/`set` on dotted paths); feature-detected. */
export const settings: unknown;
}

/** Canonical scope; identical surface — re-exported so both specifiers typecheck. */
declare module "@oh-my-pi/pi-coding-agent" {
	export * from "@earendil-works/pi-coding-agent";
}
