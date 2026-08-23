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
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const markerPath = join(home, ".config", "dashboard", ".ownership.json");
const configPath = join(home, ".omp", "agent", "config.yml");

function finish(note) {
	if (note) console.log(`omp-startup postuninstall: ${note}`);
	try {
		rmSync(markerPath, { force: true });
	} catch {
		// best effort only
	}
	process.exit(0); // must never break uninstallation
}

let marker;
try {
	marker = JSON.parse(readFileSync(markerPath, "utf8"));
} catch {
	process.exit(0); // no marker — quiet was never ours
}
if (marker?.state !== "owned") process.exit(0);

let content;
try {
	content = readFileSync(configPath, "utf8");
} catch {
	finish(`no agent config at ${configPath}; nothing to reset`);
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
	} catch (error) {
		finish(
			`could not write ${configPath} (${error instanceof Error ? error.message : String(error)}); reset startup.quiet manually`,
		);
	}
	finish(`restored startup.quiet to false in ${configPath}`);
}
finish(wantTrue ? "previous value was quiet:true; left as-is" : "no startup.quiet=true found (already default)");
