import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { formatCountdown, parseSetupStatus, renderSetupFrame } from '../src/setup-window.js';
import {
	resolvePaths,
	resolveSetupWindowCommand,
	setupStatusFile,
	writeSetupStatus,
} from '../src/plugin/service.js';

const homes: string[] = [];
after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function tempPaths() {
	const home = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-window-'));
	homes.push(home);
	return resolvePaths(home);
}

describe('parseSetupStatus', () => {
	it('round-trips a waiting status and rejects garbage', () => {
		const status = {
			runId: 'run-1',
			phase: 'waiting',
			url: 'https://example.com/auth',
			expireAt: 1_000,
			copied: true,
			updatedAt: 123,
		};
		assert.deepEqual(parseSetupStatus(JSON.stringify(status)), status);
		assert.equal(parseSetupStatus('not json'), undefined);
		assert.equal(parseSetupStatus('{"phase":"waiting"}'), undefined, 'missing runId');
		assert.equal(parseSetupStatus(JSON.stringify({ runId: 'r', phase: 'nope' })), undefined);
	});
});

describe('formatCountdown', () => {
	it('formats seconds and minutes', () => {
		assert.equal(formatCountdown(0), '0 秒');
		assert.equal(formatCountdown(59_000), '59 秒');
		assert.equal(formatCountdown(60_000), '1 分 00 秒');
		assert.equal(formatCountdown(125_000), '2 分 05 秒');
	});
});

describe('renderSetupFrame', () => {
	it('asks for patience while requesting', () => {
		const lines = renderSetupFrame({ runId: 'r', phase: 'requesting', updatedAt: 0 }, 0, 80).join('\n');
		assert.match(lines, /正在申请授权链接/);
		assert.match(lines, /不影响授权流程/);
	});

	it('shows link, clipboard state and the validity countdown while waiting', () => {
		const now = Date.now();
		const lines = renderSetupFrame(
			{ runId: 'r', phase: 'waiting', url: 'https://example.com/auth?x=1', expireAt: now + 60_000, copied: true, updatedAt: now },
			now,
			80,
		).join('\n');
		assert.match(lines, /https:\/\/example\.com\/auth\?x=1/);
		assert.match(lines, /已复制到剪贴板/);
		assert.match(lines, /剩余有效期：1 分 00 秒/);
	});

	it('flags an expired link and the SSH hint', () => {
		const now = Date.now();
		const lines = renderSetupFrame(
			{ runId: 'r', phase: 'waiting', url: 'https://example.com/', expireAt: now - 1_000, copied: false, opened: 'remote', updatedAt: now },
			now,
			80,
		).join('\n');
		assert.match(lines, /可能已过期/);
		assert.match(lines, /SSH 远程会话/);
		assert.match(lines, /请手动复制/);
	});

	it('celebrates success and explains failure', () => {
		const done = renderSetupFrame({ runId: 'r', phase: 'done', appId: 'cli_x', updatedAt: 0 }, 0, 80).join('\n');
		assert.match(done, /授权完成/);
		assert.match(done, /cli_x/);
		const failed = renderSetupFrame(
			{ runId: 'r', phase: 'failed', error: '用户拒绝', hint: '重试即可', updatedAt: 0 },
			0,
			80,
		).join('\n');
		assert.match(failed, /配置失败/);
		assert.match(failed, /用户拒绝/);
		assert.match(failed, /重试即可/);
	});
});

describe('setup status plumbing', () => {
	it('writes the status file under the service home', () => {
		const paths = tempPaths();
		const file = setupStatusFile(paths);
		writeSetupStatus(file, { runId: 'r9', phase: 'waiting', url: 'https://example.com/' });
		assert.ok(existsSync(file));
		const parsed = parseSetupStatus(readFileSync(file, 'utf8'));
		assert.equal(parsed?.runId, 'r9');
		assert.equal(parsed?.phase, 'waiting');
		assert.ok(typeof parsed?.updatedAt === 'number');
	});

	it('resolves a viewer command from this checkout', () => {
		const command = resolveSetupWindowCommand(process.cwd(), 'status.json', 'run-1');
		assert.ok(command);
		assert.equal(command[0], '--import');
		assert.ok(command[1]!.startsWith('file://'));
		assert.ok(command[2]!.endsWith('setup-window.ts'));
		assert.deepEqual(command.slice(3), ['status.json', 'run-1']);
	});

	it('returns undefined without an installed viewer', () => {
		assert.equal(resolveSetupWindowCommand(tempPaths().home, 'status.json', 'run-1'), undefined);
	});
});
