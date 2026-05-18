import { z } from 'zod'
import { google } from 'googleapis'
import { getGoogleClient } from './oauth.js'
import { getScope } from './scope.js'

type Content = { type: 'text'; text: string }
export type ToolResult = { content: Content[]; isError?: boolean }

const err = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

const requireAuth = (userId: string | null): ToolResult | null =>
  userId ? null : err('Not authenticated. Reconnect the account.')

const requireScope = (userId: string) => {
  const scope = getScope(userId)
  if (!scope) return { scope: null, error: err('No folder scope set. Reconnect to choose one.') }
  return { scope, error: null }
}

export const tools = [
  {
    name: 'ping',
    description: 'Health check. Echoes back the provided message.',
    shape: { message: z.string().describe('Any text to echo back.') },
    handler: async (
      { message }: { message: string },
      _userId: string | null,
    ): Promise<ToolResult> => ({
      content: [{ type: 'text', text: `pong: ${message}` }],
    }),
  },
  {
    name: 'sleep_test',
    description:
      'Sleeps for N seconds then returns. Used to probe the ChatGPT tool-call timeout budget.',
    shape: {
      seconds: z.number().int().min(1).max(900).describe('How many seconds to sleep (1-900).'),
    },
    handler: async (
      { seconds }: { seconds: number },
      _userId: string | null,
    ): Promise<ToolResult> => {
      const started = Date.now()
      await new Promise((r) => setTimeout(r, seconds * 1000))
      return {
        content: [{ type: 'text', text: `slept ${((Date.now() - started) / 1000).toFixed(2)}s` }],
      }
    },
  },
  {
    name: 'drive_list_files',
    description:
      "Lists files inside the folder the user authorized for this connection. Cannot see anything outside that folder.",
    shape: {
      nameContains: z.string().optional().describe('Optional substring to filter file names by.'),
      pageSize: z.number().int().min(1).max(50).default(20),
    },
    handler: async (
      { nameContains, pageSize }: { nameContains?: string; pageSize: number },
      userId: string | null,
    ): Promise<ToolResult> => {
      const authErr = requireAuth(userId)
      if (authErr) return authErr
      const { scope, error } = requireScope(userId!)
      if (error) return error

      const auth = await getGoogleClient(userId!)
      const drive = google.drive({ version: 'v3', auth })
      const parts = [`'${scope!.folder_id}' in parents`, 'trashed = false']
      if (nameContains) parts.push(`name contains '${nameContains.replace(/'/g, "\\'")}'`)
      const res = await drive.files.list({
        q: parts.join(' and '),
        pageSize,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
      })
      return {
        content: [
          {
            type: 'text',
            text: `Scope: ${scope!.folder_name}\n\n${JSON.stringify(res.data.files ?? [], null, 2)}`,
          },
        ],
      }
    },
  },
  {
    name: 'drive_create_doc',
    description:
      'Create a new Google Doc inside the authorized folder. Cannot create outside the folder.',
    shape: {
      title: z.string().min(1).describe('Title of the new document.'),
      content: z.string().describe('Plain text body of the new document.'),
    },
    handler: async (
      { title, content }: { title: string; content: string },
      userId: string | null,
    ): Promise<ToolResult> => {
      const authErr = requireAuth(userId)
      if (authErr) return authErr
      const { scope, error } = requireScope(userId!)
      if (error) return error

      const auth = await getGoogleClient(userId!)
      const drive = google.drive({ version: 'v3', auth })
      const created = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: 'application/vnd.google-apps.document',
          parents: [scope!.folder_id],
        },
        fields: 'id',
      })
      const docId = created.data.id
      if (!docId) return err('Failed to create document.')

      if (content.length > 0) {
        const docs = google.docs({ version: 'v1', auth })
        await docs.documents.batchUpdate({
          documentId: docId,
          requestBody: {
            requests: [{ insertText: { location: { index: 1 }, text: content } }],
          },
        })
      }
      return {
        content: [
          {
            type: 'text',
            text: `Created in "${scope!.folder_name}": https://docs.google.com/document/d/${docId}/edit`,
          },
        ],
      }
    },
  },
] as const
