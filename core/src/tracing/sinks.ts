import type { RunTrace } from '../agent/types.js';
import { redactDeep, redactText } from '../security/redact.js';

/** Where a finished agent run goes. A sink must never throw into the run: the emitter catches, but be careful anyway. */
export interface TraceSink {
  readonly name: string;
  write(trace: RunTrace): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface ExportPolicy {
  /**
   * Include tool arguments and results (only present when the run itself was started with `debug`).
   * Default false. Ignored (content is always stripped) when the environment says it is CI.
   */
  includeDebugContent?: boolean;
  /** exact strings to remove in addition to the credential patterns (the API key, ...) */
  secrets?: readonly string[];
}

/** True in CI (CI=true or 1, or LEDGERWORKS_CI): debug content is never exported there. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    ['true', '1'].includes(String(env.CI ?? '').toLowerCase()) ||
    ['true', '1'].includes(String(env.LEDGERWORKS_CI ?? '').toLowerCase())
  );
}

/**
 * The version of a trace that may leave the process. By default it holds hashes, sizes, timings,
 * token counts, provider and model names and stop reasons only. Tool arguments and results (which
 * exist only for debug runs) are removed unless the sink opts in AND the run was a debug run AND this
 * is not CI. Whatever remains passes through the redaction helper.
 */
export function prepareForExport(trace: RunTrace, policy: ExportPolicy = {}): RunTrace {
  const copy = structuredClone(trace);
  const keepContent = policy.includeDebugContent === true && copy.debug && !isCi();
  for (const step of copy.steps) {
    const err = step.model.error;
    // A provider's error text can echo what was sent to it (a prompt, a request body): only its kind is exported.
    if (err && !keepContent) err.message = '(withheld: provider text is not exported)';
    for (const call of step.toolCalls) {
      // Ids and the name of an UNKNOWN tool come from the model: capped, and the name not exported at all.
      call.callId = call.callId.slice(0, 64);
      if (call.outcome === 'unknown_tool') call.name = '(unknown)';
      else call.name = call.name.slice(0, 64);
      if (!keepContent) {
        delete call.arguments;
        delete call.result;
      }
    }
  }
  copy.debug = keepContent;
  return redactDeep(copy, policy.secrets ?? []);
}

/**
 * Writes the trace to every sink, in parallel, each bounded by `timeoutMs`. Returns the failures;
 * never throws. A sink that hangs is abandoned after the timeout (its write may still finish later).
 */
export async function emitTrace(
  sinks: readonly TraceSink[],
  trace: RunTrace,
  o: { timeoutMs?: number; secrets?: readonly string[] } = {},
): Promise<{ sink: string; message: string }[]> {
  if (sinks.length === 0) return [];
  const timeoutMs = o.timeoutMs ?? 2000;
  const errors: { sink: string; message: string }[] = [];
  await Promise.all(
    sinks.map(async (sink) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => sink.write(structuredClone(trace))),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`the sink did not finish within ${timeoutMs} ms`)),
              timeoutMs,
            );
          }),
        ]);
      } catch (e) {
        errors.push({
          sink: sink.name,
          message: redactText(e instanceof Error ? e.message : String(e), o.secrets ?? []).slice(
            0,
            300,
          ),
        });
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return errors;
}
