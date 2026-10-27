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

export type OpenOutcome = 'opened' | 'remote' | 'failed';

/**
 * Open `url` in the platform's default browser. Resolves once a launcher
 * actually reported success (or every option failed). Inside an SSH session
 * there is no desktop to open a browser on — the caller is told so and can
 * guide the user to their local browser instead.
 */
export async function openUrl(url: string): Promise<OpenOutcome> {
	if (!WEB_URL.test(url)) return 'failed';
	if (isRemoteSession()) return 'remote';
	try {
		if (process.platform === 'win32') {
			// `rundll32 url.dll,FileProtocolHandler` is ShellExecute without a
			// shell — the canonical route to the default browser, and it never
			// flashes a console. explorer also accepts URLs but silently does
			// nothing on some setups, so it is only the fallback.
			if (await tryLaunch(spawn('rundll32', ['url.dll,FileProtocolHandler', url], LAUNCH_FLAGS), true)) {
				return 'opened';
			}
			return (await tryLaunch(spawn('explorer', [url], LAUNCH_FLAGS), false)) ? 'opened' : 'failed';
		}
		if (process.platform === 'darwin') {
			return (await tryLaunch(spawn('open', [url], LAUNCH_FLAGS), true)) ? 'opened' : 'failed';
		}
		return (await tryLaunch(spawn('xdg-open', [url], LAUNCH_FLAGS), true)) ? 'opened' : 'failed';
	} catch {
		return 'failed';
	}
}

function clipOk(result: { error?: Error | null; status: number | null }): boolean {
	return !result.error && result.status === 0;
}

/**
 * True when the process runs inside an SSH session: there is no desktop here
 * to open a browser on, and the only clipboard that matters is the user's
 * local one, reachable through the terminal itself.
 */
export function isRemoteSession(): boolean {
	return (
		process.env.SSH_TTY !== undefined ||
		process.env.SSH_CONNECTION !== undefined ||
		process.env.SSH_CLIENT !== undefined
	);
}

/**
 * Clipboard escape sequence: the one channel that crosses an SSH session.
 * Fire-and-forget — a terminal that does not implement OSC 52 ignores it
 * silently, which is why callers phrase success as "tried".
 */
function copyViaOsc52(text: string): boolean {
	if (!process.stdout.isTTY) return false;
	const payload = Buffer.from(text, 'utf8').toString('base64');
	// Oversized sequences are dropped or wedge some terminals; the links we
	// send stay far below this, the guard is for future callers.
	if (payload.length > 7_500) return false;
	process.stdout.write(`\x1b]52;c;${payload}\x07`);
	return true;
}

/**
 * Copy `text` to the clipboard. Native tools win when a desktop is attached;
 * over SSH (or a bare terminal) the OSC 52 sequence carries the text to the
 * user's local clipboard instead. Returns false when nothing could be tried.
 */
export function copyToClipboard(text: string): boolean {
	if (text.length === 0) return false;
	if (process.platform === 'win32') {
		return clipOk(spawnSync('clip', [], { ...CLIPBOARD_FLAGS, input: text })) || copyViaOsc52(text);
	}
	if (process.platform === 'darwin') {
		return clipOk(spawnSync('pbcopy', [], { ...CLIPBOARD_FLAGS, input: text })) || copyViaOsc52(text);
	}
	// Wayland first: `xclip` needs an X server.
	return (
		clipOk(spawnSync('wl-copy', [], { ...CLIPBOARD_FLAGS, input: text })) ||
		clipOk(spawnSync('xclip', ['-selection', 'clipboard'], { ...CLIPBOARD_FLAGS, input: text })) ||
		clipOk(spawnSync('xsel', ['--clipboard', '--input'], { ...CLIPBOARD_FLAGS, input: text })) ||
		copyViaOsc52(text)
	);
}
