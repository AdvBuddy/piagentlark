import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { PiLarkBridge } from './bridge/bridge.js';
import { cleanupInbox } from './bridge/attachments.js';
import { describeConfig, loadConfig, type Config } from './config.js';
import { createGateway } from './lark/gateway.js';
import { startWebhookServer } from './lark/webhook.js';
import { Logger } from './logger.js';
import { AgentPool, SessionStore } from './pi/agentPool.js';
import { loadDotEnv } from './util/dotenv.js';
import { acquireInstanceLock, type InstanceLock } from './util/pid.js';
import { isRemoteSession } from './util/system.js';

/** Written once the gateway is connected; the extension polls it for readiness. */
const STATUS_FILE = 'bridge-status.json';
/** Created by `stopBridge` on Windows; the bridge shuts down gracefully when it appears. */
const STOP_FILE = 'bridge.stop';

function statusFile(config: Config): string {
	return path.join(config.dataDir, STATUS_FILE);
}

function stopFile(config: Config): string {
	return path.join(config.dataDir, STOP_FILE);
}

/**
 * One lock per app id under the service home, so the CLI (`npm start`) and the
 * extension (`/lark-start`) can never run a second instance for the same bot.
 */
function lockFile(config: Config): string {
	const home = process.env.PI_LARK_HOME ?? path.join(os.homedir(), '.pi', 'lark');
	return path.join(home, 'locks', `bridge-${config.lark.appId}.lock`);
}

async function main(): Promise<void> {
	loadDotEnv();
	const config = loadConfig();
	const logger = new Logger('bridge', config.logLevel);

	logger.info('pi-lark bridge 启动中');
	logger.info(describeConfig(config));
	if (config.lark.connectionMode === 'webhook' && isRemoteSession()) {
		logger.warn(
			'SSH 远程会话下 webhook 模式监听本机回环地址，飞书服务器无法回调；建议改用 FEISHU_CONNECTION_MODE=websocket，或为回调端口配置反向代理/端口转发',
		);
	}

	const lock = acquireInstanceLock(lockFile(config), 'pi-lark');
	const store = new SessionStore(config.dataDir, logger);
	const pool = new AgentPool(config, logger, store);
	pool.start();

	cleanupInbox(config.inboxDir, config.bridge.inboxMaxAgeMs, logger);
	const inboxTimer =
		config.bridge.inboxMaxAgeMs > 0
			? setInterval(() => cleanupInbox(config.inboxDir, config.bridge.inboxMaxAgeMs, logger), 24 * 60 * 60_000)
			: undefined;
	inboxTimer?.unref();

	const channel = createGateway(config, logger);
	const bridge = new PiLarkBridge(config, channel, pool, logger);

	channel.on({
		message: (message) => bridge.onMessage(message),
		cardAction: (event) => bridge.onCardAction(event),
		botAdded: (event) => bridge.onBotAdded(event.chatId, event.botName),
		reject: (event) =>
			logger.debug(`消息被策略拒绝 reason=${event.reason} chat=${event.chatId} sender=${event.senderId}`),
		error: (error) => logger.error('飞书通道错误', error),
		reconnecting: () => logger.warn('飞书长连接断开，正在重连'),
		reconnected: () => logger.info('飞书长连接已恢复'),
	});

	await channel.connect();
	const identity = channel.botIdentity;
	logger.info(`已连接到${config.lark.domain === 'lark' ? 'Lark' : '飞书'}，机器人 ${identity?.name ?? '?'} (${identity?.openId ?? '?'})`);
	writeFileSync(
		statusFile(config),
		`${JSON.stringify({ pid: process.pid, connectedAt: new Date().toISOString(), bot: identity?.name }, null, 2)}\n`,
		'utf8',
	);

	let server: http.Server | undefined;
	if (config.lark.connectionMode === 'webhook') {
		server = await startWebhookServer(channel, config, logger);
	}

	let stopping = false;
	const shutdown = async (reason: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		logger.info(`收到 ${reason}，正在关闭…`);
		const force = setTimeout(() => {
			logger.warn('关闭超时，强制退出');
			process.exit(1);
		}, 20_000);
		force.unref();
		try {
			await bridge.shutdown();
			await channel.disconnect();
			server?.close();
			await pool.shutdown();
			for (const file of [statusFile(config), stopFile(config)]) {
				try {
					rmSync(file, { force: true });
				} catch {
					// Best effort cleanup only.
				}
			}
			lock.release();
		} catch (error) {
			logger.error('关闭过程出错', error);
		}
		clearTimeout(force);
		logger.info('已退出');
		process.exit(0);
	};

	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('unhandledRejection', (reason) => logger.error('未处理的 Promise 拒绝', reason));
	process.on('uncaughtException', (error) => logger.error('未捕获的异常', error));

	// Windows has no deliverable signal for a graceful stop, so stopBridge
	// drops this file and watches for the process to exit.
	const stopWatcher = setInterval(() => {
		if (!existsSync(stopFile(config))) return;
		try {
			rmSync(stopFile(config), { force: true });
		} catch {
			// Another reader got it first.
		}
		void shutdown('停止请求（stop 文件）');
	}, 1_000);
	stopWatcher.unref();

	const home = config.lark.homeChannel;
	if (home) {
		await channel.send(home, { markdown: '**pi-lark bridge 已上线**，可直接发送消息给 Pi。' }).catch((error: unknown) => {
			logger.warn(`无法向 home channel ${home} 发送上线通知`, error);
		});
	}
}

main().catch((error: unknown) => {
	const debug = (process.env.LOG_LEVEL ?? '').toLowerCase() === 'debug';
	const detail =
		error instanceof Error ? (debug ? (error.stack ?? error.message) : error.message) : String(error);
	process.stderr.write(`启动失败: ${detail}\n`);
	if (error instanceof Error && error.message.includes('缺少必需的环境变量')) {
		process.stderr.write('提示：运行 npm run setup 打开链接创建/配置机器人，凭据会自动写入 .env\n');
	}
	process.exitCode = 1;
});
