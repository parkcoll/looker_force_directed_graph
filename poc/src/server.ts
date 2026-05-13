import Fastify from 'fastify'
import staticPlugin from '@fastify/static'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { registerOAuth } from './oauth.js'
import { registerApprovals } from './approvals.js'
import { registerMcp } from './mcp.js'
import './db.js'

const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 })

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
)

await app.register(staticPlugin, { root: publicDir, serve: false })

registerOAuth(app)
registerApprovals(app)
registerMcp(app)

app.get('/', async (_, reply) =>
  reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Guard Proxy POC</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#f3f3f3;padding:.1rem .4rem;border-radius:3px}</style>
</head><body>
<h1>Guard Proxy POC</h1>
<p>Status: <strong>running</strong></p>
<ul>
  <li>MCP endpoint: <code>${config.publicUrl}/mcp</code></li>
  <li>OAuth discovery: <code>${config.publicUrl}/.well-known/oauth-protected-resource</code></li>
  <li>Approvals UI: <code>${config.publicUrl}/approvals?secret=...</code></li>
</ul>
</body></html>`),
)

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() =>
    app.log.info(`guard-proxy listening on :${config.port} (public ${config.publicUrl})`),
  )
  .catch((err) => {
    app.log.error(err)
    process.exit(1)
  })
