/** Character budget helpers shared by the card renderer and prompt builder. */

export function truncateEnd(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.max(1, maxChars - 1);
	return `${text.slice(0, keep)}…`;
}

export function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.max(1, maxChars - 1);
	return `…${text.slice(text.length - keep)}`;
}

export function collapseWhitespace(text: string, maxChars: number): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	return truncateEnd(collapsed, maxChars);
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '0.0s';
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatTokens(count: number | undefined): string | undefined {
	if (count === undefined || !Number.isFinite(count) || count <= 0) return undefined;
	if (count < 1000) return String(count);
	return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

export function formatCost(cost: number | undefined): string | undefined {
	if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return undefined;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

/** Keep only characters that are safe in a Windows and POSIX file name. */
export function safeFileName(name: string, fallback = 'file'): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
		.replace(/^\.+/, '_')
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}
