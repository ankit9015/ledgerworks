import { z } from 'zod';
import { isLLMError, type LLMError } from './errors.js';
import { collectStream } from './stream.js';
import {
  unknownCapabilities,
  type Capabilities,
  type LLMProvider,
  type ToolDefinition,
} from './types.js';

export type ProbeStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped';

export interface ProbeEvidence {
  check: 'models' | 'chat' | 'streaming' | 'tool_calls' | 'json_mode';
  status: ProbeStatus;
  /** what was seen, in words (never a key, header or body) */
  detail: string;
  latencyMs: number | null;
}

export interface ProbeReport {
  provider: string;
  model: string;
  /** ISO time of the probe; also the `probedAt` of every probed capability */
  probedAt: string;
  reachable: boolean;
  /** null when it could not be told (not reachable) */
  authOk: boolean | null;
  /** from listModels; null when the endpoint has no model list */
  modelExists: boolean | null;
  streaming: boolean | null;
  tools: boolean | null;
  jsonMode: boolean | null;
  /** latency of the basic chat call */
  latencyMs: number | null;
  totalMs: number;
  evidence: ProbeEvidence[];
  /** the same facts as capability flags, labelled "probed" with the timestamp; unknown where inconclusive */
  capabilities: Capabilities;
}

export interface ProbeOptions {
  /** per request, ms. Default 30,000. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** injectable for tests */
  now?: () => Date;
  timer?: () => number;
}

const PROBE_TOOL: ToolDefinition = {
  name: 'probe_echo',
  description: 'Returns the value it is given. Used only to test tool calling.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};
const probeArgs = z.object({ value: z.string() }).strict();

/**
 * "Test connection": checks a configured provider and reports with evidence what it can do:
 * reachable, auth ok, model exists (if listModels works), streaming, tool calls (a tiny forced tool
 * call whose returned arguments must validate), JSON mode, and the latency of the basic chat call.
 *
 * A capability is reported `false` only on evidence that the server refused or did not do it (a
 * 400, a reply without the tool call, arguments that do not validate). Timeouts and other
 * transient failures leave it `null` (unknown), not `false`.
 */
export async function probeProvider(
  provider: LLMProvider,
  o: ProbeOptions = {},
): Promise<ProbeReport> {
  const timer = o.timer ?? (() => performance.now());
  const t0 = timer();
  const timeoutMs = o.timeoutMs ?? 30_000;
  const evidence: ProbeEvidence[] = [];
  const probedAt = (o.now ?? (() => new Date()))().toISOString();
  const nonce = Math.random().toString(36).slice(2, 10);

  let reachable = false as boolean;
  let authOk = null as boolean | null;
  let modelExists = null as boolean | null;
  let streaming = null as boolean | null;
  let tools = null as boolean | null;
  let jsonMode = null as boolean | null;
  let latencyMs = null as number | null;

  const add = (
    check: ProbeEvidence['check'],
    status: ProbeStatus,
    detail: string,
    started: number | null,
  ): void => {
    evidence.push({
      check,
      status,
      detail: detail.slice(0, 300),
      latencyMs: started === null ? null : Math.round(timer() - started),
    });
  };
  const describe = (e: unknown): LLMError | null => (isLLMError(e) ? e : null);
  /** classifies a failed call: updates reachable/authOk and says whether the server refused the feature (4xx) */
  const classify = (e: unknown): { refused: boolean; stop: boolean } => {
    const err = describe(e);
    if (!err) return { refused: false, stop: false };
    if (err.kind === 'network' || err.kind === 'timeout') {
      return { refused: false, stop: err.kind === 'network' };
    }
    reachable = true;
    if (err.kind === 'auth_failed') {
      authOk = false;
      return { refused: false, stop: true };
    }
    return { refused: err.kind === 'bad_request' || err.kind === 'context_length', stop: false };
  };

  // 1. model list (also the cheapest reachability and auth check)
  if (provider.listModels) {
    const s = timer();
    try {
      const models = await provider.listModels(o.signal);
      reachable = true;
      authOk = true;
      modelExists = models.includes(provider.model);
      add(
        'models',
        modelExists ? 'pass' : 'fail',
        modelExists
          ? `model "${provider.model}" is in the list of ${models.length}`
          : `model "${provider.model}" is not among the ${models.length} listed`,
        s,
      );
    } catch (e) {
      const c = classify(e);
      add(
        'models',
        'inconclusive',
        `listing models failed: ${describe(e)?.kind ?? 'error'}${describe(e)?.status ? ` (HTTP ${describe(e)!.status})` : ''}`,
        s,
      );
      if (c.stop && authOk === false) return finish(true);
    }
  } else {
    add('models', 'skipped', 'this provider has no model list', null);
  }

  // 2. a tiny chat call: reachable, auth, latency
  {
    const s = timer();
    try {
      await provider.chat({
        messages: [{ role: 'user', content: 'Reply with the word: ok' }],
        maxTokens: 16,
        temperature: 0,
        timeoutMs,
        signal: o.signal,
      });
      reachable = true;
      authOk = true;
      latencyMs = Math.round(timer() - s);
      add('chat', 'pass', 'a basic chat call succeeded', s);
    } catch (e) {
      const c = classify(e);
      const err = describe(e);
      add(
        'chat',
        'fail',
        `the basic chat call failed: ${err?.kind ?? 'error'}${err?.status ? ` (HTTP ${err.status})` : ''}`,
        s,
      );
      if (c.stop || !reachable || authOk === false) return finish(true);
    }
  }

  // 3. streaming
  {
    const s = timer();
    try {
      const r = await collectStream(
        provider.stream({
          messages: [{ role: 'user', content: 'Reply with the word: ok' }],
          maxTokens: 16,
          temperature: 0,
          timeoutMs,
          signal: o.signal,
        }),
      );
      streaming = true;
      add('streaming', 'pass', `a stream completed (${r.finishReason})`, s);
    } catch (e) {
      const c = classify(e);
      const err = describe(e);
      if (c.refused) {
        streaming = false;
        add(
          'streaming',
          'fail',
          `the server refused streaming: ${err?.kind} (HTTP ${err?.status})`,
          s,
        );
      } else
        add(
          'streaming',
          'inconclusive',
          `streaming could not be checked: ${err?.kind ?? 'error'}`,
          s,
        );
    }
  }

  // 4. tool calls: a forced call whose arguments must validate
  {
    const s = timer();
    const messages = [
      { role: 'user' as const, content: `Call the tool probe_echo with the value "${nonce}".` },
    ];
    let result;
    let lastErr: unknown;
    for (const choice of [{ name: 'probe_echo' }, 'required' as const]) {
      try {
        result = await provider.chat({
          messages,
          tools: [PROBE_TOOL],
          toolChoice: choice,
          maxTokens: 64,
          temperature: 0,
          timeoutMs,
          signal: o.signal,
        });
        break;
      } catch (e) {
        lastErr = e;
        if (!classify(e).refused) break; // only a refusal is worth trying a looser tool choice for
      }
    }
    if (result) {
      const call = result.toolCalls[0];
      if (!call) {
        tools = false;
        add('tool_calls', 'fail', 'the reply contained no tool call although one was forced', s);
      } else if (call.name !== 'probe_echo') {
        tools = false;
        add(
          'tool_calls',
          'fail',
          `the reply called a different tool (${JSON.stringify(call.name.slice(0, 40))})`,
          s,
        );
      } else if (call.argumentsError) {
        tools = false;
        add(
          'tool_calls',
          'fail',
          `the tool arguments were not valid JSON: ${call.argumentsError.slice(0, 120)}`,
          s,
        );
      } else if (!probeArgs.safeParse(call.arguments).success) {
        tools = false;
        add(
          'tool_calls',
          'fail',
          'the returned tool arguments did not validate against the schema',
          s,
        );
      } else {
        tools = true;
        add(
          'tool_calls',
          'pass',
          `a forced tool call returned arguments that validate${result.quirks?.length ? ` (adapter normalised: ${result.quirks.join(', ')})` : ''}`,
          s,
        );
      }
    } else {
      const err = describe(lastErr);
      if (classify(lastErr).refused) {
        tools = false;
        add(
          'tool_calls',
          'fail',
          `the server refused a request with tools: ${err?.kind} (HTTP ${err?.status})`,
          s,
        );
      } else
        add(
          'tool_calls',
          'inconclusive',
          `tool calls could not be checked: ${err?.kind ?? 'error'}`,
          s,
        );
    }
  }

  // 5. JSON mode
  {
    const s = timer();
    try {
      const r = await provider.chat({
        messages: [
          { role: 'user', content: 'Return a JSON object with the key "ok" set to true.' },
        ],
        jsonMode: true,
        maxTokens: 40,
        temperature: 0,
        timeoutMs,
        signal: o.signal,
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.content ?? '');
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        jsonMode = true;
        add('json_mode', 'pass', 'JSON mode returned a JSON object', s);
      } else {
        jsonMode = false;
        add('json_mode', 'fail', 'JSON mode was accepted but the reply was not a JSON object', s);
      }
    } catch (e) {
      const c = classify(e);
      const err = describe(e);
      if (c.refused) {
        jsonMode = false;
        add(
          'json_mode',
          'fail',
          `the server refused JSON mode: ${err?.kind} (HTTP ${err?.status})`,
          s,
        );
      } else
        add(
          'json_mode',
          'inconclusive',
          `JSON mode could not be checked: ${err?.kind ?? 'error'}`,
          s,
        );
    }
  }
  return finish(false);

  function finish(early: boolean): ProbeReport {
    if (early) {
      for (const c of ['streaming', 'tool_calls', 'json_mode'] as const) {
        add(
          c,
          'skipped',
          reachable
            ? 'skipped: the server did not accept the basic request'
            : 'skipped: the server was not reachable',
          null,
        );
      }
    }
    const probed = <T>(
      v: T | null,
    ): { value: T | null; source: 'probed' | 'unknown'; probedAt?: string } =>
      v === null ? { value: null, source: 'unknown' } : { value: v, source: 'probed', probedAt };
    const capabilities: Capabilities = {
      ...unknownCapabilities(),
      tools: probed(tools),
      streaming: probed(streaming),
      jsonMode: probed(jsonMode),
    };
    return {
      provider: provider.id,
      model: provider.model,
      probedAt,
      reachable,
      authOk,
      modelExists,
      streaming,
      tools,
      jsonMode,
      latencyMs,
      totalMs: Math.round(timer() - t0),
      evidence,
      capabilities,
    };
  }
}

/** Probes the provider and stores what it found as "probed" capability flags on it. */
export async function testConnection(
  provider: LLMProvider,
  o: ProbeOptions = {},
): Promise<ProbeReport> {
  const report = await probeProvider(provider, o);
  const patch: Partial<Capabilities> = {};
  for (const k of ['tools', 'streaming', 'jsonMode'] as const) {
    if (report.capabilities[k].source === 'probed') patch[k] = report.capabilities[k];
  }
  provider.updateCapabilities?.(patch);
  return report;
}
