/**
 * Dashboard rendering. Pure functions over config + state + a duck-typed
 * theme — no host imports, fully unit-testable.
 *
 * The "box" layout replicates the native omp WelcomeComponent geometry
 * (column split, rounded border, embedded title) so that unconfigured
 * elements keep the native look; see oh-my-pi
 * `packages/coding-agent/src/modes/components/welcome.ts`.
 */

import type { DashboardConfig } from "./config.ts";
import { expandTokens } from "./config.ts";
import type { DashboardState } from "./host.ts";

/** Native π glyph art (oh-my-pi welcome.ts PI_LOGO). */
const PI_LOGO = ["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "];

/** Multi-stop palette for the diagonal gradient (oh-my-pi welcome.ts GRADIENT_STOPS). */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[255, 92, 200], // hot pink
	[200, 110, 255], // violet
	[120, 130, 255], // periwinkle
	[60, 200, 255], // bright cyan
	[120, 255, 220], // mint
];

const BORDER_H = "─";
const BORDER_V = "│";

// Inline style markers: "\x01color\x02text" spans, resolved against the theme
// in applyTheme(). Multiple spans chain: "\x01dim\x02key\x01muted\x02 label".
const MARKER_OPEN = "\x01";
const MARKER_CLOSE = "\x02";

// ---------------------------------------------------------------------------
// ANSI-aware text helpers
// ---------------------------------------------------------------------------

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function plainText(text: string): string {
	return text.replace(SGR_PATTERN, "");
}

/**
 * Terminal cell width for one code point. Full wcwidth is out of scope for a
 * zero-dependency renderer; this covers the wide ranges that actually appear
 * in greetings/logos/quotes (CJK, kana, Hangul, fullwidth forms, emoji).
 * Combining marks are counted as width 1 — a known, documented simplification.
 */
function charCellWidth(cp: number): number {
	if (cp < 0x1100) return 1;
	if (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals .. CJK symbols
		(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana .. CJK compatibility
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
		(cp >= 0xa000 && cp <= 0xa4cf) || // Yi syllables
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
		(cp >= 0x1f300 && cp <= 0x1faff) || // Pictographic emoji
		(cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B and beyond
	) {
		return 2;
	}
	return 1;
}

/** Visible terminal-cell width of a line after stripping SGR sequences. */
export function visibleWidth(text: string): number {
	let total = 0;
	for (const char of plainText(text)) total += charCellWidth(char.codePointAt(0) ?? 0);
	return total;
}

function padding(count: number): string {
	return count > 0 ? " ".repeat(count) : "";
}

const ELLIPSIS_PLACEHOLDER = "…";

/**
 * Truncate to an exact visible cell width, preserving SGR runs so styled
 * text keeps its color when it overflows.
 */
function truncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	const maxCells = Math.max(0, width - 1); // room for the ellipsis
	let out = "";
	let used = 0;
	let inEscape = false;
	for (const char of text) {
		if (inEscape) {
			out += char;
			if (char === "m") inEscape = false;
			continue;
		}
		if (char === "\x1b") {
			inEscape = true;
			out += char;
			continue;
		}
		const w = charCellWidth(char.codePointAt(0) ?? 0);
		if (used + w > maxCells) break;
		out += char;
		used += w;
	}
	return `${out}${ELLIPSIS_PLACEHOLDER}`;
}

/** Fit a (possibly styled) string to an exact visible width, preserving SGR runs. */
function fitToWidth(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen > width) return truncateToWidth(text, width);
	return text + padding(width - visLen);
}

function centerText(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen >= width) return truncateToWidth(text, width);
	const leftPad = Math.floor((width - visLen) / 2);
	return padding(leftPad) + text + padding(width - visLen - leftPad);
}

// ---------------------------------------------------------------------------
// Logo gradient
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function gradientColorAt(t: number): readonly [number, number, number] {
	const clamped = Math.min(1, Math.max(0, t));
	const scaled = clamped * (GRADIENT_STOPS.length - 1);
	const index = Math.min(GRADIENT_STOPS.length - 2, Math.floor(scaled));
	const localT = scaled - index;
	const fallback: readonly [number, number, number] = [255, 92, 200];
	const from = GRADIENT_STOPS[index] ?? fallback;
	const to = GRADIENT_STOPS[index + 1] ?? fallback;
	return [lerp(from[0], to[0], localT), lerp(from[1], to[1], localT), lerp(from[2], to[2], localT)];
}

/**
 * Paint a diagonal bottom-left → top-right gradient across the given lines,
 * one resting frame (the native intro animation is intentionally not replicated).
 */
function paintGradient(lines: string[]): string[] {
	const height = Math.max(1, lines.length);
	return lines.map((line, y) => {
		const chars = [...line];
		const width = Math.max(1, chars.length);
		let out = "";
		for (let x = 0; x < chars.length; x++) {
			const char = chars[x];
			if (char === " ") {
				out += char;
				continue;
			}
			const t = (x / width + (height - 1 - y) / height) / 2;
			const [r, g, b] = gradientColorAt(t);
			out += `\x1b[38;2;${r};${g};${b}m${char}\x1b[39m`;
		}
		return out;
	});
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

interface BlockLines {
	header?: string;
	lines: string[];
}

function resolveLogoArt(cfg: DashboardConfig): string[] {
	if (cfg.logo === "none") return [];
	const art = cfg.logo === "pi" ? PI_LOGO : cfg.logo;
	return cfg.gradient ? paintGradient(art) : [...art];
}

function buildBlock(name: string, cfg: DashboardConfig, state: DashboardState): BlockLines | undefined {
	switch (name) {
		case "greeting":
			return { lines: [expandTokens(cfg.greeting, state)] };
		case "blank":
			return { lines: [""] };
		case "logo": {
			const art = resolveLogoArt(cfg);
			if (art.length === 0) return undefined;
			return { lines: art };
		}
		case "info": {
			if (cfg.info.length === 0) return undefined;
			const rows = cfg.info.map((row, index) => {
				const text = expandTokens(row, state);
				// Alternating muted/borderMuted reproduces the native model/provider styling.
				const color = index % 2 === 0 ? "muted" : "borderMuted";
				return text === "" ? "" : `${MARKER_OPEN}${color}${MARKER_CLOSE}${text}`;
			});
			return { lines: rows };
		}
		case "shortcuts": {
			if (cfg.shortcuts.length === 0) return undefined;
			const rows = cfg.shortcuts.map(
				hint => `${MARKER_OPEN}dim${MARKER_CLOSE}${hint.key}${MARKER_OPEN}muted${MARKER_CLOSE} ${hint.label}`,
			);
			return { header: "Tips", lines: rows };
		}
		case "sessions": {
			if (cfg.sessions <= 0) return undefined;
			const rows: string[] = [];
			if (state.sessions.length === 0) {
				rows.push(`${MARKER_OPEN}dim${MARKER_CLOSE}No recent sessions`);
			} else {
				for (const session of state.sessions.slice(0, cfg.sessions)) {
					rows.push(
						`${MARKER_OPEN}dim${MARKER_CLOSE} • ${MARKER_OPEN}muted${MARKER_CLOSE}${session.name}${MARKER_OPEN}dim${MARKER_CLOSE} (${session.timeAgo})`,
					);
				}
			}
			// Pad to the fixed slot count so box height doesn't depend on session count.
			while (rows.length < cfg.sessions) rows.push("");
			return { header: "Recent sessions", lines: rows };
		}
		default:
			return undefined;
	}
}

/** Resolve "\x01color\x02…" spans against the real theme; strips stray markers. */
function applyTheme(line: string, theme: DashboardTheme): string {
	return line
		.split(MARKER_OPEN)
		.map((segment, index) => {
			if (index === 0) return segment;
			const end = segment.indexOf(MARKER_CLOSE);
			if (end < 0) return segment;
			const color = segment.slice(0, end) as Parameters<DashboardTheme["fg"]>[0];
			return theme.fg(color, segment.slice(end + 1));
		})
		.join("");
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

interface ColumnGeometry {
	boxWidth: number;
	showRightColumn: boolean;
	leftCol: number;
	rightCol: number;
}

/** Column math mirrors oh-my-pi welcome.ts #renderLines. */
function computeGeometry(cfg: DashboardConfig, termWidth: number, hasRightBlocks: boolean): ColumnGeometry | undefined {
	const boxWidth = Math.min(cfg.width, Math.max(0, termWidth - 2));
	if (boxWidth < 4) return undefined;

	const dualContentWidth = boxWidth - 3; // │ + │ + │
	const preferredLeftCol = 26;
	const minLeftCol = 12; // logo width
	const minRightCol = 20;
	const leftMinContentWidth = Math.max(minLeftCol, visibleWidth(plainText(cfg.greeting)));

	const desiredLeftCol = Math.max(
		Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35))),
		leftMinContentWidth,
	);
	const dualLeftCol =
		dualContentWidth >= minRightCol + 1
			? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
			: Math.max(1, dualContentWidth - 1);
	const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
	const showRightColumn = hasRightBlocks && dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;

	return {
		boxWidth,
		showRightColumn,
		leftCol: showRightColumn ? dualLeftCol : boxWidth - 2,
		rightCol: showRightColumn ? dualRightCol : 0,
	};
}

/**
 * Pick a quote deterministically: `render()` runs on every TUI repaint, so
 * per-render randomness would flicker between frames. Rotation is keyed on
 * the UTC day index — every frame within a day shows the same entry, and the
 * list cycles over consecutive days.
 */
function pickQuote(quote: string[]): string | undefined {
	if (quote.length === 0) return undefined;
	if (quote.length === 1) return quote[0];
	const dayIndex = Math.floor(Date.now() / 86_400_000);
	return quote[dayIndex % quote.length];
}

function buildQuoteLine(cfg: DashboardConfig, state: DashboardState, theme: DashboardTheme, width: number): string[] {
	if (cfg.quote.length === 0) return [];
	const picked = pickQuote(cfg.quote);
	if (!picked) return [];
	const text = expandTokens(picked, state);
	return [` ${theme.fg("dim", `\x1b[3m${truncateToWidth(text, Math.max(1, width - 2))}\x1b[23m`)}`];
}

function renderRightColumn(blocks: BlockLines[], width: number, theme: DashboardTheme): string[] {
	const lines: string[] = [];
	let pendingGroup = false;
	for (const block of blocks) {
		if (pendingGroup) lines.push(theme.fg("dim", BORDER_H.repeat(Math.max(0, width - 2))));
		pendingGroup = true;
		lines.push(` ${theme.bold(theme.fg("accent", block.header ?? ""))}`);
		for (const line of block.lines) {
			lines.push(` ${applyTheme(line, theme)}`);
		}
	}
	lines.push("");
	return lines;
}

function assembleBox(
	leftBlocks: BlockLines[],
	rightBlocks: BlockLines[],
	geo: ColumnGeometry,
	cfg: DashboardConfig,
	state: DashboardState,
	theme: DashboardTheme,
): string[] {
	const leftRaw: string[] = [];
	for (const block of leftBlocks) {
		for (const line of block.lines) leftRaw.push(centerText(applyTheme(line, theme), geo.leftCol));
	}
	const rightLines = geo.showRightColumn ? renderRightColumn(rightBlocks, geo.rightCol, theme) : [];

	const dimH = theme.fg("dim", BORDER_H);
	const dimV = theme.fg("dim", BORDER_V);
	const lines: string[] = [];

	// Top border with optional embedded title (native: three dashes, then title).
	const rawTitle = expandTokens(cfg.title, state).trim();
	// Degenerate expansion (e.g. "{app} v{version}" on hosts exposing neither)
	// would render a lone "v" — treat it as no title.
	if (rawTitle.length > 0 && !/^[v\s]*$/.test(rawTitle)) {
		const title = ` ${rawTitle} `;
		const titleStyled = dimH.repeat(3) + theme.fg("muted", title);
		const titleSpace = geo.boxWidth - 2;
		if (visibleWidth(titleStyled) >= titleSpace) {
			lines.push(theme.fg("dim", "╭") + fitToWidth(titleStyled, titleSpace) + theme.fg("dim", "╮"));
		} else {
			const afterTitle = titleSpace - visibleWidth(titleStyled);
			lines.push(theme.fg("dim", "╭") + titleStyled + dimH.repeat(afterTitle) + theme.fg("dim", "╮"));
		}
	} else {
		lines.push(theme.fg("dim", `╭${BORDER_H.repeat(geo.boxWidth - 2)}╮`));
	}

	// Content rows.
	const maxRows = Math.max(leftRaw.length, rightLines.length);
	for (let i = 0; i < maxRows; i++) {
		const left = fitToWidth(leftRaw[i] ?? "", geo.leftCol);
		if (geo.showRightColumn) {
			const right = fitToWidth(rightLines[i] ?? "", geo.rightCol);
			lines.push(dimV + left + dimV + right + dimV);
		} else {
			lines.push(dimV + left + dimV);
		}
	}

	// Bottom border with the column tee.
	if (geo.showRightColumn) {
		lines.push(
			theme.fg("dim", "╰") +
				dimH.repeat(geo.leftCol) +
				theme.fg("dim", "┬") +
				dimH.repeat(geo.rightCol) +
				theme.fg("dim", "╯"),
		);
	} else {
		lines.push(theme.fg("dim", `╰${BORDER_H.repeat(geo.leftCol)}╯`));
	}

	return lines;
}

function assemblePlain(blocks: BlockLines[], contentWidth: number, theme: DashboardTheme): string[] {
	const lines: string[] = [];
	let pendingRight = false;
	for (const block of blocks) {
		if (block.header === undefined) {
			for (const line of block.lines) lines.push(centerText(applyTheme(line, theme), contentWidth));
			continue;
		}
		if (pendingRight) lines.push("");
		pendingRight = true;
		lines.push(` ${theme.bold(theme.fg("accent", block.header))}`);
		for (const line of block.lines) lines.push(` ${applyTheme(line, theme)}`);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

// ---------------------------------------------------------------------------
/** Dim italic advisory under the box (widget-mode hint on non-header hosts). */
function hintLine(state: DashboardState, theme: DashboardTheme, boxWidth: number): string[] {
	if (!state.hint) return [];
	return [` ${theme.fg("dim", `\x1b[3m${truncateToWidth(state.hint, Math.max(1, boxWidth - 2))}\x1b[23m`)}`];
}

// Entry points
// ---------------------------------------------------------------------------

export function renderDashboard(
	cfg: DashboardConfig,
	state: DashboardState,
	theme: DashboardTheme,
	termWidth: number,
): string[] {
	const isBox = cfg.layout === "box";

	const seen = new Set<string>();
	// A name renders at most once per dashboard, whether duplicated within one
	// column or repeated across both.
	const leftList = cfg.left.filter(name => {
		if (seen.has(name)) return false;
		seen.add(name);
		return true;
	});
	const rightList = cfg.right.filter(name => {
		if (seen.has(name)) return false;
		seen.add(name);
		return true;
	});
	const buildAll = (names: string[]) =>
		names.map(name => buildBlock(name, cfg, state)).filter((block): block is BlockLines => block !== undefined);

	if (!isBox) {
		// Plain layout stacks every configured block full-width, left order then right.
		const geometry = computeGeometry(cfg, termWidth, false);
		if (!geometry) return [];
		const stacked = [...buildAll(leftList), ...buildAll(rightList)];
		return [
			...assemblePlain(stacked, geometry.boxWidth - 2, theme),
			...buildQuoteLine(cfg, state, theme, geometry.boxWidth),
			...hintLine(state, theme, geometry.boxWidth),
		];
	}

	const rightBlocks = buildAll(rightList);
	const geometry = computeGeometry(cfg, termWidth, rightBlocks.length > 0);
	if (!geometry) return [];
	const leftBlocks = buildAll(leftList);
	const lines = assembleBox(leftBlocks, rightBlocks, geometry, cfg, state, theme);
	return [
		...lines,
		...buildQuoteLine(cfg, state, theme, geometry.boxWidth),
		...hintLine(state, theme, geometry.boxWidth),
	];
}

export interface DashboardComponentHandle {
	factory: DashboardComponentFactory;
	/** Ask the host TUI for a re-render after late async data lands. */
	refresh(): void;
}

/**
 * Build the component handle handed to `setWidget`/`setHeader`. The factory
 * remembers its TUI so `refresh()` can trigger re-renders when async fetches
 * (git branch, recent sessions) resolve after mount.
 */
export function makeDashboardComponent(
	stateRef: { current: DashboardState },
	cfgRef: { current: DashboardConfig },
): DashboardComponentHandle {
	let requestRender: (() => void) | null = null;
	return {
		refresh() {
			requestRender?.();
		},
		factory: (tui: DashboardTUI, theme: DashboardTheme): DashboardComponent => ({
			render(width: number): string[] {
				requestRender = () => tui.requestRender();
				return renderDashboard(cfgRef.current, stateRef.current, theme, width);
			},
		}),
	};
}
