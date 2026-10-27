import { copyToClipboard, openUrl } from '../src/util/system.js';
import type { ExtensionComponent, ExtensionTheme } from './pi.js';

/**
 * The link card shown while an app registration polls in the background.
 *
 * The verification URL carries the prefilled scopes and runs to ~700
 * characters, so the card never asks the user to select it by hand: the link is
 * copied to the clipboard the moment it arrives, `o` hands it to the browser and
 * `c` copies it again. Nothing opens by itself — a browser window stealing focus
 * from the terminal mid-session is worse than pressing one key.
 */

/** Wide enough for a readable link without blanking the whole screen. */
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
	open?: (url: string) => boolean;
	/** Puts the URL on the clipboard; overridable so tests never touch it. */
	copy?: (text: string) => boolean;
}

export class LinkOverlay implements ExtensionComponent {
	private readonly theme: ExtensionTheme;
	private readonly done: () => void;
	private readonly onCancel: () => void;
	private readonly open: (url: string) => boolean;
	private readonly copy: (text: string) => boolean;
	private url: string | undefined;
	private status = '正在申请授权链接…';
	private note: Note | undefined;
	private error: string | undefined;
	private closed = false;

	constructor(theme: ExtensionTheme, done: () => void, onCancel: () => void, options: LinkOverlayOptions = {}) {
		this.theme = theme;
		this.done = done;
		this.onCancel = onCancel;
		this.open = options.open ?? openUrl;
		this.copy = options.copy ?? copyToClipboard;
	}

	setUrl(url: string): void {
		this.url = url;
		this.status = '在浏览器中完成授权，这里会自动继续';
		// Copying on arrival is the point: the link is far too long to select by
		// hand, and the terminal may not show all of it at once.
		this.note = this.copy(url)
			? { text: '链接已复制到剪贴板，粘贴到浏览器即可', warn: false }
			: { text: '链接复制失败，请按 o 打开浏览器', warn: true };
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
		this.closed = true;
		this.done();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (data === 'o' || data === 'O') {
			this.reveal();
			return;
		}
		if (data === 'c' || data === 'C' || data === 'y' || data === 'Y') {
			this.copyUrl();
			return;
		}
		if (data === '\u001b' || data === 'q' || data === 'Q' || data === '\u0003') {
			this.closed = true;
			this.onCancel();
			this.done();
		}
	}

	private reveal(): void {
		if (!this.url) return;
		this.note = this.open(this.url)
			? { text: '已在浏览器中打开链接', warn: false }
			: { text: '无法自动打开浏览器，请手动复制上面的链接', warn: true };
	}

	private copyUrl(): void {
		if (!this.url) return;
		this.note = this.copy(this.url)
			? { text: '链接已复制到剪贴板', warn: false }
			: { text: '复制失败，请手动选中上面的链接', warn: true };
	}

	render(width: number): string[] {
		const theme = this.theme;
		const border = (text: string): string => theme.fg('border', text);
		const cols = Math.max(1, Math.floor(width));
		const hint = 'o 浏览器打开 · c 复制链接 · Esc / q 取消';
		const contentWidth = Math.max(
			displayWidth(this.status),
			this.note ? displayWidth(this.note.text) : 0,
			this.error ? displayWidth(this.error) : 0,
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
			[' pi-lark：打开链接创建 / 配置机器人 ', ' pi-lark '].find((text) => displayWidth(text) <= inner - 2) ?? '';
		lines.push(frame(edge('╭', '╮', title)));
		for (const part of wrap(this.status, wrapAt)) lines.push(row(` ${theme.fg('text', part)}`));
		if (this.note) {
			const style = this.note.warn ? 'warning' : 'accent';
			for (const part of wrap(this.note.text, wrapAt)) lines.push(row(` ${theme.fg(style, part)}`));
		}
		if (this.error) {
			for (const part of wrap(this.error, wrapAt)) lines.push(row(` ${theme.fg('error', part)}`));
		}
		if (this.url) {
			for (const part of wrap(this.url, wrapAt)) lines.push(row(` ${theme.fg('dim', part)}`));
		}
		for (const part of wrap(hint, wrapAt)) lines.push(row(` ${theme.fg('dim', part)}`));
		lines.push(frame(`╰${'─'.repeat(inner)}╯`));
		return lines.map(fill);
	}

	invalidate(): void {
		// The card only changes when a new URL or status arrives.
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
