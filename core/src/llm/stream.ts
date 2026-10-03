import { LLMError } from './errors.js';
import type { ChatResult, StreamEvent } from './types.js';

/** Consumes a stream and returns the assembled result; throws the stream's LLMError if it failed. */
export async function collectStream(
  events: AsyncIterable<StreamEvent>,
  onEvent?: (e: StreamEvent) => void,
): Promise<ChatResult> {
  let result: ChatResult | undefined;
  for await (const e of events) {
    onEvent?.(e);
    if (e.type === 'error') throw e.error;
    if (e.type === 'done') result = e.result;
  }
  if (!result) {
    throw new LLMError({
      kind: 'invalid_response',
      message: 'the stream ended without a done event',
    });
  }
  return result;
}
