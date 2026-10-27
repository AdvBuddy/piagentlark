import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import larkPlugin from '../extension/index.js';
import type { ExtensionAPI, ExtensionCommandContext } from '../extension/pi.js';
import {
	buildBridgeEnv,
	clearBridgeState,
	readBridgeState,
	readConfig,
	resolveBridgeCommand,
	resolveDataDir,
	resolvePaths,
	resolveSetupCommand,
	runningBridge,
	saveConfig,
	setupSnapshot,
	startBridge,
	tailLog,
	waitForBridgeReady,
	waitForSetupCredentials,
	writeBridgeState,
	writeSetupScripts,
} from '../src/plugin/service.js';
import type { BridgePaths } from '../src/plugin/service.js';

const homes: string[] = [];

function tempPaths(): BridgePaths {
	const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-'));
	homes.push(home);
	return resolvePaths(home);
}

after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** A pid that has already exited, so liveness checks report false. */
async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
	const pid = child.pid ?? 0;
	await new Promise<void>((resolve) => child.on('exit', () => resolve()));
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
		} finally {
			if (previous === undefined) delete process.env.PI_LARK_HOME;
			else process.env.PI_LARK_HOME = previous;
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
		assert.ok(existsSync(fileURLToPath(command[1]!)));
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
		writeFileSync(
			path.join(paths.data, 'bridge-status.json'),
			`${JSON.stringify({ pid: process.pid, connectedAt: new Date().toISOString() })}\n`,
			'utf8',
		);
		assert.equal(await waitForBridgeReady(paths, process.pid, 1_000), 'connected');
	});

	it('reports exited for a dead pid', async () => {
		assert.equal(await waitForBridgeReady(tempPaths(), await deadPid(), 100), 'exited');
	});

	it('times out when no status file appears', async () => {
		assert.equal(await waitForBridgeReady(tempPaths(), process.pid, 50), 'timeout');
	});
});

	describe('resolveSetupCommand', () => {
		it('points the wizard at the tsx loader entry', () => {
			const command = resolveSetupCommand(process.cwd());
			assert.ok(command);
			assert.equal(command[0], '--import');
			assert.ok(existsSync(fileURLToPath(command[1]!)));
			assert.equal(command[2], path.join(process.cwd(), 'src', 'setup.ts'));
		});
	});

	describe('writeSetupScripts and waitForSetupCredentials', () => {
		it('writes launcher scripts aimed at the service config', () => {
			const paths = tempPaths();
			const plan = writeSetupScripts(paths, process.cwd(), ['--app-id', 'cli_x']);
			assert.ok(existsSync(plan.scriptCmd));
			assert.ok(existsSync(plan.scriptSh));
			const batch = readFileSync(plan.scriptCmd, 'utf8');
			// The script starts in the service home so the wizard's plain ./.env
			// write lands on the service config.
			assert.match(batch, new RegExp(`cd /d "${paths.home.replace(/\\/g, '\\\\')}"`));
			assert.match(batch, /setup\.(ts|js)" "--"/);
			assert.match(batch, /"--no-start"/);
			assert.match(batch, /"--app-id" "cli_x"/);
			assert.match(plan.manualCommand, /setup\.(cmd|sh)/);
		});

		it('resolves once credentials appear and tolerates timeouts', async () => {
			const paths = tempPaths();
			const before = setupSnapshot(paths);
			// Nothing appears: the short wait times out.
			assert.equal(await waitForSetupCredentials(paths, before, 10), undefined);
			// The wizard writes credentials while we wait.
			const late = tempPaths();
			const start = setupSnapshot(late);
			setTimeout(() => saveConfig(late, { FEISHU_APP_ID: 'cli_new', FEISHU_APP_SECRET: 's' }), 30);
			assert.equal(await waitForSetupCredentials(late, start, 5_000), 'cli_new');
			// Updating the same app id is detected through the mtime.
			const again = setupSnapshot(late);
			setTimeout(() => saveConfig(late, { FEISHU_APP_NAME: 'x' }), 30);
			assert.equal(await waitForSetupCredentials(late, again, 5_000), 'cli_new');
		});
	});

	describe('startBridge', () => {
	it('refuses to start without credentials', () => {
		const paths = tempPaths();
		assert.throws(
			() => startBridge(paths, { root: process.cwd(), cwd: process.cwd() }),
			/先运行 \/lark-setup/,
		);
		assert.equal(existsSync(paths.state), false);
	});

	it('refuses to start when the bridge entry is missing', () => {
		const paths = tempPaths();
		saveConfig(paths, { FEISHU_APP_ID: 'cli_1', FEISHU_APP_SECRET: 's' });
		assert.throws(
			() => startBridge(paths, { root: paths.home, cwd: process.cwd() }),
			/找不到桥接器入口/,
		);
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

interface FakeCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakeApi(): { api: ExtensionAPI; commands: Map<string, FakeCommand>; events: Map<string, Function> } {
	const commands = new Map<string, FakeCommand>();
	const events = new Map<string, Function>();
	const api = {
		registerCommand: (name: string, options: FakeCommand) => {
			commands.set(name, options);
		},
		on: (event: string, handler: Function) => {
			events.set(event, handler);
			return () => events.delete(event);
		},
	} as unknown as ExtensionAPI;
	return { api, commands, events };
}

interface FakeCtx {
	ctx: ExtensionCommandContext;
	notifications: { message: string; type?: string }[];
	statuses: { key: string; text: string | undefined }[];
}

function fakeContext(): FakeCtx {
	const notifications: FakeCtx['notifications'] = [];
	const statuses: FakeCtx['statuses'] = [];
	const ctx = {
		cwd: process.cwd(),
		mode: 'tui',
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push({ message, type });
			},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			custom: async () => undefined,
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, statuses };
}

describe('lark extension', () => {
	it('registers the slash commands and the session hook', () => {
		const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-ext-'));
		homes.push(home);
		process.env.PI_LARK_HOME = home;
		const { api, commands, events } = fakeApi();
		larkPlugin(api);
		assert.deepEqual(
			[...commands.keys()].sort(),
			['lark', 'lark-config', 'lark-logs', 'lark-restart', 'lark-setup', 'lark-start', 'lark-stop'],
		);
		for (const command of commands.values()) assert.ok(command.description);
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
		const values = (prefix: string) => (complete(prefix) ?? []).map((item) => item.value);
		assert.deepEqual(values(''), ['setup', 'start', 'stop', 'restart', 'logs', 'config']);
		assert.deepEqual(values(' s'), ['setup', 'start', 'stop']);
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
