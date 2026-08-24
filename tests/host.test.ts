/**
 * Tests for src/host.ts — capability probe, snapshot, branch fetch,
 * session mapping, and failure tolerance.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeMockApi, makeMockCtx } from "./helpers.ts";
import {
	clearQuietOwnership,
	detectAppName,
	fetchBranch,
	fetchRecentSessions,
	loadHostSettings,
	mapSessionInfos,
	probeHeaderSupport,
	readQuietOwnership,
	setHostSettingsForTest,
	snapshotInfo,
	writeQuietOwnership,
} from "../src/host.ts";

describe("probeHeaderSupport", () => {
	it("classifies Pi-style synchronous setHeader as supported", () => {
		const ui = {
			setHeader(factory: unknown) {
				if (factory !== undefined) {
					const component = (factory as (t: unknown, th: unknown) => { render(): string[] })(undefined, undefined);
					component.render();
				}
			},
			setWidget() {},
			notify() {},
		};
		assert.equal(probeHeaderSupport(ui as never), true);
	});

	it("classifies omp's declared-but-no-op setHeader as unsupported", () => {
		const ui = { setHeader() {}, setWidget() {}, notify() {} };
		assert.equal(probeHeaderSupport(ui as never), false);
	});

	it("treats a throwing setHeader as unsupported", () => {
		const ui = { setHeader() { throw new Error("boom"); }, setWidget() {}, notify() {} };
		assert.equal(probeHeaderSupport(ui as never), false);
	});
	it("restores the native header after a positive probe (no trace left on Pi)", () => {
		const calls: Array<{ factory: unknown }> = [];
		const ui = {
			setHeader(factory: unknown) {
				calls.push({ factory });
				if (factory !== undefined) {
					// Pi mounts the sentinel in place of the built-in header.
					(factory as (t: unknown, th: unknown) => { render(): string[] })(undefined, undefined);
				}
			},
			setWidget() {},
			notify() {},
		};
		assert.equal(probeHeaderSupport(ui as never), true);
		assert.equal(calls.length, 2);
		assert.notEqual(calls[0]?.factory, undefined); // sentinel install
		assert.equal(calls[1]?.factory, undefined); // immediate restore
	});

	it("makes no restore call when the host never invokes the factory", () => {
		const factories: unknown[] = [];
		const ui = {
			setHeader(factory: unknown) {
				factories.push(factory);
			},
			setWidget() {},
			notify() {},
		};
		assert.equal(probeHeaderSupport(ui as never), false);
		assert.equal(factories.length, 1); // sentinel handed over, ignored by omp
		assert.notEqual(factories[0], undefined); // no undefined-restore follows
	});
});

describe("snapshotInfo", () => {
	it("collects model/provider/version with Unknown fallbacks", () => {
		const { ctx } = makeMockCtx({ version: "7.7.7" });
		const snap = snapshotInfo(ctx, makeMockApi("7.7.7").api);
		assert.equal(snap.model, "test-model");
		assert.equal(snap.provider, "test-provider");
		assert.equal(snap.version, "7.7.7");
		assert.equal(snap.branch, "");
		assert.deepEqual(snap.sessions, []);
	});

	it("falls back to lowercase `version` when VERSION is absent", () => {
		const mock = makeMockApi();
		const api = { ...mock.api, pi: { version: "0.84.2" } };
		const snap = snapshotInfo(makeMockCtx().ctx, api);
		assert.equal(snap.version, "0.84.2");
	});

	it("falls back to Unknown without a model", () => {
		const { ctx } = makeMockCtx({ model: null });
		const snap = snapshotInfo(ctx, makeMockApi().api);
		assert.equal(snap.model, "Unknown");
		assert.equal(snap.provider, "Unknown");
	});

	it("derives dir from the cwd basename", () => {
		const snap = snapshotInfo(makeMockCtx().ctx, makeMockApi().api);
		assert.equal(snap.dir, "demo");
	});
});

describe("detectAppName ({app} token heuristic)", () => {
	it("recognizes omp and pi binaries", () => {
		assert.equal(detectAppName("/opt/homebrew/bin/omp"), "omp");
		assert.equal(detectAppName("/usr/local/bin/pi"), "pi");
	});

	it("returns empty for runtime binaries or odd names", () => {
		assert.equal(detectAppName("/Users/x/.bun/bin/bun"), "");
		assert.equal(detectAppName(""), "");
	});
});

describe("fetchBranch", () => {
	it("returns trimmed stdout on success", async () => {
		const mock = makeMockApi();
		mock.api.exec = async (command: string, args: string[]) => {
			mock.execCalls.push({ command, args });
			return { stdout: "  feature/auth \n", stderr: "", code: 0 };
		};
		assert.equal(await fetchBranch(mock.api), "feature/auth");
		assert.deepEqual(mock.execCalls[0], { command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"] });
	});

	it("returns empty string on nonzero exit", async () => {
		const mock = makeMockApi();
		assert.equal(await fetchBranch(mock.api), ""); // default mock execs exit 128
	});

	it("survives exec throwing", async () => {
		const mock = makeMockApi();
		mock.api.exec = async () => {
			throw new Error("no exec");
		};
		assert.equal(await fetchBranch(mock.api), "");
	});

	it("falls back to the short hash on a detached HEAD", async () => {
		const mock = makeMockApi();
		mock.api.exec = async (_command: string, args: string[]) => {
			mock.execCalls.push({ command: "git", args });
			return args.includes("--abbrev-ref")
				? { stdout: "HEAD\n", stderr: "", code: 0 }
				: { stdout: "160ed43\n", stderr: "", code: 0 };
		};
		assert.equal(await fetchBranch(mock.api), "160ed43");
		assert.equal(mock.execCalls.length, 2);
		assert.deepEqual(mock.execCalls[1]?.args, ["rev-parse", "--short", "HEAD"]);
	});

	it("returns empty when the detached-HEAD fallback also fails", async () => {
		const mock = makeMockApi();
		mock.api.exec = async (_command: string, args: string[]) => {
			return args.includes("--abbrev-ref")
				? { stdout: "HEAD\n", stderr: "", code: 0 }
				: { stdout: "", stderr: "error", code: 1 };
		};
		assert.equal(await fetchBranch(mock.api), "");
	});
});

describe("mapSessionInfos (host shape tolerance)", () => {
	const base = { path: "/s/abc.json", modified: new Date(Date.now() - 5 * 60_000) };

	it("maps omp-style title rows", () => {
		const rows = mapSessionInfos([{ ...base, title: "omp session" }]);
		assert.equal(rows[0]?.name, "omp session");
		assert.match(rows[0]?.timeAgo ?? "", /m ago|just now/);
	});

	it("maps pi-style name rows", () => {
		const rows = mapSessionInfos([{ ...base, name: "pi session" }]);
		assert.equal(rows[0]?.name, "pi session");
	});

	it("prefers the first non-empty of name → title → basename(path)", () => {
		const rows = mapSessionInfos([
			{ ...base, name: "", title: "title-wins" },
			{ ...base, name: "name-wins", title: "ignored" },
			{ ...base },
		]);
		assert.deepEqual(rows.map(r => r.name), ["title-wins", "name-wins", "abc.json"]);
	});

	it("renders an invalid date as unknown instead of NaN", () => {
		const rows = mapSessionInfos([{ ...base, modified: new Date(Number.NaN) }]);
		assert.equal(rows[0]?.timeAgo, "unknown");
	});
});

describe("fetchRecentSessions failure tolerance", () => {
	it("degrades to an empty list when no host package is installed", async () => {
		// The dynamic import of "@earendil-works/pi-coding-agent" cannot resolve
		// in this bare test environment — exactly the degraded-host scenario.
		assert.deepEqual(await fetchRecentSessions("/tmp/demo", 4), []);
	});

	it("short-circuits count <= 0 without touching the package", async () => {
		assert.deepEqual(await fetchRecentSessions("/tmp/demo", 0), []);
	});
});

describe("quiet-ownership marker", () => {
	const home = mkdtempSync(join(tmpdir(), "omp-startup-host-"));
	const dir = join(home, ".config", "dashboard");

	after(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("reads as absent when nothing was written", () => {
		assert.equal(readQuietOwnership(home), undefined);
	});

	it("roundtrips owned and yielded records", () => {
		writeQuietOwnership(home, { previous: false, state: "owned" });
		assert.deepEqual(readQuietOwnership(home), { previous: false, state: "owned" });
		writeQuietOwnership(home, { previous: true, state: "yielded" });
		assert.deepEqual(readQuietOwnership(home), { previous: true, state: "yielded" });
	});

	it("reports marker writes as booleans (rollback seam)", () => {
		assert.equal(writeQuietOwnership(home, { previous: false, state: "owned" }), true);
		rmSync(join(dir, ".ownership.json"), { force: true });
		mkdirSync(join(dir, ".ownership.json")); // directory blocks every write
		assert.equal(writeQuietOwnership(home, { previous: false, state: "owned" }), false);
		rmSync(join(dir, ".ownership.json"), { recursive: true, force: true });
	});

	it("creates the config directory on first write", () => {
		rmSync(dir, { recursive: true, force: true });
		assert.equal(existsSync(dir), false);
		writeQuietOwnership(home, { previous: false, state: "owned" });
		assert.equal(existsSync(dir), true);
	});

	it("treats corrupt or malformed markers as absent", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".ownership.json"), "{not json");
		assert.equal(readQuietOwnership(home), undefined);
		writeFileSync(join(dir, ".ownership.json"), JSON.stringify({ previous: "yes", state: "owned" }));
		assert.equal(readQuietOwnership(home), undefined);
		writeFileSync(join(dir, ".ownership.json"), JSON.stringify({ previous: false, state: "other" }));
		assert.equal(readQuietOwnership(home), undefined);
	});

	it("clears the marker idempotently", () => {
		clearQuietOwnership(home);
		clearQuietOwnership(home); // second call must not throw
		assert.equal(readQuietOwnership(home), undefined);
	});
});

describe("loadHostSettings flush passthrough", () => {
	it("exposes flush when the host SDK provides one", async () => {
		let flushes = 0;
		setHostSettingsForTest({
			get: () => undefined,
			set: () => {},
			async flush() {
				flushes++;
			},
		});
		try {
			const settings = await loadHostSettings();
			await settings?.flush?.();
			assert.equal(flushes, 1);
		} finally {
			setHostSettingsForTest(null);
		}
	});

	it("omits flush when the host SDK lacks one", async () => {
		setHostSettingsForTest({ get: () => undefined, set: () => {} });
		try {
			const settings = await loadHostSettings();
			assert.equal(settings?.flush, undefined);
		} finally {
			setHostSettingsForTest(null);
		}
	});
});
