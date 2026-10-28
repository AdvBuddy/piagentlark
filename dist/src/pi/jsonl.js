import { StringDecoder } from 'node:string_decoder';
/**
 * Incremental JSONL reader for the pi RPC stream.
 *
 * Records are separated by LF only: JSON strings may legally contain U+2028 /
 * U+2029, which Node's readline treats as line breaks and would corrupt.
 * Multi-byte characters split across chunks are handled by StringDecoder.
 */
export class JsonlDecoder {
    decoder = new StringDecoder('utf8');
    buffer = '';
    /** Feed a chunk and return every complete, non-empty line it completed. */
    push(chunk) {
        this.buffer += this.decoder.write(Buffer.from(chunk));
        const lines = [];
        for (;;) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0)
                break;
            lines.push(this.buffer.slice(0, newline));
            this.buffer = this.buffer.slice(newline + 1);
        }
        const cleaned = [];
        for (const raw of lines) {
            const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
            if (line.trim().length > 0)
                cleaned.push(line);
        }
        return cleaned;
    }
    /** Whatever is left without a trailing newline (for diagnostics and tests). */
    get pending() {
        return this.buffer;
    }
}
