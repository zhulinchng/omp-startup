/**
 * Tests for src/config.ts — layered loading, inert rule, coercion,
 * per-key provenance warnings, and token expansion.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, expandTokens, loadConfig } from "../src/config.ts";
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
		assert.equal(DEFAULT_CONFIG.replaceHeader, false);
		assert.equal(DEFAULT_CONFIG.hideNativeWelcome, false);
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

	it("filters unknown block names and falls back when nothing valid remains", () => {
		const partial = withDirs({ project: { left: ["greeting", "nope"] as never } });
		try {
			const loaded = loadConfig(partial.cwd, partial.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, ["greeting"]);
		} finally {
			partial.dispose();
		}
		const garbage = withDirs({ project: { left: ["zzz"] as never } });
		try {
			const loaded = loadConfig(garbage.cwd, garbage.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.left, DEFAULT_CONFIG.left);
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

	it("falls back to default shortcuts when none survive", () => {
		const fx = withDirs({ project: { shortcuts: [42] as never } });
		try {
			const loaded = loadConfig(fx.cwd, fx.home);
			assert.ok(loaded);
			assert.deepEqual(loaded.cfg.shortcuts, DEFAULT_CONFIG.shortcuts);
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

	it("parses hideNativeWelcome and rejects non-boolean values", () => {
		const on = withDirs({ project: { hideNativeWelcome: true } });
		try {
			const loaded = loadConfig(on.cwd, on.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.hideNativeWelcome, true);
			assert.ok(loaded.explicitKeys.has("hideNativeWelcome"));
		} finally {
			on.dispose();
		}
		const bad = withDirs({ project: { hideNativeWelcome: "yes" } });
		try {
			const loaded = loadConfig(bad.cwd, bad.home);
			assert.ok(loaded);
			assert.equal(loaded.cfg.hideNativeWelcome, false);
			assert.ok(loaded.warnings.some(w => w.includes('"hideNativeWelcome"')));
		} finally {
			bad.dispose();
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
});
