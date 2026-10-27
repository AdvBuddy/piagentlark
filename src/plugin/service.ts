import { spawn, spawnSync } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeEnvText, parseEnvText } from '../setup/envFile.js';
import { isProcessAlive } from '../util/pid.js';

export { isProcessAlive };

/** Written by the bridge after the gateway connects; polled for readiness. */
const STATUS_FILE = 'bridge-status.json';
/** Dropped by stopBridge on Windows for a graceful in-process shutdown. */
const STOP_FILE = 'bridge.stop';

/**
 * Filesystem and process plumbing for running the bridge as a background
 * service. Everything lives under a single home directory (default
 * `~/.pi/lark`) so sessions survive restarts and are independent of the
 * project the bridge was started from.
 */

export interface BridgePaths {
	home: string;
	/** `.env` read by the bridge (and written by the setup flow). */
	config: string;
	log: string;
	state: string;
	/** `BRIDGE_DATA_DIR`: session mapping, pi sessions, attachment inbox. */
	data: string;
}

export function resolvePaths(home?: string): BridgePaths {
	const base = path.resolve(home ?? process.env.PI_LARK_HOME ?? path.join(os.homedir(), '.pi', 'lark'));
	return {
		home: base,
		config: path.join(base, '.env'),
		log: path.join(base, 'bridge.log'),
		state: path.join(base, 'bridge.json'),
		data: path.join(base, 'data'),
	};
}

export interface BridgeState {
	pid: number;
	/** Working directory pi sessions run in (`PI_CWD`). */
	cwd: string;
	startedAt: string;
	command: string[];
}

function readText(file: string): string {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

export function readBridgeState(file: string): BridgeState | undefined {
	const text = readText(file);
	if (text.length === 0) return undefined;
	try {
		const parsed = JSON.parse(text) as Partial<BridgeState>;
		if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) return undefined;
		return {
			pid: parsed.pid,
			cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
			startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
			command: Array.isArray(parsed.command) ? parsed.command.filter((part): part is string => typeof part === 'string') : [],
		};
	} catch {
		return undefined;
	}
}

export function writeBridgeState(file: string, state: BridgeState): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function clearBridgeState(file: string): void {
	try {
		rmSync(file, { force: true });
	} catch {
		// Best effort: a stale state file only costs one failed liveness check.
	}
}

/** Running state with a live pid, or undefined. */
export function runningBridge(paths: BridgePaths): BridgeState | undefined {
	const state = readBridgeState(paths.state);
	if (!state) return undefined;
	if (isProcessAlive(state.pid)) return state;
	clearBridgeState(paths.state);
	return undefined;
}

export function readConfig(paths: BridgePaths): Record<string, string> {
	return parseEnvText(readText(paths.config));
}

/** The data directory the running bridge uses (status/stop files, sessions). */
export function resolveDataDir(paths: BridgePaths): string {
	const configured = readConfig(paths).BRIDGE_DATA_DIR?.trim();
	if (!configured) return paths.data;
	const resolved = path.resolve(paths.home, configured);
	// Relative values must stay inside the service home; an absolute path is
	// an explicit operator choice and may point anywhere.
	if (!path.isAbsolute(configured)) {
		const relative = path.relative(paths.home, resolved);
		const within = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
		if (!within) throw new Error(`BRIDGE_DATA_DIR 不能指向服务主目录之外：${configured}`);
	}
	return resolved;
}

export function saveConfig(paths: BridgePaths, updates: Record<string, string>): void {
	mkdirSync(paths.home, { recursive: true });
	writeFileSync(paths.config, mergeEnvText(readText(paths.config), updates), 'utf8');
}

/** `[script, ...args]` to run with `process.execPath`, preferring the source. */
export function resolveBridgeCommand(root: string): string[] | undefined {
	// Source first: a local checkout may be newer than `dist/`. Published
	// installs ship the build and no dev dependencies, hence the fallback.
	// The tsx loader is registered with `--import` instead of running the
	// `tsx` CLI: the CLI spawns the entry in yet another node process, and a
	// detached bridge has no console, so that grandchild would create its own
	// visible console window on Windows.
	const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
	const entry = path.join(root, 'src', 'index.ts');
	if (existsSync(loader) && existsSync(entry)) return ['--import', pathToFileURL(loader).href, entry];
	const built = path.join(root, 'dist', 'src', 'index.js');
	if (existsSync(built)) return [built];
	return undefined;
}

/** Same as `resolveBridgeCommand`, but for the interactive setup wizard. */
export function resolveSetupCommand(root: string): string[] | undefined {
	const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
	const entry = path.join(root, 'src', 'setup.ts');
	if (existsSync(loader) && existsSync(entry)) return ['--import', pathToFileURL(loader).href, entry];
	const built = path.join(root, 'dist', 'src', 'setup.js');
	if (existsSync(built)) return [built];
	return undefined;
}

export interface SetupWizardPlan {
	/** Windows batch launcher for the wizard. */
	scriptCmd: string;
	/** POSIX shell launcher for the wizard. */
	scriptSh: string;
	/** Copy-pasteable command for the current platform. */
	manualCommand: string;
}

/**
 * Write small launcher scripts for the setup wizard into the service home, so
 * a second terminal can run the authorization flow without pi's UI: the
 * wizard writes credentials to `paths.config`, which the extension watches.
 */
export function writeSetupScripts(paths: BridgePaths, root: string, extraArgs: string[]): SetupWizardPlan {
	const command = resolveSetupCommand(root);
	if (!command) throw new Error(`找不到授权向导入口，请在 ${root} 运行 npm install（或 npm run build）`);
	// The `--` keeps node's own option parser away from the wizard flags
	// (node eats known options even after the entry file). The script starts
	// in the service home, so the wizard's plain `./.env` write lands on the
	// service config — no path ever crosses the command line.
	const args = [...command, '--', '--no-start', ...extraArgs];
	const quoted = [process.execPath, ...args].map((part) => `"${part}"`).join(' ');
	const scriptCmd = path.join(paths.home, 'setup.cmd');
	const scriptSh = path.join(paths.home, 'setup.sh');
	mkdirSync(paths.home, { recursive: true });
	writeFileSync(
		scriptCmd,
		[
			'@echo off',
			'rem 由 pi-lark 生成：在独立终端中运行飞书授权向导',
			`cd /d "${paths.home}"`,
			`${quoted}\n`,
		].join('\r\n'),
		'utf8',
	);
	writeFileSync(
		scriptSh,
		[
			'#!/bin/sh',
			'# 由 pi-lark 生成：在独立终端中运行飞书授权向导',
			`cd "${paths.home}" && exec ${quoted}\n`,
		].join('\n'),
		'utf8',
	);
	const manualCommand = process.platform === 'win32' ? scriptCmd : `sh ${scriptSh}`;
	return { scriptCmd, scriptSh, manualCommand };
}

export interface SetupSnapshot {
	/** App id in the config when the wait started (empty when unconfigured). */
	appId: string;
	/** Config mtime when the wait started; updates rewrite the same app id. */
	mtimeMs: number;
}

/** Credentials state before the wizard runs, for change detection. */
export function setupSnapshot(paths: BridgePaths): SetupSnapshot {
	try {
		const appId = readConfig(paths).FEISHU_APP_ID?.trim() ?? '';
		return { appId, mtimeMs: statSync(paths.config).mtimeMs };
	} catch {
		return { appId: '', mtimeMs: 0 };
	}
}

/**
 * Wait until the service config changes — the signal that the wizard in the
 * other terminal finished. Polls instead of watching for the same behaviour
 * across platforms and network file systems.
 */
export async function waitForSetupCredentials(
	paths: BridgePaths,
	before: SetupSnapshot,
	timeoutMs: number,
): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const now = setupSnapshot(paths);
		if (now.appId && (now.appId !== before.appId || now.mtimeMs > before.mtimeMs)) {
			return now.appId;
		}
		if (Date.now() >= deadline) return undefined;
		await delay(2_000);
	}
}

/**
 * Env for the bridge: the service `.env` wins over the caller's environment,
 * relative paths resolve against the service home, and PI_CWD defaults to the
 * project the command was issued from.
 */
export function buildBridgeEnv(
	paths: BridgePaths,
	cwd: string,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const [key, value] of Object.entries(readConfig(paths))) {
		if (value.trim().length > 0) env[key] = value;
	}
	env.PI_CWD = env.PI_CWD ? path.resolve(paths.home, env.PI_CWD) : path.resolve(cwd);
	env.BRIDGE_DATA_DIR = resolveDataDir(paths);
	env.FEISHU_CONNECTION_MODE = env.FEISHU_CONNECTION_MODE ?? 'websocket';
	return env;
}

export interface StartBridgeOptions {
	/** Directory holding this package (bridge entry point lives there). */
	root: string;
	/** Project directory pi sessions should run in. */
	cwd: string;
	baseEnv?: NodeJS.ProcessEnv;
}

export interface StartedBridge extends BridgeState {
	log: string;
}

export function startBridge(paths: BridgePaths, options: StartBridgeOptions): StartedBridge {
	const running = runningBridge(paths);
	if (running) throw new Error(`pi-lark 已在运行（pid ${running.pid}），先 /lark-stop 再启动`);

	const command = resolveBridgeCommand(options.root);
	if (!command) {
		throw new Error(`找不到桥接器入口，请在 ${options.root} 运行 npm install（或 npm run build）`);
	}

	const env = buildBridgeEnv(paths, options.cwd, options.baseEnv ?? process.env);
	if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
		throw new Error('还没有配置机器人凭据，先运行 /lark-setup');
	}

	mkdirSync(paths.home, { recursive: true });
	mkdirSync(paths.data, { recursive: true });
	const logFd = openSync(paths.log, 'a');
	let child;
	try {
		child = spawn(process.execPath, command, {
			cwd: paths.home,
			env,
			detached: true,
			stdio: ['ignore', logFd, logFd],
			windowsHide: true,
		});
	} finally {
		closeSync(logFd);
	}
	// Spawn failures arrive asynchronously; the pid check below reports them.
	child.on('error', () => undefined);
	if (!child.pid) throw new Error('无法启动 pi-lark 进程');
	child.unref();

	const state: BridgeState = {
		pid: child.pid,
		cwd: path.resolve(options.cwd),
		startedAt: new Date().toISOString(),
		command,
	};
	writeBridgeState(paths.state, state);
	return { ...state, log: paths.log };
}

export interface StopBridgeOptions {
	timeoutMs?: number;
	/** How long to wait after a graceful stop request before force-killing. */
	graceMs?: number;
}

export type BridgeReadyStatus = 'connected' | 'exited' | 'timeout';

/** Fixed file name inside the validated bridge data directory. */
function bridgeFile(paths: BridgePaths, name: string): string {
	const dir = resolveDataDir(paths);
	const file = path.resolve(dir, name);
	const relative = path.relative(dir, file);
	if (relative !== name) throw new Error(`非法的桥接器文件名：${name}`);
	return file;
}

/**
 * Poll the bridge's status file until it reports a live gateway connection.
 * The bridge writes the file once its Feishu/Lark connection is up, which is
 * the readiness signal `/lark-start` reports to the user.
 */
export async function waitForBridgeReady(
	paths: BridgePaths,
	pid: number,
	timeoutMs = 20_000,
): Promise<BridgeReadyStatus> {
	const status = bridgeFile(paths, STATUS_FILE);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!isProcessAlive(pid)) return 'exited';
		try {
			const parsed = JSON.parse(readFileSync(status, 'utf8')) as { pid?: number; connectedAt?: string };
			if (parsed.connectedAt && (!parsed.pid || parsed.pid === pid)) return 'connected';
		} catch {
			// Not written yet: still starting up.
		}
		if (Date.now() >= deadline) return 'timeout';
		await delay(400);
	}
}

export async function stopBridge(paths: BridgePaths, options: StopBridgeOptions = {}): Promise<boolean> {
	const state = readBridgeState(paths.state);
	if (!state) return false;
	if (!isProcessAlive(state.pid)) {
		clearBridgeState(paths.state);
		return false;
	}

	if (process.platform === 'win32') {
		// Ask for a graceful shutdown first: the bridge watches for this file
		// and flushes its sessions itself. Only a process that ignores it (or
		// fails before wiring the watcher) falls through to the hard kill.
		const stopFile = bridgeFile(paths, STOP_FILE);
		try {
			mkdirSync(path.dirname(stopFile), { recursive: true });
			writeFileSync(stopFile, `${Date.now()}\n`, 'utf8');
		} catch {
			// Without the stop file the hard kill below is the only option.
		}
		const graceDeadline = Date.now() + (options.graceMs ?? 8_000);
		while (Date.now() < graceDeadline && isProcessAlive(state.pid)) {
			await delay(150);
		}
		if (!isProcessAlive(state.pid)) {
			clearBridgeState(paths.state);
			return true;
		}
		// Kill the whole tree: the bridge owns one `pi --mode rpc` child per chat.
		spawnSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
	} else {
		try {
			process.kill(-state.pid, 'SIGTERM');
		} catch {
			try {
				process.kill(state.pid, 'SIGTERM');
			} catch {
				// Already gone.
			}
		}
	}

	const deadline = Date.now() + (options.timeoutMs ?? 6_000);
	while (Date.now() < deadline && isProcessAlive(state.pid)) {
		await delay(120);
	}
	if (isProcessAlive(state.pid) && process.platform !== 'win32') {
		try {
			process.kill(state.pid, 'SIGKILL');
		} catch {
			// Already gone.
		}
	}
	clearBridgeState(paths.state);
	return true;
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Last `lines` non-empty log lines (log files grow forever). */
export function tailLog(file: string, lines = 40): string {
	const text = readText(file);
	if (text.length === 0) return '';
	const capped = text.length > 160_000 ? text.slice(-160_000) : text;
	const all = capped.split(/\r?\n/).filter((line) => line.trim().length > 0);
	return all.slice(-Math.max(1, lines)).join('\n');
}
