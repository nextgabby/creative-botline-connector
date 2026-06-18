require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { readFileSync, readdirSync } = require("fs");
const { join, extname } = require("path");

/* ───────────────────────────────────────────
   ENV
   ─────────────────────────────────────────── */
const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_SIGNING_SECRET,
  XAI_API_KEY,
  HOTLINE_CHANNEL_ID,
  BOT_USER_ID,
  PORT = "3000",
} = process.env;

const SOCKET_MODE = process.env.SLACK_SOCKET_MODE !== "false"; // default true

// Resolved at startup via auth.test — the bot's own bot_id (distinct from BOT_USER_ID)
let SELF_BOT_ID = null;

/* ───────────────────────────────────────────
   GROK CONSTANTS
   ─────────────────────────────────────────── */
const XAI_BASE = "https://api.x.ai/v1";
const GROK_MODEL = "grok-4.3-latest";

function xaiHeaders(contentType) {
  const h = { Authorization: `Bearer ${XAI_API_KEY}` };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

/* ───────────────────────────────────────────
   FILES DIRECTORY
   Contains system-prompt.txt + reference PDFs
   (product catalogs, creative specs, etc.)
   ─────────────────────────────────────────── */
const FILES_DIR = join(__dirname, "files");

// Load system prompt
const PROMPT_PATH = join(FILES_DIR, "system-prompt.txt");
let SYSTEM_PROMPT;
try {
  SYSTEM_PROMPT = readFileSync(PROMPT_PATH, "utf-8").trim();
} catch (err) {
  console.error(`Failed to load system prompt from ${PROMPT_PATH}:`, err.message);
  process.exit(1);
}

// Discover local reference files (PDFs, images) to upload to x.ai at startup
const LOCAL_REF_FILES = [];
try {
  const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg"]);
  for (const name of readdirSync(FILES_DIR)) {
    if (name === "system-prompt.txt") continue;
    const ext = extname(name).toLowerCase();
    if (!ALLOWED_EXTS.has(ext)) continue;
    LOCAL_REF_FILES.push({ name, path: join(FILES_DIR, name) });
  }
} catch (err) {
  console.error("Failed to read files directory:", err.message);
}
console.log(`[startup] Found ${LOCAL_REF_FILES.length} reference file(s) to upload`);

// Populated after upload — array of { name, fileId }
const UPLOADED_REF_FILES = [];

/**
 * Upload reference files to x.ai Files API so they can be
 * referenced by file_id in every Grok call (no re-transmission).
 */
async function uploadReferenceFiles() {
  for (const local of LOCAL_REF_FILES) {
    try {
      const buf = readFileSync(local.path);
      const blob = new Blob([buf]);
      const form = new FormData();
      form.append("file", blob, local.name);
      form.append("purpose", "assistants");

      const resp = await fetch(`${XAI_BASE}/files`, {
        method: "POST",
        headers: { Authorization: `Bearer ${XAI_API_KEY}` },
        body: form,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`[startup] Failed to upload ${local.name}: ${resp.status} ${errText}`);
        continue;
      }

      const data = await resp.json();
      UPLOADED_REF_FILES.push({ name: local.name, fileId: data.id });
      console.log(`[startup] Uploaded ${local.name} → ${data.id}`);
    } catch (err) {
      console.error(`[startup] Error uploading ${local.name}:`, err.message);
    }
  }
  console.log(`[startup] ${UPLOADED_REF_FILES.length}/${LOCAL_REF_FILES.length} reference file(s) uploaded to x.ai`);
}

/* ───────────────────────────────────────────
   SLACK APP INIT
   ─────────────────────────────────────────── */
let appOptions;

if (SOCKET_MODE) {
  appOptions = {
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  };
} else {
  // HTTP mode for Render / production
  const receiver = new ExpressReceiver({
    signingSecret: SLACK_SIGNING_SECRET,
    endpoints: "/slack/events",
  });
  appOptions = {
    token: SLACK_BOT_TOKEN,
    receiver,
  };
}

const app = new App(appOptions);

/* ───────────────────────────────────────────
   HOTLINE DETECTION
   ─────────────────────────────────────────── */
const HOTLINE_PATTERN = /Submit a Hotline Request/i;
const REQUEST_ID_PATTERN = /\b[A-Z]{1,4}-\d{4,6}\b/; // SS-34277, CR-12345, etc.

function isHotlineSubmission(text, files) {
  if (HOTLINE_PATTERN.test(text) || REQUEST_ID_PATTERN.test(text)) return true;
  if (files && files.some(f => /client\s*brief/i.test(f.name || ""))) return true;
  return false;
}

/* ───────────────────────────────────────────
   BRIEF PARSER
   Extracts structured fields from the Workflow
   message. Falls back to raw text if parsing
   finds nothing — Grok can still handle it.
   ─────────────────────────────────────────── */
function parseBrief(text) {
  const fields = {};
  const patterns = {
    requestId: /(?:Request\s*ID|Ticket)[:\s]*([A-Z]{1,4}-\d{4,6})/i,
    brand: /(?:Brand|Client)[:\s]*(.+)/i,
    campaign: /(?:Campaign(?:\s*Name)?|Initiative)[:\s]*(.+)/i,
    handle: /(?:@?Handle|Twitter|X\s*Handle)[:\s]*(@?\w+)/i,
    valueProp: /(?:Value\s*Prop(?:osition)?|Key\s*Message)[:\s]*(.+)/i,
    cta: /(?:CTA|Call\s*to\s*Action)[:\s]*(.+)/i,
    objective: /(?:Objective|Goal)[:\s]*(.+)/i,
    kpi: /(?:KPI|Key\s*Performance|Success\s*Metric)[:\s]*(.+)/i,
    audience: /(?:Audience|Target)[:\s]*(.+)/i,
    timeline: /(?:Timeline|Dates?|Flight)[:\s]*(.+)/i,
  };

  for (const [key, rx] of Object.entries(patterns)) {
    const m = text.match(rx);
    if (m) fields[key] = m[1].trim();
  }

  // Multi-line: capture from "Additional Information:" to next field label or end
  const addInfoMatch = text.match(
    /Additional\s*Information[:\s]*([\s\S]+?)(?=\n(?:Request\s*ID|Ticket|Brand|Client|Campaign|Initiative|@?Handle|Twitter|X\s*Handle|Value\s*Prop|Key\s*Message|CTA|Call\s*to\s*Action|Objective|Goal|KPI|Key\s*Performance|Success\s*Metric|Audience|Target|Timeline|Dates?|Flight)[:\s]|$)/i
  );
  if (addInfoMatch) fields.additionalInfo = addInfoMatch[1].trim();

  // Also try to grab the Request ID from the broader pattern if not caught
  if (!fields.requestId) {
    const m = text.match(REQUEST_ID_PATTERN);
    if (m) fields.requestId = m[0];
  }

  return {
    parsed: fields,
    raw: text,
    hasParsedFields: Object.keys(fields).length > 0,
  };
}

function formatBrief(brief) {
  if (!brief.hasParsedFields) {
    return brief.raw;
  }

  const lines = [];
  const labels = {
    requestId: "Request ID",
    brand: "Brand",
    campaign: "Campaign",
    handle: "X Handle",
    valueProp: "Value Proposition",
    cta: "CTA",
    objective: "Objective",
    kpi: "KPI",
    audience: "Target Audience",
    timeline: "Flight Dates",
    additionalInfo: "Additional Information",
  };

  for (const [key, label] of Object.entries(labels)) {
    if (brief.parsed[key]) {
      lines.push(`${label}: ${brief.parsed[key]}`);
    }
  }

  lines.push("", "--- Full original message ---", brief.raw);
  return lines.join("\n");
}

/* ───────────────────────────────────────────
   FILE HANDLING (Slack attachments)
   ─────────────────────────────────────────── */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

function extractFiles(message) {
  const images = [];
  const docs = [];
  if (!message.files) return { images, docs };

  for (const file of message.files) {
    const mime = file.mimetype || "";
    if (IMAGE_TYPES.has(mime)) {
      images.push({
        url: file.url_private,
        name: file.name || "attachment",
        mimetype: mime,
      });
    } else if (file.url_private) {
      // PDFs, decks, text files — upload to x.ai on the fly
      docs.push({
        url: file.url_private,
        name: file.name || "document",
        mimetype: mime,
      });
    }
  }
  // Diagnostic: log attachment breakdown
  if (images.length || docs.length) {
    const parts = [];
    for (const img of images) parts.push(`"${img.name}" (${img.mimetype}) → image`);
    for (const doc of docs) parts.push(`"${doc.name}" (${doc.mimetype}) → doc`);
    console.log(`[files] ${images.length + docs.length} attachment(s): ${parts.join(", ")}`);
  }

  return { images, docs };
}

async function downloadAsBuffer(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Upload a Slack file to x.ai Files API and return the file_id.
 */
async function uploadSlackFileToXai(slackUrl, filename) {
  const buf = await downloadAsBuffer(slackUrl, SLACK_BOT_TOKEN);
  if (!buf) {
    console.error(`[files] FAILED to upload "${filename}": could not download from Slack`);
    return null;
  }

  const blob = new Blob([buf]);
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("purpose", "assistants");

  const resp = await fetch(`${XAI_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    body: form,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[files] FAILED to upload "${filename}": ${resp.status} ${errText}`);
    return null;
  }
  const data = await resp.json();
  console.log(`[files] Uploaded "${filename}" → ${data.id}`);
  return data.id;
}

/* ───────────────────────────────────────────
   HISTORY FETCHER
   Paginate back ~12 months to build a deep
   set of hotline submissions + strategist
   replies for Grok context.
   ─────────────────────────────────────────── */
const HISTORY_MONTHS = 12;
const MAX_EXAMPLES = 15;      // cap examples sent to Grok
const MAX_PAGES = 10;         // cap pagination to avoid rate-limit hammering
const MSGS_PER_PAGE = 200;    // Slack max per page

// Simple in-memory cache so we don't re-fetch 12 months on every trigger
let historyCache = { examples: [], fetchedAt: 0 };
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchRecentExamples(client, channelId, currentTs) {
  // Return cache if fresh
  if (Date.now() - historyCache.fetchedAt < CACHE_TTL_MS && historyCache.examples.length) {
    return historyCache.examples.filter((e) => e.ts !== currentTs).slice(0, MAX_EXAMPLES);
  }

  const examples = [];
  const oldest = String(Math.floor(Date.now() / 1000) - HISTORY_MONTHS * 30 * 24 * 60 * 60);

  try {
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = {
        channel: channelId,
        limit: MSGS_PER_PAGE,
        oldest,
      };
      if (cursor) params.cursor = cursor;

      const history = await client.conversations.history(params);
      const messages = history.messages || [];

      for (const m of messages) {
        if (!m.text || !isHotlineSubmission(m.text, m.files) || m.bot_id) continue;
        if (m.ts === currentTs) continue;

        const example = {
          ts: m.ts,
          brief: m.text.substring(0, 1000),
          response: null,
        };

        // Fetch thread to find strategist / bot replies
        try {
          const thread = await client.conversations.replies({
            channel: channelId,
            ts: m.ts,
            limit: 15,
          });

          // Grab the best reply (bot or strategist — any non-original reply with substance)
          const replies = (thread.messages || []).filter(
            (r) => r.ts !== m.ts && r.text && r.text.length > 100
          );
          if (replies.length) {
            // Prefer bot replies, fall back to longest human reply
            const best =
              replies.find((r) => r.bot_id || r.user === BOT_USER_ID) ||
              replies.sort((a, b) => b.text.length - a.text.length)[0];
            example.response = best.text.substring(0, 2000);
          }
        } catch {
          // Thread fetch failed — skip response
        }

        examples.push(example);
      }

      if (!history.has_more) break;
      cursor = history.response_metadata?.next_cursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.error("Failed to fetch history:", err.message);
  }

  // Sort newest-first, cache
  examples.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  historyCache = { examples, fetchedAt: Date.now() };

  return examples.filter((e) => e.ts !== currentTs).slice(0, MAX_EXAMPLES);
}

function formatExamples(examples) {
  if (!examples.length) return "";

  const parts = [
    "HOTLINE INTELLIGENCE — #x-creative-hotline submissions + strategist replies (last 12 months):\n",
  ];

  for (let i = 0; i < examples.length; i++) {
    parts.push(`[Submission ${i + 1}]\n${examples[i].brief}`);
    if (examples[i].response) {
      parts.push(`[Strategist Reply]\n${examples[i].response}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/* ───────────────────────────────────────────
   GROK CALL  (x.ai Responses API)
   Uses /v1/responses with input_file refs for
   PDFs and input_image for vision. Reference
   files are pre-uploaded; Slack attachments
   are uploaded on the fly.
   ─────────────────────────────────────────── */
async function callGrok(briefText, examples, { images = [], docs = [] } = {}) {
  const examplesBlock = formatExamples(examples);

  // Build user content array (Responses API format)
  const content = [];

  // 1. Reference files (pre-uploaded product catalogs, specs, etc.)
  for (const ref of UPLOADED_REF_FILES) {
    content.push({ type: "input_file", file_id: ref.fileId });
  }
  if (UPLOADED_REF_FILES.length) {
    content.push({
      type: "input_text",
      text: `The ${UPLOADED_REF_FILES.length} file(s) above are the product catalog, creative specs, and tactic references. Use them for 100% product accuracy.`,
    });
  }

  // 2. Past hotline intelligence
  if (examplesBlock) {
    content.push({ type: "input_text", text: examplesBlock });
  }

  // 3. The new brief
  content.push({ type: "input_text", text: `NEW BRIEF:\n${briefText}` });

  // 4. Attached images from Slack (base64 vision)
  for (const img of images) {
    const buf = await downloadAsBuffer(img.url, SLACK_BOT_TOKEN);
    if (buf) {
      const b64 = buf.toString("base64");
      content.push({
        type: "input_image",
        image_url: `data:${img.mimetype};base64,${b64}`,
      });
      content.push({
        type: "input_text",
        text: `[Attached image: ${img.name}] — Analyze this visual and incorporate its brand elements and style into your concepts.`,
      });
    }
  }

  // 5. Attached documents from Slack (upload to x.ai on the fly)
  for (const doc of docs) {
    const fileId = await uploadSlackFileToXai(doc.url, doc.name);
    if (fileId) {
      content.push({ type: "input_file", file_id: fileId });
      content.push({
        type: "input_text",
        text: `[Attached document: ${doc.name}] — Deeply analyze this client deck/document and use it as part of the brief.`,
      });
    }
  }

  content.push({
    type: "input_text",
    text: "Generate 5–7 creative concepts for this brief following every rule in your system prompt.",
  });

  // Diagnostic: summarize what we're sending to Grok
  const inputImageCount = content.filter((c) => c.type === "input_image").length;
  const inputDocCount = docs.length;
  const totalTextLen = content
    .filter((c) => c.type === "input_text")
    .reduce((sum, c) => sum + c.text.length, 0);
  console.log(
    `[grok] Sending: ${UPLOADED_REF_FILES.length} ref files, ${examples.length} examples, ` +
    `${inputImageCount} image(s), ${inputDocCount} doc(s), brief=${briefText.length} chars, ` +
    `total text=${totalTextLen} chars`
  );

  // Call x.ai Responses API
  const resp = await fetch(`${XAI_BASE}/responses`, {
    method: "POST",
    headers: xaiHeaders("application/json"),
    body: JSON.stringify({
      model: GROK_MODEL,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      max_output_tokens: 16384,
      temperature: 0.85,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Grok API ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();

  // Extract text from the response output
  const outputMsg = (data.output || []).find((o) => o.type === "message");
  if (!outputMsg) throw new Error("No message in Grok response");
  const textBlock = (outputMsg.content || []).find((c) => c.type === "output_text");
  if (!textBlock) throw new Error("No output_text in Grok response");
  return textBlock.text;
}

/* ───────────────────────────────────────────
   SLACK CHUNKING
   Splits long Grok responses to stay under
   Slack's per-message limit (~4000 chars).
   ─────────────────────────────────────────── */
const SLACK_MAX_CHARS = 3500;

function chunkSlackResponse(text) {
  if (text.length <= SLACK_MAX_CHARS) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > SLACK_MAX_CHARS) {
    const slice = remaining.substring(0, SLACK_MAX_CHARS);

    // Primary: split before a *Concept N header
    let splitIdx = -1;
    const conceptMatch = slice.match(/[\s\S]*\n(?=\*Concept \d)/);
    if (conceptMatch) {
      splitIdx = conceptMatch[0].length;
    }

    // Fallback: split on ─── divider line
    if (splitIdx <= 0) {
      const dividerIdx = slice.lastIndexOf("\n───");
      if (dividerIdx > 0) splitIdx = dividerIdx;
    }

    // Fallback: split on double-newline
    if (splitIdx <= 0) {
      const dblNewline = slice.lastIndexOf("\n\n");
      if (dblNewline > 0) splitIdx = dblNewline;
    }

    // Last resort: split on last newline
    if (splitIdx <= 0) {
      const lastNl = slice.lastIndexOf("\n");
      splitIdx = lastNl > 0 ? lastNl : SLACK_MAX_CHARS;
    }

    chunks.push(remaining.substring(0, splitIdx).trimEnd());
    remaining = remaining.substring(splitIdx).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function postChunkedResponse(client, channel, threadTs, thinkingTs, fullText) {
  const chunks = chunkSlackResponse(fullText);
  console.log(`[slack] Response split into ${chunks.length} chunk(s), posting to thread`);

  // Chunk 1: update the thinking message
  await client.chat.update({
    channel,
    ts: thinkingTs,
    text: chunks[0],
  });

  // Chunks 2+: post as sequential replies in the same thread
  for (let i = 1; i < chunks.length; i++) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunks[i],
    });
  }
}

/* ───────────────────────────────────────────
   @MENTION / DM HANDLER
   Uses the full system prompt + reference files
   via the Responses API, same as the hotline path.
   ─────────────────────────────────────────── */
async function handleMention(event, client) {
  const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  console.log(`[@mention/DM] Request from <@${event.user}>`);

  try {
    // Post a thinking message
    const thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: `:brain: Working on it...`,
    });

    // Extract images if any
    const { images, docs } = extractFiles(event);

    // Run through the full Grok pipeline (system prompt + reference files + history)
    const grokResponse = await callGrok(text, [], { images, docs });

    await postChunkedResponse(
      client, event.channel, event.thread_ts || event.ts, thinking.ts,
      grokResponse
    );
  } catch (err) {
    console.error("[@mention/DM] Grok error:", err.message);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
      text: `Something went wrong generating ideas. Error: ${err.message}`,
    });
  }
}

/* ───────────────────────────────────────────
   MAIN MESSAGE HANDLER
   ─────────────────────────────────────────── */
const processed = new Set(); // dedup by ts
const activeThreads = new Set(); // thread_ts values where the bot has responded

/* ───────────────────────────────────────────
   THREAD FOLLOW-UP HANDLER (hotline only)
   ─────────────────────────────────────────── */
const TRANSIENT_BOT_MSG = /^:brain:|^:warning:/;

async function handleThreadFollowUp(event, client) {
  console.log(`[follow-up] Thread reply from <@${event.user}> in thread ${event.thread_ts}`);

  try {
    // 1. Fetch thread BEFORE posting thinking indicator
    const thread = await client.conversations.replies({
      channel: event.channel,
      ts: event.thread_ts,
      limit: 50,
    });
    const messages = (thread.messages || []).filter(
      (m) => m.text && !TRANSIENT_BOT_MSG.test(m.text)
    );

    // 2. Separate human messages and bot responses
    // First message is the original brief (human or Workflow)
    const originalBrief = messages[0]?.text || "";
    const botResponses = [];
    const humanFollowUps = [];

    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.user === BOT_USER_ID) {
        // Coalesce consecutive bot messages (chunked responses)
        if (botResponses.length && messages[i - 1]?.user === BOT_USER_ID) {
          botResponses[botResponses.length - 1] += "\n\n" + msg.text;
        } else {
          botResponses.push(msg.text);
        }
      } else {
        humanFollowUps.push(msg.text);
      }
    }

    // The latest human message is the follow-up request
    const followUpText = humanFollowUps.pop() || event.text;

    // 3. Now post thinking indicator (after fetch, before Grok call)
    const thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `:brain: Working on it...`,
    });

    // 4. Build single user turn with full context
    const content = [];

    // Reference files
    for (const ref of UPLOADED_REF_FILES) {
      content.push({ type: "input_file", file_id: ref.fileId });
    }

    // Structured context as one input_text block
    const contextParts = [`ORIGINAL BRIEF:\n${originalBrief}`];

    if (botResponses.length) {
      contextParts.push(`PREVIOUS CREATIVE IDEAS:\n${botResponses.join("\n\n---\n\n")}`);
    }
    if (humanFollowUps.length) {
      contextParts.push(`PRIOR FOLLOW-UPS:\n${humanFollowUps.join("\n\n")}`);
    }
    contextParts.push(`FOLLOW-UP REQUEST:\n${followUpText}`);

    content.push({ type: "input_text", text: contextParts.join("\n\n") });

    // Diagnostic: log reconstructed context summary
    const truncFollow = followUpText.length > 80 ? followUpText.substring(0, 80) + "..." : followUpText;
    console.log(
      `[follow-up] Context: originalBrief=${originalBrief.length} chars, ` +
      `${botResponses.length} prior bot response(s), ` +
      `${humanFollowUps.length} prior follow-up(s), ` +
      `followUpText="${truncFollow}"`
    );

    // 5. Call Grok — system + single user turn, no assistant turns
    const resp = await fetch(`${XAI_BASE}/responses`, {
      method: "POST",
      headers: xaiHeaders("application/json"),
      body: JSON.stringify({
        model: GROK_MODEL,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content },
        ],
        max_output_tokens: 16384,
        temperature: 0.85,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Grok API ${resp.status}: ${errBody}`);
    }

    const data = await resp.json();
    const outputMsg = (data.output || []).find((o) => o.type === "message");
    if (!outputMsg) throw new Error("No message in Grok response");
    const textBlock = (outputMsg.content || []).find((c) => c.type === "output_text");
    if (!textBlock) throw new Error("No output_text in Grok response");

    await postChunkedResponse(
      client, event.channel, event.thread_ts, thinking.ts,
      textBlock.text
    );
  } catch (err) {
    console.error("[follow-up] Error:", err);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `:warning: Creative Botline hit an error: ${err.message}`,
    });
  }
}

app.event("message", async ({ event, client }) => {
  console.log(`[debug] msg in ${event.channel} | bot_id=${event.bot_id} | subtype=${event.subtype} | user=${event.user} | bot_profile=${event.bot_profile?.name} | text=${(event.text||"").slice(0,60)}`);

  // --- Direct DMs to the bot (channel starts with D) ---
  if (event.channel_type === "im" || (event.channel && event.channel.startsWith("D"))) {
    if (event.bot_id) return; // skip own messages
    return handleMention(event, client);
  }

  // --- Guard: only the hotline channel ---
  if (event.channel !== HOTLINE_CHANNEL_ID) {
    // Check for @mention in any channel
    if (
      BOT_USER_ID &&
      event.text &&
      event.text.includes(`<@${BOT_USER_ID}>`)
    ) {
      return handleMention(event, client);
    }
    return;
  }

  // --- Guard: skip edits, deletes ---
  if (event.subtype === "message_changed" || event.subtype === "message_deleted") {
    return;
  }

  // --- Guard: skip our own messages (prevent self-trigger loop) ---
  // Workflow posts carry a bot_id too, so we can't blanket-drop all bot_id messages.
  // Match on both signals: user ID (when present) and our own bot_id.
  if (event.user === BOT_USER_ID || (event.bot_id && event.bot_id === SELF_BOT_ID)) {
    return;
  }

  // --- Threaded reply in an active thread → follow-up ---
  if (event.thread_ts && event.thread_ts !== event.ts && activeThreads.has(event.thread_ts)) {
    if (processed.has(event.ts)) return;
    processed.add(event.ts);
    return handleThreadFollowUp(event, client);
  }

  // --- Guard: must look like a hotline submission ---
  const text = event.text || "";
  if (!isHotlineSubmission(text, event.files)) {
    // Still handle @mention in hotline channel
    if (BOT_USER_ID && text.includes(`<@${BOT_USER_ID}>`)) {
      return handleMention(event, client);
    }
    return;
  }

  // --- Dedup ---
  if (processed.has(event.ts)) return;
  processed.add(event.ts);
  // Keep sets from growing unbounded
  if (processed.size > 500) {
    const arr = [...processed];
    arr.splice(0, 250);
    processed.clear();
    arr.forEach((t) => processed.add(t));
  }
  if (activeThreads.size > 1000) {
    const arr = [...activeThreads];
    arr.splice(0, 500);
    activeThreads.clear();
    arr.forEach((t) => activeThreads.add(t));
  }

  console.log(`[hotline] New submission detected: ${event.ts}`);

  try {
    // 1. Parse the brief
    const brief = parseBrief(text);
    const briefText = formatBrief(brief);
    const requestId = brief.parsed.requestId || "NEW";
    const campaign = brief.parsed.campaign || "Hotline Request";
    const submitter = event.user;

    // Diagnostic: log parsed vs missing fields
    const allBriefKeys = ["requestId", "brand", "campaign", "handle", "valueProp", "cta", "objective", "kpi", "audience", "timeline", "additionalInfo"];
    const found = allBriefKeys
      .filter((k) => brief.parsed[k])
      .map((k) => k === "additionalInfo" ? `${k}=<${brief.parsed[k].length} chars>` : `${k}=${brief.parsed[k]}`)
      .join(", ");
    const missing = allBriefKeys.filter((k) => !brief.parsed[k]).join(", ");
    console.log(`[hotline] Parsed fields: ${found || "(none)"} | missing: ${missing || "(none)"}`);

    // 2. Extract files (images + documents/decks)
    const { images, docs } = extractFiles(event);

    // 3. Post a "thinking" message in thread
    const thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `:brain: Generating creative ideas for *${requestId}*...`,
    });

    // 4. Fetch recent examples for context (up to 12 months)
    const examples = await fetchRecentExamples(
      client,
      HOTLINE_CHANNEL_ID,
      event.ts
    );
    console.log(`[hotline] Fetched ${examples.length} past examples`);

    // 5. Call Grok
    const grokResponse = await callGrok(briefText, examples, { images, docs });

    // 6. Build header
    const header = `Creative ideas for *${requestId}* (${campaign}) from <@${submitter}>:`;

    // 7. Update the thinking message with the real response
    await postChunkedResponse(
      client, event.channel, event.ts, thinking.ts,
      `${header}\n\n${grokResponse}`
    );

    activeThreads.add(event.ts);
    console.log(`[hotline] Response posted for ${requestId}`);
  } catch (err) {
    console.error("[hotline] Error:", err);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `:warning: Creative Botline hit an error: ${err.message}`,
    });
  }
});

/* ───────────────────────────────────────────
   APP_MENTION HANDLER (fallback for @mentions)
   Slack fires app_mention separately from
   message events — handle both to be safe.
   ─────────────────────────────────────────── */
app.event("app_mention", async ({ event, client }) => {
  // Skip if already processed via the message handler
  if (processed.has(event.ts)) return;
  return handleMention(event, client);
});

/* ───────────────────────────────────────────
   START
   Upload reference files, then start listening.
   ─────────────────────────────────────────── */
(async () => {
  // Resolve the bot's own bot_id so we can filter self-messages reliably
  try {
    const auth = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
    SELF_BOT_ID = auth.bot_id;
    console.log(`[startup] Resolved SELF_BOT_ID=${SELF_BOT_ID} (user_id=${auth.user_id})`);
  } catch (err) {
    console.error("[startup] auth.test failed — self-loop guard will rely on BOT_USER_ID only:", err.message);
  }

  await uploadReferenceFiles();
  const port = SOCKET_MODE ? undefined : parseInt(PORT, 10);
  await app.start(port);
  console.log(
    `Creative Botline is running (${SOCKET_MODE ? "Socket Mode" : `HTTP :${PORT}`})`
  );
})();
