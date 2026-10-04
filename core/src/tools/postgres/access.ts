import pg from 'pg';
import type { ConnectionFactory } from '../../db/cancellable.js';
import { SourceWritableError, assertSourceReadOnly } from '../../shadow/source.js';
import { ToolError } from '../registry.js';

export interface PostgresToolsConfig {
  /** connection string of the READ-ONLY source role (see provisionReaderRole). Never logged. */
  sourceUrl: string;
  /** server-side limit of every statement, ms. Default 10,000. */
  statementTimeoutMs?: number;
  /** default 2,000 */
  lockTimeoutMs?: number;
  /** replace constants in the query text of list_slow_queries with "?". Default TRUE. */
  redactSlowQueryLiterals?: boolean;
  /** replace constants in the plan text of get_query_plan (filters, conditions). Default false: the caller wrote the query. */
  redactPlanLiterals?: boolean;
  /** proceed although the role can write (the tools themselves never write). Logged by assertSourceReadOnly. */
  allowWritableSource?: boolean;
  applicationName?: string;
  log?: (message: string) => void;
}

export interface SourceAccess {
  /** a read-only session: default_transaction_read_only on, statement and lock timeouts set at connect */
  connect: ConnectionFactory;
  /** the same readiness check as the shadow runner, once; throws ToolError('source_not_read_only') */
  ensureReadOnly(): Promise<void>;
  statementTimeoutMs: number;
}

export function createSourceAccess(cfg: PostgresToolsConfig): SourceAccess {
  const statementTimeoutMs = cfg.statementTimeoutMs ?? 10_000;
  const lockTimeoutMs = cfg.lockTimeoutMs ?? 2_000;
  let ready: Promise<void> | undefined;
  return {
    statementTimeoutMs,
    async connect() {
      const c = new pg.Client({
        connectionString: cfg.sourceUrl,
        application_name: cfg.applicationName ?? 'ledgerworks-tool',
        options: [
          '-c default_transaction_read_only=on',
          `-c statement_timeout=${statementTimeoutMs}`,
          `-c lock_timeout=${lockTimeoutMs}`,
          '-c idle_in_transaction_session_timeout=30000',
        ].join(' '),
      });
      c.on('error', () => undefined);
      await c.connect();
      const r = await c.query<{ v: string }>(
        "SELECT current_setting('default_transaction_read_only') AS v",
      );
      if (r.rows[0]?.v !== 'on') {
        await c.end();
        throw new ToolError('source_not_read_only', 'the session is not read-only');
      }
      return c;
    },
    ensureReadOnly() {
      ready ??= assertSourceReadOnly(cfg.sourceUrl, {
        allowWritableSource: cfg.allowWritableSource,
        log: cfg.log,
      }).then(
        () => undefined,
        (e: unknown) => {
          ready = undefined; // do not cache a failure: the role may be fixed
          if (e instanceof SourceWritableError) {
            throw new ToolError(
              'source_not_read_only',
              `the source role can write (${e.reasons.slice(0, 3).join('; ')}); use a read-only role`,
            );
          }
          throw new ToolError('source_unreachable', 'could not check the source role');
        },
      );
      return ready;
    },
  };
}
