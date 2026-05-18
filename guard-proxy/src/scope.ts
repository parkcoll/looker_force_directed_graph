import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.js'
import { config } from './config.js'
import { getGoogleClient, completePendingAuth } from './oauth.js'

export type DriveScope = { folder_id: string; folder_name: string }

export function getScope(userId: string): DriveScope | null {
  const row = db
    .prepare('SELECT folder_id, folder_name FROM drive_scopes WHERE user_id = ?')
    .get(userId) as DriveScope | undefined
  return row ?? null
}

export function setScope(userId: string, folderId: string, folderName: string) {
  db.prepare(
    `INSERT INTO drive_scopes (user_id, folder_id, folder_name, set_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       folder_id = excluded.folder_id,
       folder_name = excluded.folder_name,
       set_at = excluded.set_at`,
  ).run(userId, folderId, folderName, Date.now())
}

function userIdForSession(sessionId: string): string | null {
  const row = db
    .prepare('SELECT user_id FROM auth_sessions WHERE id = ?')
    .get(sessionId) as { user_id: string | null } | undefined
  return row?.user_id ?? null
}

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

export function registerScope(app: FastifyInstance) {
  app.get('/scope-picker', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (!q.session) return reply.code(400).send('Missing session')
    if (!userIdForSession(q.session)) return reply.code(400).send('Unknown or completed session')

    const html = await readFile(path.join(publicDir, 'scope-picker.html'), 'utf8')
    return reply
      .type('text/html')
      .send(
        html
          .replaceAll('{{API_KEY}}', JSON.stringify(config.google.apiKey))
          .replaceAll('{{APP_ID}}', JSON.stringify(config.google.appId))
          .replaceAll('{{SESSION_ID}}', JSON.stringify(q.session)),
      )
  })

  app.get('/api/scope/picker-token', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (!q.session) return reply.code(400).send({ error: 'missing_session' })
    const userId = userIdForSession(q.session)
    if (!userId) return reply.code(400).send({ error: 'invalid_session' })

    const auth = await getGoogleClient(userId)
    const token = await auth.getAccessToken()
    if (!token.token) return reply.code(500).send({ error: 'no_token' })
    return { access_token: token.token }
  })

  app.post<{ Body: { session?: string; folder_id?: string; folder_name?: string } }>(
    '/api/scope/save',
    async (req, reply) => {
      const { session, folder_id, folder_name } = req.body ?? {}
      if (!session || !folder_id || !folder_name) {
        return reply.code(400).send({ error: 'missing_fields' })
      }
      const userId = userIdForSession(session)
      if (!userId) return reply.code(400).send({ error: 'invalid_session' })

      setScope(userId, folder_id, folder_name)
      const completion = completePendingAuth(session)
      if (!completion) return reply.code(500).send({ error: 'auth_completion_failed' })
      return reply.send({ redirect_url: completion.redirectUrl })
    },
  )
}
