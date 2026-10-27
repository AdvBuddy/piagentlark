import { registerApp } from '@larksuiteoapi/node-sdk';
import { buildAddons } from './presets.js';

/**
 * Device-authorization ("scan to create an app") flow shared by the CLI wizard
 * and the pi extension. Wraps the SDK's `registerApp`, normalises its plain
 * `{ code, description }` rejections and turns the result into env values.
 */

export type RegistrationStatus = 'polling' | 'slow_down' | 'domain_switched';

export interface RegistrationRequest {
	domain: 'feishu' | 'lark';
	/** Existing app to update. Ignored when `createOnly` is true. */
	appId?: string;
	/** `true` = the confirm page may only create a new app. */
	createOnly: boolean;
	name?: string;
	desc?: string;
	source?: string;
	signal?: AbortSignal;
	/** Called once with the verification link the user has to open. */
	onUrl(url: string, expireInSeconds: number): void;
	onStatus?(status: RegistrationStatus): void;
}

export interface RegistrationResult {
	appId: string;
	appSecret: string;
	domain: 'feishu' | 'lark';
	tenantBrand?: 'feishu' | 'lark';
}

export class RegistrationError extends Error {
	readonly code: string | undefined;
	readonly hint: string | undefined;

	constructor(code: string | undefined, message: string, hint?: string) {
		super(message);
		this.name = 'RegistrationError';
		this.code = code;
		this.hint = hint;
	}
}

export const DEFAULT_APP_NAME = 'Pi 编码助手';
export const DEFAULT_APP_DESC = '在飞书里使用 pi 编码代理：流式卡片、会话隔离、命令与附件。';

const FEISHU_HOST = 'accounts.feishu.cn';
const LARK_HOST = 'accounts.larksuite.com';

function failureCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === 'string' ? code : undefined;
	}
	return undefined;
}

/** `registerApp` rejects with `{ code, description }` objects, not `Error`s. */
export function toRegistrationError(error: unknown): RegistrationError {
	if (error instanceof RegistrationError) return error;
	const code = failureCode(error);
	let description: string | undefined;
	if (error && typeof error === 'object') {
		const record = error as { description?: unknown; message?: unknown };
		if (typeof record.description === 'string') description = record.description;
		else if (typeof record.message === 'string') description = record.message;
	} else if (typeof error === 'string') {
		description = error;
	}
	const message = description ?? code ?? '未知错误';
	const hint =
		code === 'access_denied'
			? '你在确认页取消了授权，需要时重新运行即可。'
			: code === 'expired_token'
				? '链接已过期，重新运行会生成新的。'
				: code === 'abort'
					? undefined
					: '请重试；若链接已过期，重新运行会生成新的。';
	return new RegistrationError(code, message, hint);
}

export async function requestAppRegistration(request: RegistrationRequest): Promise<RegistrationResult> {
	try {
		const registered = await registerApp({
			domain: request.domain === 'lark' ? LARK_HOST : FEISHU_HOST,
			larkDomain: LARK_HOST,
			source: request.source ?? 'pi-lark-bridge',
			signal: request.signal,
			createOnly: request.createOnly,
			appId: request.appId,
			appPreset: {
				name: request.name ?? DEFAULT_APP_NAME,
				desc: request.desc ?? DEFAULT_APP_DESC,
			},
			addons: buildAddons(),
			onQRCodeReady: (info) => request.onUrl(info.url, info.expireIn),
			onStatusChange: (info) => request.onStatus?.(info.status),
		});
		const tenantBrand =
			registered.user_info?.tenant_brand === 'lark' || registered.user_info?.tenant_brand === 'feishu'
				? registered.user_info.tenant_brand
				: undefined;
		return {
			appId: registered.client_id,
			appSecret: registered.client_secret,
			domain: tenantBrand === 'lark' ? 'lark' : request.domain,
			tenantBrand,
		};
	} catch (error) {
		throw toRegistrationError(error);
	}
}

/** Env keys the bridge reads, ready to be merged into `.env`. */
export function registrationEnv(result: RegistrationResult): Record<string, string> {
	return {
		FEISHU_APP_ID: result.appId,
		FEISHU_APP_SECRET: result.appSecret,
		FEISHU_DOMAIN: result.domain,
	};
}
