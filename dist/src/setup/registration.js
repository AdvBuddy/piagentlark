import { registerApp } from '@larksuiteoapi/node-sdk';
import { buildAddons } from './presets.js';
export class RegistrationError extends Error {
    code;
    hint;
    constructor(code, message, hint) {
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
function failureCode(error) {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        return typeof code === 'string' ? code : undefined;
    }
    return undefined;
}
/** `registerApp` rejects with `{ code, description }` objects, not `Error`s. */
export function toRegistrationError(error) {
    if (error instanceof RegistrationError)
        return error;
    const code = failureCode(error);
    let description;
    if (error && typeof error === 'object') {
        const record = error;
        if (typeof record.description === 'string')
            description = record.description;
        else if (typeof record.message === 'string')
            description = record.message;
    }
    else if (typeof error === 'string') {
        description = error;
    }
    const message = description ?? code ?? '未知错误';
    const hint = code === 'access_denied'
        ? '你在确认页取消了授权，需要时重新运行即可。'
        : code === 'expired_token'
            ? '链接已过期，重新运行会生成新的。'
            : code === 'abort'
                ? undefined
                : '请重试；若链接已过期，重新运行会生成新的。';
    return new RegistrationError(code, message, hint);
}
export async function requestAppRegistration(request) {
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
        const tenantBrand = registered.user_info?.tenant_brand === 'lark' || registered.user_info?.tenant_brand === 'feishu'
            ? registered.user_info.tenant_brand
            : undefined;
        return {
            appId: registered.client_id,
            appSecret: registered.client_secret,
            domain: tenantBrand === 'lark' ? 'lark' : request.domain,
            tenantBrand,
        };
    }
    catch (error) {
        throw toRegistrationError(error);
    }
}
/** Env keys the bridge reads, ready to be merged into `.env`. */
export function registrationEnv(result) {
    return {
        FEISHU_APP_ID: result.appId,
        FEISHU_APP_SECRET: result.appSecret,
        FEISHU_DOMAIN: result.domain,
    };
}
