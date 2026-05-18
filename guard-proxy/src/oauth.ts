import type { FastifyInstance } from 'fastify'
import { google } from 'googleapis'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { db } from './db.js'
import { config } from './config.js'

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.file',
]

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const AUTH_CODE_TTL_MS = 5 * 60 * 1000

const googleOAuth = () =>
  new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    `${config.publicUrl}/auth/google/callback`,
  )

const opaqueToken = () => randomBytes(32).toString('base64url')

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === 'S256') {
    const computed = createHash('sha256').update(verifier).digest('base64url')
    return computed === challenge
  }
  return verifier === challenge
}

export function completePendingAuth(sessionId: string): { redirectUrl: string } | null {
  const session = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sessionId) as
    | {
        id: string
        client_id: string
        redirect_uri: string
        state: string | null
        code_challenge: string
        code_challenge_method: string
        user_id: string | null
      }
    | undefined
  if (!session || !session.user_id) return null

  const code = opaqueToken()
  db.prepare(
    `INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code,
    session.user_id,
    session.client_id,
    session.redirect_uri,
    session.code_challenge,
    session.code_challenge_method,
    Date.now() + AUTH_CODE_TTL_MS,
  )
  db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(session.id)

  const url = new URL(session.redirect_uri)
  url.searchParams.set('code', code)
  if (session.state) url.searchParams.set('state', session.state)
  return { redirectUrl: url.toString() }
}

export function userIdFromToken(token: string): string | null {
  const row = db
    .prepare('SELECT user_id, expires_at FROM access_tokens WHERE token = ?')
    .get(token) as { user_id: string; expires_at: number } | undefined
  if (!row || row.expires_at < Date.now()) return null
  return row.user_id
}

export async function getGoogleClient(userId: string) {
  const row = db.prepare('SELECT * FROM google_tokens WHERE user_id = ?').get(userId) as
    | { refresh_token: string; access_token: string | null; expires_at: number | null }
    | undefined
  if (!row) throw new Error(`No Google credentials for user ${userId}`)
  const client = googleOAuth()
  client.setCredentials({
    refresh_token: row.refresh_token,
    access_token: row.access_token ?? undefined,
    expiry_date: row.expires_at ?? undefined,
  })
  client.on('tokens', (tokens) => {
    if (tokens.access_token) {
      db.prepare(
        'UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?',
      ).run(tokens.access_token, tokens.expiry_date ?? null, userId)
    }
  })
  return client
}

export function registerOAuth(app: FastifyInstance) {
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    token_endpoint: `${config.publicUrl}/token`,
    registration_endpoint: `${config.publicUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  }))

  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: `${config.publicUrl}/mcp`,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
  }))

  app.post('/register', async (req, reply) => {
    const body = (req.body ?? {}) as {
      client_name?: string
      redirect_uris?: string[]
    }
    const clientId = randomUUID()
    const redirectUris = body.redirect_uris ?? []
    db.prepare(
      'INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
    ).run(clientId, body.client_name ?? null, JSON.stringify(redirectUris), Date.now())
    return reply.code(201).send({
      client_id: clientId,
      client_name: body.client_name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    })
  })

  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (
      q.response_type !== 'code' ||
      !q.client_id ||
      !q.redirect_uri ||
      !q.code_challenge
    ) {
      return reply.code(400).send({ error: 'invalid_request' })
    }
    const sessionId = randomUUID()
    db.prepare(
      `INSERT INTO auth_sessions (id, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      q.client_id,
      q.redirect_uri,
      q.state ?? null,
      q.code_challenge,
      q.code_challenge_method ?? 'plain',
      q.scope ?? null,
      Date.now(),
    )
    const url = googleOAuth().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_SCOPES,
      state: sessionId,
    })
    return reply.redirect(url)
  })

  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    if (!q.code || !q.state) return reply.code(400).send('Missing code or state')
    const session = db
      .prepare('SELECT * FROM auth_sessions WHERE id = ?')
      .get(q.state) as
      | {
          id: string
          client_id: string
          redirect_uri: string
          state: string | null
          code_challenge: string
          code_challenge_method: string
        }
      | undefined
    if (!session) return reply.code(400).send('Unknown auth session')

    const oauthClient = googleOAuth()
    const { tokens } = await oauthClient.getToken(q.code)
    oauthClient.setCredentials(tokens)
    const oauth2 = google.oauth2({ auth: oauthClient, version: 'v2' })
    const info = await oauth2.userinfo.get()
    const sub = info.data.id
    const email = info.data.email
    if (!sub || !email) return reply.code(500).send('Google did not return user info')

    let user = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(sub) as
      | { id: string }
      | undefined
    if (!user) {
      const userId = randomUUID()
      db.prepare(
        'INSERT INTO users (id, google_sub, google_email, created_at) VALUES (?, ?, ?, ?)',
      ).run(userId, sub, email, Date.now())
      user = { id: userId }
    } else {
      db.prepare('UPDATE users SET google_email = ? WHERE id = ?').run(email, user.id)
    }

    if (!tokens.refresh_token) {
      const existing = db
        .prepare('SELECT refresh_token FROM google_tokens WHERE user_id = ?')
        .get(user.id) as { refresh_token: string } | undefined
      if (!existing) {
        return reply
          .code(400)
          .send('Google did not return a refresh token. Revoke access at https://myaccount.google.com/permissions and retry.')
      }
      db.prepare(
        'UPDATE google_tokens SET access_token = ?, expires_at = ? WHERE user_id = ?',
      ).run(tokens.access_token ?? null, tokens.expiry_date ?? null, user.id)
    } else {
      db.prepare(
        `INSERT INTO google_tokens (user_id, refresh_token, access_token, expires_at, scopes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           refresh_token = excluded.refresh_token,
           access_token = excluded.access_token,
           expires_at = excluded.expires_at,
           scopes = excluded.scopes`,
      ).run(
        user.id,
        tokens.refresh_token,
        tokens.access_token ?? null,
        tokens.expiry_date ?? null,
        GOOGLE_SCOPES.join(' '),
      )
    }

    db.prepare('UPDATE auth_sessions SET user_id = ? WHERE id = ?').run(user.id, session.id)
    return reply.redirect(`${config.publicUrl}/scope-picker?session=${encodeURIComponent(session.id)}`)
  })

  app.post('/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri || !body.code_verifier) {
        return reply.code(400).send({ error: 'invalid_request' })
      }
      const authCode = db
        .prepare('SELECT * FROM auth_codes WHERE code = ? AND used = 0')
        .get(body.code) as
        | {
            code: string
            user_id: string
            client_id: string
            redirect_uri: string
            code_challenge: string
            code_challenge_method: string
            expires_at: number
          }
        | undefined
      if (!authCode) return reply.code(400).send({ error: 'invalid_grant' })
      if (authCode.expires_at < Date.now())
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'expired' })
      if (authCode.redirect_uri !== body.redirect_uri)
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'redirect mismatch' })
      if (body.client_id && authCode.client_id !== body.client_id)
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'client mismatch' })
      if (!verifyPkce(body.code_verifier, authCode.code_challenge, authCode.code_challenge_method))
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'pkce' })

      db.prepare('UPDATE auth_codes SET used = 1 WHERE code = ?').run(body.code)
      const accessToken = opaqueToken()
      const refreshToken = opaqueToken()
      db.prepare(
        'INSERT INTO access_tokens (token, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
      ).run(accessToken, authCode.user_id, authCode.client_id, Date.now() + ACCESS_TOKEN_TTL_MS)
      db.prepare(
        'INSERT INTO refresh_tokens (token, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
      ).run(refreshToken, authCode.user_id, authCode.client_id, Date.now() + REFRESH_TOKEN_TTL_MS)
      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
      })
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return reply.code(400).send({ error: 'invalid_request' })
      const rt = db.prepare('SELECT * FROM refresh_tokens WHERE token = ?').get(body.refresh_token) as
        | { token: string; user_id: string; client_id: string; expires_at: number }
        | undefined
      if (!rt || rt.expires_at < Date.now())
        return reply.code(400).send({ error: 'invalid_grant' })
      const accessToken = opaqueToken()
      db.prepare(
        'INSERT INTO access_tokens (token, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
      ).run(accessToken, rt.user_id, rt.client_id, Date.now() + ACCESS_TOKEN_TTL_MS)
      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: rt.token,
      })
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' })
  })
}
