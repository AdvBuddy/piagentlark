import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireInstanceLock, isProcessAlive } from '../src/util/pid.js';

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempLock(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-lark-lock-'));
	dirs.push(dir);
	return path.join(dir, 'bridge-test.lock');
}

describe('isProcessAlive', () => {
	it('recognises the current process and rejects garbage', () => {
		assert.equal(isProcessAlive(process.pid), true);
		assert.equal(isProcessAlive(0), false);
		assert.equal(isProcessAlive(-1), false);
		assert.equal(isProcessAlive(Number.NaN), false);
		// PIDs are capped well below this; nothing can match.
		assert.equal(isProcessAlive(2 ** 31), false);
	});
});

describe('acquireInstanceLock', () => {
	it('acquires, records the pid and releases', () => {
		const file = tempLock();
		const lock = acquireInstanceLock(file);
		assert.equal(Number.parseInt(readFileSync(file, 'utf8').trim(), 10), process.pid);

		// A second holder for the same live pid is refused.
		assert.throws(() => acquireInstanceLock(file), /已在运行/);

		lock.release();
		assert.throws(() => readFileSync(file, 'utf8'), /ENOENT/);
		const second = acquireInstanceLock(file);
		second.release();
	});

	it('steals a lock whose holder is gone', () => {
		const file = tempLock();
		writeFileSync(file, '999999999\n', 'utf8');
		const lock = acquireInstanceLock(file);
		assert.equal(Number.parseInt(readFileSync(file, 'utf8').trim(), 10), process.pid);
		lock.release();
	});

	it('steals a lock with unreadable content', () => {
		const file = tempLock();
		writeFileSync(file, 'not-a-pid\n', 'utf8');
		const lock = acquireInstanceLock(file);
		lock.release();
	});
});
