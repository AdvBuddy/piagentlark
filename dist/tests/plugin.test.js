import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import larkPlugin from '../extension/index.js';
import { buildBridgeEnv, clearBridgeState, readBridgeState, readConfig, resolveBridgeCommand, resolveDataDir, resolvePaths, runningBridge, saveConfig, startBridge, tailLog, uninstallBridge, waitForBridgeReady, writeBridgeState, } from '../src/plugin/service.js';
const homes = [];
function tempPaths() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-'));
    homes.push(home);
    return resolvePaths(home);
}
after(() => {
    for (const home of homes)
        rmSync(home, { recursive: true, force: true });
});
/** A pid that has already exited, so liveness checks report false. */
async function deadPid() {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.on('exit', () => resolve()));
    return pid;
}
describe('resolvePaths', () => {
    it('derives every file from one home directory', () => {
        const paths = resolvePaths(path.join(os.tmpdir(), 'pi-lark-home'));
        assert.equal(path.basename(paths.config), '.env');
        assert.equal(path.basename(paths.log), 'bridge.log');
        assert.equal(path.basename(paths.state), 'bridge.json');
        assert.equal(paths.data, path.join(paths.home, 'data'));
    });
    it('honours PI_LARK_HOME', () => {
        const previous = process.env.PI_LARK_HOME;
        process.env.PI_LARK_HOME = path.join(os.tmpdir(), 'pi-lark-env');
        try {
            assert.equal(resolvePaths().home, path.resolve(path.join(os.tmpdir(), 'pi-lark-env')));
        }
        finally {
            if (previous === undefined)
                delete process.env.PI_LARK_HOME;
            else
                process.env.PI_LARK_HOME = previous;
        }
    });
});
describe('config file', () => {
    it('round-trips values and keeps what it did not touch', () => {
        const paths = tempPaths();
        assert.deepEqual(readConfig(paths), {});
        saveConfig(paths, { FEISHU_APP_ID: 'cli_1', FEISHU_APP_SECRET: 's3cret' });
        saveConfig(paths, { FEISHU_APP_ID: 'cli_2' });
        assert.deepEqual(readConfig(paths), { FEISHU_APP_ID: 'cli_2', FEISHU_APP_SECRET: 's3cret' });
        assert.ok(existsSync(paths.home));
    });
});
describe('buildBridgeEnv', () => {
    it('layers the service config over the caller environment', () => {
        const paths = tempPaths();
        saveConfig(paths, { FEISHU_APP_ID: 'cli_1', FEISHU_APP_SECRET: 's', FEISHU_APP_SECRET_ALT: '' });
        const env = buildBridgeEnv(paths, 'C:\\work\\proj', {
            FEISHU_APP_ID: 'from-shell',
            FEISHU_APP_SECRET_ALT: 'kept',
            LOG_LEVEL: 'debug',
        });
        assert.equal(env.FEISHU_APP_ID, 'cli_1');
        assert.equal(env.FEISHU_APP_SECRET, 's');
        // Blank values never shadow the caller environment.
        assert.equal(env.FEISHU_APP_SECRET_ALT, 'kept');
        assert.equal(env.LOG_LEVEL, 'debug');
    });
    it('defaults PI_CWD, BRIDGE_DATA_DIR and the connection mode', () => {
        const paths = tempPaths();
        const env = buildBridgeEnv(paths, 'C:\\work\\proj', {});
        assert.equal(env.PI_CWD, path.resolve('C:\\work\\proj'));
        assert.equal(env.BRIDGE_DATA_DIR, paths.data);
        assert.equal(env.FEISHU_CONNECTION_MODE, 'websocket');
    });
    it('resolves relative paths against the service home', () => {
        const paths = tempPaths();
        saveConfig(paths, { PI_CWD: 'sessions', BRIDGE_DATA_DIR: 'state' });
        const env = buildBridgeEnv(paths, 'C:\\work\\proj', {});
        assert.equal(env.PI_CWD, path.resolve(paths.home, 'sessions'));
        assert.equal(env.BRIDGE_DATA_DIR, path.resolve(paths.home, 'state'));
    });
});
describe('bridge state', () => {
    it('round-trips through the state file', () => {
        const paths = tempPaths();
        writeBridgeState(paths.state, {
            pid: 4321,
            cwd: 'C:\\work\\proj',
            startedAt: '2026-01-01T00:00:00.000Z',
            command: ['dist/src/index.js'],
        });
        const state = readBridgeState(paths.state);
        assert.equal(state?.pid, 4321);
        assert.deepEqual(state?.command, ['dist/src/index.js']);
    });
    it('ignores a corrupt state file', () => {
        const paths = tempPaths();
        writeFileSync(paths.state, '{not json');
        assert.equal(readBridgeState(paths.state), undefined);
        assert.equal(runningBridge(paths), undefined);
    });
    it('drops state whose process is gone', async () => {
        const paths = tempPaths();
        writeBridgeState(paths.state, {
            pid: await deadPid(),
            cwd: '',
            startedAt: '',
            command: [],
        });
        assert.equal(runningBridge(paths), undefined);
        assert.equal(existsSync(paths.state), false);
    });
    it('keeps state while the process lives', () => {
        const paths = tempPaths();
        writeBridgeState(paths.state, {
            pid: process.pid,
            cwd: '',
            startedAt: '',
            command: [],
        });
        assert.equal(runningBridge(paths)?.pid, process.pid);
        clearBridgeState(paths.state);
        assert.equal(existsSync(paths.state), false);
    });
});
describe('resolveBridgeCommand', () => {
    it('prefers a single-process tsx boot and falls back to the build', () => {
        const command = resolveBridgeCommand(process.cwd());
        assert.ok(command);
        // node --import <loader URL> <entry>: no tsx CLI middleman process.
        assert.equal(command.length, 3);
        assert.equal(command[0], '--import');
        assert.ok(existsSync(fileURLToPath(command[1])));
        assert.equal(command[2], path.join(process.cwd(), 'src', 'index.ts'));
    });
    it('returns undefined when nothing is installed', () => {
        assert.equal(resolveBridgeCommand(tempPaths().home), undefined);
    });
});
describe('resolveDataDir', () => {
    it('defaults to the service data dir', () => {
        const paths = tempPaths();
        assert.equal(resolveDataDir(paths), paths.data);
    });
    it('resolves a relative value inside the service home', () => {
        const paths = tempPaths();
        saveConfig(paths, { BRIDGE_DATA_DIR: 'alt-data' });
        assert.equal(resolveDataDir(paths), path.resolve(paths.home, 'alt-data'));
    });
    it('allows an absolute path anywhere', () => {
        const paths = tempPaths();
        const elsewhere = path.join(os.tmpdir(), 'pi-lark-elsewhere');
        saveConfig(paths, { BRIDGE_DATA_DIR: elsewhere });
        assert.equal(resolveDataDir(paths), elsewhere);
    });
    it('rejects a relative value escaping the service home', () => {
        const paths = tempPaths();
        saveConfig(paths, { BRIDGE_DATA_DIR: path.join('..', 'escape') });
        assert.throws(() => resolveDataDir(paths), /主目录之外/);
    });
});
describe('waitForBridgeReady', () => {
    it('reports connected once the status file names a live gateway', async () => {
        const paths = tempPaths();
        mkdirSync(paths.data, { recursive: true });
        writeFileSync(path.join(paths.data, 'bridge-status.json'), `${JSON.stringify({ pid: process.pid, connectedAt: new Date().toISOString() })}\n`, 'utf8');
        assert.equal(await waitForBridgeReady(paths, process.pid, 1_000), 'connected');
    });
    it('reports exited for a dead pid', async () => {
        assert.equal(await waitForBridgeReady(tempPaths(), await deadPid(), 100), 'exited');
    });
    it('times out when no status file appears', async () => {
        assert.equal(await waitForBridgeReady(tempPaths(), process.pid, 50), 'timeout');
    });
});
describe('uninstallBridge', () => {
    it('stops nothing and removes the whole service home', async () => {
        const paths = tempPaths();
        saveConfig(paths, { FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 's' });
        writeFileSync(paths.log, 'log\n', 'utf8');
        mkdirSync(paths.data, { recursive: true });
        writeFileSync(path.join(paths.data, 'sessions.json'), '{}\n', 'utf8');
        const result = await uninstallBridge(paths);
        assert.equal(result.stopped, false);
        assert.deepEqual(result.removed, [paths.home]);
        assert.equal(existsSync(paths.home), false);
        assert.equal(existsSync(paths.config), false);
    });
    it('refuses targets that are too broad to be a service home', async () => {
        await assert.rejects(uninstallBridge(resolvePaths(os.homedir())), /拒绝删除/);
        await assert.rejects(uninstallBridge(resolvePaths(process.cwd())), /拒绝删除/);
    });
});
describe('startBridge', () => {
    it('refuses to start without credentials', () => {
        const paths = tempPaths();
        assert.throws(() => startBridge(paths, { root: process.cwd(), cwd: process.cwd() }), /先运行 \/lark-setup/);
        assert.equal(existsSync(paths.state), false);
    });
    it('refuses to start when the bridge entry is missing', () => {
        const paths = tempPaths();
        saveConfig(paths, { FEISHU_APP_ID: 'cli_1', FEISHU_APP_SECRET: 's' });
        assert.throws(() => startBridge(paths, { root: paths.home, cwd: process.cwd() }), /找不到桥接器入口/);
    });
});
describe('tailLog', () => {
    it('returns the newest lines and ignores blanks', () => {
        const paths = tempPaths();
        assert.equal(tailLog(paths.log), '');
        writeFileSync(paths.log, 'one\n\ntwo\nthree\n');
        assert.equal(tailLog(paths.log, 2), 'two\nthree');
        assert.equal(tailLog(paths.log), 'one\ntwo\nthree');
    });
    it('handles a missing file', () => {
        assert.equal(tailLog(path.join(tempPaths().home, 'nope.log')), '');
    });
});
function fakeApi() {
    const commands = new Map();
    const events = new Map();
    const api = {
        registerCommand: (name, options) => {
            commands.set(name, options);
        },
        on: (event, handler) => {
            events.set(event, handler);
            return () => events.delete(event);
        },
    };
    return { api, commands, events };
}
function fakeContext() {
    const notifications = [];
    const statuses = [];
    const ctx = {
        cwd: process.cwd(),
        mode: 'tui',
        hasUI: true,
        ui: {
            notify: (message, type) => {
                notifications.push({ message, type });
            },
            select: async () => undefined,
            confirm: async () => false,
            input: async () => undefined,
            editor: async () => undefined,
            setStatus: (key, text) => {
                statuses.push({ key, text });
            },
            custom: async () => undefined,
        },
    };
    return { ctx, notifications, statuses };
}
describe('lark extension', () => {
    it('registers the slash commands and the session hook', () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-ext-'));
        homes.push(home);
        process.env.PI_LARK_HOME = home;
        const { api, commands, events } = fakeApi();
        larkPlugin(api);
        assert.deepEqual([...commands.keys()].sort(), [
            'lark',
            'lark-config',
            'lark-logs',
            'lark-restart',
            'lark-setup',
            'lark-start',
            'lark-stop',
            'lark-uninstall',
        ]);
        for (const command of commands.values())
            assert.ok(command.description);
        assert.ok(events.has('session_start'));
    });
    it('/lark completes its subcommands', () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-ext-'));
        homes.push(home);
        process.env.PI_LARK_HOME = home;
        const { api, commands } = fakeApi();
        larkPlugin(api);
        const complete = commands.get('lark')?.getArgumentCompletions;
        assert.ok(complete);
        const values = (prefix) => (complete(prefix) ?? []).map((item) => item.value);
        assert.deepEqual(values(''), ['setup', 'start', 'stop', 'restart', 'logs', 'config', 'uninstall']);
        assert.deepEqual(values(' s'), ['setup', 'start', 'stop']);
        assert.deepEqual(values('un'), ['uninstall']);
        assert.equal(complete('zz'), null);
    });
    it('/lark reports the summary and the status bar', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-ext-'));
        homes.push(home);
        process.env.PI_LARK_HOME = home;
        const { api, commands, events } = fakeApi();
        larkPlugin(api);
        const { ctx, notifications, statuses } = fakeContext();
        await commands.get('lark')?.handler('', ctx);
        assert.equal(notifications.length, 1);
        assert.match(notifications[0]?.message ?? '', /未配置/);
        assert.match(notifications[0]?.message ?? '', /未运行/);
        assert.deepEqual(statuses.at(-1), { key: 'lark', text: undefined });
        await events.get('session_start')?.({}, ctx);
        assert.equal(statuses.at(-1)?.key, 'lark');
    });
    it('/lark-start explains what is missing instead of spawning', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-ext-'));
        homes.push(home);
        process.env.PI_LARK_HOME = home;
        const { api, commands } = fakeApi();
        larkPlugin(api);
        const { ctx, notifications } = fakeContext();
        await commands.get('lark')?.handler('start', ctx);
        assert.equal(notifications[0]?.type, 'error');
        assert.match(notifications[0]?.message ?? '', /\/lark-setup/);
        assert.equal(existsSync(resolvePaths(home).state), false);
    });
    it('/lark-logs warns when the log is empty', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-ext-'));
        homes.push(home);
        process.env.PI_LARK_HOME = home;
        const { api, commands } = fakeApi();
        larkPlugin(api);
        const { ctx, notifications } = fakeContext();
        await commands.get('lark-logs')?.handler('', ctx);
        assert.equal(notifications[0]?.type, 'warning');
        assert.match(notifications[0]?.message ?? '', /\/lark-start/);
    });
});
