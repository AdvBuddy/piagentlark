import { spawn, spawnSync } from 'node:child_process';

/**
 * Handing a URL to the OS and putting text on the clipboard.
 *
 * Both are best-effort: a headless, remote or containerised box has no browser
 * and no clipboard, so callers keep showing the link for the user to act on.
 */

/** Only web URLs are ever handed to a launcher. */
const WEB_URL = /^https?:\/\//i;

/** How long a clipboard tool may block before we give up and try the next one. */
const CLIPBOARD_TIMEOUT_MS = 2_000;

interface ClipboardCommand {
	bin: string;
	args: string[];
}

/**
 * Open `url` in the platform's default browser. Returns whether a launcher
 * started; the browser itself may still fail to appear.
 */
export function openUrl(url: string): boolean {
	if (!WEB_URL.test(url)) return false;
	// Each branch spawns a literal program with the URL as its only argument; no
	// shell is involved, so query strings cannot be re-split. On Windows
	// `explorer` is a GUI process, so opening a URL never flashes a console the
	// way `cmd /c start` does.
	const options = { detached: true, stdio: 'ignore' as const, windowsHide: true };
	const launch =
		process.platform === 'win32'
			? () => spawn('explorer', [url], options)
			: process.platform === 'darwin'
				? () => spawn('open', [url], options)
				: () => spawn('xdg-open', [url], options);
	try {
		const child = launch();
		child.on('error', () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/** Clipboard tools to try, in order. Wayland first: `xclip` needs an X server. */
function clipboardCommands(): ClipboardCommand[] {
	if (process.platform === 'win32') return [{ bin: 'clip', args: [] }];
	if (process.platform === 'darwin') return [{ bin: 'pbcopy', args: [] }];
	return [
		{ bin: 'wl-copy', args: [] },
		{ bin: 'xclip', args: ['-selection', 'clipboard'] },
		{ bin: 'xsel', args: ['--clipboard', '--input'] },
	];
}

/**
 * Copy `text` to the system clipboard. Returns false when no clipboard tool is
 * available, which is the normal outcome over SSH or in a container.
 */
export function copyToClipboard(text: string): boolean {
	if (text.length === 0) return false;
	for (const { bin, args } of clipboardCommands()) {
		const result = spawnSync(bin, args, {
			input: text,
			stdio: ['pipe', 'ignore', 'ignore'],
			windowsHide: true,
			timeout: CLIPBOARD_TIMEOUT_MS,
		});
		if (!result.error && result.status === 0) return true;
	}
	return false;
}
