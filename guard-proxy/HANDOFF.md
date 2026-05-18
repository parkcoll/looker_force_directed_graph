# Guard Proxy — Session Handoff

A scoped MCP proxy that lets users connect ChatGPT to their Google Drive but only to **one folder of their choosing**. ChatGPT can read and write inside that folder; Google itself blocks access to anything else.

This document is a handoff for picking up where the previous Claude Code session left off. The previous session had its GitHub access scoped to a different repo and couldn't push, so all the code lives only in a sandbox + tarball. Start the next session with `parkcoll/guard-proxy` mounted from the beginning and the code can flow normally.

---

## What this is

A small Node/TypeScript service that sits between ChatGPT (or any MCP client) and Google. To the AI client it is an MCP server with a few tools. To Google it is a normal OAuth-using web app. Its job is to enforce a **per-user folder scope** on every Drive operation, so that even if the AI is jailbroken or hallucinates a destructive call, it physically cannot reach anything outside the user's chosen folder.

**Wedge thesis**: people are nervous about plugging ChatGPT into their whole Drive. Giving them one folder, picked through Google's own picker UI, with Google-enforced scope, is a strong reassurance pitch. The setup is one OAuth flow plus one folder click — under 30 seconds.

---

## Architecture

```
ChatGPT  ──MCP/HTTPS──▶  Guard Proxy  ──Google APIs──▶  Google
                            │
                            ├── OAuth 2.0 server (for ChatGPT to auth users)
                            ├── OAuth 2.0 client (for users to auth us to Google)
                            ├── /scope-picker (Google Drive Picker UI)
                            └── SQLite (users, tokens, scopes, sessions)
```

### Connection flow

1. User adds a connector in ChatGPT pointing at `<PUBLIC_URL>/mcp`
2. ChatGPT discovers OAuth via `/.well-known/oauth-protected-resource`
3. ChatGPT redirects user's browser to `/authorize` → we redirect to Google sign-in
4. Google calls back to `/auth/google/callback` → we store tokens and redirect to `/scope-picker?session=…`
5. The picker page loads Google's official Drive Picker, user picks **one folder**
6. POST `/api/scope/save` saves the choice and finalizes the OAuth flow back to ChatGPT
7. ChatGPT exchanges the code for an MCP access token at `/token`
8. ChatGPT calls tools via `/mcp` — every Drive op is filtered by the user's saved folder

### Why this design

- **`drive.file` OAuth scope only.** Google's design: this scope only grants access to files the app created OR files the user explicitly opened via the Picker. Picking a folder grants container-level access to that folder. Anything else is invisible to us at the Google API level, not just our code level.
- **Real Google Picker, not custom UI.** The Picker is a Google-controlled iframe. The user browses their own Drive in a familiar UI, the app receives the folder ID only when the user explicitly picks it. This is the strongest possible "Google itself prevents leaks" story.
- **Single folder per user.** Multi-folder is a v2 if anyone asks. Keeping it to one folder keeps the UX and code simple.
- **Folder choice happens during connect, not later.** Inserts a `/scope-picker` step between Google callback and the ChatGPT redirect, so connect-and-scope is a single ceremony.

---

## Repo layout

```
guard-proxy/
├── src/
│   ├── server.ts       Fastify bootstrap + route registration
│   ├── config.ts       Env var loading
│   ├── db.ts           SQLite schema (better-sqlite3, WAL mode)
│   ├── oauth.ts        Both halves of OAuth (ChatGPT <-> us, us <-> Google)
│   ├── scope.ts        Scope-picker routes + DB helpers
│   ├── mcp.ts          MCP server (JSON-RPC over POST /mcp)
│   ├── tools.ts        Tool definitions and handlers
│   └── approvals.ts    Dormant — kept for future tools where scope can't catch the risk
├── public/
│   ├── scope-picker.html   Drive Picker page (server-rendered with API key + app ID)
│   └── approvals.html      Dormant — corresponds to approvals.ts
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

### Key files

- **`src/oauth.ts`** — implements OAuth 2.0 server endpoints for ChatGPT (`/authorize`, `/token`, `/register`, `/.well-known/oauth-protected-resource`) and the Google OAuth client flow. Exports `completePendingAuth(sessionId)` which is called from `scope.ts` after the user picks a folder, to finalize the auth-code generation back to ChatGPT.
- **`src/scope.ts`** — `getScope(userId)` and `setScope(...)` helpers, plus routes: `GET /scope-picker` (serves picker HTML with config injected), `GET /api/scope/picker-token` (returns the user's Google access token for the Picker iframe to use), `POST /api/scope/save` (records the choice and completes auth).
- **`src/tools.ts`** — currently exposes: `ping`, `sleep_test`, `drive_list_files`, `drive_create_doc`. The Drive tools call `requireScope(userId)` first and pass `'<folderId>' in parents` / `parents: [folderId]` into the Drive API.
- **`src/db.ts`** — schemas: `users`, `google_tokens`, `mcp_clients`, `auth_sessions` (with `user_id` column), `auth_codes`, `access_tokens`, `refresh_tokens`, `drive_scopes`, `pending_approvals`. The `pending_approvals` table is dormant.

### State of the code

- Hello-world MCP path: complete, untested end-to-end
- OAuth flow including the picker detour: complete, untested end-to-end
- `drive_list_files` and `drive_create_doc` with scope enforcement: complete, untested end-to-end
- Approval flow: code exists in `src/approvals.ts` + `public/approvals.html`, **not wired into any tool** — left dormant for future actions where structural scope can't catch the risk (email send, file delete, etc.)

Nothing has been deployed or run yet. The tarball delivered to the previous session's chat contains everything.

---

## Setup

### Google Cloud Console (one-time)

1. Create or pick a project.
2. **APIs & Services → Library** — enable:
   - Google Drive API
   - Google Docs API
   - **Google Picker API** (this is the one people miss)
3. **APIs & Services → Credentials**:
   - **OAuth 2.0 Client ID** of type Web application. Add `<PUBLIC_URL>/auth/google/callback` to authorized redirect URIs. Save client ID + secret.
   - **API Key**. Restrict to HTTP referrers → `<PUBLIC_URL>/*`. This is for the Picker.
4. Note the **project number** from Project Settings — this is the Picker `appId`.

### Env vars (`.env`)

```
PUBLIC_URL=https://<your-public-https-url>
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_API_KEY=
GOOGLE_APP_ID=        # numeric project number
APPROVAL_PAGE_SECRET= # any long random string; not currently used by any flow
DB_PATH=./data.db
PORT=3000
```

### Run

```bash
npm install
cp .env.example .env   # fill in
npm run dev
```

### Hosting options

- **Railway, from GitHub** — push to `parkcoll/guard-proxy`, point Railway at it, set env vars in dashboard. `PUBLIC_URL` is the Railway URL.
- **Local + ngrok** — `npm run dev` locally, `ngrok http 3000`, set `PUBLIC_URL` to the ngrok HTTPS URL. Tighter iteration loop.

ChatGPT requires HTTPS for the MCP endpoint, so a public HTTPS URL is mandatory either way.

### Wiring into ChatGPT

In ChatGPT settings → Connectors → Add a connector → MCP server → URL = `<PUBLIC_URL>/mcp`. ChatGPT will discover the OAuth metadata and walk the user through Google sign-in + the picker.

---

## Test gates — run these before building anything else

| # | Test | Verifies |
|---|---|---|
| 1 | `ping("hello")` from ChatGPT returns `pong: hello` | Connector + token + MCP wiring works end-to-end |
| 2 | Full connect flow lands the user back in ChatGPT after the picker step | Multi-step OAuth survives the `/scope-picker` detour |
| 3 | `sleep_test` at 5s, 30s, 90s, 300s | What's ChatGPT's tool-call timeout budget (informs design of any future long-running approval flows) |
| 4 | `drive_list_files` returns only files in the picked folder, including pre-existing ones the user had there before connecting | Confirms `drive.file` + Picker grants container-level read access |
| 5 | `drive_create_doc` lands the new doc inside the picked folder (verify visually in Drive UI) | Write-scope works |
| 6 | Reconnect, pick a different folder, verify the new folder is the one in effect | Scope can be changed |

**Most important uncertainty**: gate 4. With `drive.file` scope, theory says "files the user opened via the Picker are accessible" — for a picked folder this should mean container access to its contents. If gate 4 fails (i.e. you only see files the app itself created, not pre-existing user files in the folder), the fallback is to add `drive.readonly` back to the OAuth scope. That re-introduces "see everything in Drive" on the consent screen, but keeps our enforcement at the proxy layer. Try the tight version first.

---

## Decisions already made — don't relitigate

- **Scoping, not per-action approval, is the wedge.** The earlier design used a human-in-the-loop approval modal for every write. That was the marquee feature, but it created UX friction and didn't actually constrain reads. Scoping by folder is structural, covers reads + writes, and is much faster.
- **`drive.file` OAuth scope only.** Tighter than `drive.readonly` + `drive.file`. The reassurance pitch ("Google itself blocks anything else") is the whole product, so the scope must be the tight one. Only revisit if gate 4 fails.
- **Google's official Picker, not a custom folder browser.** Custom would work but the Picker is more polished, familiar, and crucially is what lets us run with `drive.file` only.
- **Single folder per user.** Not multi-folder, not file-by-file. If users ask for more, that's a v2 question.
- **Approval module stays in the codebase.** Dormant. Useful for future tools where scope can't catch the risk: email send, calendar delete, file delete. Don't rip it out.
- **Folder choice happens during connect, not later.** No separate settings page; the picker is part of the OAuth ceremony.

---

## Open product questions worth thinking about (not blockers)

- **Reconnect UX.** If a user reconnects, should we re-prompt the picker or skip if a scope is already set? Current code re-prompts every time. Probably fine, but worth a thought once gates pass.
- **Second connector.** Most likely next: Gmail (read-only on a label) or Calendar (one calendar). Same scoping pattern. Worth picking which to ship next based on what feels most demoable.
- **Recovery from token revocation.** If a user revokes us from their Google account, the next tool call will error. We should detect 401 from Google and surface a "reconnect" message back through MCP. Not built yet.
- **Multi-tenancy / org accounts.** Currently every user is independent. If we ever sell to teams, scopes might belong to an org admin, not the individual. Not a near-term concern.

---

## Next features in priority order

1. **Run the test gates.** Don't build anything else until gates 1–5 pass.
2. **Polish error states in `/scope-picker`.** Currently most errors just show "Could not load the picker." A user-facing reason ("Picker API isn't enabled in the project") would save debugging time.
3. **Add more Drive tools**: `drive_read_file` (get text contents), `drive_update_doc` (insert/replace text). Same scope-enforcement pattern.
4. **Second connector** (Gmail or Calendar).
5. **Settings page** — list connected services, current scope, "change scope" / "disconnect" buttons.
6. **Wire approvals back in** for actions scope can't structurally catch (delete file, send email).

---

## Why the previous session couldn't push

For future reference: that session was created scoped to `parkcoll/looker_force_directed_graph`. The sandbox's commit-signing service and git proxy are both whitelisted only to repos registered at session creation. Adding a GitHub MCP connector mid-session doesn't extend the git proxy's whitelist. Net: a session can only push to repos it was created with.

To work on this project, **start a new Claude Code session with `parkcoll/guard-proxy` in the initial repo list**. Then commits sign cleanly and `git push` works through the local proxy.

---

## Tarball

The current code is in a tarball that was delivered as a chat attachment in the previous session: `guard-proxy.tar.gz`. Extract it, push it to `parkcoll/guard-proxy` from your Mac, then start a fresh session with that repo and you're set up.

```bash
cd ~
tar -xzf ~/Downloads/guard-proxy.tar.gz
cd guard-proxy
git init && git add -A && git commit -m "Initial commit: scope-picker MCP proxy"
git branch -M main
git remote add origin git@github.com:parkcoll/guard-proxy.git
git push -u origin main
```
