import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tools } from './tools.js'
import { userIdFromToken } from './oauth.js'
import { config } from './config.js'

const userContext = new AsyncLocalStorage<{ userId: string | null }>()

export function getCurrentUserId(): string | null {
  return userContext.getStore()?.userId ?? null
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'guard-proxy', version: '0.1.0' })
  for (const t of tools) {
    server.tool(
      t.name,
      t.description,
      t.shape as Parameters<typeof server.tool>[2],
      async (args: unknown) =>
        // Casting because each tool's handler has its own arg shape; runtime is validated by zod.
        (t.handler as (a: unknown, u: string | null) => Promise<ReturnType<typeof t.handler>>)(
          args,
          getCurrentUserId(),
        ),
    )
  }
  return server
}

export function registerMcp(app: FastifyInstance) {
  app.all('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization
    let userId: string | null = null
    if (authHeader?.startsWith('Bearer ')) {
      userId = userIdFromToken(authHeader.slice(7).trim())
    }

    if (!userId) {
      const wwwAuth =
        `Bearer realm="${config.publicUrl}", ` +
        `resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`
      reply.header('WWW-Authenticate', wwwAuth).code(401)
      return {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      }
    }

    const server = buildMcpServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.hijack()
    await server.connect(transport)

    await userContext.run({ userId }, async () => {
      await transport.handleRequest(
        req.raw as IncomingMessage,
        reply.raw as ServerResponse,
        req.body,
      )
    })
  })
}
