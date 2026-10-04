import { ToolRegistry } from '../tools/registry.js';
import { createPostgresTools } from '../tools/postgres/index.js';
import { createMcpServer } from './server.js';

/** Reads MCP_SOURCE_URL (the READ-ONLY source role) and builds the registry and a server factory. */
export function buildFromEnv(env: NodeJS.ProcessEnv): {
  registry: ToolRegistry;
  makeServer: () => ReturnType<typeof createMcpServer>;
} {
  const sourceUrl = env.MCP_SOURCE_URL;
  if (!sourceUrl)
    throw new Error(
      'set MCP_SOURCE_URL to the connection string of a READ-ONLY role (see provisionReaderRole)',
    );
  const { tools, connect } = createPostgresTools({ sourceUrl, log: (m) => console.error(m) });
  const registry = new ToolRegistry().registerAll(tools);
  return { registry, makeServer: () => createMcpServer({ registry, connect }) };
}
