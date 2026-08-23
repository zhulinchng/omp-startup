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

function visibleWidth(text: string): number {
	return [...plainText(text)].length;
}

function padding(count: number): string {
	return count > 0 ? " ".repeat(count) : "";
}

function truncateToWidth(text: string, width: number): string {
	const stripped = plainText(text);
	if ([...stripped].length <= width) return text;
	let out = "";
	let used = 0;
	for (const char of stripped) {
		if (used >= width - 1) break;
		out += char;
		used++;
	}
	return `${out}${ELLIPSIS_PLACEHOLDER}`;
}

const ELLIPSIS_PLACEHOLDER = "…";

/** Fit a (possibly styled) string to an exact visible width, preserving SGR runs. */
function fitToWidth(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen > width) {
		const maxWidth = Math.max(0, width - [...ELLIPSIS_PLACEHOLDER].length);
		let truncated = "";
		let currentWidth = 0;
		let inEscape = false;
		for (const char of text) {
			if (char === "\x1b") inEscape = true;
			if (inEscape) {
				truncated += char;
				if (char === "m") inEscape = false;
			} else if (currentWidth < maxWidth) {
				truncated += char;
				currentWidth++;
			}
		}
		return `${truncated}${ELLIPSIS_PLACEHOLDER}`;
	}
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
	rightColumn: boolean;
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
			return { rightColumn: false, lines: [expandTokens(cfg.greeting, state)] };
		case "blank":
			return { rightColumn: false, lines: [""] };
		case "logo": {
			const art = resolveLogoArt(cfg);
			if (art.length === 0) return undefined;
			return { rightColumn: false, lines: art };
		}
		case "info": {
			if (cfg.info.length === 0) return undefined;
			const rows = cfg.info.map((row, index) => {
				const text = expandTokens(row, state);
				// Alternating muted/borderMuted reproduces the native model/provider styling.
				const color = index % 2 === 0 ? "muted" : "borderMuted";
				return text === "" ? "" : `${MARKER_OPEN}${color}${MARKER_CLOSE}${text}`;
			});
			return { rightColumn: false, lines: rows };
		}
		case "shortcuts": {
			if (cfg.shortcuts.length === 0) return undefined;
			const rows = cfg.shortcuts.map(
				hint => `${MARKER_OPEN}dim${MARKER_CLOSE}${hint.key}${MARKER_OPEN}muted${MARKER_CLOSE} ${hint.label}`,
			);
			return { rightColumn: true, header: "Tips", lines: rows };
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
			return { rightColumn: true, header: "Recent sessions", lines: rows };
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

function buildQuoteLine(cfg: DashboardConfig, state: DashboardState, theme: DashboardTheme, width: number): string[] {
	if (cfg.quote.length === 0) return [];
	const picked = cfg.quote[Math.floor(Math.random() * cfg.quote.length)];
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
		if (!block.rightColumn) {
			for (const line of block.lines) lines.push(centerText(applyTheme(line, theme), contentWidth));
			continue;
		}
		if (pendingRight) lines.push("");
		pendingRight = true;
		if (block.header !== undefined) lines.push(` ${theme.bold(theme.fg("accent", block.header))}`);
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
	const leftNames = new Set<string>(cfg.left);
	const isBox = cfg.layout === "box";
	const buildAll = (names: string[]) =>
		names
			.filter(name => !leftNames.has(name))
			.map(name => buildBlock(name, cfg, state))
			.filter((block): block is BlockLines => block !== undefined);
	const rightBlocks = isBox ? buildAll(cfg.right).filter(block => block.rightColumn) : [];

	const geometry = computeGeometry(cfg, termWidth, rightBlocks.length > 0);
	if (!geometry) return [];

	if (!isBox) {
		// Plain layout stacks every configured block full-width, left order then right.
		const stacked = [...cfg.left.map(name => buildBlock(name, cfg, state)), ...buildAll(cfg.right)].filter(
			(block): block is BlockLines => block !== undefined,
		);
		return [
			...assemblePlain(stacked, geometry.boxWidth - 2, theme),
			...buildQuoteLine(cfg, state, theme, geometry.boxWidth),
			...hintLine(state, theme, geometry.boxWidth),
		];
	}

	const leftBlocks = cfg.left
		.map(name => buildBlock(name, cfg, state))
		.filter((block): block is BlockLines => block !== undefined && !block.rightColumn);

	const lines = assembleBox(leftBlocks, rightBlocks, geometry, cfg, state, theme);

	return [...lines, ...buildQuoteLine(cfg, state, theme, geometry.boxWidth), ...hintLine(state, theme, geometry.boxWidth)];
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
