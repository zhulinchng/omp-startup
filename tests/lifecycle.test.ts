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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	shutdown(): Promise<void>;
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
		async shutdown() {
			await mockApi.handlerFor("session_shutdown")({}, ctxWithCwd);
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
		for (const event of ["session_start", "before_agent_start", "session_shutdown"]) {
			assert.ok(mock.handlers.has(event), `missing ${event}`);
		}
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
			await drain();
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
});

describe("lifecycle: session hygiene", () => {
	it("resets visibility on session_shutdown", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await h.shutdown();
			await h.beforeAgentStart(); // must not unmount anything post-shutdown
			const undefinedCalls = h.calls.setWidget.filter(c => c.content === undefined).length;
			assert.equal(undefinedCalls, 0);
		} finally {
			project.dispose();
		}
	});

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

describe("lifecycle: replaceNativeWelcome welcome takeover", () => {
	it("engages startup.quiet once on mount and suppresses the advisory hint (omp family)", async () => {
		const project = scratchProject({ greeting: "Solo" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain(); // second tick: engageQuiet resolves after refreshAsync chain
			const sets = settings.calls.filter(c => c.op === "set");
			assert.equal(sets.length, 1);
			assert.equal(sets[0]?.path, "startup.quiet");
			assert.equal(sets[0]?.value, true);

			const latest = h.calls.setWidget.at(-1)?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			assert.ok(latest);
			const lines = latest({ requestRender() {} }, INLINE_THEME).render(100).join("\n");
			assert.ok(!lines.includes("set startup.quiet=true"), "advisory must be suppressed");
		} finally {
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("restores the previous value on session_shutdown", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(false);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			await h.shutdown();
			await drain();
			const sets = settings.calls.filter(c => c.op === "set");
			assert.deepEqual(
				sets.map(s => s.value),
				[true, false],
			);
			assert.equal(settings.flushed(), 1, "restore must flush the debounced save");
		} finally {
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("never writes when the user already had quiet enabled", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(true);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain();
			assert.equal(settings.calls.filter(c => c.op === "set").length, 0);
			await h.shutdown();
			await drain();
			assert.equal(settings.calls.filter(c => c.op === "set").length, 0);
		} finally {
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("leaves settings untouched when takeover is disabled or the header route wins", async () => {
		const optedOut = scratchProject({ greeting: "Plain", replaceNativeWelcome: false });
		const optedOutSettings = makeFakeSettings();
		setHostSettingsForTest(optedOutSettings.fake);
		try {
			const h1 = boot({ headerMode: "noop", version: "18.0.1", cwd: optedOut.cwd });
			await h1.sessionStart();
			await drain();
			assert.equal(h1.calls.setWidget.length, 0); // nothing mounted at startup…
			assert.equal(optedOutSettings.calls.length, 0); // …and no settings traffic
		} finally {
			optedOut.dispose();
		}

		const headerRoute = scratchProject({ greeting: "Ahoy!" });
		const headerSettings = makeFakeSettings();
		setHostSettingsForTest(headerSettings.fake);
		try {
			const h2 = boot({ headerMode: "sync", version: "18.0.1", cwd: headerRoute.cwd });
			await h2.sessionStart();
			await drain();
			assert.ok(h2.calls.setHeader.length > 0); // header route taken
			assert.equal(headerSettings.calls.length, 0); // Pi owns its own header
		} finally {
			headerRoute.dispose();
			setHostSettingsForTest(null);
		}
	});

	it("restores on dismissal and re-engages with a fresh capture on re-show", async () => {
		const project = scratchProject({ greeting: "Ahoy!" });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			await drain(); // engage #1: set(true)
			await h.beforeAgentStart(); // dismiss (unmount) → restore(false) mid-session
			await drain();
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[true, false],
				"dismissal must restore while the session is still alive",
			);

			const toggle = h.api.commandHandlerNamed("dashboard");
			await toggle("", h.ctx); // remount → fresh capture (now false) → engage again
			await drain();
			await drain();
			await h.shutdown(); // dashboard still visible → shutdown releases again
			await drain();
			assert.equal(settings.flushed(), 2, "each restore flushes");
			assert.deepEqual(
				settings.calls.filter(c => c.op === "set").map(s => s.value),
				[true, false, true, false],
			);
		} finally {
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("does not automount when takeover is disabled; manual /dashboard stacks with advisory", async () => {
		const project = scratchProject({ greeting: "Manual", replaceNativeWelcome: false });
		const settings = makeFakeSettings(undefined);
		setHostSettingsForTest(settings.fake);
		try {
			const h = boot({ headerMode: "noop", version: "18.0.1", cwd: project.cwd });
			await h.sessionStart();
			await drain();
			assert.equal(h.calls.setWidget.length, 0); // native welcome owns startup
			assert.equal(settings.calls.length, 0);

			const toggle = h.api.commandHandlerNamed("dashboard");
			await toggle("", h.ctx); // manual show
			await drain();
			assert.equal(h.calls.setWidget.length, 1);
			const widgetContent = h.calls.setWidget[0]?.content as
				| ((t: unknown, th: unknown) => { render(w: number): string[] })
				| undefined;
			const lines = widgetContent?.({ requestRender() {} }, INLINE_THEME).render(100).join("\n") ?? "";
			assert.ok(lines.includes("Manual"));
			assert.ok(lines.includes("replaceNativeWelcome"), "stacked show carries the advisory");
			assert.equal(settings.calls.length, 0); // still fully read-only

			await toggle("", h.ctx); // second invocation hides again
			assert.ok(h.calls.setWidget.some(c => c.content === undefined));
		} finally {
			setHostSettingsForTest(null);
			project.dispose();
		}
	});

	it("loadHostSettings degrades to undefined in a host-free environment", async () => {
		setHostSettingsForTest(null); // clear override → real probing path
		assert.equal(await loadHostSettings(), undefined);
	});
});
