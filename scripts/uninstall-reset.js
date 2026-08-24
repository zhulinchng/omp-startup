#!/usr/bin/env node
/**
 * npm postuninstall hook: return `startup.quiet` to its pre-takeover value
 * when omp-startup owned it. Best-effort, zero dependencies.
 *
 * Only acts when the ownership marker (~/.config/dashboard/.ownership.json)
 * records `state: "owned"` — a `quiet: true` the user set themselves is never
 * touched. Caveat: omp's own `plugin uninstall` shells out to bun, which may
 * skip npm lifecycle scripts; the manual one-liner in docs/USAGE.md covers
 * that path.
 *
 * The meat lives in `resetOwnedQuiet(home)` so tests can drive it against a
 * scratch home; the CLI tail only translates the outcome into output and
 * guarantees exit 0 — a reset hook must never break uninstallation.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @param {string} home sandbox/real home root
 * @returns {"no-marker" | "not-owned" | "config-missing" | "write-failed" |
 *   "restored" | "preserved-true" | "already-default"} what happened
 */
export function resetOwnedQuiet(home) {
	const markerPath = join(home, ".config", "dashboard", ".ownership.json");
	const configPath = join(home, ".omp", "agent", "config.yml");

	let marker;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		try {
			rmSync(markerPath, { force: true }); // corrupt record — tidy up
		} catch {
			// best effort only
		}
		return "no-marker"; // quiet was never ours (or the record is unreadable)
	}

	const clearMarker = () => {
		try {
			rmSync(markerPath, { force: true });
		} catch {
			// best effort only
		}
	};

	if (marker?.state !== "owned") {
		clearMarker(); // yielded — nothing left to restore
		return "not-owned";
	}

	let content;
	try {
		content = readFileSync(configPath, "utf8");
	} catch {
		clearMarker(); // plugin is going away regardless
		return "config-missing";
	}

	// Flip `quiet: true` back only inside the top-level `startup:` block so an
	// unrelated `quiet` key elsewhere in the YAML is untouched.
	const wantTrue = marker.previous === true;
	const lines = content.split("\n");
	let inStartup = false;
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\S/.test(line)) inStartup = line.startsWith("startup:");
		if (!inStartup) continue;
		if (!wantTrue) {
			const match = line.match(/^(\s+quiet:\s*)true\s*$/);
			if (match) {
				lines[i] = `${match[1]}false`;
				changed = true;
				break; // single scalar setting; first hit under startup: wins
			}
		}
	}

	if (changed) {
		try {
			writeFileSync(configPath, lines.join("\n"));
		} catch {
			// Keep trying nowhere — uninstall proceeds; docs cover manual reset.
			clearMarker();
			return "write-failed";
		}
		clearMarker();
		return "restored";
	}
	clearMarker();
	return wantTrue ? "preserved-true" : "already-default";
}

const OUTCOME_NOTES = {
	"no-marker": undefined,
	"not-owned": "ownership marker was not ours; nothing to reset",
	"config-missing": "no agent config found; nothing to reset",
	"write-failed": "could not write agent config; reset startup.quiet manually",
	restored: "restored startup.quiet to its previous value",
	"preserved-true": "previous value was quiet:true; left as-is",
	"already-default": "no startup.quiet=true found (already default)",
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const outcome = resetOwnedQuiet(homedir());
	const note = OUTCOME_NOTES[outcome];
	if (note) console.log(`omp-startup postuninstall: ${note}`);
	process.exit(0);
}
