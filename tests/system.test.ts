import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyToClipboard, openUrl } from '../src/util/system.js';

// Only the no-launch paths run here: a URL a launcher accepts would open a
// real browser on the dev machine.
describe('openUrl guards', () => {
	it('refuses anything that is not a plain web URL', async () => {
		assert.equal(await openUrl('file:///C:/Windows/win.ini'), false);
		assert.equal(await openUrl('ftp://example.com/'), false);
		assert.equal(await openUrl('javascript:alert(1)'), false);
		assert.equal(await openUrl(''), false);
	});
});

describe('copyToClipboard guards', () => {
	it('refuses empty text without spawning a tool', () => {
		assert.equal(copyToClipboard(''), false);
	});
});
