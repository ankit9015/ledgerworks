import type { ToolSpec } from '../registry.js';
import { createSourceAccess, type PostgresToolsConfig } from './access.js';
import { describeSchemaTool } from './describe-schema.js';
import { getQueryPlanTool } from './get-query-plan.js';
import { listSlowQueriesTool } from './list-slow-queries.js';

export * from './access.js';
export { describeSchemaTool, getQueryPlanTool, listSlowQueriesTool };

/** The three read-only Postgres tools, sharing one source access (and one read-only readiness check). */
export function createPostgresTools(cfg: PostgresToolsConfig): {
  tools: ToolSpec[];
  connect: ReturnType<typeof createSourceAccess>['connect'];
} {
  const access = createSourceAccess(cfg);
  return {
    tools: [
      listSlowQueriesTool(cfg, access),
      getQueryPlanTool(cfg, access),
      describeSchemaTool(cfg, access),
    ],
    connect: access.connect,
  };
}
