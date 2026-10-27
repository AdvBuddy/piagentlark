import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { SETUP_USAGE, parseSetupArgs } from './setup/args.js';
import { mergeEnvText, parseEnvText } from './setup/envFile.js';
import { CALLBACKS, TENANT_EVENTS, TENANT_SCOPES } from './setup/presets.js';
import {
	DEFAULT_APP_DESC,
	DEFAULT_APP_NAME,
	RegistrationError,
	registrationEnv,
	requestAppRegistration,
} from './setup/registration.js';
import { copyToClipboard, openUrl } from './util/system.js';

const ENV_PATH = '.env';

function line(text = ''): void {
	process.stdout.write(`${text}\n`);
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function loadDotEnv(): void {
	if (!existsSync(ENV_PATH)) return;
	try {
		process.loadEnvFile(ENV_PATH);
	} catch {
		// A malformed .env only means we cannot reuse its defaults.
	}
}

/**
 * Show the verification link and try to make it easy to reach: the URL carries
 * the prefilled scopes and runs to ~700 characters, which nobody wants to
 * select by hand, so it goes to the clipboard and to the browser as well as to
 * stdout.
 */
async function showLink(url: string, expireInSeconds: number): Promise<void> {
	const copied = copyToClipboard(url);
	line('在浏览器中打开下面的链接完成授权：');
	line(url);
	line(copied ? '（链接已复制到剪贴板，可直接粘贴到浏览器）' : '（未能复制到剪贴板，请手动选中上面的链接）');
	// openUrl resolves on the launcher's real verdict, so this line is honest.
	const opened = await openUrl(url);
	if (!opened) line('（未能自动打开浏览器，请手动打开上面的链接）');
	line(`有效期约 ${Math.max(1, Math.round(expireInSeconds / 60))} 分钟，确认后这里会自动继续。`);
	line('等待确认…');
}

function printManualChecklist(): void {
	line('如果确认页没有自动勾选（该能力仍在灰度中），请在开发者后台手动补全：');
	line(`  · 权限：${TENANT_SCOPES.join(', ')}`);
	line(`  · 事件：${TENANT_EVENTS.join(', ')}`);
	line(`  · 回调：${CALLBACKS.join(', ')}`);
	line('  · 事件订阅方式选「长连接 / WebSocket」，并在版本管理与发布中发版、由管理员通过');
}

async function main(): Promise<void> {
	loadDotEnv();
	const args = parseSetupArgs(process.argv.slice(2));
	if (args.help) {
		line(SETUP_USAGE);
		return;
	}

	const envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
	const existing = parseEnvText(envText);
	const knownAppId = nonEmpty(existing.FEISHU_APP_ID) ?? nonEmpty(process.env.FEISHU_APP_ID);
	const targetAppId = args.appId ?? (args.force ? undefined : knownAppId);
	const createNew = !targetAppId;
	const shouldStart = args.start ?? createNew;

	line('pi-lark 配置向导');
	if (createNew) {
		line('将打开链接创建一个新的飞书自建应用，并自动写入 .env。');
	} else {
		line(`将更新已有应用 ${targetAppId} 的权限与事件订阅（打开链接确认差异即可）。`);
	}
	line('确认页会预填：');
	line(`  · 权限：${TENANT_SCOPES.join(', ')}`);
	line(`  · 事件：${TENANT_EVENTS.join(', ')}`);
	line(`  · 回调：${CALLBACKS.join(', ')}`);
	line();

	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.once('SIGINT', onSigint);

	let result: Awaited<ReturnType<typeof requestAppRegistration>>;
	try {
		result = await requestAppRegistration({
			domain: args.domain,
			source: 'pi-lark-bridge',
			signal: controller.signal,
			createOnly: createNew,
			appId: targetAppId,
			name: args.name ?? DEFAULT_APP_NAME,
			desc: DEFAULT_APP_DESC,
			onUrl: (url, expireInSeconds) => {
				void showLink(url, expireInSeconds);
			},
			onStatus: (status) => {
				if (status === 'slow_down') line('仍在等待确认（平台要求降低轮询频率）…');
				if (status === 'domain_switched') line('已自动切换到 Lark 国际版认证域名…');
			},
		});
	} catch (error) {
		const failure = error instanceof RegistrationError ? error : new RegistrationError(undefined, String(error));
		if (failure.code === 'abort' || controller.signal.aborted) {
			line('\n已取消。');
			process.exitCode = 130;
			return;
		}
		line(`\n配置失败：${failure.message}${failure.code ? `（${failure.code}）` : ''}`);
		if (failure.hint) line(failure.hint);
		process.exitCode = 1;
		return;
	} finally {
		process.off('SIGINT', onSigint);
	}

	const updates = registrationEnv(result);
	if (args.homeChannel) updates.FEISHU_HOME_CHANNEL = args.homeChannel;
	if (args.piCwd) updates.PI_CWD = path.resolve(args.piCwd);

	writeFileSync(ENV_PATH, mergeEnvText(envText, updates), 'utf8');
	line();
	line(`配置完成：${result.appId}${result.tenantBrand ? ` (${result.tenantBrand})` : ''}`);
	line(`凭据已写入 ${path.resolve(ENV_PATH)}`);
	printManualChecklist();
	line();

	if (!shouldStart) {
		line('下一步：npm start    # 启动桥接器');
		return;
	}

	line('正在启动桥接器（Ctrl+C 停止）…');
	line();
	const child = spawn('npm', ['start'], { stdio: 'inherit' });
	child.on('exit', (code, signal) => {
		if (signal) {
			process.exitCode = 0;
			return;
		}
		process.exitCode = code ?? 0;
	});
	child.on('error', (error: Error) => {
		line(`无法启动 npm start：${error.message}`);
		line('请手动运行 npm start');
		process.exitCode = 1;
	});
}

main().catch((error: unknown) => {
	const failure = error instanceof RegistrationError ? error : new RegistrationError(undefined, error instanceof Error ? error.message : String(error));
	process.stderr.write(`配置向导出错：${failure.message}${failure.code ? `（${failure.code}）` : ''}\n`);
	process.exitCode = 1;
});
