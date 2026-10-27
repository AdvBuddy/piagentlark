import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { copyToClipboard, isRemoteSession, openTerminalWindow, openUrl } from '../src/util/system.js';

// Only the no-launch paths run here: a URL a launcher accepts would open a
// real browser on the dev machine.
describe('openUrl guards', () => {
	it('refuses anything that is not a plain web URL', async () => {
		assert.equal(await openUrl('file:///C:/Windows/win.ini'), 'failed');
		assert.equal(await openUrl('ftp://example.com/'), 'failed');
		assert.equal(await openUrl('javascript:alert(1)'), 'failed');
		assert.equal(await openUrl(''), 'failed');
	});
});

describe('copyToClipboard guards', () => {
	it('refuses empty text without spawning a tool', () => {
		assert.equal(copyToClipboard(''), false);
	});
});

describe('remote sessions', () => {
	const saved = ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT'].map((key) => [key, process.env[key]] as const);
	after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('detects the SSH marker variables', () => {
		for (const key of ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT']) delete process.env[key];
		assert.equal(isRemoteSession(), false);
		process.env.SSH_TTY = '/dev/pts/0';
		assert.equal(isRemoteSession(), true);
	});

	it('never launches a browser inside an SSH session', async () => {
		for (const key of ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT']) delete process.env[key];
		process.env.SSH_CONNECTION = '1.2.3.4 56789 10.0.0.1 22';
		try {
			assert.equal(await openUrl('https://example.com/ssh'), 'remote');
		} finally {
			delete process.env.SSH_CONNECTION;
		}
	});

	it('never opens a terminal window inside an SSH session', async () => {
		for (const key of ['SSH_TTY', 'SSH_CONNECTION', 'SSH_CLIENT']) delete process.env[key];
		process.env.SSH_TTY = '/dev/pts/0';
		try {
			assert.equal(await openTerminalWindow([process.execPath, '-v'], 'pi-lark-test'), false);
		} finally {
			delete process.env.SSH_TTY;
		}
	});
});
