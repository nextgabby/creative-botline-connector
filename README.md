# Creative Botline Connector

Slack listener bot that watches `#x-creative-botline` for new botline submissions
(posted by the existing Workflow) and auto-generates 5-7 creative concepts using Grok,
drawing on 12 months of botline history for context.

## How it works

```
Workflow posts in #x-creative-botline
        |
        v
Bot detects message (contains "Submit a Botline Request" or SS-/CR- pattern)
        |
        v
Parses structured fields (Request ID, Brand, Campaign, Handle, Budget, KPI, CTA, etc.)
        |
        v
Downloads attached images (vision) + documents/decks (text extraction)
        |
        v
Paginates back 12 months of #x-creative-botline history via conversations.history
  + fetches strategist reply threads for each submission (cached 30 min)
        |
        v
Calls Grok (grok-4.3) with:
  - System prompt (system-prompt.txt — full creative strategy rules)
  - Botline intelligence (up to 25 past submissions + strategist replies)
  - New brief (parsed fields + raw message)
  - Attached images + document text
        |
        v
Replies in the same thread as the original Workflow message
  "Creative ideas for SS-34277 (Samsung US Open) from @submitter:"
```

Also supports **@mention** anywhere for quick freeform creative requests.

## Setup

### 1. Slack App Configuration

Create a Slack app at https://api.slack.com/apps with these settings:

**OAuth Scopes** (Bot Token):
- `channels:history` — read messages in public channels
- `channels:read` — list channels
- `chat:write` — post messages
- `files:read` — download attached images and documents
- `app_mentions:read` — respond to @mentions

**Event Subscriptions** — subscribe to these bot events:
- `message.channels` — listen for messages in public channels
- `app_mention` — handle @mentions

**Socket Mode** (for local dev):
- Enable Socket Mode and generate an App-Level Token with `connections:write` scope

### 2. Environment Variables

```bash
cp .env.example .env
```

Fill in all values. To find your `BOT_USER_ID`, check the bot's profile in Slack
or call `auth.test` in the Slack API tester. To find `HOTLINE_CHANNEL_ID`, right-click
the channel name in Slack > "Copy link" > the ID is the last segment.

### 3. Install & Run

```bash
npm install
npm start
```

### 4. System Prompt

The creative strategy prompt lives in `system-prompt.txt`. This file is loaded at
startup and sent verbatim as the Grok system message. The bot passes botline
intelligence (past submissions + strategist replies) and the new brief as user
message content — no placeholder tokens needed in the prompt.

To update the prompt, edit `system-prompt.txt` and restart the bot.

## Local vs Production

| Setting | Local | Render |
|---------|-------|--------|
| `SLACK_SOCKET_MODE` | `true` | `false` |
| `SLACK_APP_TOKEN` | required | not needed |
| `SLACK_SIGNING_SECRET` | not needed | required |
| `PORT` | — | set by Render (`10000`) |

### Deploy to Render

1. Push to GitHub
2. Create a new **Web Service** on Render
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all env vars (set `SLACK_SOCKET_MODE=false`)
6. Set the Request URL in your Slack app's Event Subscriptions to:
   `https://your-app.onrender.com/slack/events`

## @Mention Path

In any channel where the bot is invited, @mention it with a freeform creative request:

> @CreativeBotline Give me 3 carousel concepts for a Nike running campaign

The bot replies in-thread with a concise creative response.

## Architecture

- **Detection**: Regex for "Submit a Botline Request" (or legacy "Hotline") or `XX-NNNNN` Request ID patterns
- **Parsing**: Regex extraction of structured fields (Request ID, Brand, Campaign, Handle, Budget, KPI, Objective, Audience, Flight Dates, Value Prop, CTA); falls back to raw text
- **Files**: Images are downloaded from Slack, base64-encoded, and sent to Grok as `image_url` content blocks. Text-based documents (PDFs, decks) are downloaded and extracted as text.
- **History**: Paginates `conversations.history` back 12 months (up to 50 pages of 200 messages), filters for botline submissions, fetches human strategist thread replies via `conversations.replies`, caches results for 60 minutes. Up to 25 past examples are sent to Grok as "Botline Intelligence."
- **Dedup**: In-memory Set of processed `ts` values (capped at 500) to avoid re-processing
- **Grok**: System prompt is sent verbatim from `system-prompt.txt`. Past examples + new brief + attachments go in the user message. Model: `grok-4.3-latest`, max 8000 tokens, temperature 0.85.
