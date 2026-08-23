/**
 * Host abstraction: capability probing, info snapshotting, and async data
 * fetches. Everything here is failure-tolerant — a missing capability degrades
 * a single dashboard element, never the session.
 */

import { basename } from "node:path";
import type { TokenSnapshot } from "./config.ts";

export const WIDGET_KEY = "omp-startup";

export interface SessionRow {
	name: string;
	timeAgo: string;
}

export interface DashboardState extends TokenSnapshot {
	sessions: SessionRow[];
	/** Dim advisory line rendered under the box (widget mode on non-header hosts). */
	hint?: string | undefined;
}

/**
 * Detect whether `ui.setHeader` is actually wired up.
 *
 * Upstream Pi invokes the header factory synchronously when installing it;
 * omp declares the method but implements it as a no-op. A sentinel factory
 * that records invocation tells the two apart without version sniffing, and
 * self-heals if omp wires setHeader up later.
 */
export function probeHeaderSupport(ui: ExtensionUiSubset): boolean {
	let invoked = false;
	const sentinel = (_tui: DashboardTUI, _theme: DashboardTheme): DashboardComponent => {
		// Flag at FACTORY-CALL time: upstream Pi invokes the factory to obtain
		// the component but renders only on the next paint.
		invoked = true;
		return { render: () => [] };
	};
	try {
		ui.setHeader(sentinel);
	} catch {
		return false;
	}
	if (!invoked) return false;
	// A header-capable host actually INSTALLED the sentinel, displacing the
	// native header (Pi's setExtensionHeader swaps it into the container).
	// Restore the built-in header immediately so probing leaves no trace —
	// inert sessions and additive-widget mounts must keep the native header.
	try {
		ui.setHeader(undefined);
	} catch {
		// Restore failure must not break routing decisions.
	}
	return true;
}

/**
 * Binary-name heuristic for the `{app}` token. Returns "omp"/"pi" when the
 * running executable matches, else "". Exported with an injectable path for
 * tests (process.execPath cannot be reassigned reliably).
 */
export function detectAppName(execPath: string = process.execPath): string {
	try {
		const binary = basename(execPath);
		return binary === "omp" || binary === "pi" ? binary : "";
	} catch {
		return "";
	}
}

function detectUser(): string {
	return process.env.USER ?? process.env.USERNAME ?? "?";
}

/** Synchronously collect everything the renderer needs except async blocks. */
export function snapshotInfo(ctx: ExtensionContextSubset, api: OmpStartupExtensionAPI): DashboardState {
	const cwd = ctx.cwd;
	return {
		user: detectUser(),
		cwd,
		dir: basename(cwd) || cwd,
		model: ctx.model?.name ?? "Unknown",
		provider: ctx.model?.provider ?? "Unknown",
		version: api.pi?.VERSION ?? api.pi?.version ?? "",
		branch: "",
		app: detectAppName(),
		sessions: [],
		hint: undefined,
	};
}

/** Current git branch via the host's exec seam; "" outside a repo. */
export async function fetchBranch(api: OmpStartupExtensionAPI): Promise<string> {
	try {
		const result = await api.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (result.code !== 0) return "";
		return result.stdout.trim();
	} catch {
		return "";
	}
}

function formatTimeAgo(then: Date): string {
	const seconds = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}

async function listViaHostPackage(cwd: string, count: number): Promise<SessionRow[]> {
	const mod = await import("@earendil-works/pi-coding-agent");
	const sessionManager = mod.SessionManager;

	// Preferred path: the host's own recent-session helper yields native
	// name/timeAgo formatting (exact parity with the built-in welcome).
	if (typeof mod.getRecentSessions === "function" && typeof sessionManager?.getDefaultSessionDir === "function") {
		return await mod.getRecentSessions(sessionManager.getDefaultSessionDir(cwd), count);
	}

	// Fallback: plain listing mapped defensively.
	if (typeof sessionManager?.list === "function") {
		const infos = await sessionManager.list(cwd);
		return mapSessionInfos(infos).slice(0, count);
	}

	return [];
}

/**
 * Map either host's session-listing rows to dashboard rows.
 * omp names sessions `title`, upstream Pi `name`; empty strings fall through
 * to the file basename. Exported for tests.
 */
export function mapSessionInfos(
	infos: Array<{ title?: string | undefined; name?: string | undefined; path: string; modified: Date }>,
): SessionRow[] {
	return infos.map(info => ({
		name: info.name || info.title || basename(info.path),
		timeAgo: formatTimeAgo(info.modified),
	}));
}


/**
 * Recent sessions for the sessions block. Any failure — package absent,
 * API shape drifted, storage unreadable — degrades to an empty list.
 */
export async function fetchRecentSessions(cwd: string, count: number): Promise<SessionRow[]> {
	if (count <= 0) return [];
	try {
		return await listViaHostPackage(cwd, count);
	} catch {
		return [];
	}
}
