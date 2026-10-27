import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

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

/** Fire-and-forget launch flags: no console window, no pipe to wait on. */
const LAUNCH_FLAGS = { stdio: 'ignore' as const, windowsHide: true };

/** Clipboard flags: text on stdin, nothing back, bounded runtime. */
const CLIPBOARD_FLAGS = {
	stdio: ['pipe', 'ignore', 'ignore'] as ('pipe' | 'ignore')[],
	windowsHide: true,
	timeout: CLIPBOARD_TIMEOUT_MS,
};

/**
 * Wait for a launcher's real verdict. spawn() failures (a missing binary, for
 * example) arrive as an async 'error' event, not a throw — resolving only on
 * those events is what keeps the caller's "opened" message honest.
 *
 * `strictExit` marks launchers whose exit code means success (rundll32, open,
 * xdg-open). explorer exits 1 even when it handed the URL over, so for it only
 * a spawn error counts as failure.
 */
function tryLaunch(child: ChildProcess, strictExit: boolean): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		child.on('error', () => finish(false));
		child.on('exit', (code) => finish(strictExit ? code === 0 : true));
		// A launcher still running after the grace period has handed off (or is
		// wedged); either way its verdict will not change. The timer keeps the
		// loop alive on purpose: an unref'd child's exit event would otherwise
		// leave a short-lived caller with an unsettled verdict.
		const timer = setTimeout(() => finish(!strictExit), 2_000);
		child.unref();
	});
}

/**
 * Open `url` in the platform's default browser. Resolves once a launcher
 * actually reported success (or every option failed).
 */
export async function openUrl(url: string): Promise<boolean> {
	if (!WEB_URL.test(url)) return false;
	try {
		if (process.platform === 'win32') {
			// `rundll32 url.dll,FileProtocolHandler` is ShellExecute without a
			// shell — the canonical route to the default browser, and it never
			// flashes a console. explorer also accepts URLs but silently does
			// nothing on some setups, so it is only the fallback.
			if (await tryLaunch(spawn('rundll32', ['url.dll,FileProtocolHandler', url], LAUNCH_FLAGS), true)) {
				return true;
			}
			return tryLaunch(spawn('explorer', [url], LAUNCH_FLAGS), false);
		}
		if (process.platform === 'darwin') {
			return tryLaunch(spawn('open', [url], LAUNCH_FLAGS), true);
		}
		return tryLaunch(spawn('xdg-open', [url], LAUNCH_FLAGS), true);
	} catch {
		return false;
	}
}

function clipOk(result: { error?: Error | null; status: number | null }): boolean {
	return !result.error && result.status === 0;
}

/**
 * Copy `text` to the system clipboard. Returns false when no clipboard tool is
 * available, which is the normal outcome over SSH or in a container. Wayland
 * tools come first on Linux: `xclip` needs an X server.
 */
export function copyToClipboard(text: string): boolean {
	if (text.length === 0) return false;
	if (process.platform === 'win32') {
		return clipOk(spawnSync('clip', [], { ...CLIPBOARD_FLAGS, input: text }));
	}
	if (process.platform === 'darwin') {
		return clipOk(spawnSync('pbcopy', [], { ...CLIPBOARD_FLAGS, input: text }));
	}
	return (
		clipOk(spawnSync('wl-copy', [], { ...CLIPBOARD_FLAGS, input: text })) ||
		clipOk(spawnSync('xclip', ['-selection', 'clipboard'], { ...CLIPBOARD_FLAGS, input: text })) ||
		clipOk(spawnSync('xsel', ['--clipboard', '--input'], { ...CLIPBOARD_FLAGS, input: text }))
	);
}
