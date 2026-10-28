import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function parseSetupStatus(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.runId !== 'string')
        return undefined;
    if (parsed.phase !== 'requesting' && parsed.phase !== 'waiting' && parsed.phase !== 'done' && parsed.phase !== 'failed') {
        return undefined;
    }
    return { ...parsed, updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0 };
}
/** Remaining validity as a short human countdown. */
export function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1_000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${seconds} 秒`;
}
/** Terminal cell width: CJK and emoji take two columns. */
function displayWidth(text) {
    let width = 0;
    for (const char of text)
        width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
    return width;
}
function isWide(code) {
    return ((code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x303e) ||
        (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f9ff));
}
function wrap(text, width) {
    const lines = [];
    let current = '';
    let currentWidth = 0;
    for (const char of text) {
        const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
        if (currentWidth + charWidth > width && current.length > 0) {
            lines.push(current);
            current = '';
            currentWidth = 0;
        }
        current += char;
        currentWidth += charWidth;
    }
    if (current.length > 0)
        lines.push(current);
    return lines.length > 0 ? lines : [''];
}
/** The frame for one status; pure so tests can assert on it. */
export function renderSetupFrame(status, now, columns) {
    const width = Math.max(40, Math.min(120, Math.floor(columns) || 80));
    const lines = ['', `  pi-lark · 飞书设备授权`, `  ${'─'.repeat(width - 4)}`, ''];
    if (status.phase === 'requesting') {
        lines.push('  正在申请授权链接…', '', '  本窗口会自动更新；关闭它不影响授权流程（q 退出）。');
        return lines;
    }
    if (status.phase === 'waiting') {
        lines.push('  在浏览器中完成授权，这里会自动继续。', '');
        lines.push(...(status.copied === false ? ['  请手动复制下面的链接：'] : ['  链接已复制到剪贴板，可直接粘贴到浏览器。', '']));
        if (status.url) {
            lines.push('');
            lines.push(...wrap(status.url, width - 4).map((part) => `  ${part}`));
        }
        lines.push('');
        if (status.opened === 'remote') {
            lines.push('  SSH 远程会话：请在【本地】浏览器打开链接。');
        }
        else if (status.opened === 'failed') {
            lines.push('  未能自动打开浏览器，请手动粘贴链接。');
        }
        if (typeof status.expireAt === 'number') {
            const left = status.expireAt - now;
            lines.push(left > 0
                ? `  链接剩余有效期：${formatCountdown(left)}`
                : '  链接可能已过期；重新运行 /lark-setup 会生成新链接。');
        }
        lines.push('', '  q / Esc 关闭本窗口（不影响授权）。');
        return lines;
    }
    if (status.phase === 'done') {
        lines.push('  ✔ 授权完成', ...(status.appId ? [`  应用：${status.appId}`] : []), '', '  凭据已保存，pi 窗口会继续后续步骤。', '', '  本窗口将在片刻后自动关闭，按任意键立即关闭。');
        return lines;
    }
    lines.push('  ✘ 配置失败', '');
    for (const part of wrap(status.error ?? '未知错误', width - 4))
        lines.push(`  ${part}`);
    if (status.hint) {
        lines.push('');
        for (const part of wrap(status.hint, width - 4))
            lines.push(`  ${part}`);
    }
    lines.push('', '  按任意键关闭本窗口。');
    return lines;
}
function main() {
    const [file, runId] = process.argv.slice(2);
    if (!file || !runId) {
        process.stderr.write('用法：setup-window <statusFile> <runId>\n');
        process.exitCode = 2;
        return;
    }
    if (process.platform === 'win32') {
        // A fresh console starts in the legacy code page; UTF-8 output needs 65001.
        try {
            spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true, timeout: 3_000 });
        }
        catch {
            // Cosmetic only.
        }
    }
    const tty = process.stdout.isTTY === true;
    const input = process.stdin;
    const rawCapable = typeof input.setRawMode === 'function';
    if (tty && rawCapable)
        input.setRawMode(true);
    input.resume();
    let closed = false;
    let current;
    let missingPolls = 0;
    let closeTimer;
    const exit = (code = 0) => {
        if (closed)
            return;
        closed = true;
        if (closeTimer)
            clearTimeout(closeTimer);
        if (rawCapable)
            input.setRawMode(false);
        process.exit(code);
    };
    input.on('data', (data) => {
        const key = String(data);
        const terminal = current !== undefined && (current.phase === 'done' || current.phase === 'failed');
        if (terminal || key === 'q' || key === 'Q' || key === '\u001b' || key === '\u0003')
            exit(0);
    });
    process.on('SIGINT', () => exit(0));
    const draw = () => {
        if (!tty || closed)
            return;
        const lines = current === undefined
            ? ['', '  pi-lark · 飞书设备授权', '', '  等待授权流程状态…', '']
            : renderSetupFrame(current, Date.now(), process.stdout.columns ?? 80);
        process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\n`);
        if (current && (current.phase === 'done' || current.phase === 'failed') && closeTimer === undefined) {
            closeTimer = setTimeout(() => exit(0), 15_000);
        }
    };
    const tick = () => {
        if (closed)
            return;
        let fresh = false;
        try {
            if (existsSync(file)) {
                const next = parseSetupStatus(readFileSync(file, 'utf8'));
                if (next && next.runId === runId) {
                    current = next;
                    fresh = true;
                }
            }
        }
        catch {
            // Unreadable for now; counted as missing.
        }
        missingPolls = fresh ? 0 : missingPolls + 1;
        // The status file should exist from the start; if it never appears the
        // run was cancelled before writing anything.
        if (current === undefined && missingPolls > 25) {
            current = { runId, phase: 'failed', error: '未收到授权流程状态（流程可能已被取消）', updatedAt: Date.now() };
        }
        // A vanished file mid-run means the registration ended without a final
        // frame (crash or shutdown) — say so instead of waiting forever.
        if (current &&
            (current.phase === 'requesting' || current.phase === 'waiting') &&
            missingPolls > 10) {
            current = {
                runId,
                phase: 'failed',
                error: '授权流程已结束（未见最终结果，请查看 pi 窗口或重新运行 /lark-setup）',
                updatedAt: Date.now(),
            };
        }
        draw();
    };
    tick();
    setInterval(tick, 400);
}
// Run only as a script, not when imported for the helpers under test.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
