import { copyToClipboard, openUrl } from '../src/util/system.js';
import type { ExtensionComponent, ExtensionTheme } from './pi.js';

/**
 * The link card shown while an app registration polls in the background.
 *
 * The verification URL carries the prefilled scopes and runs to ~700
 * characters, so the card never asks the user to select it by hand: the link
 * is copied to the clipboard the moment it arrives, `o` (or Enter) hands it to
 * the browser and `c` copies it again. The raw URL stays collapsed behind `l`
 * — a one-line preview with host and path is enough to tell links apart.
 * Nothing opens by itself — a browser window stealing focus from the terminal
 * mid-session is worse than pressing one key.
 */

/** Wide enough to wrap the expanded link without blanking the whole screen. */
const BOX_COLUMNS = 88;

/** Columns to ask pi for. pi clamps it again when the window shrinks. */
export function linkOverlayWidth(): number {
	const columns = process.stdout.columns ?? 80;
	return Math.max(40, Math.min(columns - 2, BOX_COLUMNS));
}

/** Terminal cell width: CJK and emoji take two columns. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return width;
}

function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f9ff)
	);
}

interface Note {
	text: string;
	warn: boolean;
}

export interface LinkOverlayOptions {
	/** Hands the URL to the browser; overridable so tests never open one. */
	open?: (url: string) => boolean | Promise<boolean>;
	/** Puts the URL on the clipboard; overridable so tests never touch it. */
	copy?: (text: string) => boolean;
	/** Asks pi for a repaint; drives the waiting-time / expiry line. */
	requestRender?: () => void;
	/** Waiting-line tick rate; the default shows one update per second. */
	tickMs?: number;
	/** Clock injection for tests. */
	now?: () => number;
}

/** Host plus path, with the query collapsed: readable but recognisable. */
function linkPreview(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname}${parsed.search ? '?…' : ''}`;
	} catch {
		return url.length > 36 ? `${url.slice(0, 35)}…` : url;
	}
}

function formatElapsed(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds} 秒`;
	return `${Math.floor(totalSeconds / 60)} 分 ${String(totalSeconds % 60).padStart(2, '0')} 秒`;
}

export class LinkOverlay implements ExtensionComponent {
	private readonly theme: ExtensionTheme;
	private readonly done: () => void;
	private readonly onCancel: () => void;
	private readonly open: (url: string) => boolean | Promise<boolean>;
	private readonly copy: (text: string) => boolean;
	private readonly requestRender: (() => void) | undefined;
	private readonly tickMs: number;
	private readonly now: () => number;
	private url: string | undefined;
	private status = '正在申请授权链接…';
	private note: Note | undefined;
	private error: string | undefined;
	private closed = false;
	private showFullUrl = false;
	private opening = false;
	private linkAt = 0;
	private expireSeconds = 0;
	private timer: NodeJS.Timeout | undefined;

	constructor(theme: ExtensionTheme, done: () => void, onCancel: () => void, options: LinkOverlayOptions = {}) {
		this.theme = theme;
		this.done = done;
		this.onCancel = onCancel;
		this.open = options.open ?? openUrl;
		this.copy = options.copy ?? copyToClipboard;
		this.requestRender = options.requestRender;
		this.tickMs = options.tickMs ?? 1_000;
		this.now = options.now ?? Date.now;
	}

	setUrl(url: string, expireInSeconds?: number): void {
		this.url = url;
		this.expireSeconds = expireInSeconds && expireInSeconds > 0 ? expireInSeconds : 0;
		this.linkAt = this.now();
		this.status = '在浏览器中完成授权，这里会自动继续';
		// Copying on arrival is the point: the link is far too long to select by
		// hand, and the terminal may not show all of it at once.
		this.note = this.copy(url)
			? { text: '链接已复制到剪贴板，粘贴到浏览器即可', warn: false }
			: { text: '链接复制失败，请按 o 打开浏览器', warn: true };
		this.startTimer();
	}

	setStatus(text: string): void {
		if (!this.error) this.status = text;
	}

	setError(message: string): void {
		this.error = message;
		this.status = '配置失败，按 Esc 关闭';
	}

	/** Close the overlay once the registration settles. */
	finish(): void {
		if (this.closed) return;
		this.stopTimer();
		this.closed = true;
		this.done();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data === 'o' || data === 'O' || data === '\r' || data === '\n') {
			this.reveal();
			return;
		}
		if (data === 'c' || data === 'C' || data === 'y' || data === 'Y') {
			this.copyUrl();
			return;
		}
		if (data === 'l' || data === 'L') {
			this.showFullUrl = !this.showFullUrl;
			return;
		}
		if (data === '\u001b' || data === 'q' || data === 'Q' || data === '\u0003') {
			this.stopTimer();
			this.closed = true;
			this.onCancel();
			this.done();
		}
	}

	dispose(): void {
		this.stopTimer();
	}

	private reveal(): void {
		if (!this.url || this.opening) return;
		this.opening = true;
		// The launcher's real verdict arrives asynchronously (spawn errors and
		// exit codes are events), so show a provisional note and correct it —
		// claiming success before anything opened is worse than a short wait.
		this.note = { text: '正在打开浏览器…', warn: false };
		this.requestRender?.();
		const settle = (ok: boolean): void => {
			this.opening = false;
			this.note = ok
				? { text: '已在浏览器中打开链接', warn: false }
				: { text: '无法自动打开浏览器，请按 c 复制后手动粘贴', warn: true };
			this.requestRender?.();
		};
		Promise.resolve(this.open(this.url)).then(settle, () => settle(false));
	}

	private copyUrl(): void {
		if (!this.url) return;
		this.note = this.copy(this.url)
			? { text: '链接已复制到剪贴板', warn: false }
			: { text: '复制失败，请按 l 展开链接后手动选中', warn: true };
	}

	/** The dim line under the link: validity window, wait time, expiry. */
	private metaLine(): Note | undefined {
		if (!this.url) return undefined;
		const elapsed = Math.max(0, Math.floor((this.now() - this.linkAt) / 1_000));
		if (this.expireSeconds > 0 && elapsed >= this.expireSeconds) {
			return { text: '链接可能已过期，取消后重试会生成新链接', warn: true };
		}
		const parts: string[] = [];
		if (this.expireSeconds > 0) {
			parts.push(`链接约 ${Math.max(1, Math.ceil(this.expireSeconds / 60))} 分钟内有效`);
		}
		if (elapsed >= 1) parts.push(`已等待 ${formatElapsed(elapsed)}`);
		return parts.length > 0 ? { text: parts.join(' · '), warn: false } : undefined;
	}

	private startTimer(): void {
		if (this.timer || !this.requestRender || this.closed) return;
		this.timer = setInterval(() => this.requestRender?.(), this.tickMs);
		this.timer.unref();
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = (text: string): string => theme.fg('border', text);
		const cols = Math.max(1, Math.floor(width));
		const hint = this.showFullUrl
			? 'o 打开 · c 复制 · l 收起链接 · Esc 取消'
			: 'o 打开浏览器 · c 复制 · l 完整链接 · Esc 取消';
		const preview = this.url && !this.showFullUrl ? `🔗 ${linkPreview(this.url)}` : undefined;
		const meta = this.metaLine();
		const contentWidth = Math.max(
			displayWidth(this.status),
			this.note ? displayWidth(this.note.text) : 0,
			this.error ? displayWidth(this.error) : 0,
			preview ? displayWidth(preview) : 0,
			meta ? displayWidth(meta.text) : 0,
			displayWidth(hint),
			28,
		);
		const inner = Math.max(24, Math.min(Math.max(1, cols - 2), contentWidth + 2));
		const wrapAt = Math.max(8, inner - 2);
		const indent = Math.max(0, Math.floor((cols - inner - 2) / 2));
		const gutter = ' '.repeat(indent);
		const pad = (text: string): string => text + ' '.repeat(Math.max(0, inner - displayWidth(text)));
		const row = (text: string): string => `${gutter}${border('│')}${pad(text)}${border('│')}`;
		const frame = (text: string): string => `${gutter}${border(text)}`;
		// pi composites the overlay over the lines below it, so pad to the full
		// width or the underlying UI shows through next to the box.
		const fill = (text: string): string => text + ' '.repeat(Math.max(0, cols - displayWidth(text)));
		// The title rides in the top border, which keeps the box two rows shorter.
		const edge = (open: string, close: string, label: string): string => {
			const text = displayWidth(label) <= inner - 2 ? label : '';
			return `${open}${text}${'─'.repeat(Math.max(0, inner - displayWidth(text)))}${close}`;
		};

		const lines: string[] = [];
		const title =
			[' pi-lark · 设备授权 ', ' pi-lark '].find((text) => displayWidth(text) <= inner - 2) ?? '';
		lines.push(frame(edge('╭', '╮', title)));
		lines.push(row(''));
		for (const part of wrap(this.status, wrapAt)) lines.push(row(` ${theme.fg('text', part)}`));
		if (this.note) {
			const style = this.note.warn ? 'warning' : 'accent';
			for (const part of wrap(this.note.text, wrapAt)) lines.push(row(` ${theme.fg(style, part)}`));
		}
		if (this.error) {
			for (const part of wrap(this.error, wrapAt)) lines.push(row(` ${theme.fg('error', part)}`));
		}
		if (preview) {
			for (const part of wrap(preview, wrapAt)) lines.push(row(` ${theme.fg('dim', part)}`));
		}
		if (this.url && this.showFullUrl) {
			for (const part of wrap(this.url, wrapAt)) lines.push(row(` ${theme.fg('dim', part)}`));
		}
		if (meta) {
			for (const part of wrap(meta.text, wrapAt)) lines.push(row(` ${theme.fg(meta.warn ? 'warning' : 'dim', part)}`));
		}
		lines.push(row(''));
		for (const part of wrap(hint, wrapAt)) lines.push(row(` ${theme.fg('dim', part)}`));
		lines.push(frame(`╰${'─'.repeat(inner)}╯`));
		return lines.map(fill);
	}

	invalidate(): void {
		// The card only changes when a new URL, status or tick arrives.
	}
}

/** Hard-wrap by display width so a long URL stays inside the box. */
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = '';
	let currentWidth = 0;
	for (const char of text) {
		const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
		if (currentWidth + charWidth > width && current.length > 0) {
			lines.push(current);
			current = '';
			currentWidth = 0;
		}
		current += char;
		currentWidth += charWidth;
	}
	if (current.length > 0) lines.push(current);
	return lines.length > 0 ? lines : [''];
}
