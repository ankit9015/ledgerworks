/** One server-sent event: the joined `data:` lines (comments and keep-alives are dropped). */
export interface SseMessage {
  data: string;
}

export interface SseLimits {
  /** stop with an error after this many bytes */
  maxBytes: number;
  /** stop with an error after this many events */
  maxEvents: number;
}

export class SseLimitError extends Error {
  constructor(readonly limit: 'bytes' | 'events') {
    super(`stream exceeded the maximum number of ${limit}`);
    this.name = 'SseLimitError';
  }
}

/**
 * Parses a byte stream as server-sent events (WHATWG rules, simplified): lines end in \n, \r\n or
 * \r; a blank line ends an event; lines starting with ":" are comments (keep-alives); `data:`
 * lines are joined with "\n"; other fields are ignored. A final event without a trailing blank
 * line is still delivered at the end of the stream. Chunk boundaries may fall anywhere, also in
 * the middle of a multi-byte character.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  limits: SseLimits,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bytes = 0;
  let events = 0;
  let data: string[] = [];
  let first = true;
  let pendingCr = false;

  const take = (): SseMessage | null => {
    if (data.length === 0) return null;
    const m = { data: data.join('\n') };
    data = [];
    return m;
  };
  const line = (l: string): SseMessage | null => {
    if (l === '') return take();
    if (l.startsWith(':')) return null;
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limits.maxBytes) throw new SseLimitError('bytes');
      let text = decoder.decode(value, { stream: true });
      if (first) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte order mark
        first = false;
      }
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c === '\n' || c === '\r') {
          const msg = line(buffer.slice(start, i));
          if (c === '\r') {
            if (buffer[i + 1] === '\n') i++;
            else if (i + 1 >= buffer.length) pendingCr = true;
          }
          start = i + 1;
          if (msg) {
            if (++events > limits.maxEvents) throw new SseLimitError('events');
            yield msg;
          }
        }
      }
      buffer = buffer.slice(start);
    }
    buffer += decoder.decode();
    if (buffer.length > 0) line(buffer);
    const last = take();
    if (last) {
      if (++events > limits.maxEvents) throw new SseLimitError('events');
      yield last;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
