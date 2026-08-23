/**
 * Tests for src/dashboard.ts — block rendering, box/plain layouts,
 * native-parity defaults, delta behavior, width fitting, component handle.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { makeDashboardComponent, renderDashboard } from "../src/dashboard.ts";
import type { DashboardState } from "../src/host.ts";
import { makeState, PLAIN_THEME, render, stripAll, stripAnsi } from "./helpers.ts";

const STATE = makeState();

describe("dashboard: box layout native parity", () => {
	const lines = render(undefined, STATE);

	it("renders rounded corners and column tee", () => {
		assert.ok(lines.some(l => l.includes("╭")));
		assert.ok(lines.some(l => l.includes("╯")));
		assert.ok(lines.some(l => l.includes("┬")));
	});

	it("centers the greeting", () => {
		assert.ok(stripAll(lines).some(l => l.includes("Welcome back!")));
	});

	it("renders the π logo glyphs", () => {
		assert.ok(stripAll(lines).some(l => l.includes("▀██████████▀")));
	});

	it("renders model/provider info rows", () => {
		const flat = stripAll(lines).join("\n");
		assert.ok(flat.includes("claude-opus-4-6"));
		assert.ok(flat.includes("anthropic"));
	});

	it("embeds the expanded title in the top border", () => {
		assert.ok(stripAll(lines).some(l => l.includes(" omp v1.2.3 ")));
	});

	it("renders Tips shortcuts and Recent sessions with slot padding", () => {
		const flat = stripAll(lines).join("\n");
		assert.ok(flat.includes("Tips"));
		assert.ok(flat.includes("# for prompt actions"));
		assert.ok(flat.includes("$ to run python"));
		assert.ok(flat.includes("Recent sessions"));
		assert.ok(flat.includes("(5m ago)"));
	});

	it("keeps every box row at the full box width", () => {
		const widths = new Set(stripAll(lines).map(l => [...l].length));
		assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(",")}`);
		const top = stripAll(lines)[0] ?? "";
		assert.equal([...top].length, [...(stripAll(lines)[1] ?? "")].length);
	});
});

describe("dashboard: partial-config delta behavior", () => {
	it("changing only the greeting changes exactly one line", () => {
		const base = render(undefined, STATE);
		const changed = render({ greeting: "Ahoy!" }, STATE);
		assert.equal(base.length, changed.length);
		const diffs: Array<{ index: number; after: string }> = [];
		base.forEach((line, i) => {
			const after = changed[i];
			if (after !== undefined && line !== after) diffs.push({ index: i, after });
		});
		assert.equal(diffs.length, 1);
		assert.ok(diffs[0]?.after.includes("Ahoy!"));
	});
});

describe("dashboard: element customization", () => {
	it("logo none removes art while keeping the greeting", () => {
		const lines = render({ logo: "none" }, STATE);
		const flat = stripAnsi(lines.join("\n"));
		assert.ok(!flat.includes("█"));
		assert.ok(flat.includes("Welcome back!"));
	});

	it("custom logo arrays render verbatim (no gradient)", () => {
		const lines = render({ logo: ["hello-art"], gradient: false }, STATE);
		assert.ok(stripAll(lines).some(l => l.includes("hello-art")));
	});

	it("gradient paints per-character truecolor SGR runs", () => {
		const grad = render({ gradient: true }, STATE);
		const plain = render({ gradient: false }, STATE);
		const sgrRuns = (arr: string[]) => arr.join("").match(/\x1b\[38;2;\d+;\d+;\d+m/g)?.length ?? 0;
		assert.ok(sgrRuns(grad) > 20);
		assert.ok(sgrRuns(plain) === 0);
	});

	it("sessions: 0 removes the sessions block entirely", () => {
		const lines = render({ sessions: 0 }, STATE);
		assert.ok(!stripAll(lines).some(l => l.includes("Recent sessions")));
	});

	it("empty recent sessions renders the placeholder row", () => {
		const lines = render({}, makeState({ sessions: [] }));
		assert.ok(stripAll(lines).some(l => l.includes("No recent sessions")));
	});

	it("a single-entry quote renders deterministically below the box", () => {
		const base = render(undefined, STATE);
		const quoted = render({ quote: ["stay curious"] }, STATE);
		assert.equal(quoted.length, base.length + 1);
		assert.ok(quoted[quoted.length - 1]?.includes("stay curious"));
	});

	it("long quotes truncate instead of overflowing", () => {
		const quoted = render({ quote: ["x".repeat(500)] }, STATE);
		const last = quoted[quoted.length - 1] ?? "";
		assert.ok([...stripAnsi(last)].length <= 100);
	});

	it("state hint renders as a dim italic advisory", () => {
		const hinted = render({}, makeState({ hint: "set startup.quiet=true" }));
		assert.ok(stripAll(hinted).some(l => l.includes("set startup.quiet=true")));
		assert.ok(!render(undefined, STATE).some(l => l.includes("startup.quiet")));
	});
});

describe("dashboard: title handling", () => {
	it("empty title removes the embedded label", () => {
		const lines = render({ title: "" }, STATE);
		const top = stripAll(lines)[0] ?? "";
		assert.match(top, /^╭─+╮$/);
	});

	it("degenerate expansion ({app}/{version} empty) skips the lone-v title", () => {
		const lines = render({}, makeState({ version: "", app: "" }));
		assert.match(stripAll(lines)[0] ?? "", /^╭─+╮$/);
	});

	it("custom titles expand tokens", () => {
		const lines = render({ title: "{dir} // {branch}" }, makeState({ branch: "main" }));
		assert.ok(stripAll(lines).some(l => l.includes("demo // main")));
	});
});

describe("dashboard: plain layout", () => {
	const plain = render({ layout: "plain", logo: "none", title: "" }, STATE);

	it("drops borders entirely", () => {
		const flat = plain.join("\n");
		assert.ok(!flat.includes("╭") && !flat.includes("╯") && !flat.includes("│"));
	});

	it("stacks left-column blocks centered", () => {
		const flat = plain.join("\n");
		assert.ok(flat.includes("Welcome back!"));
		assert.ok(flat.includes("claude-opus-4-6"));
	});

	it("still includes right-column blocks with headers", () => {
		const flat = plain.join("\n");
		assert.ok(flat.includes("Tips") && flat.includes("for prompt actions"));
		assert.ok(flat.includes("Recent sessions") && flat.includes("(5m ago)"));
	});
});

describe("dashboard: responsive geometry", () => {
	it("falls back to a single column below the breakpoint", () => {
		const narrow = renderDashboard(DEFAULT_CONFIG, makeState({ sessions: [] }), PLAIN_THEME, 30);
		const flat = stripAll(narrow).join("\n");
		assert.ok(flat.includes("Welcome back!"));
		assert.ok(!flat.includes("Tips")); // right column dropped, not wrapped
		assert.ok(flat.includes("╭")); // borders still present in box layout
	});

	it("respects the configured max width", () => {
		const lines = render({ width: 40 }, STATE);
		for (const line of lines) {
			assert.ok([...stripAnsi(line)].length <= 40, `line exceeds 40: ${stripAnsi(line)}`);
		}
	});

	it("width invariants hold across a sweep of term widths", () => {
		for (let w = 30; w <= 140; w += 10) {
			for (const line of renderDashboard(DEFAULT_CONFIG, STATE, PLAIN_THEME, w)) {
				assert.ok([...stripAnsi(line)].length <= Math.max(w, 2), `overflow at ${w}`);
			}
		}
	});
});

describe("dashboard: duplicate block names across columns", () => {
	it("right column drops blocks already present in left", () => {
		const lines = render(
			{ left: ["greeting", "info"], right: ["shortcuts", "sessions"] },
			makeState(),
		);
		const count = stripAll(lines).filter(l => l.includes("Recent sessions")).length;
		assert.equal(count, 1);

		const dup = render(
			{ left: ["greeting", "shortcuts"], right: ["shortcuts", "sessions"] },
			makeState(),
		);
		const flat = stripAll(dup).join("\n");
		assert.equal(flat.split("for prompt actions").length - 1, 1); // exactly one copy
	});
});

describe("makeDashboardComponent", () => {
	it("exposes a factory producing a working component", () => {
		const stateRef = { current: makeState() };
		const cfgRef = { current: DEFAULT_CONFIG };
		const handle = makeDashboardComponent(stateRef, cfgRef);
		let renders = 0;
		const component = handle.factory({ requestRender: () => renders++ }, PLAIN_THEME);
		const out = component.render(100);
		assert.ok(out.length > 0);
		assert.ok(stripAll(out).some(l => l.includes("Welcome back!")));
		assert.equal(renders, 0); // render() registers the TUI but does not self-request
		handle.refresh();
		assert.ok(renders >= 1);
	});

	it("re-renders from live refs without re-mounting", () => {
		const stateRef = { current: makeState() };
		const cfgRef = { current: DEFAULT_CONFIG };
		const handle = makeDashboardComponent(stateRef, cfgRef);
		const component = handle.factory({ requestRender() {} }, PLAIN_THEME);
		assert.ok(!stripAll(component.render(100)).join("\n").includes("Ahoy!"));
		cfgRef.current = { ...DEFAULT_CONFIG, greeting: "Ahoy!" };
		assert.ok(stripAll(component.render(100)).join("\n").includes("Ahoy!"));
	});
});

