/** Read and update `KEY=value` lines without disturbing comments or ordering. */
const KEY_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
export function parseEnvText(text) {
    const values = {};
    for (const line of text.split(/\r?\n/)) {
        const match = KEY_PATTERN.exec(line);
        if (!match?.[1])
            continue;
        const raw = line.slice(line.indexOf('=') + 1).trim();
        values[match[1]] = unquote(raw);
    }
    return values;
}
function unquote(value) {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return value.slice(1, -1);
        }
    }
    return value;
}
/**
 * Replace the given keys in place, append the missing ones at the end and keep
 * every unrelated line (comments included) untouched.
 */
export function mergeEnvText(original, updates) {
    const pending = new Map(Object.entries(updates).filter(([, value]) => value.length > 0));
    const lines = original.length > 0 ? original.split(/\r?\n/) : [];
    const output = [];
    for (const line of lines) {
        const key = KEY_PATTERN.exec(line)?.[1];
        if (key && pending.has(key)) {
            output.push(`${key}=${pending.get(key) ?? ''}`);
            pending.delete(key);
            continue;
        }
        output.push(line);
    }
    while (output.length > 0 && (output[output.length - 1] ?? '').trim() === '')
        output.pop();
    if (pending.size > 0) {
        if (output.length > 0)
            output.push('');
        output.push('# 由 npm run setup 自动写入');
        for (const [key, value] of pending)
            output.push(`${key}=${value}`);
    }
    return `${output.join('\n')}\n`;
}
