/**
 * pnpm mcp:inspect
 *
 * Prints how to connect to the MCP servers with the MCP Inspector and with a Claude Desktop style
 * client. It starts nothing and reads no secret: every value that would be one is a placeholder.
 */
const dir = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const stdioConfig = {
  mcpServers: {
    'ledgerworks-postgres': {
      command: 'node',
      args: ['--import', 'tsx', `${dir}/src/mcp/stdio-main.ts`],
      env: {
        MCP_SOURCE_URL:
          'postgres://READONLY_ROLE:PASSWORD_PLACEHOLDER@localhost:5432/YOUR_DATABASE',
      },
    },
  },
};

const httpConfig = {
  mcpServers: {
    'ledgerworks-postgres-http': {
      url: 'http://127.0.0.1:8765/mcp',
      headers: { Authorization: 'Bearer <YOUR_MCP_AUTH_TOKEN>' },
    },
  },
};

console.log(`# Connecting to the ledgerworks MCP tools (list_slow_queries, get_query_plan, describe_schema)

The tools are READ-ONLY. Use a read-only database role (provisionReaderRole in core/src/shadow/source.ts creates one).

## 1. MCP Inspector (stdio)

  npx @modelcontextprotocol/inspector node --import tsx ${dir}/src/mcp/stdio-main.ts

  In the Inspector's environment variables add:  MCP_SOURCE_URL = postgres://READONLY_ROLE:PASSWORD_PLACEHOLDER@localhost:5432/YOUR_DATABASE

## 2. MCP Inspector (Streamable HTTP)

  Start the server (loopback only; the token is read from the environment and never printed):

  MCP_SOURCE_URL='postgres://READONLY_ROLE:PASSWORD_PLACEHOLDER@localhost:5432/YOUR_DATABASE' \\
  MCP_AUTH_TOKEN='<generate a random string of 16 or more characters>' \\
  pnpm --filter @ledgerworks/core mcp:http

  then run  npx @modelcontextprotocol/inspector  and choose transport "Streamable HTTP",
  URL http://127.0.0.1:8765/mcp, and add the header  Authorization: Bearer <YOUR_MCP_AUTH_TOKEN>

## 3. Claude Desktop style configuration (stdio)

${JSON.stringify(stdioConfig, null, 2)}

## 4. A client that supports HTTP servers with headers

${JSON.stringify(httpConfig, null, 2)}

Notes
  - Replace every placeholder yourself. Nothing here is a real credential.
  - The HTTP server refuses requests without the bearer token, with an Origin header that is not allowed,
    with a Host header that is not a loopback name, bodies over 1 MiB, and more than 120 requests a minute
    per client. It refuses to start on a non-loopback address without a token and MCP_ALLOW_NON_LOOPBACK=1;
    exposing it publicly is out of scope for now.
  - This script only prints instructions. It does not start the Inspector, and it has not been used to run it.`);
