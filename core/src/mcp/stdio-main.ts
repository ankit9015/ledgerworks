/**
 * MCP server over stdio (one client, the process that started this one).
 *
 *   MCP_SOURCE_URL=postgres://reader:...@host:5432/db pnpm --filter @ledgerworks/core mcp:stdio
 *
 * stdout carries only the protocol; anything else goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildFromEnv } from './main-common.js';

try {
  const { makeServer } = buildFromEnv(process.env);
  await makeServer().connect(new StdioServerTransport());
  console.error('ledgerworks MCP server (stdio) ready');
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
