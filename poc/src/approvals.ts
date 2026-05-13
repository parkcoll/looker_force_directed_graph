import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db } from './db.js'
import { config } from './config.js'

type Decision = 'approve' | 'deny'
type Resolver = (decision: Decision) => void

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const pendingResolvers = new Map<string, Resolver>()

export async function requestApproval(
  userId: string,
  tool: string,
  args: unknown,
): Promise<Decision> {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO pending_approvals (id, user_id, tool, args, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, userId, tool, JSON.stringify(args), 'pending', Date.now())

  return new Promise<Decision>((resolve) => {
    pendingResolvers.set(id, resolve)
    setTimeout(() => {
      if (!pendingResolvers.has(id)) return
      pendingResolvers.delete(id)
      db.prepare(
        "UPDATE pending_approvals SET status = 'timeout', decided_at = ? WHERE id = ? AND status = 'pending'",
      ).run(Date.now(), id)
      resolve('deny')
    }, APPROVAL_TIMEOUT_MS)
  })
}

function authorized(req: { query: unknown }): boolean {
  const q = (req.query ?? {}) as Record<string, string | undefined>
  return q.secret === config.approvalPageSecret
}

export function registerApprovals(app: FastifyInstance) {
  app.get('/approvals', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send('Unauthorized')
    return reply.sendFile('approvals.html')
  })

  app.get('/api/pending', async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' })
    const rows = db
      .prepare(
        "SELECT id, user_id, tool, args, created_at FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50",
      )
      .all() as Array<{ id: string; user_id: string; tool: string; args: string; created_at: number }>
    return rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      tool: r.tool,
      args: JSON.parse(r.args),
      created_at: r.created_at,
    }))
  })

  app.post<{ Params: { id: string }; Body: { decision: Decision } }>(
    '/api/approve/:id',
    async (req, reply) => {
      if (!authorized(req)) return reply.code(401).send({ error: 'unauthorized' })
      const { id } = req.params
      const decision = req.body?.decision
      if (decision !== 'approve' && decision !== 'deny')
        return reply.code(400).send({ error: 'invalid_decision' })

      const row = db
        .prepare("SELECT id FROM pending_approvals WHERE id = ? AND status = 'pending'")
        .get(id) as { id: string } | undefined
      if (!row) return reply.code(404).send({ error: 'not_found_or_resolved' })

      db.prepare(
        'UPDATE pending_approvals SET status = ?, decided_at = ? WHERE id = ?',
      ).run(decision, Date.now(), id)
      const resolver = pendingResolvers.get(id)
      if (resolver) {
        pendingResolvers.delete(id)
        resolver(decision)
      }
      return reply.send({ ok: true })
    },
  )
}
