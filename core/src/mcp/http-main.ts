/**
 * MCP server over Streamable HTTP, loopback only by default.
 *
 *   MCP_SOURCE_URL=postgres://reader:...@host:5432/db MCP_AUTH_TOKEN=<random, 16+ chars> pnpm --filter @ledgerworks/core mcp:http
 *
 * MCP_PORT (default 8765), MCP_HOST (default 127.0.0.1), MCP_ALLOWED_ORIGINS (comma separated, default none),
 * MCP_ALLOW_NON_LOOPBACK=1 (only with a token; exposing it publicly is out of scope for now).
 * The token is read from the environment and never printed.
 */
import { startMcpHttp } from './http.js';
import { buildFromEnv } from './main-common.js';

try {
  const { makeServer } = buildFromEnv(process.env);
  const h = await startMcpHttp({
    createServer: makeServer,
    host: process.env.MCP_HOST,
    port: Number(process.env.MCP_PORT ?? 8765),
    token: process.env.MCP_AUTH_TOKEN,
    allowNonLoopback: process.env.MCP_ALLOW_NON_LOOPBACK === '1',
    allowedOrigins: process.env.MCP_ALLOWED_ORIGINS?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    log: (m) => console.error(m),
  });
  console.error(`ledgerworks MCP server listening on ${h.url} (bearer token required)`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
