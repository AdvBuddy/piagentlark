import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { cleanupInbox } from '../src/bridge/attachments.js';
import { loadDotEnv, packageRoot } from '../src/util/dotenv.js';
import { Logger } from '../src/logger.js';

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

const silentLogger = new Logger('test', 'error');

describe('cleanupInbox', () => {
	it('removes only files older than the cutoff', () => {
		const dir = tempDir('pi-lark-inbox-');
		const oldFile = path.join(dir, 'om_old-notes.txt');
		const newFile = path.join(dir, 'om_new-notes.txt');
		writeFileSync(oldFile, 'x', 'utf8');
		writeFileSync(newFile, 'y', 'utf8');
		const now = Date.now();
		utimesSync(oldFile, new Date(now - 90_000), new Date(now - 90_000));

		const removed = cleanupInbox(dir, 60_000, silentLogger);
		assert.equal(removed, 1);
		assert.equal(existsSync(oldFile), false, 'the expired file should be gone');
		assert.equal(existsSync(newFile), true, 'the fresh file should stay');
	});

	it('keeps everything when cleanup is disabled', () => {
		const dir = tempDir('pi-lark-inbox-');
		writeFileSync(path.join(dir, 'om_old.txt'), 'x', 'utf8');
		utimesSync(path.join(dir, 'om_old.txt'), new Date(0), new Date(0));
		assert.equal(cleanupInbox(dir, 0, silentLogger), 0);
		assert.equal(cleanupInbox(dir, Number.NaN, silentLogger), 0);
	});

	it('tolerates a missing directory', () => {
		assert.equal(cleanupInbox(path.join(tempDir('pi-lark-inbox-'), 'nope'), 60_000, silentLogger), 0);
	});
});

describe('packageRoot and loadDotEnv', () => {
	it('finds the package root from any module location', () => {
		assert.equal(path.basename(packageRoot()), 'piclient');
		assert.ok(packageRoot().endsWith('piclient'));
	});

	it('fills missing values and never overwrites existing ones', () => {
		const dir = tempDir('pi-lark-env-');
		const file = path.join(dir, '.env');
		writeFileSync(file, 'PI_LARK_TEST_A=from-file\nPI_LARK_TEST_B=from-file\n# comment\n', 'utf8');
		const env: NodeJS.ProcessEnv = { PI_LARK_TEST_A: 'from-env' };
		loadDotEnv(env, [file]);
		assert.equal(env.PI_LARK_TEST_A, 'from-env');
		assert.equal(env.PI_LARK_TEST_B, 'from-file');
	});

	it('tolerates a missing file', () => {
		const env: NodeJS.ProcessEnv = {};
		loadDotEnv(env, [path.join(tempDir('pi-lark-env-'), 'nope.env')]);
		assert.deepEqual(Object.keys(env), []);
	});
});
