import { readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { PiImage } from '../pi/rpc.js';
import { safeFileName } from '../util/text.js';

export interface AttachmentResult {
	images: PiImage[];
	notes: string[];
}

/**
 * Delete inbox files older than `maxAgeMs`; returns how many were removed.
 * Missing directory or per-file races are tolerated silently.
 */
export function cleanupInbox(dir: string, maxAgeMs: number, logger: Logger): number {
	if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return 0;
	}
	const cutoff = Date.now() - maxAgeMs;
	let removed = 0;
	for (const name of entries) {
		const file = path.join(dir, name);
		try {
			const stat = statSync(file);
			if (stat.isFile() && stat.mtimeMs < cutoff) {
				rmSync(file, { force: true });
				removed += 1;
			}
		} catch {
			// The file disappeared or is not readable; nothing to reclaim.
		}
	}
	if (removed > 0) logger.info(`已清理 ${removed} 个过期附件文件（${dir}）`);
	return removed;
}

const TEXT_EXTENSIONS = new Set([
	'.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.csv', '.tsv', '.log',
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp',
	'.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql', '.html', '.css', '.xml',
]);
const MAX_INLINE_TEXT_BYTES = 64 * 1024;

export function detectImageMime(buffer: Buffer): string {
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return 'image/png';
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return 'image/jpeg';
	}
	if (buffer.length >= 6 && buffer.subarray(0, 3).toString('latin1') === 'GIF') {
		return 'image/gif';
	}
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
		buffer.subarray(8, 12).toString('latin1') === 'WEBP'
	) {
		return 'image/webp';
	}
	if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
		return 'image/bmp';
	}
	return 'image/png';
}

function describeResource(resource: ResourceDescriptor): string {
	const kind = resource.type;
	const name = resource.fileName ? `「${resource.fileName}」` : '';
	return `${kind}${name}`;
}

/**
 * Download inbound media. Images become pi `ImageContent` entries; files are
 * written into the bridge inbox so the agent can read them with its own tools.
 */
export async function collectAttachments(
	channel: LarkChannel,
	message: NormalizedMessage,
	config: Config,
	logger: Logger,
): Promise<AttachmentResult> {
	const images: PiImage[] = [];
	const notes: string[] = [];
	const resources = message.resources ?? [];
	if (resources.length === 0) return { images, notes };

	let imageCount = 0;
	for (const resource of resources) {
		try {
			if (resource.type === 'image') {
				if (imageCount >= config.bridge.maxImagesPerMessage) {
					notes.push(`（图片 ${describeResource(resource)} 超出单条消息上限，已忽略）`);
					continue;
				}
				const buffer = await channel.downloadResource(resource.fileKey, 'image');
				if (buffer.byteLength > config.bridge.maxImageBytes) {
					notes.push(`（图片过大 ${Math.round(buffer.byteLength / 1024)}KB，已忽略）`);
					continue;
				}
				images.push({
					type: 'image',
					data: buffer.toString('base64'),
					mimeType: detectImageMime(buffer),
				});
				imageCount += 1;
				continue;
			}

			if (resource.type !== 'file') {
				notes.push(`（暂不支持处理 ${describeResource(resource)}）`);
				continue;
			}

			const buffer = await channel.downloadResource(resource.fileKey, 'file');
			if (buffer.byteLength > config.bridge.maxFileBytes) {
				notes.push(`（文件 ${resource.fileName ?? resource.fileKey} 过大，已忽略）`);
				continue;
			}
			const fileName = safeFileName(resource.fileName ?? `${resource.fileKey}`);
			const target = path.join(config.inboxDir, `${message.messageId}-${fileName}`);
			await mkdir(config.inboxDir, { recursive: true });
			await writeFile(target, buffer);
			notes.push(`文件已保存到本地：${target}（${Math.max(1, Math.round(buffer.byteLength / 1024))}KB）`);

			const extension = path.extname(fileName).toLowerCase();
			if (TEXT_EXTENSIONS.has(extension) && buffer.byteLength <= MAX_INLINE_TEXT_BYTES) {
				const text = buffer.toString('utf8');
				const fence = extension === '.md' || extension === '.markdown' ? 'markdown' : '';
				notes.push(`文件内容：\n\`\`\`${fence}\n${text}\n\`\`\``);
			}
		} catch (error) {
			logger.warn(`下载附件 ${resource.fileKey} 失败`, error);
			notes.push(`（无法下载 ${describeResource(resource)}，可能是权限或网络问题）`);
		}
	}

	return { images, notes };
}
