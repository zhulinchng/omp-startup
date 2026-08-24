/**
 * Tests for scripts/uninstall-reset.js — the npm postuninstall hook that
 * restores an owned `startup.quiet`. Drives `resetOwnedQuiet()` against
 * scratch homes; every path must be non-throwing and leave no owned marker.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resetOwnedQuiet } from "../scripts/uninstall-reset.js";

describe("uninstall reset hook", () => {
	const homes: string[] = [];
	after(() => {
		for (const home of homes) rmSync(home, { recursive: true, force: true });
	});

	function scratch(): string {
		const home = mkdtempSync(join(tmpdir(), "omp-startup-uninstall-"));
		homes.push(home);
		return home;
	}
	const markerOf = (home: string) => join(home, ".config", "dashboard", ".ownership.json");
	const configOf = (home: string) => join(home, ".omp", "agent", "config.yml");
	const seed = (home: string, marker: object | undefined, config: string | undefined): void => {
		if (marker !== undefined) {
			mkdirSync(join(home, ".config", "dashboard"), { recursive: true });
			writeFileSync(markerOf(home), JSON.stringify(marker));
		}
		if (config !== undefined) {
			mkdirSync(join(home, ".omp", "agent"), { recursive: true });
			writeFileSync(configOf(home), config);
		}
	};

	it("reports no-marker when nothing was recorded", () => {
		const home = scratch();
		seed(home, undefined, "startup:\n  quiet: true\n");
		assert.equal(resetOwnedQuiet(home), "no-marker");
		// The user's own quiet:true is never touched.
		assert.match(readFileSync(configOf(home), "utf8"), /quiet: true/);
	});

	it("restores only the startup block's quiet and clears the marker", () => {
		const home = scratch();
		seed(
			home,
			{ previous: false, state: "owned" },
			"providers:\n  a: 1\nother:\n  quiet: true\nstartup:\n  quiet: true\n",
		);
		assert.equal(resetOwnedQuiet(home), "restored");
		const text = readFileSync(configOf(home), "utf8");
		assert.match(text, /other:\n  quiet: true/); // unrelated key untouched
		assert.match(text, /startup:\n  quiet: false/); // ours flipped back
		assert.equal(existsSync(markerOf(home)), false);
	});

	it("preserves a previous value of true without writing the config", () => {
		const home = scratch();
		seed(home, { previous: true, state: "owned" }, "startup:\n  quiet: true\n");
		const before = readFileSync(configOf(home), "utf8");
		assert.equal(resetOwnedQuiet(home), "preserved-true");
		assert.equal(readFileSync(configOf(home), "utf8"), before);
		assert.equal(existsSync(markerOf(home)), false);
	});

	it("reports already-default when no quiet:true exists under startup", () => {
		const home = scratch();
		seed(home, { previous: false, state: "owned" }, "startup:\n  quiet: false\ntheme: x\n");
		assert.equal(resetOwnedQuiet(home), "already-default");
		assert.equal(existsSync(markerOf(home)), false);
	});

	it("clears yielded markers without touching the config", () => {
		const home = scratch();
		seed(home, { previous: false, state: "yielded" }, "startup:\n  quiet: false\n");
		const before = readFileSync(configOf(home), "utf8");
		assert.equal(resetOwnedQuiet(home), "not-owned");
		assert.equal(readFileSync(configOf(home), "utf8"), before);
		assert.equal(existsSync(markerOf(home)), false);
	});

	it("treats a malformed marker as absent and clears it", () => {
		const home = scratch();
		mkdirSync(join(home, ".config", "dashboard"), { recursive: true });
		writeFileSync(markerOf(home), "{bogus");
		seed(home, undefined, "startup:\n  quiet: true\n");
		writeFileSync(markerOf(home), "{bogus"); // re-assert after seed()
		assert.equal(resetOwnedQuiet(home), "no-marker"); // unreadable = treated as absent
		assert.equal(existsSync(markerOf(home)), false);
	});

	it("handles a missing agent config by clearing the marker", () => {
		const home = scratch();
		seed(home, { previous: false, state: "owned" }, undefined);
		assert.equal(resetOwnedQuiet(home), "config-missing");
		assert.equal(existsSync(markerOf(home)), false);
	});

	it("keeps the marker when writing the config fails (retryable)", () => {
		if (process.getuid?.() === 0) return; // root ignores permission bits
		const home = scratch();
		seed(home, { previous: false, state: "owned" }, "startup:\n  quiet: true\n");
		chmodSync(configOf(home), 0o444); // read-only file → in-place write fails
		try {
			assert.equal(resetOwnedQuiet(home), "write-failed");
			assert.match(readFileSync(configOf(home), "utf8"), /quiet: true/); // untouched
			assert.equal(existsSync(markerOf(home)), true, "marker kept for a later rerun");
			const marker = JSON.parse(readFileSync(markerOf(home), "utf8")) as { state: string };
			assert.equal(marker.state, "owned");
		} finally {
			chmodSync(configOf(home), 0o644);
		}
	});
});
