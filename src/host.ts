/**
 * Host abstraction: capability probing, info snapshotting, and async data
 * fetches. Everything here is failure-tolerant — a missing capability degrades
 * a single dashboard element, never the session.
 */

import { basename, join } from "node:path";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
		// Restore failed: the sentinel is still installed, displacing the
		// native header. Route to the additive widget rather than leaving a
		// blank header behind (observed with a sentinel-installing setHeader
		// whose restore path throws).
		return false;
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
		const ref = result.stdout.trim();
		if (ref !== "" && ref !== "HEAD") return ref;
		// Detached HEAD: --abbrev-ref prints the literal "HEAD"; the short
		// commit hash is the honest stand-in.
		const sha = await api.exec("git", ["rev-parse", "--short", "HEAD"]);
		return sha.code === 0 ? sha.stdout.trim() : "";
	} catch {
		return "";
	}
}

function formatTimeAgo(then: Date): string {
	if (!Number.isFinite(then.getTime())) return "unknown";
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
 * omp-family predicate for the widget route: omp exposes VERSION while
 * upstream Pi exports none, but older omp builds may also omit it — in that
 * case the `{app}` heuristic (binary name "omp") still identifies the host.
 * Quiet writes additionally require loadHostSettings() to succeed, so this
 * predicate only widens the advisory path, never the write path alone.
 */
export function isOmpFamily(version: string, app: string): boolean {
	return version !== "" || app === "omp";
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
		name: info.name || info.title || (typeof info.path === "string" ? basename(info.path) : "untitled"),
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

// ---------------------------------------------------------------------------
// Host settings access (replaceNativeWelcome takeover)
// ---------------------------------------------------------------------------
/**
 * Minimal shape of the host SDK settings singleton this extension relies on.
 */
export interface HostSettings {
	get(path: string): unknown;
	set(path: string, value: unknown): void;
	/**
	 * Flushes debounced persistence to disk. Optional: every durable write
	 * this extension performs awaits it, because the host exits immediately
	 * after teardown and a pending debounced save would be lost.
	 */
	flush?(): Promise<void>;
}

let settingsOverride: HostSettings | undefined;
let settingsOverridden = false;

/**
 * Test seam: force loadHostSettings() to return `s` (pass undefined to
 * simulate an absent SDK); pass null to clear the override entirely.
 */
export function setHostSettingsForTest(s: HostSettings | undefined | null): void {
	if (s === null) {
		settingsOverride = undefined;
		settingsOverridden = false;
		return;
	}
	settingsOverride = s;
	settingsOverridden = true;
}

/**
 * The host SDK's settings singleton, or undefined when unavailable.
 *
 * omp exports one — `settings.set("startup.quiet", …)` updates memory now and
 * persists (debounced) to the global config.yml; upstream Pi exports none.
 * Feature-detected dynamic import, same pattern as listViaHostPackage:
 * absence or drift degrades to undefined and callers keep advisory-only mode.
 */
export async function loadHostSettings(): Promise<HostSettings | undefined> {
	if (settingsOverridden) return settingsOverride;
	try {
		const mod = await import("@earendil-works/pi-coding-agent");
		const s: unknown = mod.settings;
		if (typeof s !== "object" || s === null) return undefined;
		// Named typed view so members can be inspected; each member is validated
		// by typeof below before use. (`in` checks are unreliable here: bundled
		// module-namespace objects may answer `in` falsely for existing props.)
		const candidate = s as { get?: unknown; set?: unknown; flush?: unknown };
		const { get, set } = candidate;
		if (typeof get !== "function" || typeof set !== "function") {
			return undefined;
		}
		const flush =
			typeof candidate.flush === "function"
				? async () => {
						await (candidate.flush as () => Promise<void>)();
					}
				: undefined;
		const wrapped: HostSettings = {
			get: path => get(path),
			set: (path, value) => {
				set(path, value);
			},
		};
		if (flush) wrapped.flush = flush;
		return wrapped;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Quiet-ownership state file (replaceNativeWelcome takeover bookkeeping)
// ---------------------------------------------------------------------------

/**
 * Persistent record of the plugin's relationship to `startup.quiet`.
 *
 * - `owned`: we flipped quiet false→true and owe a restore when takeover
 *   stops (config disabled, config deleted, or host without settings).
 * - `yielded`: the user reset `startup.quiet` underneath us — an escape
 *   hatch. We never auto-take again until they delete this file.
 *
 * Lives outside the extension directory so it can outlive the install just
 * long enough for the postuninstall reset script to find it.
 */
export interface QuietOwnership {
	previous: boolean;
	state: "owned" | "yielded";
}

function ownershipPath(home: string): string {
	return join(home, ".config", "dashboard", ".ownership.json");
}

/** Reads the marker; absent/corrupt/malformed all mean "no record". */
export function readQuietOwnership(home: string): QuietOwnership | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(ownershipPath(home), "utf8"));
		if (typeof raw !== "object" || raw === null) return undefined;
		const rec = raw as { previous?: unknown; state?: unknown };
		if ((rec.state !== "owned" && rec.state !== "yielded") || typeof rec.previous !== "boolean") {
			return undefined;
		}
		return { previous: rec.previous, state: rec.state };
	} catch {
		return undefined;
	}
}

export function writeQuietOwnership(home: string, ownership: QuietOwnership): boolean {
	try {
		mkdirSync(join(home, ".config", "dashboard"), { recursive: true });
		writeFileSync(ownershipPath(home), `${JSON.stringify(ownership, null, "\t")}\n`);
		return true;
	} catch {
		// Callers decide what losing the record means; see claim's rollback.
		return false;
	}
}

export function clearQuietOwnership(home: string): void {
	try {
		unlinkSync(ownershipPath(home));
	} catch {
		// Already absent — nothing to clean.
	}
}
