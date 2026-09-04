/**
 * Tests for src/config.ts — layered loading, inert rule, coercion,
 * per-key provenance warnings, and token expansion.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configFileCandidates, DEFAULT_CONFIG, expandTokens, loadConfig } from "../src/config.ts";
import { withDirs } from "./helpers.ts";

describe("config: inert rule", () => {
	it("returns null when no config files exist", () => {
		const fx = withDirs({});
		try {
			assert.equal(loadConfig(fx.cwd, fx.home), null);
		} finally {
			fx.dispose();
		}
	});

	it("returns defaults with empty explicitKeys when the project file is an empty object", () => {
		const fx = withDirs({ project: {} });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.explicitKeys.size, 0);
			assert.deepEqual(loaded.cfg, DEFAULT_CONFIG);
			assert.deepEqual(loaded.warnings, []);
		} finally {
			fx.dispose();
		}
	});

	it("reports unknown keys while keeping explicitKeys empty", () => {
		const fx = withDirs({ project: { bogus: 1, another: "x" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.explicitKeys.size, 0);
			assert.equal(loaded.warnings.length, 2);
			assert.ok(loaded.warnings.every(w => w.includes("unknown key")));
		} finally {
			fx.dispose();
		}
	});

	it("reports unknown keys from a user file with empty explicitKeys", () => {
		const fx = withDirs({ user: { nope: true } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.explicitKeys.size, 0);
			assert.equal(loaded.warnings.length, 1);
		} finally {
			fx.dispose();
		}
	});

	it("surfaces broken JSON as a warning instead of collapsing to null", () => {
		const fixture = withDirs({});
		try {
			mkdirSync(join(fixture.cwd, ".omp"), { recursive: true });
			writeFileSync(join(fixture.cwd, ".omp", "dashboard.json"), "{ not json");
			const loaded = loadConfig(fixture.cwd, fixture.home);
			assert.ok(loaded);
			assert.equal(loaded.explicitKeys.size, 0);
			assert.ok(loaded.warnings.some(w => w.includes("invalid JSON")));
		} finally {
			fixture.dispose();
		}
	});

	it("treats an untraversable project path as absent (ENOTDIR, no warning)", () => {
		const fixture = withDirs({});
		try {
			writeFileSync(join(fixture.cwd, ".omp"), "not a dir");
			const loaded = loadConfig(fixture.cwd, fixture.home);
			assert.equal(loaded, null);
		} finally {
			fixture.dispose();
		}
	});

	it("warns on a directory at the config path (EISDIR) without keys", () => {
		const fixture = withDirs({});
		try {
			mkdirSync(join(fixture.cwd, ".omp", "dashboard.json"), { recursive: true });
			const loaded = loadConfig(fixture.cwd, fixture.home);
			assert.ok(loaded);
			assert.equal(loaded.explicitKeys.size, 0);
			assert.ok(loaded.warnings.some(w => w.includes("invalid JSON")));
		} finally {
			fixture.dispose();
		}
	});
});

describe("config: layer discovery", () => {
	it("loads a project .omp/dashboard.json", () => {
		const fx = withDirs({ project: { greeting: "Ahoy!" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.greeting, "Ahoy!");
			assert.deepEqual([...loaded.explicitKeys], ["greeting"]);
			assert.deepEqual(loaded.warnings, []);
		} finally {
			fx.dispose();
		}
	});

	it("falls back to .pi/dashboard.json when .omp is absent", () => {
		const fx = withDirs({ project: { greeting: "Pi!" }, projectSubdir: ".pi" });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.greeting, "Pi!");
		} finally {
			fx.dispose();
		}
	});

	it("prefers .omp over .pi when both exist", () => {
		const fx = withDirs({ project: { greeting: "FromOmp" } });
		mkdirSync(join(fx.cwd, ".pi"), { recursive: true });
		writeFileSync(join(fx.cwd, ".pi", "dashboard.json"), JSON.stringify({ greeting: "FromPi" }));
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.greeting, "FromOmp");
		} finally {
			fx.dispose();
		}
	});

	it("ignores the shadowed .pi file entirely once .omp exists", () => {
		const fx = withDirs({ project: { greeting: "FromOmp" } });
		mkdirSync(join(fx.cwd, ".pi"), { recursive: true });
		writeFileSync(join(fx.cwd, ".pi", "dashboard.json"), "{ not json");
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.greeting, "FromOmp");
			assert.ok(
				loaded.warnings.every(w => !w.includes(".pi")),
				`shadowed file must stay silent: ${loaded.warnings.join("; ")}`,
			);
		} finally {
			fx.dispose();
		}
	});

	it("project keys override user keys; user-only keys still apply", () => {
		const fx = withDirs({
			project: { greeting: "ProjectWins" },
			user: { greeting: "UserLoses", sessions: 2 },
		});
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.greeting, "ProjectWins");
			assert.equal(loaded.cfg.sessions, 2);
			assert.equal(loaded.explicitKeys.size, 2);
		} finally {
			fx.dispose();
		}
	});
});

describe("config: defaults are native-equivalent", () => {
	it("matches the omp welcome look", () => {
		assert.equal(DEFAULT_CONFIG.layout, "box");
		assert.equal(DEFAULT_CONFIG.title, "{app} v{version}");
		assert.equal(DEFAULT_CONFIG.logo, "pi");
		assert.equal(DEFAULT_CONFIG.gradient, true);
		assert.equal(DEFAULT_CONFIG.greeting, "Welcome back!");
		assert.equal(DEFAULT_CONFIG.width, 100);
		assert.equal(DEFAULT_CONFIG.sessions, 4);
		assert.equal(DEFAULT_CONFIG.dismiss, true);
		assert.equal(DEFAULT_CONFIG.command, "dashboard");
		assert.equal(DEFAULT_CONFIG.replaceNativeWelcome, true);
		assert.deepEqual(DEFAULT_CONFIG.info, ["{model}", "{provider}"]);
		assert.deepEqual(DEFAULT_CONFIG.left, ["greeting", "blank", "logo", "blank", "info"]);
		assert.deepEqual(DEFAULT_CONFIG.right, ["shortcuts", "sessions"]);
		assert.deepEqual(DEFAULT_CONFIG.quote, []);
		assert.deepEqual(
			DEFAULT_CONFIG.shortcuts,
			Object.freeze([
				{ key: "#", label: "for prompt actions" },
				{ key: "/", label: "for commands" },
				{ key: "!", label: "to run bash" },
				{ key: "$", label: "to run python" },
			]).slice(),
		);
	});
});

describe("config: coercion and warnings", () => {
	it("rejects invalid layout with a warning naming the file", () => {
		const fx = withDirs({ project: { layout: "diagonal" as unknown as string } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.layout, "box");
			assert.ok(loaded.warnings.some(w => w.includes('"layout"') && w.includes(fx.cwd)));
		} finally {
			fx.dispose();
		}
	});

	it("clamps width into [20, 500]", () => {
		const low = withDirs({ project: { width: 5 } });
		try {
			assert.equal(loadConfig(low.cwd, low.home)?.cfg.width, 20);
		} finally {
			low.dispose();
		}
		const high = withDirs({ project: { width: 9999 } });
		try {
			assert.equal(loadConfig(high.cwd, high.home)?.cfg.width, 500);
		} finally {
			high.dispose();
		}
	});

	it("clamps sessions into [0, 12] and rounds", () => {
		const frac = withDirs({ project: { sessions: 2.7 } });
		try {
			assert.equal(loadConfig(frac.cwd, frac.home)?.cfg.sessions, 3);
		} finally {
			frac.dispose();
		}
		const neg = withDirs({ project: { sessions: -4 } });
		try {
			assert.equal(loadConfig(neg.cwd, neg.home)?.cfg.sessions, 0);
		} finally {
			neg.dispose();
		}
	});

	it("accepts all three logo shapes and rejects others", () => {
		for (const logo of ["pi", "none"] as const) {
			const fx = withDirs({ project: { logo } });
			try {
				assert.equal(loadConfig(fx.cwd, fx.home)?.cfg.logo, logo);
			} finally {
				fx.dispose();
			}
		}
		const custom = withDirs({ project: { logo: ["LINE ONE", "line two"] } });
		try {
			assert.deepEqual(loadConfig(custom.cwd, custom.home)?.cfg.logo, ["LINE ONE", "line two"]);
		} finally {
			custom.dispose();
		}
		const bad = withDirs({ project: { logo: 42 as unknown as string } });
		try {
			const loaded = loadConfig(bad.cwd, bad.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.logo, "pi");
			assert.ok(loaded.warnings.some(w => w.includes('"logo"')));
		} finally {
			bad.dispose();
		}
	});

	it("filters unknown block names, keeping the remainder even when empty", () => {
		const partial = withDirs({ project: { left: ["greeting", "nope"] as never } });
		try {
			const loaded = loadConfig(partial.cwd, partial.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, ["greeting"]);
			assert.ok(loaded.warnings.some(w => w.includes('"left"')));
		} finally {
			partial.dispose();
		}
		const garbage = withDirs({ project: { left: ["zzz"] as never } });
		try {
			const loaded = loadConfig(garbage.cwd, garbage.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, []);
			assert.equal(loaded.warnings.length, 1);
		} finally {
			garbage.dispose();
		}
	});

	it("wraps a scalar quote into an array", () => {
		const fx = withDirs({ project: { quote: "solo" } });
		try {
			assert.deepEqual(loadConfig(fx.cwd, fx.home)?.cfg.quote, ["solo"]);
		} finally {
			fx.dispose();
		}
	});

	it("accepts shortcuts as pairs or objects and drops invalid entries", () => {
		const fx = withDirs({
			project: { shortcuts: [["?", "help"], { key: "@", label: "files" }, "junk"] as never },
		});
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.shortcuts, [
				{ key: "?", label: "help" },
				{ key: "@", label: "files" },
			]);
			assert.ok(loaded.warnings.some(w => w.includes("shortcuts")));
		} finally {
			fx.dispose();
		}
	});

	it("keeps configured shortcuts empty when no entry survives", () => {
		const fx = withDirs({ project: { shortcuts: [42] as never } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.shortcuts, []);
			assert.equal(loaded.warnings.length, 1);
		} finally {
			fx.dispose();
		}
	});

	it("honors explicit zero and empty-string values instead of defaults", () => {
		const fx = withDirs({ project: { sessions: 0, greeting: "" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.sessions, 0);
			assert.equal(loaded.cfg.greeting, "");
			assert.ok(loaded.explicitKeys.has("sessions"));
			assert.ok(loaded.explicitKeys.has("greeting"));
			assert.deepEqual(loaded.warnings, []);
		} finally {
			fx.dispose();
		}
	});

	it("honors an explicit single blank info row", () => {
		const fx = withDirs({ project: { info: [""] } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.info, [""]);
			assert.ok(loaded.explicitKeys.has("info"));
			assert.deepEqual(loaded.warnings, []);
		} finally {
			fx.dispose();
		}
	});

	it("enforces command-name charset", () => {
		const bad = withDirs({ project: { command: "not a word!" } });
		try {
			const loaded = loadConfig(bad.cwd, bad.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.command, "dashboard");
			assert.ok(loaded.warnings.some(w => w.includes('"command"')));
		} finally {
			bad.dispose();
		}
		const ok = withDirs({ project: { command: "dash_2" } });
		try {
			assert.equal(loadConfig(ok.cwd, ok.home)?.cfg.command, "dash_2");
		} finally {
			ok.dispose();
		}
	});

	it("parses replaceNativeWelcome and rejects non-boolean values", () => {
		const on = withDirs({ project: { replaceNativeWelcome: true } });
		try {
			const loaded = loadConfig(on.cwd, on.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.replaceNativeWelcome, true);
			assert.ok(loaded.explicitKeys.has("replaceNativeWelcome"));
		} finally {
			on.dispose();
		}
		const bad = withDirs({ project: { replaceNativeWelcome: "yes" } });
		try {
			const loaded = loadConfig(bad.cwd, bad.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.replaceNativeWelcome, true);
			assert.ok(loaded.warnings.some(w => w.includes('"replaceNativeWelcome"')));
		} finally {
			bad.dispose();
		}
	});

	it("honors explicit empty arrays instead of reverting to defaults", () => {
		const fx = withDirs({ project: { left: [], right: [], shortcuts: [] } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, []);
			assert.deepEqual(loaded.cfg.right, []);
			assert.deepEqual(loaded.cfg.shortcuts, []);
			for (const key of ["left", "right", "shortcuts"]) assert.ok(loaded.explicitKeys.has(key));
			assert.deepEqual(loaded.warnings, []);
		} finally {
			fx.dispose();
		}
	});

	it("still warns and defaults on invalid array entries while keeping valid empties", () => {
		const fx = withDirs({ project: { left: ["greeting", "nope"], right: "box" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, ["greeting"]);
			assert.equal(loaded.cfg.right, DEFAULT_CONFIG.right);
			assert.equal(loaded.warnings.length, 2);
			assert.ok(loaded.warnings.every(w => w.includes('"right"') || w.includes('"left"')));
		} finally {
			fx.dispose();
		}
	});

});

describe("expandTokens", () => {
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

	it("expands every known token", () => {
		assert.equal(
			expandTokens("{user}@{dir}:{model}/{provider} v{version} on {branch} via {app}", snap),
			"zhu@proj:m1/p1 v9.9 on main via pi",
		);
		assert.equal(expandTokens("{cwd}", snap), "/home/zhu/proj");
	});

	it("leaves unknown tokens untouched", () => {
		assert.equal(expandTokens("{nope} {user}", snap), "{nope} zhu");
	});

	it("produces stable date/time shapes", () => {
		assert.match(expandTokens("{date}", snap), /^\d{4}-\d{2}-\d{2}$/);
		assert.match(expandTokens("{time}", snap), /^\d{2}:\d{2}$/);
	});

	it("expands date/time from an injected clock", () => {
		const now = new Date(2026, 8, 4, 9, 5);
		assert.equal(expandTokens("{date} {time} {time}", snap, now), "2026-09-04 09:05 09:05");
	});
});

describe("config: explicit empties and top-level shape", () => {
	it("honors explicit empty block lists without warnings", () => {
		const fx = withDirs({ project: { left: [], right: [] } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, []);
			assert.deepEqual(loaded.cfg.right, []);
			assert.ok(loaded.explicitKeys.has("left"));
			assert.ok(loaded.explicitKeys.has("right"));
			assert.deepEqual(loaded.warnings, []);
		} finally {
			fx.dispose();
		}
	});

	it("warns on a non-object top level instead of collapsing to null", () => {
		const fx = withDirs({});
		try {
			mkdirSync(join(fx.cwd, ".omp"), { recursive: true });
			writeFileSync(join(fx.cwd, ".omp", "dashboard.json"), "[1, 2]");
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded, "existing file keeps the layer set non-inert");
			assert.deepEqual(loaded.explicitKeys, new Set());
			assert.ok(loaded.warnings.some(w => w.includes("expected a JSON object")));
		} finally {
			fx.dispose();
		}
	});
});

describe("config: file provenance", () => {
	it("reports the three probed paths in check order", () => {
		const fx = withDirs({});
		try {
			assert.deepEqual(configFileCandidates(fx.cwd, fx.home), {
				projectOmp: join(fx.cwd, ".omp", "dashboard.json"),
				projectPi: join(fx.cwd, ".pi", "dashboard.json"),
				user: join(fx.home, ".config", "dashboard", "config.json"),
			});
		} finally {
			fx.dispose();
		}
	});

	it("names the project file when only it exists", () => {
		const fx = withDirs({ project: { greeting: "hi" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { project: join(fx.cwd, ".omp", "dashboard.json") });
		} finally {
			fx.dispose();
		}
	});

	it("names the user file when only it exists", () => {
		const fx = withDirs({ user: { greeting: "hi" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { user: join(fx.home, ".config", "dashboard", "config.json") });
		} finally {
			fx.dispose();
		}
	});

	it("names both files when both layers exist", () => {
		const fx = withDirs({ project: { greeting: "hi" }, user: { title: "t" } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, {
				project: join(fx.cwd, ".omp", "dashboard.json"),
				user: join(fx.home, ".config", "dashboard", "config.json"),
			});
		} finally {
			fx.dispose();
		}
	});

	it("names the .pi fallback when no .omp file exists", () => {
		const fx = withDirs({ project: { greeting: "hi" }, projectSubdir: ".pi" });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { project: join(fx.cwd, ".pi", "dashboard.json") });
		} finally {
			fx.dispose();
		}
	});

	it("names only the shadowing .omp file when both project dirs exist", () => {
		const fx = withDirs({ project: { greeting: "hi" } });
		try {
			mkdirSync(join(fx.cwd, ".pi"), { recursive: true });
			writeFileSync(join(fx.cwd, ".pi", "dashboard.json"), JSON.stringify({ title: "shadowed" }));
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { project: join(fx.cwd, ".omp", "dashboard.json") });
			assert.equal(loaded.cfg.title, DEFAULT_CONFIG.title);
		} finally {
			fx.dispose();
		}
	});

	it("still names a project file with broken JSON", () => {
		const fx = withDirs({});
		try {
			mkdirSync(join(fx.cwd, ".omp"), { recursive: true });
			writeFileSync(join(fx.cwd, ".omp", "dashboard.json"), "{oops");
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { project: join(fx.cwd, ".omp", "dashboard.json") });
			assert.equal(loaded.explicitKeys.size, 0);
		} finally {
			fx.dispose();
		}
	});

	it("still names a project path that is a directory", () => {
		const fx = withDirs({});
		try {
			mkdirSync(join(fx.cwd, ".omp", "dashboard.json"), { recursive: true });
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { project: join(fx.cwd, ".omp", "dashboard.json") });
			assert.ok(loaded.warnings.some(w => w.includes("invalid JSON")));
		} finally {
			fx.dispose();
		}
	});

	it("names an existing-but-empty project file", () => {
		const fx = withDirs({ project: {} });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.files, { project: join(fx.cwd, ".omp", "dashboard.json") });
			assert.equal(loaded.explicitKeys.size, 0);
		} finally {
			fx.dispose();
		}
	});
});
