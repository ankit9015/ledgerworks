import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Db } from '../db/tenant.js';

export const tracer = () => trace.getTracer('ledgerline');

/**
 * Starts tracing. Without an exporter nothing is sent (the tracer stays a no-op).
 * Spans never carry API keys, tenant ids or SQL text: only route patterns, status codes, SQL
 * operation names (BEGIN, SELECT, ...), and for queue spans the job id, type, queue and attempt.
 */
export function initTracing(options: {
  serviceName: string;
  /** OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces */
  endpoint?: string | undefined;
  /** For tests: an in-memory exporter (spans are exported immediately). */
  exporter?: SpanExporter | undefined;
}): { shutdown: () => Promise<void> } {
  const exporter =
    options.exporter ??
    (options.endpoint ? new OTLPTraceExporter({ url: options.endpoint }) : undefined);
  if (!exporter) return { shutdown: async () => {} };
  const processor = options.exporter
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName }),
    spanProcessors: [processor],
  });
  provider.register();
  return { shutdown: () => provider.shutdown() };
}

/** Runs fn inside a span (child of the active one), recording errors. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).name });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** One HTTP server span per request (route pattern, method, status), continuing an incoming trace. */
export function registerHttpTracing(app: FastifyInstance): void {
  const spans = new WeakMap<object, Span>();
  app.addHook('onRequest', (req, _reply, done) => {
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer().startSpan(
      `${req.method} request`,
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method } },
      parent,
    );
    spans.set(req, span);
    // Everything later in this request's lifecycle (handler, database calls) runs inside the span.
    context.with(trace.setSpan(parent, span), done);
  });
  app.addHook('onResponse', async (req, reply) => {
    const span = spans.get(req);
    if (!span) return;
    const route = req.routeOptions?.url ?? 'unmatched';
    span.updateName(`${req.method} ${route}`);
    span.setAttributes({
      'http.route': route,
      'http.response.status_code': reply.statusCode,
    });
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
}

function operationOf(text: unknown): string {
  const sql =
    typeof text === 'string' ? text : ((text as { text?: string } | undefined)?.text ?? '');
  const m = /^\s*([A-Za-z]+)/.exec(sql);
  return m ? m[1]!.toUpperCase() : 'UNKNOWN';
}

/**
 * Wraps a pool so each query becomes a client span named after its operation only (never the SQL
 * text or parameters, which can hold tenant data).
 */
export function instrumentDb(db: Db): Db {
  const run =
    (call: (...a: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]): Promise<unknown> =>
      withSpan(
        `db ${operationOf(args[0])}`,
        { 'db.system': 'postgresql', 'db.operation.name': operationOf(args[0]) },
        () => call(...args),
        SpanKind.CLIENT,
      );
  const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return run((...a) => (target.query as (...x: unknown[]) => Promise<unknown>)(...a));
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
  return {
    query: run((...a) => (db.query as (...x: unknown[]) => Promise<unknown>)(...a)) as Db['query'],
    connect: (async () => wrapClient(await db.connect())) as Db['connect'],
  };
}
