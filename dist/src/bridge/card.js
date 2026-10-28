import { collapseWhitespace, formatDuration, truncateEnd, truncateTail } from '../util/text.js';
const STATUS_LABEL = {
    working: '运行中',
    done: '已完成',
    aborted: '已中止',
    error: '出错',
};
const STATUS_TEMPLATE = {
    working: 'blue',
    done: 'green',
    aborted: 'orange',
    error: 'red',
};
const MAX_VISIBLE_TOOLS = 8;
const MAX_NOTICES = 4;
const THINKING_PREVIEW = 500;
export function buildCard(view, options) {
    const elements = [];
    if (options.showThinking && view.status === 'working' && view.thinking && view.thinking.trim().length > 0) {
        const thinking = truncateTail(view.thinking.trim(), THINKING_PREVIEW);
        elements.push({
            tag: 'markdown',
            content: `<font color='grey'>思考中…\n${indentQuote(thinking)}</font>`,
        });
    }
    elements.push({ tag: 'markdown', content: renderAnswer(view, options.answerLimit) });
    if (options.showTools && view.tools.length > 0) {
        elements.push({ tag: 'hr' });
        elements.push({ tag: 'markdown', content: renderTools(view.tools) });
    }
    if (view.notices.length > 0) {
        const notices = view.notices.slice(-MAX_NOTICES).map((notice) => `- ${notice}`);
        elements.push({ tag: 'markdown', content: notices.join('\n') });
    }
    if (view.queued.length > 0) {
        const preview = view.queued.slice(0, 3).map((item) => `- ${collapseWhitespace(item, 60)}`);
        const extra = view.queued.length > 3 ? `\n- 其余 ${view.queued.length - 3} 条` : '';
        elements.push({ tag: 'markdown', content: `**已排队**\n${preview.join('\n')}${extra}` });
    }
    if (view.status === 'working' && view.abortValue) {
        elements.push({
            tag: 'action',
            actions: [
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '停止' },
                    type: 'danger',
                    value: view.abortValue,
                },
            ],
        });
    }
    elements.push({
        tag: 'note',
        elements: [{ tag: 'plain_text', content: view.footer }],
    });
    return {
        config: { wide_screen_mode: true, update_multi: true },
        header: {
            template: STATUS_TEMPLATE[view.status],
            title: { tag: 'plain_text', content: `${view.title} · ${STATUS_LABEL[view.status]}` },
        },
        elements,
    };
}
function renderAnswer(view, limit) {
    const answer = view.answer.trim();
    if (answer.length === 0) {
        return view.status === 'working' ? '_等待 Pi 输出…_' : '_(无文本输出)_';
    }
    if (answer.length <= limit)
        return answer;
    if (view.status === 'working') {
        return `_…仅显示最近 ${limit} 个字符_\n\n${truncateTail(answer, Math.max(0, limit - 24))}`;
    }
    return `${truncateEnd(answer, Math.max(0, limit - 30))}\n\n_…完整内容见下方消息_`;
}
function renderTools(tools) {
    const visible = tools.slice(-MAX_VISIBLE_TOOLS);
    const hidden = tools.length - visible.length;
    const lines = visible.map((tool) => {
        const marker = tool.status === 'running' ? '…' : tool.status === 'error' ? 'x' : '·';
        const duration = tool.durationMs !== undefined && tool.status !== 'running' ? ` (${formatDuration(tool.durationMs)})` : '';
        return `- ${marker} \`${tool.name}\` ${tool.summary}${duration}`;
    });
    if (hidden > 0)
        lines.unshift(`- 其余 ${hidden} 个工具调用已省略`);
    return `**工具调用**\n${lines.join('\n')}`;
}
function indentQuote(text) {
    return text
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
}
/** One-line summary of tool arguments for the activity list. */
export function summarizeToolArgs(toolName, args) {
    if (args === null || args === undefined)
        return '';
    const record = typeof args === 'object' ? args : undefined;
    if (!record)
        return collapseWhitespace(String(args), 80);
    const pick = (...keys) => {
        for (const key of keys) {
            const value = record[key];
            if (typeof value === 'string' && value.trim().length > 0)
                return value;
            if (Array.isArray(value) && value.length > 0)
                return value.map((item) => String(item)).join(' ');
        }
        return undefined;
    };
    const candidate = pick('command', 'cmd') ??
        pick('file_path', 'path', 'filePath', 'file', 'target') ??
        pick('pattern', 'query', 'glob', 'url') ??
        pick('description', 'prompt');
    if (candidate) {
        const normalized = candidate.replace(/\s+/g, ' ').trim();
        return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
    }
    try {
        return collapseWhitespace(JSON.stringify(record), 80);
    }
    catch {
        return '';
    }
}
