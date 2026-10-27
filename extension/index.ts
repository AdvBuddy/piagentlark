import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readConfig,
	resolvePaths,
	runningBridge,
	saveConfig,
	startBridge,
	stopBridge,
	tailLog,
	waitForBridgeReady,
} from '../src/plugin/service.js';
import type { BridgePaths } from '../src/plugin/service.js';
import {
	RegistrationError,
	registrationEnv,
	requestAppRegistration,
} from '../src/setup/registration.js';
import type { RegistrationResult } from '../src/setup/registration.js';
import type { ExtensionAPI, ExtensionCommandContext } from './pi.js';
import { LinkOverlay, linkOverlayWidth } from './link.js';

/** Repo root: the package that ships `dist/` and `node_modules/`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATUS_KEY = 'lark';
const CONFIG_KEYS: readonly string[] = [
	'FEISHU_APP_ID',
	'FEISHU_APP_SECRET',
	'FEISHU_DOMAIN',
	'FEISHU_GROUP_POLICY',
	'FEISHU_REQUIRE_MENTION',
	'FEISHU_ALLOWED_USERS',
	'FEISHU_HOME_CHANNEL',
	'PI_CWD',
	'PI_MODEL',
	'PI_THINKING',
	'BRIDGE_DATA_DIR',
];
const SUBCOMMANDS: readonly { value: string; label: string }[] = [
	{ value: 'setup', label: 'setup — 打开链接创建 / 更新机器人' },
	{ value: 'start', label: 'start — 后台启动并连接飞书' },
	{ value: 'stop', label: 'stop — 停止后台桥接器' },
	{ value: 'restart', label: 'restart — 重启桥接器' },
	{ value: 'logs', label: 'logs — 查看最近日志' },
	{ value: 'config', label: 'config — 修改配置项' },
];

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mask(value: string | undefined): string {
	if (!value) return '(空)';
	return value.length <= 8 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function summary(paths: BridgePaths): string {
	const config = readConfig(paths);
	const state = runningBridge(paths);
	const app = config.FEISHU_APP_ID
		? `${config.FEISHU_APP_ID}（${config.FEISHU_DOMAIN ?? 'feishu'}）`
		: '未配置，运行 /lark-setup 打开链接创建';
	const status = state ? `运行中 pid=${state.pid}，目录 ${state.cwd}` : '未运行';
	return [
		`应用：${app}`,
		`状态：${status}`,
		`配置：${paths.config}`,
		`日志：${paths.log}`,
		`命令：/lark-setup · /lark-start · /lark-stop · /lark-restart · /lark-logs · /lark-config`,
	].join('\n');
}

function refreshStatus(ctx: ExtensionCommandContext, paths: BridgePaths): void {
	const state = runningBridge(paths);
	ctx.ui.setStatus(STATUS_KEY, state ? `lark ● ${state.pid}` : undefined);
}

async function startService(ctx: ExtensionCommandContext, paths: BridgePaths): Promise<void> {
	const running = runningBridge(paths);
	if (running) {
		ctx.ui.notify(`pi-lark 已在运行（pid ${running.pid}，目录 ${running.cwd}）`, 'warning');
		return;
	}
	let started;
	try {
		started = startBridge(paths, { root: PACKAGE_ROOT, cwd: ctx.cwd });
	} catch (error) {
		ctx.ui.notify(describe(error), 'error');
		return;
	}
	refreshStatus(ctx, paths);
	ctx.ui.notify(`已启动 pi-lark（pid ${started.pid}，目录 ${started.cwd}），正在连接飞书…`, 'info');

	// The bridge reports readiness through its status file; no log-text
	// matching and no fixed sleep.
	const result = await waitForBridgeReady(paths, started.pid, 20_000);
	refreshStatus(ctx, paths);
	if (result === 'connected') {
		ctx.ui.notify('已连接飞书，给机器人发条消息试试', 'info');
		return;
	}
	if (result === 'exited') {
		ctx.ui.notify(`启动失败，最后几行日志：\n${tailLog(paths.log, 10)}`, 'error');
		return;
	}
	ctx.ui.notify('启动较慢，尚未看到连接成功；稍后可用 /lark-logs 查看日志。', 'warning');
}

async function stopService(ctx: ExtensionCommandContext, paths: BridgePaths): Promise<void> {
	const stopped = await stopBridge(paths);
	refreshStatus(ctx, paths);
	ctx.ui.notify(stopped ? 'pi-lark 已停止' : 'pi-lark 未在运行', 'info');
}

async function showLogs(ctx: ExtensionCommandContext, paths: BridgePaths): Promise<void> {
	const text = tailLog(paths.log, 150);
	if (text.length === 0) {
		ctx.ui.notify('还没有日志，先运行 /lark-start', 'warning');
		return;
	}
	if (ctx.hasUI) await ctx.ui.editor('pi-lark 日志（最近 150 行）', text);
	else ctx.ui.notify(text, 'info');
}

async function editConfig(ctx: ExtensionCommandContext, paths: BridgePaths): Promise<void> {
	const config = readConfig(paths);
	const items = CONFIG_KEYS.map((key) => `${key} = ${key.includes('SECRET') ? mask(config[key]) : (config[key] ?? '(空)')}`);
	const chosen = await ctx.ui.select('选择要修改的配置项', items);
	if (!chosen) return;
	const key = chosen.split(' = ')[0] ?? '';
	if (key.length === 0) return;
	const value = await ctx.ui.input(key, '输入新值（留空保持不变）');
	if (value === undefined || value.trim().length === 0) {
		ctx.ui.notify('未修改', 'info');
		return;
	}
	saveConfig(paths, { [key]: value.trim() });
	ctx.ui.notify(`已更新 ${key}`, 'info');
	if (runningBridge(paths) && (await ctx.ui.confirm('重启', '配置已保存，现在重启桥接器使其生效？'))) {
		await stopBridge(paths);
		await startService(ctx, paths);
	}
}

async function runSetup(ctx: ExtensionCommandContext, paths: BridgePaths): Promise<void> {
	const config = readConfig(paths);
	let createOnly = true;
	let appId: string | undefined;
	if (config.FEISHU_APP_ID) {
		const choice = await ctx.ui.select('已经配置过应用', [
			`更新权限 / 事件：${config.FEISHU_APP_ID}`,
			'新建应用（覆盖当前凭据）',
			'取消',
		]);
		if (!choice || choice === '取消') return;
		createOnly = choice.startsWith('新建');
		appId = createOnly ? undefined : config.FEISHU_APP_ID;
	}

	const controller = new AbortController();
	let overlay: LinkOverlay | undefined;
	let tui: { requestRender(force?: boolean): void } | undefined;
	let closed: Promise<void> | undefined;
	if (ctx.mode === 'tui') {
		closed = ctx.ui.custom<void>(
			(tuiRef, theme, _keybindings, done) => {
				tui = tuiRef;
				overlay = new LinkOverlay(theme, done, () => controller.abort());
				return overlay;
			},
			{
				overlay: true,
				// pi caps overlays at 80 columns by default; the card asks for a bit
				// more so a long URL wraps in fewer rows.
				overlayOptions: { width: linkOverlayWidth(), margin: 1 },
			},
		);
	}

	let result: RegistrationResult;
	try {
		result = await requestAppRegistration({
			domain: config.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu',
			createOnly,
			appId,
			signal: controller.signal,
			onUrl: (url) => {
				if (overlay) {
					overlay.setUrl(url);
					tui?.requestRender();
				} else {
					ctx.ui.notify(`打开链接完成授权：${url}`, 'info');
				}
			},
			onStatus: (status) => {
				if (status !== 'slow_down' || !overlay) return;
				overlay.setStatus('仍在等待确认（平台要求降低轮询频率）…');
				tui?.requestRender();
			},
		});
	} catch (error) {
		const failure =
			error instanceof RegistrationError ? error : new RegistrationError(undefined, describe(error));
		overlay?.finish();
		if (closed) await closed;
		if (failure.code === 'abort') ctx.ui.notify('已取消配置', 'info');
		else ctx.ui.notify(`配置失败：${failure.message}${failure.hint ? `\n${failure.hint}` : ''}`, 'error');
		return;
	}

	overlay?.finish();
	if (closed) await closed;
	saveConfig(paths, registrationEnv(result));
	ctx.ui.notify(`已保存 ${result.appId}（${result.domain}）→ ${paths.config}`, 'info');
	if (!runningBridge(paths) && (await ctx.ui.confirm('启动', '现在启动 pi-lark 并连接飞书？'))) {
		await startService(ctx, paths);
	}
}

export default function larkPlugin(pi: ExtensionAPI): void {
	const paths = resolvePaths();
	const restart = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (runningBridge(paths)) await stopBridge(paths);
		await startService(ctx, paths);
	};

	pi.on('session_start', (_event, ctx) => {
		refreshStatus(ctx, paths);
	});

	pi.registerCommand('lark', {
		description: 'pi-lark：查看状态，或 /lark setup|start|stop|restart|logs|config',
		getArgumentCompletions: (prefix) => {
			const wanted = prefix.trim().toLowerCase();
			const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(wanted));
			return matches.length > 0 ? matches.map((item) => ({ ...item })) : null;
		},
		handler: async (args, ctx) => {
			const sub = (args.trim().split(/\s+/)[0] ?? '').toLowerCase();
			switch (sub) {
				case 'setup':
					return runSetup(ctx, paths);
				case 'start':
					return startService(ctx, paths);
				case 'stop':
					return stopService(ctx, paths);
				case 'restart':
					return restart(ctx);
				case 'logs':
					return showLogs(ctx, paths);
				case 'config':
					return editConfig(ctx, paths);
				default:
					refreshStatus(ctx, paths);
					ctx.ui.notify(summary(paths), 'info');
			}
		},
	});

	pi.registerCommand('lark-setup', {
		description: '打开链接创建或更新飞书机器人，并写入本地配置',
		handler: async (_args, ctx) => runSetup(ctx, paths),
	});
	pi.registerCommand('lark-start', {
		description: '后台启动 pi-lark 并连接飞书（使用当前目录作为 pi 工作目录）',
		handler: async (_args, ctx) => startService(ctx, paths),
	});
	pi.registerCommand('lark-stop', {
		description: '停止后台运行的 pi-lark',
		handler: async (_args, ctx) => stopService(ctx, paths),
	});
	pi.registerCommand('lark-restart', {
		description: '重启 pi-lark',
		handler: async (_args, ctx) => restart(ctx),
	});
	pi.registerCommand('lark-logs', {
		description: '查看 pi-lark 最近日志',
		handler: async (_args, ctx) => showLogs(ctx, paths),
	});
	pi.registerCommand('lark-config', {
		description: '修改 pi-lark 配置（凭据、群策略、pi 工作目录等）',
		handler: async (_args, ctx) => editConfig(ctx, paths),
	});
}
