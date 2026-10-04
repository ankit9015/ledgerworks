import {
  SpanKind,
  SpanStatusCode,
  context,
  trace as otelTrace,
  type Attributes,
  type Tracer,
} from '@opentelemetry/api';
import type { RunTrace } from '../agent/types.js';
import { prepareForExport, type TraceSink } from './sinks.js';

/**
 * Bridges a finished run to OpenTelemetry using the app's existing setup (the global tracer
 * provider that e.g. Ledgerline's initTracing registers, or a tracer you pass): one `agent.run`
 * span, and under it one `agent.model_call` span per model call and one `agent.tool_call` span per
 * tool call, with their real start times and durations. Attributes hold names, counts, hashes,
 * sizes, token numbers, outcomes and stop reasons: never prompts, tool arguments or results, never
 * keys (the same rules as the JSONL file; debug content is never put in spans).
 */
export class OtelSink implements TraceSink {
  readonly name = 'otel';
  constructor(private o: { tracer?: Tracer; secrets?: readonly string[] } = {}) {}

  write(runTrace: RunTrace): void {
    const t = prepareForExport(runTrace, { includeDebugContent: false, secrets: this.o.secrets });
    const tracer = this.o.tracer ?? otelTrace.getTracer('ledgerworks-agent');
    const start = new Date(t.startedAt);
    const end = new Date(t.finishedAt);
    const root = tracer.startSpan(
      'agent.run',
      {
        startTime: start,
        kind: SpanKind.INTERNAL,
        attributes: {
          'agent.run_id': t.runId,
          'agent.stop_reason': t.stopReason,
          'agent.steps': t.totals.steps,
          'agent.tool_calls': t.totals.toolCalls,
          'agent.tool_errors': t.totals.toolErrors,
          'agent.repairs': t.totals.repairs,
          'agent.failures': t.totals.failures,
          'agent.truncations': t.totals.truncations,
          'llm.tokens.prompt': t.totals.promptTokens,
          'llm.tokens.completion': t.totals.completionTokens,
          'llm.tokens.total': t.totals.totalTokens,
          'llm.tokens.estimated': t.totals.tokensEstimated,
        },
      },
      context.active(),
    );
    if (t.stopReason !== 'final_answer' && t.stopReason !== 'cancelled')
      root.setStatus({ code: SpanStatusCode.ERROR, message: t.stopReason });
    const parent = otelTrace.setSpan(context.active(), root);
    for (const step of t.steps) {
      const m = step.model;
      const mStart = new Date(m.startedAt);
      const attrs: Attributes = {
        'agent.step': step.index,
        'llm.provider': m.provider,
        'llm.model': m.model,
        'llm.latency_ms': m.latencyMs,
      };
      if (m.finishReason) attrs['llm.finish_reason'] = m.finishReason;
      if (m.usage) {
        attrs['llm.tokens.prompt'] = m.usage.promptTokens;
        attrs['llm.tokens.completion'] = m.usage.completionTokens;
        attrs['llm.tokens.total'] = m.usage.totalTokens;
        attrs['llm.tokens.estimated'] = m.usage.source === 'estimated';
      }
      if (m.routing) {
        attrs['llm.routing.provider'] = m.routing.provider;
        attrs['llm.routing.skipped_count'] = m.routing.skipped.length;
        if (m.routing.skipped.length)
          attrs['llm.routing.skipped'] = m.routing.skipped
            .map((s) => `${s.provider}: ${s.reason}`)
            .join('; ')
            .slice(0, 300);
      }
      if (m.quirks?.length) attrs['llm.quirks'] = m.quirks.join(',');
      const span = tracer.startSpan(
        'agent.model_call',
        { startTime: mStart, kind: SpanKind.CLIENT, attributes: attrs },
        parent,
      );
      if (m.error) {
        attrs['llm.error.kind'] = m.error.kind;
        span.setAttribute('llm.error.kind', m.error.kind);
        span.setStatus({ code: SpanStatusCode.ERROR, message: m.error.kind });
      }
      span.end(new Date(mStart.getTime() + m.latencyMs));
      for (const c of step.toolCalls) {
        const cStart = new Date(c.startedAt);
        const toolSpan = tracer.startSpan(
          'agent.tool_call',
          {
            startTime: cStart,
            kind: SpanKind.INTERNAL,
            attributes: {
              'agent.step': step.index,
              // a model-supplied name of an unknown tool is untrusted text: not recorded
              'tool.name': c.outcome === 'unknown_tool' ? '(unknown)' : c.name.slice(0, 64),
              'tool.outcome': c.outcome,
              'tool.repair': c.repair,
              'tool.truncated': c.truncated,
              'tool.abandoned': c.abandoned === true,
              'tool.arguments_hash': c.argumentsHash,
              'tool.arguments_bytes': c.argumentsBytes,
              'tool.result_hash': c.resultHash,
              'tool.result_bytes': c.resultBytes,
              'tool.approval': c.approval,
              'tool.latency_ms': c.latencyMs,
            },
          },
          parent,
        );
        if (c.outcome !== 'ok' && c.outcome !== 'invalid_arguments')
          toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: c.outcome });
        toolSpan.end(new Date(cStart.getTime() + c.latencyMs));
      }
    }
    root.end(end);
  }
}
