import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collapseWhitespace, formatCost, formatDuration, formatTokens, safeFileName, truncateEnd, truncateTail, } from '../src/util/text.js';
describe('text helpers', () => {
    it('truncateEnd keeps the head and marks the cut', () => {
        assert.equal(truncateEnd('abcdef', 10), 'abcdef');
        assert.equal(truncateEnd('abcdef', 4), 'abc…');
        assert.equal(truncateEnd('abcdef', 1), 'a…');
    });
    it('truncateTail keeps the newest characters', () => {
        assert.equal(truncateTail('abcdef', 10), 'abcdef');
        assert.equal(truncateTail('abcdef', 4), '…def');
    });
    it('collapseWhitespace flattens newlines and tabs', () => {
        assert.equal(collapseWhitespace('  a\n\tb   c  ', 100), 'a b c');
        assert.equal(collapseWhitespace('a b c d', 4), 'a b…');
    });
    it('formats durations for seconds, minutes and hours', () => {
        assert.equal(formatDuration(0), '0.0s');
        assert.equal(formatDuration(1234), '1.2s');
        assert.equal(formatDuration(65_000), '1m05s');
        assert.equal(formatDuration(3_660_000), '1h01m');
        assert.equal(formatDuration(-5), '0.0s');
    });
    it('formats token counts compactly', () => {
        assert.equal(formatTokens(undefined), undefined);
        assert.equal(formatTokens(0), undefined);
        assert.equal(formatTokens(999), '999');
        assert.equal(formatTokens(1500), '1.5k');
        assert.equal(formatTokens(24_000), '24k');
    });
    it('formats costs with enough precision for small runs', () => {
        assert.equal(formatCost(undefined), undefined);
        assert.equal(formatCost(0), undefined);
        assert.equal(formatCost(0.0042), '$0.0042');
        assert.equal(formatCost(1.234), '$1.23');
    });
    it('sanitizes attachment names for the local inbox', () => {
        assert.equal(safeFileName('a/b\\c:d.txt'), 'a_b_c_d.txt');
        assert.equal(safeFileName('..hidden'), '_hidden');
        assert.equal(safeFileName('   '), 'file');
        assert.equal(safeFileName('', 'attachment'), 'attachment');
    });
});
