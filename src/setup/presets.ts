import type { AppAddons } from '@larksuiteoapi/node-sdk';

/**
 * Permissions, events and callbacks the bridge needs. They are sent along with
 * the app-registration link so the confirm page pre-fills them; the platform
 * merges them additively on top of its base template.
 */
export const TENANT_SCOPES: readonly string[] = [
	/** 读取用户发给机器人的消息 */
	'im:message',
	/** 以应用身份发送 / 回复消息 */
	'im:message:send_as_bot',
	/** 流式刷新自己发出的卡片 */
	'im:message:update',
	/** 「正在处理」表情回执 */
	'im:message.reaction:write',
	/** 收发图片与文件 */
	'im:resource',
	/** 读取群信息（群策略校验） */
	'im:chat:readonly',
	/** CardKit 打字机式流式卡片 */
	'cardkit:card:write',
];

export const TENANT_EVENTS: readonly string[] = [
	'im.message.receive_v1',
	'im.chat.member.bot.added_v1',
];

export const CALLBACKS: readonly string[] = ['card.action.trigger'];

export function buildAddons(extraScopes: readonly string[] = []): AppAddons {
	return {
		preset: true,
		scopes: { tenant: [...TENANT_SCOPES, ...extraScopes] },
		events: { items: { tenant: [...TENANT_EVENTS] } },
		callbacks: { items: [...CALLBACKS] },
	};
}

export function describeAddons(): string {
	return [
		`- 权限：${TENANT_SCOPES.join(', ')}`,
		`- 事件：${TENANT_EVENTS.join(', ')}`,
		`- 回调：${CALLBACKS.join(', ')}`,
	].join('\n');
}
