import { DurableObject } from 'cloudflare:workers';

/** MCP session object. The MCP server (McpAgent from the Agents SDK) replaces this in phase 3. */
export class McpAgent extends DurableObject<Env> {
  override async fetch(): Promise<Response> {
    return Response.json({ error: 'The MCP server is not available yet.' }, { status: 501 });
  }
}
