import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonlDecoder } from '../src/pi/jsonl.js';
const encoder = new TextEncoder();
describe('JsonlDecoder', () => {
    it('splits several records arriving in one chunk', () => {
        const decoder = new JsonlDecoder();
        const lines = decoder.push(encoder.encode('{"type":"a"}\n{"type":"b"}\n'));
        assert.deepEqual(lines, ['{"type":"a"}', '{"type":"b"}']);
        assert.equal(decoder.pending, '');
    });
    it('buffers a partial record until its newline arrives', () => {
        const decoder = new JsonlDecoder();
        assert.deepEqual(decoder.push(encoder.encode('{"type":"mess')), []);
        assert.equal(decoder.pending, '{"type":"mess');
        assert.deepEqual(decoder.push(encoder.encode('age_start"}\n')), ['{"type":"message_start"}']);
    });
    it('keeps multi-byte characters split across chunks intact', () => {
        const decoder = new JsonlDecoder();
        const bytes = encoder.encode('{"text":"中文"}\n');
        // "中" is 3 bytes: cut inside the character to force decoder buffering.
        const first = decoder.push(bytes.subarray(0, 11));
        assert.deepEqual(first, []);
        const rest = decoder.push(bytes.subarray(11));
        assert.deepEqual(rest, ['{"text":"中文"}']);
    });
    it('does not treat U+2028 / U+2029 inside a string as line breaks', () => {
        const decoder = new JsonlDecoder();
        const record = JSON.stringify({ type: 'message_update', text: 'a\u2028b\u2029c' });
        const lines = decoder.push(encoder.encode(`${record}\n`));
        assert.equal(lines.length, 1);
        assert.deepEqual(JSON.parse(lines[0] ?? ''), { type: 'message_update', text: 'a\u2028b\u2029c' });
    });
    it('strips CRLF endings and skips blank lines', () => {
        const decoder = new JsonlDecoder();
        const lines = decoder.push(encoder.encode('\r\n{"type":"x"}\r\n   \n'));
        assert.deepEqual(lines, ['{"type":"x"}']);
    });
});
