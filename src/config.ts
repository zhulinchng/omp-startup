/**
 * Layered JSON configuration with explicit-key tracking.
 *
 * Layers (later wins per key):
 *   1. built-in defaults — native-equivalent values (omp WelcomeComponent look)
 *   2. user      ~/.config/dashboard/config.json
 *   3. project   <cwd>/.omp/dashboard.json, falling back to <cwd>/.pi/dashboard.json
 *
 * Inert rule: when neither file exists (or neither carries a recognized key)
 * `loadConfig` returns null and the extension must not touch any UI surface.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BlockName = "greeting" | "logo" | "blank" | "info" | "shortcuts" | "sessions";

export interface ShortcutHint {
	key: string;
	label: string;
}

export interface DashboardConfig {
	/** "box" mirrors the native omp welcome; "plain" stacks blocks without a border. */
	layout: "box" | "plain";
	/** Label embedded in the top border. Tokens expanded. "" disables. */
	title: string;
	/** Maximum box width in terminal columns. */
	width: number;
	/** "pi" = the native π glyph art, "none", or custom ASCII art lines. */
	logo: "pi" | "none" | string[];
	/** Diagonal multi-stop truecolor gradient over the logo art. */
	gradient: boolean;
	greeting: string;
	/** Block order, left column ("box") / sole column ("plain"). */
	left: BlockName[];
	/** Block order, right column ("box" only). */
	right: BlockName[];
	/** Token-expanded rows rendered under the logo. */
	info: string[];
	shortcuts: ShortcutHint[];
	/** Recent-session rows; 0 hides the block. */
	sessions: number;
	/** Random pick rendered below the box; empty renders nothing. */
	quote: string[];
	/** Hide the dashboard after the first submitted prompt. */
	dismiss: boolean;
	/** Slash-command name for manual toggle (without leading slash). */
	command: string;
	/** Pi only: replace the native header instead of adding an above-editor widget. */
	replaceHeader: boolean;
}

/** Native-equivalent defaults: an unconfigured render matches the host welcome. */
export const DEFAULT_CONFIG: DashboardConfig = {
	layout: "box",
	title: "{app} v{version}",
	width: 100,
	logo: "pi",
	gradient: true,
	greeting: "Welcome back!",
	left: ["greeting", "blank", "logo", "blank", "info"],
	right: ["shortcuts", "sessions"],
	info: ["{model}", "{provider}"],
	shortcuts: [
		{ key: "#", label: "for prompt actions" },
		{ key: "/", label: "for commands" },
		{ key: "!", label: "to run bash" },
		{ key: "$", label: "to run python" },
	],
	sessions: 4,
	quote: [],
	dismiss: true,
	command: "dashboard",
	replaceHeader: false,
};

const BLOCK_NAMES = ["greeting", "logo", "blank", "info", "shortcuts", "sessions"] as const;
const KNOWN_KEYS: Record<string, true> = Object.fromEntries(
	Object.keys(DEFAULT_CONFIG).map(key => [key, true as const]),
);
const KNOWN_BLOCKS: Record<string, true> = Object.fromEntries(BLOCK_NAMES.map(name => [name, true as const]));

export interface LoadedConfig {
	cfg: DashboardConfig;
	explicitKeys: Set<string>;
	warnings: string[];
}

export interface TokenSnapshot {
	user: string;
	cwd: string;
	dir: string;
	model: string;
	provider: string;
	version: string;
	branch: string;
	app: string;
}

interface RawLayer {
	file: string;
	/** Undefined when the file does not exist; {} when it exists but is unreadable. */
	data: Record<string, unknown> | undefined;
}

function readLayer(file: string, warnings: string[]): RawLayer {
	if (!existsSync(file)) return { file, data: undefined };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		// The file exists but is unreadable: keep it in the layer set (so
		// loadConfig reports warnings rather than claiming full inertness)
		// while contributing no keys.
		warnings.push(`${file}: invalid JSON (${String(error)})`);
		return { file, data: {} };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push(`${file}: expected a JSON object at the top level`);
		return { file, data: {} };
	}
	return { file, data: parsed as Record<string, unknown> };
}

function coerceString(file: string, key: string, value: unknown, fallback: string, warnings: string[]): string {
	if (typeof value === "string") return value;
	warnings.push(`${file || "(config)"}: "${key}" must be a string; using default`);
	return fallback;
}

function coerceBoolean(file: string, key: string, value: unknown, fallback: boolean, warnings: string[]): boolean {
	if (typeof value === "boolean") return value;
	warnings.push(`${file || "(config)"}: "${key}" must be a boolean; using default`);
	return fallback;
}

function coerceWidth(file: string, value: unknown, fallback: number, warnings: string[]): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.min(500, Math.max(20, Math.round(value)));
	}
	warnings.push(`${file || "(config)"}: "width" must be a number; using default`);
	return fallback;
}

function coerceSessions(file: string, value: unknown, fallback: number, warnings: string[]): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.min(12, Math.max(0, Math.round(value)));
	}
	warnings.push(`${file || "(config)"}: "sessions" must be a number; using default`);
	return fallback;
}

function coerceLayout(file: string, value: unknown, fallback: "box" | "plain", warnings: string[]): "box" | "plain" {
	if (value === "box" || value === "plain") return value;
	warnings.push(`${file || "(config)"}: "layout" must be "box" or "plain"; using default`);
	return fallback;
}

function coerceLogo(
	file: string,
	value: unknown,
	fallback: DashboardConfig["logo"],
	warnings: string[],
): DashboardConfig["logo"] {
	if (value === "pi" || value === "none") return value;
	if (Array.isArray(value) && value.every(line => typeof line === "string")) {
		return value as string[];
	}
	warnings.push(`${file || "(config)"}: "logo" must be "pi", "none", or an array of strings; using default`);
	return fallback;
}

function coerceBlocks(file: string, key: string, value: unknown, fallback: BlockName[], warnings: string[]): BlockName[] {
	if (!Array.isArray(value)) {
		warnings.push(`${file || "(config)"}: "${key}" must be an array; using default`);
		return fallback;
	}
	const blocks: BlockName[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry in KNOWN_BLOCKS) {
			blocks.push(entry as BlockName);
		} else {
			warnings.push(`${file || "(config)"}: "${key}" contains unknown block ${JSON.stringify(entry)}; skipped`);
		}
	}
	return blocks.length > 0 ? blocks : fallback;
}

function coerceStrings(file: string, key: string, value: unknown, fallback: string[], warnings: string[]): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every(item => typeof item === "string")) return value as string[];
	warnings.push(`${file || "(config)"}: "${key}" must be a string or an array of strings; using default`);
	return fallback;
}

function coerceShortcuts(file: string, value: unknown, fallback: ShortcutHint[], warnings: string[]): ShortcutHint[] {
	if (!Array.isArray(value)) {
		warnings.push(`${file || "(config)"}: "shortcuts" must be an array of [key, label] pairs; using default`);
		return fallback;
	}
	const hints: ShortcutHint[] = [];
	for (const entry of value) {
		if (
			Array.isArray(entry) &&
			entry.length >= 2 &&
			typeof entry[0] === "string" &&
			typeof entry[1] === "string"
		) {
			hints.push({ key: entry[0], label: entry[1] });
		} else if (
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as { key?: unknown }).key === "string" &&
			typeof (entry as { label?: unknown }).label === "string"
		) {
			hints.push({ key: (entry as { key: string }).key, label: (entry as { label: string }).label });
		} else {
			warnings.push(`${file || "(config)"}: "shortcuts" contains an invalid entry; skipped`);
		}
	}
	return hints.length > 0 ? hints : fallback;
}

function coerceCommand(file: string, value: unknown, fallback: string, warnings: string[]): string {
	if (typeof value === "string" && /^[\w-]+$/.test(value)) return value;
	warnings.push(`${file || "(config)"}: "command" must be a word (letters/digits/_/-); using default`);
	return fallback;
}

/**
 * Load and merge configuration layers.
 *
 * Returns null only when NO config file exists anywhere — the caller must then
 * leave every native UI surface untouched. When files exist but carry nothing
 * recognized (empty object, unknown keys, unreadable JSON), the result has an
 * empty `explicitKeys` and the collected `warnings`; callers treat that as
 * inert for mounting but may surface the warnings.
 */
export function loadConfig(cwd: string, home: string): LoadedConfig | null {
	const warnings: string[] = [];

	// Project layer: first existing file wins so .omp and .pi users don't double-apply.
	const projectFiles = [join(cwd, ".omp", "dashboard.json"), join(cwd, ".pi", "dashboard.json")];
	const project = projectFiles.map(file => readLayer(file, warnings)).find(layer => layer.data !== undefined);

	const user = readLayer(join(home, ".config", "dashboard", "config.json"), warnings);

	const layers = [user, project].filter((layer): layer is RawLayer & { data: Record<string, unknown> } =>
		layer !== undefined && layer.data !== undefined,
	);
	if (layers.length === 0) return null;

	// Dynamic runtime keys from JSON files → Map with source-file provenance.
	const merged = new Map<string, { value: unknown; file: string }>();
	const explicitKeys = new Set<string>();
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer.data)) {
			if (!(key in KNOWN_KEYS)) {
				warnings.push(`${layer.file}: unknown key "${key}"; ignored`);
				continue;
			}
			merged.set(key, { value, file: layer.file });
			explicitKeys.add(key);
		}
	}

	function pick<K extends keyof DashboardConfig>(key: K): DashboardConfig[K] {
		const entry = merged.get(key);
		// Absent keys keep their defaults untouched — never validated, no warnings.
		if (!entry) return DEFAULT_CONFIG[key];
		const file = entry.file;
		const value = entry.value;
		const fallback = DEFAULT_CONFIG[key];
		switch (key) {
			case "layout":
				return coerceLayout(file, value, fallback as "box" | "plain", warnings) as DashboardConfig[K];
			case "title":
			case "greeting":
				return coerceString(file, key, value, fallback as string, warnings) as DashboardConfig[K];
			case "width":
				return coerceWidth(file, value, fallback as number, warnings) as DashboardConfig[K];
			case "logo":
				return coerceLogo(file, value, fallback as DashboardConfig["logo"], warnings) as DashboardConfig[K];
			case "gradient":
			case "dismiss":
			case "replaceHeader":
				return coerceBoolean(file, key, value, fallback as boolean, warnings) as DashboardConfig[K];
			case "left":
				return coerceBlocks(file, "left", value, fallback as BlockName[], warnings) as DashboardConfig[K];
			case "right":
				return coerceBlocks(file, "right", value, fallback as BlockName[], warnings) as DashboardConfig[K];
			case "info":
				return coerceStrings(file, "info", value, fallback as string[], warnings) as DashboardConfig[K];
			case "quote":
				return coerceStrings(file, "quote", value, fallback as string[], warnings) as DashboardConfig[K];
			case "shortcuts":
				return coerceShortcuts(file, value, fallback as ShortcutHint[], warnings) as DashboardConfig[K];
			case "sessions":
				return coerceSessions(file, value, fallback as number, warnings) as DashboardConfig[K];
			case "command":
				return coerceCommand(file, value, fallback as string, warnings) as DashboardConfig[K];
		}
		throw new Error(`unhandled config key: ${String(key)}`);
	}

	const cfg: DashboardConfig = {
		layout: pick("layout"),
		title: pick("title"),
		width: pick("width"),
		logo: pick("logo"),
		gradient: pick("gradient"),
		greeting: pick("greeting"),
		left: pick("left"),
		right: pick("right"),
		info: pick("info"),
		shortcuts: pick("shortcuts"),
		sessions: pick("sessions"),
		quote: pick("quote"),
		dismiss: pick("dismiss"),
		command: pick("command"),
		replaceHeader: pick("replaceHeader"),
	};

	return { cfg, explicitKeys, warnings };
}

function twoDigits(n: number): string {
	return String(n).padStart(2, "0");
}

/** Substitute `{token}` placeholders; unknown tokens are left untouched. */
export function expandTokens(text: string, snap: TokenSnapshot): string {
	return text.replace(/\{(\w+)\}/g, (match, name: string) => {
		switch (name) {
			case "user":
				return snap.user;
			case "cwd":
				return snap.cwd;
			case "dir":
				return snap.dir;
			case "model":
				return snap.model;
			case "provider":
				return snap.provider;
			case "version":
				return snap.version;
			case "branch":
				return snap.branch;
			case "app":
				return snap.app;
			case "date": {
				const now = new Date();
				return `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`;
			}
			case "time": {
				const now = new Date();
				return `${twoDigits(now.getHours())}:${twoDigits(now.getMinutes())}`;
			}
			default:
				return match;
		}
	});
}
