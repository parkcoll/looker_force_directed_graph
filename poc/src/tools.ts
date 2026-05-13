import { z } from 'zod'
import { google } from 'googleapis'
import { getGoogleClient } from './oauth.js'
import { requestApproval } from './approvals.js'

type Content = { type: 'text'; text: string }
export type ToolResult = { content: Content[]; isError?: boolean }

const needsAuth = (userId: string | null): ToolResult | null =>
  userId
    ? null
    : { content: [{ type: 'text', text: 'Not authenticated. Reconnect the account.' }], isError: true }

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
      "Lists files in the user's Google Drive. Read-only, auto-approved. Returns id, name, mimeType, modifiedTime, webViewLink.",
    shape: {
      query: z
        .string()
        .optional()
        .describe("Optional Drive search query, e.g. \"name contains 'budget'\"."),
      pageSize: z.number().int().min(1).max(50).default(10),
    },
    handler: async (
      { query, pageSize }: { query?: string; pageSize: number },
      userId: string | null,
    ): Promise<ToolResult> => {
      const err = needsAuth(userId)
      if (err) return err
      const auth = await getGoogleClient(userId!)
      const drive = google.drive({ version: 'v3', auth })
      const res = await drive.files.list({
        q: query,
        pageSize,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(res.data.files ?? [], null, 2) }],
      }
    },
  },
  {
    name: 'drive_create_doc',
    description:
      'Create a new Google Doc with the given title and body content. Requires human approval before executing.',
    shape: {
      title: z.string().min(1).describe('Title of the new document.'),
      content: z.string().describe('Plain text body of the new document.'),
    },
    handler: async (
      { title, content }: { title: string; content: string },
      userId: string | null,
    ): Promise<ToolResult> => {
      const err = needsAuth(userId)
      if (err) return err
      const decision = await requestApproval(userId!, 'drive_create_doc', { title, content })
      if (decision !== 'approve') {
        return {
          content: [{ type: 'text', text: 'User denied (or timed out on) approval. Action was not performed.' }],
          isError: true,
        }
      }
      const auth = await getGoogleClient(userId!)
      const docs = google.docs({ version: 'v1', auth })
      const created = await docs.documents.create({ requestBody: { title } })
      const docId = created.data.documentId
      if (!docId) {
        return { content: [{ type: 'text', text: 'Failed to create document.' }], isError: true }
      }
      if (content.length > 0) {
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
            text: `Created: https://docs.google.com/document/d/${docId}/edit`,
          },
        ],
      }
    },
  },
] as const
