/**
 * Smoke suite — runs under plain Node (type stripping), zero host packages.
 *
 * Covers the plan's verification items 1–4 plus render snapshots:
 *   1. inert rule        loadConfig returns null without config files
 *   2. render checks     native-equivalent defaults; partial-config delta
 *   3. probe routing     synchronous setHeader vs no-op setHeader
 *   4. token expansion   exact substitution incl. unknown-token passthrough
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandTokens, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { probeHeaderSupport, snapshotInfo, type DashboardState } from "../src/host.ts";
import { makeDashboardComponent, renderDashboard } from "../src/dashboard.ts";

let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		console.log(`  ok    ${name}`);
	} else {
		failures++;
		console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const STUB_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function snapshot(cfgOverrides: Record<string, unknown>, state: DashboardState): string[] {
	const cfg = { ...DEFAULT_CONFIG, ...cfgOverrides };
	return renderDashboard(cfg as typeof DEFAULT_CONFIG, state, STUB_THEME, 100);
}

function withTempHome(projectConfig: Record<string, unknown> | undefined, fn: (cwd: string, home: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "omp-startup-smoke-"));
	try {
		if (projectConfig !== undefined) {
			mkdirSync(join(dir, ".omp"), { recursive: true });
			writeFileSync(join(dir, ".omp", "dashboard.json"), JSON.stringify(projectConfig));
		}
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		fn(dir, home);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const STATE: DashboardState = {
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
};

// ---------------------------------------------------------------------------
console.log("1. inert rule");
withTempHome(undefined, (cwd, home) => {
	check("no config files → null", loadConfig(cwd, home) === null);
});
withTempHome({}, (cwd, home) => {
	const loaded = loadConfig(cwd, home);
	check("empty config object → defaults, no explicit keys", loaded !== null && loaded.explicitKeys.size === 0 && loaded.warnings.length === 0);
});
withTempHome({ bogusKey: 1 }, (cwd, home) => {
	const loaded = loadConfig(cwd, home);
	check(
		"only unknown keys → warning surfaced, nothing explicit",
		loaded !== null && loaded.explicitKeys.size === 0 && loaded.warnings.some(w => w.includes("unknown key")),
	);
});
withTempHome({ greeting: "Ahoy!" }, (cwd, home) => {
	const loaded = loadConfig(cwd, home);
	check("one key → loaded", loaded !== null && loaded.explicitKeys.has("greeting"));
});

// ---------------------------------------------------------------------------
console.log("2. render checks");
const base = snapshot({}, STATE);

check("default render non-empty", base.length > 8);
check(
	"native greeting present",
	base.some(line => line.includes("Welcome back!")),
);
const PLAIN = (lines: string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
check(
	"π logo glyph present",
	PLAIN(base).some(line => line.includes("▀██████████▀")),
);
check(
	"rounded corners present",
	base.some(line => line.includes("╭")) && base.some(line => line.includes("╯")),
);
check(
	"model/provider info rows present",
	base.some(line => line.includes("claude-opus-4-6")) && base.some(line => line.includes("anthropic")),
);
check(
	"native title present",
	base.some(line => line.includes(" omp v1.2.3 ")),
);
check(
	"shortcuts rows present",
	base.some(line => line.includes("#") && line.includes("for prompt actions")),
);
check(
	"sessions block present",
	base.some(line => line.includes("refactor auth")) && base.some(line => line.includes("(5m ago)")),
);
check(
	"two session rows rendered",
	base.filter(line => line.includes("(5m ago)") || line.includes("(2h ago)")).length === 2,
);

// Partial-config delta: only the greeting line may change.
const changed = snapshot({ greeting: "Ahoy!" }, STATE);
check("delta render same height", changed.length === base.length, `base=${base.length} changed=${changed.length}`);
const diffIndices: number[] = [];
for (let i = 0; i < Math.min(base.length, changed.length); i++) {
	if (base[i] !== changed[i]) diffIndices.push(i);
}
check(
	"exactly one line differs",
	diffIndices.length === 1,
	`diff lines: ${diffIndices.map(i => `${i}: ${JSON.stringify(base[i])} -> ${JSON.stringify(changed[i])}`).join("; ")}`,
);
const firstDiff = diffIndices[0];
check(
	"differing line carries new greeting",
	firstDiff !== undefined && changed[firstDiff]?.includes("Ahoy!") === true,
);

// Layout/logo customization actually changes output.
const plain = snapshot({ layout: "plain", logo: "none", title: "", gradient: false }, STATE);
check(
	"plain layout drops border and glyphs",
	!plain.some(line => line.includes("╭") || line.includes("╯") || line.includes("█")),
);
check(
	"plain layout still shows content",
	plain.some(line => line.includes("Welcome back!")) && plain.some(line => line.includes("claude-opus-4-6")),
);
const customLogo = snapshot({ logo: ["hello-art"], gradient: false }, STATE);
check(
	"custom logo art rendered",
	customLogo.some(line => line.includes("hello-art")),
);
check(
	"plain layout stacks shortcuts and sessions",
	plain.some(line => line.includes("Tips")) && plain.some(line => line.includes("(5m ago)")),
);
const noSessions = snapshot({ sessions: 0 }, STATE);
check(
	"sessions:0 hides block",
	!noSessions.some(line => line.includes("Recent sessions")),
);


// Quote selection must be repaint-stable (regression: per-render randomness).
{
	const multi = ["alpha", "beta", "gamma", "delta"];
	const a = snapshot({ quote: multi }, STATE);
	const b = snapshot({ quote: multi }, STATE);
	const lastOf = (lines: string[]) => PLAIN(lines).at(-1) ?? "";
	check("quote stable across repaints", lastOf(a) === lastOf(b) && multi.some(q => lastOf(a).includes(q)));
}
const quoted = snapshot({ quote: ["stay curious"] }, STATE);
check(
	"quote renders below box",
	quoted.length === base.length + 1 && quoted[quoted.length - 1]?.includes("stay curious") === true,
);

const withHint = snapshot({ quote: [] }, { ...STATE, hint: "omp-startup: set startup.quiet=true" });
check(
	"state hint renders under box",
	withHint.some(line => line.includes("set startup.quiet=true")),
);
check("no hint by default", !base.some(line => line.includes("startup.quiet")));

// Component factory wiring.
const handle = makeDashboardComponent({ current: STATE }, { current: DEFAULT_CONFIG });
let requested = 0;
const component = handle.factory({ requestRender: () => requested++ } as never, STUB_THEME);
const rendered = component.render(100);
check("component renders via factory", rendered.length > 0);
handle.refresh();
check("refresh triggers requestRender", requested >= 1);

// ---------------------------------------------------------------------------
console.log("3. probe routing");
{
	let invoked = false;
	const piLikeUi = {
		setHeader(factory: unknown) {
			// Pi invokes the factory synchronously, then renders the component.
			const component = (factory as (t: unknown, th: unknown) => { render(): string[] })(undefined, undefined);
			component.render();
			invoked = true;
		},
	};
	check("synchronous setHeader → header-capable", probeHeaderSupport(piLikeUi as never));
	check("sentinel actually invoked", invoked);
}
{
	const ompLikeUi = {
		setHeader(_factory: unknown) {
			/* no-op like omp */
		},
	};
	check("no-op setHeader → not header-capable", probeHeaderSupport(ompLikeUi as never) === false);
}
{
	const throwingUi = {
		setHeader() {
			throw new Error("unsupported");
		},
	};
	check("throwing setHeader → not header-capable", probeHeaderSupport(throwingUi as never) === false);
}

// ---------------------------------------------------------------------------
console.log("4. token expansion");
{
	const snap = {
		user: "zhu",
		cwd: "/home/zhu/proj",
		dir: "proj",
		model: "m1",
		provider: "p1",
		version: "9.9",
		branch: "main",
		app: "pi",
	};
	check(
		"all known tokens expand",
		expandTokens("{user}@{dir}:{model}/{provider} v{version} on {branch} via {app}", snap) ===
			"zhu@proj:m1/p1 v9.9 on main via pi",
	);
	check("unknown token untouched", expandTokens("{nope}", snap) === "{nope}");
	check("cwd token expands", expandTokens("{cwd}", snap) === "/home/zhu/proj");
}

// ---------------------------------------------------------------------------
console.log("5. snapshot info");
{
	const ctx = {
		ui: {},
		mode: "tui" as const,
		hasUI: true,
		cwd: "/work/thing",
		model: { name: "gpt-5", provider: "openai" },
	};
	const api = { pi: { VERSION: "0.7.7" } };
	const info = snapshotInfo(ctx as never, api as never);
	check("snapshot fields populated", info.model === "gpt-5" && info.provider === "openai" && info.version === "0.7.7");
	check("snapshot dir is basename", info.dir === "thing");
}

console.log(failures === 0 ? "\nAll smoke checks passed." : `\n${failures} smoke check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
