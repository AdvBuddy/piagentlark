import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
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
export function resolvePaths(home) {
    const base = path.resolve(home ?? process.env.PI_LARK_HOME ?? path.join(os.homedir(), '.pi', 'lark'));
    return {
        home: base,
        config: path.join(base, '.env'),
        log: path.join(base, 'bridge.log'),
        state: path.join(base, 'bridge.json'),
        data: path.join(base, 'data'),
    };
}
function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return '';
    }
}
export function readBridgeState(file) {
    const text = readText(file);
    if (text.length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0)
            return undefined;
        return {
            pid: parsed.pid,
            cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
            startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
            command: Array.isArray(parsed.command) ? parsed.command.filter((part) => typeof part === 'string') : [],
        };
    }
    catch {
        return undefined;
    }
}
export function writeBridgeState(file, state) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
export function clearBridgeState(file) {
    try {
        rmSync(file, { force: true });
    }
    catch {
        // Best effort: a stale state file only costs one failed liveness check.
    }
}
/** Running state with a live pid, or undefined. */
export function runningBridge(paths) {
    const state = readBridgeState(paths.state);
    if (!state)
        return undefined;
    if (isProcessAlive(state.pid))
        return state;
    clearBridgeState(paths.state);
    return undefined;
}
export function readConfig(paths) {
    return parseEnvText(readText(paths.config));
}
/** The data directory the running bridge uses (status/stop files, sessions). */
export function resolveDataDir(paths) {
    const configured = readConfig(paths).BRIDGE_DATA_DIR?.trim();
    if (!configured)
        return paths.data;
    const resolved = path.resolve(paths.home, configured);
    // Relative values must stay inside the service home; an absolute path is
    // an explicit operator choice and may point anywhere.
    if (!path.isAbsolute(configured)) {
        const relative = path.relative(paths.home, resolved);
        const within = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        if (!within)
            throw new Error(`BRIDGE_DATA_DIR 不能指向服务主目录之外：${configured}`);
    }
    return resolved;
}
export function saveConfig(paths, updates) {
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.config, mergeEnvText(readText(paths.config), updates), 'utf8');
}
/** `[script, ...args]` to run with `process.execPath`, preferring the source. */
export function resolveBridgeCommand(root) {
    // Source first: a local checkout may be newer than `dist/`. Published
    // installs ship the build and no dev dependencies, hence the fallback.
    // The tsx loader is registered with `--import` instead of running the
    // `tsx` CLI: the CLI spawns the entry in yet another node process, and a
    // detached bridge has no console, so that grandchild would create its own
    // visible console window on Windows.
    const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const entry = path.join(root, 'src', 'index.ts');
    if (existsSync(loader) && existsSync(entry))
        return ['--import', pathToFileURL(loader).href, entry];
    const built = path.join(root, 'dist', 'src', 'index.js');
    if (existsSync(built))
        return [built];
    return undefined;
}
/**
 * Env for the bridge: the service `.env` wins over the caller's environment,
 * relative paths resolve against the service home, and PI_CWD defaults to the
 * project the command was issued from.
 */
export function buildBridgeEnv(paths, cwd, base = process.env) {
    const env = { ...base };
    for (const [key, value] of Object.entries(readConfig(paths))) {
        if (value.trim().length > 0)
            env[key] = value;
    }
    env.PI_CWD = env.PI_CWD ? path.resolve(paths.home, env.PI_CWD) : path.resolve(cwd);
    env.BRIDGE_DATA_DIR = resolveDataDir(paths);
    env.FEISHU_CONNECTION_MODE = env.FEISHU_CONNECTION_MODE ?? 'websocket';
    return env;
}
export function startBridge(paths, options) {
    const running = runningBridge(paths);
    if (running)
        throw new Error(`pi-lark 已在运行（pid ${running.pid}），先 /lark-stop 再启动`);
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
    }
    finally {
        closeSync(logFd);
    }
    // Spawn failures arrive asynchronously; the pid check below reports them.
    child.on('error', () => undefined);
    if (!child.pid)
        throw new Error('无法启动 pi-lark 进程');
    child.unref();
    const state = {
        pid: child.pid,
        cwd: path.resolve(options.cwd),
        startedAt: new Date().toISOString(),
        command,
    };
    writeBridgeState(paths.state, state);
    return { ...state, log: paths.log };
}
/** Fixed file name inside the validated bridge data directory. */
function bridgeFile(paths, name) {
    const dir = resolveDataDir(paths);
    const file = path.resolve(dir, name);
    const relative = path.relative(dir, file);
    if (relative !== name)
        throw new Error(`非法的桥接器文件名：${name}`);
    return file;
}
/**
 * Poll the bridge's status file until it reports a live gateway connection.
 * The bridge writes the file once its Feishu/Lark connection is up, which is
 * the readiness signal `/lark-start` reports to the user.
 */
export async function waitForBridgeReady(paths, pid, timeoutMs = 20_000) {
    const status = bridgeFile(paths, STATUS_FILE);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (!isProcessAlive(pid))
            return 'exited';
        try {
            const parsed = JSON.parse(readFileSync(status, 'utf8'));
            if (parsed.connectedAt && (!parsed.pid || parsed.pid === pid))
                return 'connected';
        }
        catch {
            // Not written yet: still starting up.
        }
        if (Date.now() >= deadline)
            return 'timeout';
        await delay(400);
    }
}
export async function stopBridge(paths, options = {}) {
    const state = readBridgeState(paths.state);
    if (!state)
        return false;
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
        }
        catch {
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
    }
    else {
        try {
            process.kill(-state.pid, 'SIGTERM');
        }
        catch {
            try {
                process.kill(state.pid, 'SIGTERM');
            }
            catch {
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
        }
        catch {
            // Already gone.
        }
    }
    clearBridgeState(paths.state);
    return true;
}
export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Last `lines` non-empty log lines (log files grow forever). */
export function tailLog(file, lines = 40) {
    const text = readText(file);
    if (text.length === 0)
        return '';
    const capped = text.length > 160_000 ? text.slice(-160_000) : text;
    const all = capped.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return all.slice(-Math.max(1, lines)).join('\n');
}
