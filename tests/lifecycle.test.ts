/**
 * Lifecycle + cross-host compatibility tests for src/index.ts.
 *
 * Drives the real default-export factory against mock ExtensionAPI objects
 * replicating each host's verified contract (see helpers.ts):
 *   - omp: no-op setHeader, working setWidget, transient notify
 *   - pi:  synchronous setHeader factory invocation, session_start fired
 *          before the built-in header exists on installed 0.84.x
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import ompStartup from "../src/index.ts";
import { WIDGET_KEY, loadHostSettings, setHostSettingsForTest } from "../src/host.ts";
import { INLINE_THEME, makeMockApi, makeMockCtx, type RecordedUiCalls } from "./helpers.ts";

// Hermeticity: index.ts resolves the user config layer via os.homedir().
// Redirect $HOME for the whole file (each test file runs in its own process)
// so a real ~/.config/dashboard/config.json on the dev machine can't leak in.
const realHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), "omp-startup-home-"));
before(() => {
	process.env.HOME = fakeHome;
});
after(() => {
	process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

function scratchProject(config: Record<string, unknown> | undefined): { cwd: string; dispose(): void } {
	const dir = join(tmpdir(), `omp-startup-life-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	if (config !== undefined) {
		mkdirSync(join(dir, ".omp"), { recursive: true });
		writeFileSync(join(dir, ".omp", "dashboard.json"), JSON.stringify(config));
	}
	return { cwd: dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- quiet-ownership marker helpers (state lives in the redirected $HOME) ---

const ownershipDir = () => join(fakeHome, ".config", "dashboard");
const ownershipFile = () => join(ownershipDir(), ".ownership.json");

function seedOwnership(previous: boolean, state: "owned" | "yielded"): void {
	mkdirSync(ownershipDir(), { recursive: true });
	writeFileSync(ownershipFile(), JSON.stringify({ previous, state }));
}

function readOwnership(): { previous: boolean; state: string } | undefined {
	try {
		return JSON.parse(readFileSync(ownershipFile(), "utf8"));
	} catch {
		return undefined;
	}
}

function dropOwnership(): void {
	rmSync(ownershipDir(), { recursive: true, force: true });
}
function makeFakeSettings(initialQuiet?: unknown) {
	const calls: Array<{ op: "get" | "set"; path: string; value?: unknown }> = [];
	let quiet = initialQuiet;
	let flushes = 0;
	const fake = {
		get(path: string) {
			calls.push({ op: "get", path });
			return path === "startup.quiet" ? quiet : undefined;
		},
		set(path: string, value: unknown) {
			calls.push({ op: "set", path, value });
			if (path === "startup.quiet") quiet = value;
		},
		async flush() {
			flushes++;
		},
	};
	return { fake, calls, flushed: () => flushes };
}

async function drain(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

interface Harness {
	api: ReturnType<typeof makeMockApi>;
	calls: RecordedUiCalls;
	ctx: ExtensionContextSubset;
	sessionStart(reason?: string): Promise<void>;
	beforeAgentStart(): Promise<void>;
}

function boot(options: { headerMode: "noop" | "sync" | "throw"; version?: string; cwd: string }): Harness {
	const mockApi = makeMockApi(options.version);
	const { ctx, calls } = makeMockCtx({ headerMode: options.headerMode, version: options.version });
	const ctxWithCwd = { ...ctx, cwd: options.cwd };
	ompStartup(mockApi.api);
	const sessionStart = async (reason = "startup") => {
		await mockApi.handlerFor("session_start")({ reason }, ctxWithCwd);
	};
	return {
		api: mockApi,
		calls,
		ctx: ctxWithCwd,
		sessionStart,
		async beforeAgentStart() {
			await mockApi.handlerFor("before_agent_start")({ prompt: "x" }, ctxWithCwd);
		},
	};
}

describe("lifecycle: registration contract (both hosts)", () => {
	it("registers the dashboard command at load time", () => {
		const mock = makeMockApi();
		ompStartup(mock.api);
		assert.equal(mock.commands.length, 1);
		assert.equal(mock.commands[0]?.name, "dashboard");
		assert.equal(mock.commands[0]?.description, "Toggle the startup dashboard");
	});

	it("subscribes to the shared event surface", () => {
		const mock = makeMockApi();
		ompStartup(mock.api);
		for (const event of ["session_start", "session_switch", "session_branch", "session_tree", "before_agent_start"]) {
			assert.ok(mock.handlers.has(event), `missing ${event}`);
		}
		// Exit-time restores moved to session-start give-up paths: shutdown
		// writes race host teardown and get lost (verified live on omp).
		assert.ok(!mock.handlers.has("session_shutdown"), "session_shutdown must stay unsubscribed");
	});
});

describe("lifecycle: inert rule", () => {
	it("touches no UI when no config exists anywhere", async () => {
		const project = scratchProject(undefined);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			assert.equal(h.calls.setWidget.length, 0);
			assert.equal(h.calls.setHeader.length, 0);
			assert.equal(h.calls.notify.length, 0);
		} finally {
			project.dispose();
		}
	});

	it("warns about unknown keys but still mounts nothing", async () => {
		const project = scratchProject({ whatever: 1 });
		try {
			const h = boot({ headerMode: "noop", cwd: project.cwd });
			await h.sessionStart();
			assert.equal(h.calls.setWidget.length, 0);
			assert.equal(h.calls.notify.length, 1);
			assert.ok(h.calls.notify[0]?.message.includes('unknown key "whatever"'));
			assert.equal(h.calls.notify[0]?.type, "warning");
		} finally {
			project.dispose();
		}
	});

	it("leaves the native header restored on a header-capable host when inert", async () => {
		const project = scratchProject(undefined);
		try {
			const h = boot({ headerMode: "sync", cwd: project.cwd });
			await h.sessionStart();
			assert.equal(h.calls.setWidget.length, 0);
			assert.ok(h.calls.setHeader.length >= 2); // probe sentinel + restore
			assert.equal(h.calls.setHeader.at(-1)?.factory, undefined); // native back
			assert.equal(h.calls.notify.length, 0); // nothing to warn about
		} finally {
			project.dispose();
		}
	});

	it("takes the header route by default on a header-capable host (Pi)", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "sync", cwd: project.cwd });
			await h.sessionStart();
			assert.ok(h.calls.setHeader.some(c => c.factory !== undefined && c.factory !== null));
			assert.ok(!h.calls.setWidget.some(c => c.content !== undefined)); // no additive widget
		} finally {
			project.dispose();
		}
	});
});

describe("lifecycle: omp host routing (no-op setHeader)", () => {
	it("mounts the widget and engages startup.quiet on launch (omp family)", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain(); // second tick: claim resolves after refreshAsync chain
			const sets = settings.calls.filter(c => c.op === "set");
			assert.equal(sets.length, 1);
			assert.equal(sets[0]?.path, "startup.quiet");
			assert.equal(sets[0]?.value, true);
			assert.equal(h.calls.setWidget.length, 1);
			assert.equal(h.calls.setWidget[0]?.key, WIDGET_KEY);
			const widgetContent = h.calls.setWidget[0]?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = widgetContent?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("Ahoy!"));
			assert.ok(!lines.includes("startup.quiet=true"), "advisory suppressed once takeover engages");
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("leaves the native welcome alone at startup when takeover is disabled", async () => {
		const project = scratchProject({ greeting: "Ahoy!", replaceNativeWelcome: false });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			assert.equal(h.calls.setWidget.length, 0); // nothing automounts
			assert.equal(settings.calls.length, 0); // and the plugin stays read-only
		} finally {
			dropOwnership(); // a stale owned marker would make give-up write here
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("dismisses on the first prompt and only the first", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await h.beforeAgentStart();
			const last = h.calls.setWidget[h.calls.setWidget.length - 1];
			assert.equal(last?.key, WIDGET_KEY);
			assert.equal(last?.content, undefined);
			const countAfterDismiss = h.calls.setWidget.length;
			await h.beforeAgentStart(); // already hidden — no further calls
			assert.equal(h.calls.setWidget.length, countAfterDismiss);
		} finally {
			project.dispose();
		}
	});

	it("keeps the dashboard when dismiss is disabled", async () => {
		const project = scratchProject({ greeting: "Ahoy!", dismiss: false });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await h.beforeAgentStart();
			assert.ok(!h.calls.setWidget.some(c => c.content === undefined));
		} finally {
			project.dispose();
		}
	});
});

describe("lifecycle: pi host routing", () => {
	it("early runner-era session_start followed by the real TUI ends in header mode", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			// Event 1: runner-era context (omp-style no-op setHeader, no VERSION).
			const early = boot({ headerMode: "noop", version: undefined, cwd: project.cwd });
			await early.sessionStart("startup");
			// Event 2: interactive-mode context on the same extension instance;
			// its setHeader actually works (builds where the header exists first).
			const lateCtx = makeMockCtx({ headerMode: "sync", version: undefined });
			await early.api.handlerFor("session_start")({ reason: "startup" }, { ...lateCtx.ctx, cwd: project.cwd });
			const lastHeader = lateCtx.calls.setHeader.at(-1);
			const widgetFactory = lastHeader?.factory as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(widgetFactory, "the real context receives the dashboard via setHeader");
			const rendered = widgetFactory({ requestRender() {} }, INLINE_THEME).render(100).join("\n");
			assert.ok(rendered.includes("Ahoy!"));
			assert.ok(!rendered.includes("startup.quiet")); // no VERSION on Pi → no omp hint
		} finally {
			project.dispose();
		}
	});

	it("dismiss restores the native header (setHeader undefined) in header mode", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "sync", cwd: project.cwd });
			await h.sessionStart();
			await h.beforeAgentStart();
			assert.ok(h.calls.setHeader.some(c => c.factory === undefined));
		} finally {
			project.dispose();
		}
	});
});

describe("lifecycle: non-TUI modes stay untouched", () => {
	for (const mode of ["print", "rpc", "json"] as const) {
		it(`does nothing in ${mode} mode`, async () => {
			const project = scratchProject({ greeting: "Ahoy!" });
			try {
				const mockApi = makeMockApi("18.0.1");
				const { ctx, calls } = makeMockCtx({ mode, hasUI: mode !== "print" });
				const ctxWithCwd = { ...ctx, cwd: project.cwd };
				ompStartup(mockApi.api);
				await mockApi.handlerFor("session_start")({ reason: "startup" }, ctxWithCwd);
				assert.equal(calls.setWidget.length, 0);
				assert.equal(calls.setHeader.length, 0);
			} finally {
				project.dispose();
			}
		});
	}
});

describe("lifecycle: /dashboard toggle", () => {
	it("shows when hidden, hides when shown, reloads config each time", async () => {
		const project = scratchProject({ greeting: "First!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart(); // mounted with First!
			const toggle = h.api.commandHandlerNamed("dashboard");

			await toggle("", h.ctx); // hide
			assert.ok(h.calls.setWidget.some(c => c.content === undefined));

			// user edits config while hidden
			writeFileSync(join(project.cwd, ".omp", "dashboard.json"), JSON.stringify({ greeting: "Second!" }));

			await toggle("", h.ctx); // show again, picks up the edit
			const latest = h.calls.setWidget.at(-1)?.content as (t: unknown, th: unknown) => { render(w: number): string[] };
			const lines = latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n");
			assert.ok(lines.includes("Second!"));
		} finally {
			project.dispose();
		}
	});

	it("works with no config at all (native-equivalent defaults)", async () => {
		const project = scratchProject(undefined);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart(); // inert
			assert.equal(h.calls.setWidget.length, 0);
			await h.api.commandHandlerNamed("dashboard")("", h.ctx); // explicit opt-in
			assert.equal(h.calls.setWidget.length, 1);
			const widget = h.calls.setWidget[0]?.content as (t: unknown, th: unknown) => { render(w: number): string[] };
			const lines = widget({ requestRender() {} }, INLINE_THEME).render(100).join("\n");
			assert.ok(lines.includes("Welcome back!")); // native-equivalent default
		} finally {
			project.dispose();
		}
	});

	it("registers an alias when the config renames the command", async () => {
		const project = scratchProject({ command: "dash" });
		try {
			const h = boot({ headerMode: "noop", cwd: project.cwd });
			await h.sessionStart();
			assert.ok(h.api.commands.some(c => c.name === "dash"));
		} finally {
			project.dispose();
		}
	});

	it("ignores invocations outside an interactive TUI context", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			const toggle = h.api.commandHandlerNamed("dashboard");
			await toggle("", { ...h.ctx, hasUI: false, mode: "json" });
			assert.equal(h.calls.setWidget.length, 0);
			assert.equal(h.calls.setHeader.length, 0);
			await toggle("", h.ctx); // a real TUI invocation still mounts
			assert.equal(h.calls.setWidget.length, 1);
		} finally {
			project.dispose();
		}
	});
});

describe("lifecycle: session hygiene", () => {
	it("surfaces config warnings exactly once per load via notify", async () => {
		const project = scratchProject({ greeting: 42 as unknown as string });
		try {
			const h = boot({ headerMode: "noop", cwd: project.cwd });
			await h.sessionStart();
			assert.equal(h.calls.notify.filter(n => n.message.includes('"greeting"')).length, 1);
			// default greeting used despite the invalid value
		} finally {
			project.dispose();
		}
	});
});

describe("lifecycle: replaceNativeWelcome quiet ownership", () => {
	it("claims quiet on mount: sets true, flushes, records the marker (omp family)", async () => {
		const project = scratchProject({ greeting: "Solo" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain(); // second tick: claim resolves after refreshAsync chain
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[true],
			);
			assert.equal(settings.flushed(), 1, "claim must be durable before any exit can happen");
			assert.deepEqual(readOwnership(), { previous: false, state: "owned" });
			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(latest);
			const lines = latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n");
			assert.ok(!lines.includes('set "replaceNativeWelcome"'), "advisory suppressed once owned");
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("never claims when quiet was already true without a marker", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(true);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			assert.equal(settings.calls.filter(c => c.op === "set").length, 0);
			assert.equal(settings.flushed(), 0);
			assert.equal(readOwnership(), undefined); // user's own preference — never claimed
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("steady state: owned marker plus quiet true writes nothing", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(true);
		seedOwnership(false, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			assert.equal(settings.calls.filter(c => c.op === "set").length, 0);
			assert.deepEqual(readOwnership(), { previous: false, state: "owned" });
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("dismissal and manual re-show never touch settings while owned", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			await h.beforeAgentStart(); // dismiss
			await drain();
			const toggle = h.api.commandHandlerNamed("dashboard");
			await toggle("", h.ctx); // re-show
			await drain();
			await drain();
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[true],
				"ownership persists across dismissal; no restore churn",
			);
			assert.equal(settings.flushed(), 1);
			assert.deepEqual(readOwnership(), { previous: false, state: "owned" });
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("escape hatch: quiet reset to false underneath us yields permanently", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(false);
		seedOwnership(false, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			assert.equal(settings.calls.filter(c => c.op === "set").length, 0, "must not fight the user");
			assert.deepEqual(readOwnership(), { previous: false, state: "yielded" });
			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = latest?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("replaceNativeWelcome"), "yielded stacking carries the advisory");

			const h2 = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h2.sessionStart(); // a later session keeps respecting the yield
			await drain();
			await drain();
			assert.equal(settings.calls.filter(c => c.op === "set").length, 0);
			assert.deepEqual(readOwnership(), { previous: false, state: "yielded" });
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("gives up ownership when takeover is disabled: restores and clears", async () => {
		const project = scratchProject({ greeting: "Plain", replaceNativeWelcome: false });
		const settings = makeFakeSettings(true);
		seedOwnership(false, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			assert.equal(h.calls.setWidget.length, 0); // nothing automounts
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[false],
			);
			assert.equal(settings.flushed(), 1, "restore flushes immediately, not at shutdown");
			assert.equal(readOwnership(), undefined);
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("gives up ownership when config disappears entirely (inert rule)", async () => {
		const project = scratchProject(undefined);
		const settings = makeFakeSettings(true);
		seedOwnership(true, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[true],
				"restores whatever it originally replaced",
			);
			assert.equal(readOwnership(), undefined);
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("gives up ownership on a Pi-style header host", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(true);
		seedOwnership(false, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "sync", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			assert.ok(h.calls.setHeader.some(c => c.factory !== undefined));
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[false],
			);
			assert.equal(readOwnership(), undefined);
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("claims nothing on an unconfigured project, even via /dashboard", async () => {
		const project = scratchProject(undefined);
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart(); // inert
			await drain();
			assert.equal(h.calls.setWidget.length, 0);
			const toggle = h.api.commandHandlerNamed("dashboard");
			await toggle("", h.ctx); // explicit user action mounts the widget…
			await drain();
			await drain();
			assert.equal(h.calls.setWidget.length, 1); // …but stays read-only:
			assert.equal(settings.calls.length, 0, "inert contract forbids settings writes");
			assert.equal(readOwnership(), undefined);
			const content = h.calls.setWidget[0]?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = content?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("replaceNativeWelcome"), "permanent stacking carries the advisory");
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("advises instead of claiming when the host exposes no settings", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart(); // no override → loadHostSettings degrades
			await drain();
			await drain();
			assert.equal(h.calls.setWidget.length, 1); // widget still mounts
			assert.equal(readOwnership(), undefined);
			const content = h.calls.setWidget[0]?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = content?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("replaceNativeWelcome"), "unstoppable stacking says so");
		} finally {
			dropOwnership();
			project.dispose();
		}
	});

	it("keeps honest stacking when set() throws mid-claim", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const calls: Array<{ op: string; value?: unknown }> = [];
		let throwOnSet = true;
		const fake = {
			get(path: string) {
				calls.push({ op: "get" });
				return path === "startup.quiet" ? false : undefined;
			},
			set(path: string, value: unknown) {
				calls.push({ op: "set", value });
				if (throwOnSet) throw new Error("disk full");
			},
			async flush() {},
		};
		setHostSettingsForTest(fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			assert.equal(calls.filter(c => c.op === "set").length, 1);
			assert.equal(readOwnership(), undefined, "failed claims must not record ownership");
			const content = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = content?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("replaceNativeWelcome"), "failed claim admits the stacking");

			throwOnSet = false; // a later session succeeds once the host recovers
			const h2 = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h2.sessionStart();
			await drain();
			await drain();
			assert.deepEqual(readOwnership(), { previous: false, state: "owned" });
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("rolls back the claim when the ownership marker cannot be written", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		mkdirSync(ownershipDir(), { recursive: true });
		mkdirSync(ownershipFile()); // a directory at the marker path → every write fails
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[true, false],
				"claim must be undone when its record is lost",
			);
			assert.equal(readOwnership(), undefined);
			const content = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = content?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("replaceNativeWelcome"), "lost marker admits the stacking");
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("give-up keeps the marker when it cannot restore (no settings)", async () => {
		const project = scratchProject(undefined); // inert → give-up path runs
		seedOwnership(false, "owned");
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart(); // real loadHostSettings → undefined in tests
			await drain();
			assert.deepEqual(readOwnership(), { previous: false, state: "owned" }, "retry later");
		} finally {
			dropOwnership();
			project.dispose();
		}
	});

	it("loadHostSettings degrades to undefined in a host-free environment", async () => {
		setHostSettingsForTest(null); // clear override → real probing path
		assert.equal(await loadHostSettings(), undefined);
	});
});

describe("lifecycle: session routes (switch/branch/tree)", () => {
	it("session_switch re-runs the load path and remounts with fresh config", async () => {
		const project = scratchProject({ greeting: "First!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			writeFileSync(join(project.cwd, ".omp", "dashboard.json"), JSON.stringify({ greeting: "Second!" }));
			await h.api.handlerFor("session_switch")({ reason: "resume" }, h.ctx);
			await drain();
			await drain();
			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(latest);
			assert.ok(latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n").includes("Second!"));
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("session_branch and session_tree remount like session_start", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			const mounted = h.calls.setWidget.length;
			assert.equal(mounted, 1);
			await h.api.handlerFor("session_branch")({ reason: "branch" }, h.ctx);
			await drain();
			await h.api.handlerFor("session_tree")({ reason: "tree" }, h.ctx);
			await drain();
			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(latest);
			assert.ok(latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n").includes("Ahoy!"));
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("a later route clears the previous surface before remounting", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			const late = makeMockCtx({ headerMode: "sync" });
			await h.api.handlerFor("session_start")({ reason: "startup" }, { ...late.ctx, cwd: project.cwd });
			await drain();
			await drain();
			assert.ok(late.calls.setWidget.some(c => c.content === undefined), "stale widget cleared");
			const lastHeader = late.calls.setHeader.at(-1)?.factory as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(lastHeader);
			assert.ok(lastHeader({ requestRender() {} }, INLINE_THEME).render(100).join("\n").includes("Ahoy!"));
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("a dismissal persists across automatic routes until an explicit show", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			const mounted = h.calls.setWidget.length;
			await h.beforeAgentStart();
			assert.equal(h.calls.setWidget.length, mounted + 1); // removal recorded
			await h.sessionStart(); // revive must not pop the dashboard back
			await drain();
			assert.equal(h.calls.setWidget.length, mounted + 1);
			await h.api.handlerFor("session_switch")({ reason: "resume" }, h.ctx);
			await drain();
			assert.equal(h.calls.setWidget.length, mounted + 1);
			await h.api.commandHandlerNamed("dashboard")("", h.ctx); // explicit re-show
			await drain();
			await drain();
			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(latest);
			assert.ok(latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n").includes("Ahoy!"));
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("a throwing settings.get surfaces the advisory without owning anything", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		setHostSettingsForTest({
			get() {
				throw new Error("get boom");
			},
			set() {},
			async flush() {},
		});
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			await drain();
			assert.equal(readOwnership(), undefined);
			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(latest);
			assert.ok(
				latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n").includes("replaceNativeWelcome"),
			);
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("toggle outside TUI gives up ownership without mounting", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(true);
		seedOwnership(false, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.api.commandHandlerNamed("dashboard")("", { ...h.ctx, hasUI: false, mode: "json" });
			await drain();
			assert.equal(h.calls.setWidget.length, 0);
			assert.equal(h.calls.setHeader.length, 0);
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[false],
			);
			assert.equal(readOwnership(), undefined);
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("session_switch without takeover restores and clears like session_start", async () => {
		const project = scratchProject({ greeting: "Plain", replaceNativeWelcome: false });
		const settings = makeFakeSettings(true);
		seedOwnership(false, "owned");
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.api.handlerFor("session_switch")({ reason: "resume" }, h.ctx);
			await drain();
			assert.equal(h.calls.setWidget.length, 0);
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[false],
			);
			assert.equal(readOwnership(), undefined);
		} finally {
			dropOwnership();
			setHostSettingsForTest(null);
			project.dispose();
		}
	});
});
