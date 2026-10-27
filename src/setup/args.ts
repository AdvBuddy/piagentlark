export interface SetupArgs {
	domain: 'feishu' | 'lark';
	/** Existing app (`cli_xxx`) to re-configure; otherwise a new app is created. */
	appId?: string;
	/** Ignore credentials already present in `.env` and create a new app. */
	force: boolean;
	/** undefined = decide after we know whether we create or update. */
	start?: boolean;
	homeChannel?: string;
	piCwd?: string;
	name?: string;
	help: boolean;
}

export const SETUP_USAGE = `用法：npm run setup -- [选项]

打开链接即可创建/配置飞书机器人，完成后自动写入 .env。

选项：
  --lark                使用 Lark（国际版）而非飞书
  --domain <d>          feishu | lark
  --app-id <cli_xxx>    配置已有应用（预填缺失的权限/事件），而不是新建
  --force               即使 .env 已有凭据也新建应用
  --start               配置完成后立即启动桥接器
  --no-start            只写配置，不启动
  --name <名称>         预填的应用名称（默认「Pi 编码助手」）
  --home <oc_xxx>       写入 FEISHU_HOME_CHANNEL（上线/告警通知的会话）
  --cwd <目录>          写入 PI_CWD（pi 的工作目录）
  -h, --help            显示帮助`;

export function parseSetupArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SetupArgs {
	const args: SetupArgs = {
		domain: (env.FEISHU_DOMAIN ?? '').trim().toLowerCase() === 'lark' ? 'lark' : 'feishu',
		force: false,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token) continue;
		const separator = token.indexOf('=');
		const flag = separator >= 0 ? token.slice(0, separator) : token;
		const inlineValue = separator >= 0 ? token.slice(separator + 1) : undefined;
		const readValue = (): string | undefined => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[index + 1];
			if (next !== undefined && !next.startsWith('--')) {
				index += 1;
				return next;
			}
			return undefined;
		};

		switch (flag) {
			case '--lark':
				args.domain = 'lark';
				break;
			case '--feishu':
				args.domain = 'feishu';
				break;
			case '--domain': {
				const value = readValue()?.toLowerCase();
				if (value === 'lark' || value === 'feishu') args.domain = value;
				break;
			}
			case '--app-id':
				args.appId = readValue();
				break;
			case '--force':
				args.force = true;
				break;
			case '--start':
				args.start = true;
				break;
			case '--no-start':
				args.start = false;
				break;
			case '--home':
			case '--home-channel':
				args.homeChannel = readValue();
				break;
			case '--cwd':
				args.piCwd = readValue();
				break;
			case '--name':
				args.name = readValue();
				break;
			case '-h':
			case '--help':
				args.help = true;
				break;
			default:
				throw new Error(`未知参数 ${token}\n\n${SETUP_USAGE}`);
		}
	}

	return args;
}
