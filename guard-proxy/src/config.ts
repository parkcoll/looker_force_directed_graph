const required = (k: string): string => {
  const v = process.env[k]
  if (!v) throw new Error(`Missing required env var: ${k}`)
  return v
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    apiKey: required('GOOGLE_API_KEY'),
    appId: required('GOOGLE_APP_ID'),
  },
  dbPath: process.env.DB_PATH ?? './data.db',
  approvalPageSecret: required('APPROVAL_PAGE_SECRET'),
}
