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
   BOTLINE DETECTION
   ─────────────────────────────────────────── */
const HOTLINE_PATTERN = /Submit a (?:Hotline|Botline) Request/i;
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

  // Strip Slack mrkdwn bold/italic markers for matching
  const clean = text.replace(/[*_]/g, "");
  const lines = clean.split("\n");

  // Label matchers — key phrases from Workflow question labels.
  // Each pattern is tested against the trimmed line.
  const labelDefs = [
    { key: "requestId", pattern: /request\s*id/i },
    { key: "brand", pattern: /^brand\s*\??$/i },
    { key: "campaign", pattern: /^campaign(\s*name)?\s*\??$/i },
    { key: "handle", pattern: /(?:^handle\s*\??$|^.*(?:what|the)\s+@?handle)/i },
    { key: "_budget", pattern: /budget/i },
    { key: "valueProp", pattern: /value\s*prop/i },
    { key: "objective", pattern: /want\s*people\s*to\s*do/i },
    { key: "additionalContext", pattern: /additional\s*(?:context|info)/i },
  ];

  function matchLabel(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    for (const def of labelDefs) {
      if (def.pattern.test(trimmed)) return def.key;
    }
    return null;
  }

  // Skip "Submitted by <@...>" header line
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*submitted\s+by\s+/i.test(lines[i])) {
      startLine = i + 1;
      break;
    }
  }

  // Walk lines: label → capture value lines below until next label
  let currentKey = null;
  let currentLines = [];

  for (let i = startLine; i < lines.length; i++) {
    const labelKey = matchLabel(lines[i]);
    if (labelKey) {
      // Save previous field
      if (currentKey) {
        const value = currentLines.join("\n").trim();
        if (value && currentKey !== "_budget") {
          fields[currentKey] = value;
        }
      }
      currentKey = labelKey;
      currentLines = [];
    } else if (currentKey) {
      currentLines.push(lines[i]);
    }
  }
  // Save last field
  if (currentKey) {
    const value = currentLines.join("\n").trim();
    if (value && currentKey !== "_budget") {
      fields[currentKey] = value;
    }
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
    additionalContext: "Additional Context",
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
   GROK REQUEST WITH FILE-INGEST RETRY
   If a reference file_id fails to ingest,
   strip it, re-upload in background, retry once.
   ─────────────────────────────────────────── */

/**
 * Extract a failed file_id from a Grok 400 error body.
 */
function extractFailedFileId(errBody) {
  const match = errBody.match(
    /failed to ingest file_id via media service:\s*(file_[a-zA-Z0-9_-]+)/i
  );
  return match ? match[1] : null;
}

/**
 * Re-upload a reference file whose file_id has gone stale.
 * Updates UPLOADED_REF_FILES in place if successful.
 */
async function refreshReferenceFile(staleFileId) {
  const refIdx = UPLOADED_REF_FILES.findIndex((r) => r.fileId === staleFileId);
  if (refIdx === -1) {
    console.warn(`[files] Stale file_id ${staleFileId} not in UPLOADED_REF_FILES — cannot refresh`);
    return null;
  }

  const refName = UPLOADED_REF_FILES[refIdx].name;
  const local = LOCAL_REF_FILES.find((l) => l.name === refName);
  if (!local) {
    console.warn(`[files] No local file for "${refName}" — cannot refresh`);
    return null;
  }

  console.log(`[files] Re-uploading ${refName} (stale file_id: ${staleFileId})`);
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
      console.error(`[files] Re-upload failed for ${refName}: ${resp.status} ${errText}`);
      return null;
    }

    const data = await resp.json();
    UPLOADED_REF_FILES[refIdx].fileId = data.id;
    console.log(`[files] Refreshed ${refName} → ${data.id} (replaced ${staleFileId})`);
    return data.id;
  } catch (err) {
    console.error(`[files] Re-upload error for ${refName}:`, err.message);
    return null;
  }
}

/**
 * Send a request to Grok /responses with automatic retry on file-ingest errors.
 * On retry: strips the bad file_id, kicks off a background re-upload, retries once.
 */
async function sendGrokRequest(input, { max_output_tokens = 16384, temperature = 0.85 } = {}) {
  const MAX_FILE_RETRIES = 3;

  const doFetch = (payload) =>
    fetch(`${XAI_BASE}/responses`, {
      method: "POST",
      headers: xaiHeaders("application/json"),
      body: JSON.stringify({
        model: GROK_MODEL,
        input: payload,
        max_output_tokens,
        temperature,
      }),
    });

  let resp = await doFetch(input);
  let retries = 0;

  while (resp.status === 400 && retries < MAX_FILE_RETRIES) {
    const errBody = await resp.text();
    const badFileId = extractFailedFileId(errBody);

    if (!badFileId) {
      // Not a file-ingest error — throw immediately, don't mask real 400s
      throw new Error(`Grok API 400: ${errBody}`);
    }

    // Count how many entries match before stripping
    let stripped = 0;
    for (const msg of input) {
      if (Array.isArray(msg.content)) {
        const before = msg.content.length;
        msg.content = msg.content.filter(
          (c) => !(c.type === "input_file" && c.file_id === badFileId)
        );
        stripped += before - msg.content.length;
      }
    }

    if (stripped === 0) {
      // Error names a file_id not in our content — retrying would loop forever
      console.warn(`[grok] File ${badFileId} not in content array — cannot strip, degrading to no ref files`);
      break;
    }

    retries++;
    console.warn(`[grok] Stripped bad file_id ${badFileId}, retrying (attempt ${retries}/${MAX_FILE_RETRIES})`);

    // Re-upload in background so future calls get a fresh file_id
    refreshReferenceFile(badFileId).catch(() => {});

    resp = await doFetch(input);
  }

  // Exhausted retries, or broke out due to unstrippable file — degrade to no ref files
  if (resp.status === 400) {
    const errBody = await resp.text();
    const badFileId = extractFailedFileId(errBody);

    if (badFileId) {
      console.warn(`[grok] Retries exhausted — stripping ALL reference files and retrying without them`);
      for (const msg of input) {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.filter((c) => c.type !== "input_file");
        }
      }
      resp = await doFetch(input);
    }

    if (!resp.ok) {
      const finalErr = await resp.text();
      throw new Error(`Grok API ${resp.status}: ${finalErr}`);
    }
  } else if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Grok API ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();
  const outputMsg = (data.output || []).find((o) => o.type === "message");
  if (!outputMsg) throw new Error("No message in Grok response");
  const textBlock = (outputMsg.content || []).find((c) => c.type === "output_text");
  if (!textBlock) throw new Error("No output_text in Grok response");
  return textBlock.text;
}

/* ───────────────────────────────────────────
   HISTORY FETCHER
   Paginate back ~12 months to build a deep
   set of botline submissions + strategist
   replies for Grok context.
   ─────────────────────────────────────────── */
const HISTORY_MONTHS = 12;
const MAX_EXAMPLES = 25;      // cap examples sent to Grok
const MAX_PAGES = 50;         // safety ceiling — oldest cutoff normally stops pagination first
const MSGS_PER_PAGE = 200;    // Slack max per page

// Simple in-memory cache so we don't re-fetch 12 months on every trigger
let historyCache = { examples: [], fetchedAt: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

async function fetchRecentExamples(client, channelId, currentTs) {
  // Return cache if fresh
  if (Date.now() - historyCache.fetchedAt < CACHE_TTL_MS && historyCache.examples.length) {
    return historyCache.examples.filter((e) => e.ts !== currentTs).slice(0, MAX_EXAMPLES);
  }

  const examples = [];
  const oldest = String(Math.floor(Date.now() / 1000) - HISTORY_MONTHS * 30 * 24 * 60 * 60);
  let totalScanned = 0;
  let pagesUsed = 0;

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
      totalScanned += messages.length;
      pagesUsed = page + 1;

      for (const m of messages) {
        // Skip empty messages
        if (!m.text) continue;
        // Skip our own messages (same logic as main handler)
        if (m.user === BOT_USER_ID || (m.bot_id && m.bot_id === SELF_BOT_ID)) continue;
        // Must look like a botline submission
        if (!isHotlineSubmission(m.text, m.files)) continue;
        if (m.ts === currentTs) continue;

        const example = {
          ts: m.ts,
          brief: m.text.substring(0, 1000),
          response: null,
        };

        // Fetch thread to find HUMAN strategist replies only
        try {
          const thread = await client.conversations.replies({
            channel: channelId,
            ts: m.ts,
            limit: 15,
          });

          // Only consider human replies — exclude any bot message
          const humanReplies = (thread.messages || []).filter(
            (r) =>
              r.ts !== m.ts &&
              r.text &&
              r.text.length > 100 &&
              r.user !== BOT_USER_ID &&
              !(r.bot_id && r.bot_id === SELF_BOT_ID) &&
              !r.bot_id
          );
          if (humanReplies.length) {
            // Pick the longest human reply
            const best = humanReplies.sort((a, b) => b.text.length - a.text.length)[0];
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
    console.error("[history] Failed to fetch:", err.message);
  }

  // Sort newest-first, cache
  examples.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  historyCache = { examples, fetchedAt: Date.now() };

  const withReplies = examples.filter((e) => e.response).length;
  console.log(`[history] Paginated ${pagesUsed} pages, scanned ${totalScanned} messages`);
  console.log(`[history] ${examples.length} matched as submissions, ${withReplies} with human replies`);

  // Prefer examples with human replies, fill remaining slots with reply-less
  const replied = examples.filter((e) => e.ts !== currentTs && e.response);
  const noReply = examples.filter((e) => e.ts !== currentTs && !e.response);
  const selected = [...replied, ...noReply].slice(0, MAX_EXAMPLES);

  return selected;
}

function formatExamples(examples) {
  if (!examples.length) return "";

  const parts = [
    "BOTLINE INTELLIGENCE — #x-creative-botline submissions + strategist replies (last 12 months):\n",
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

  // 2. Past botline intelligence
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

  // Call x.ai Responses API (with file-ingest retry)
  return sendGrokRequest([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content },
  ]);
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
   via the Responses API, same as the botline path.
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
   THREAD FOLLOW-UP HANDLER (botline only)
   ─────────────────────────────────────────── */
const TRANSIENT_BOT_MSG = /^:brain:|^:warning:/;

const CLASSIFIER_SYSTEM = `You are a message classifier for Creative Botline, an AI creative strategist in a Slack channel.
You will receive the last bot response (truncated) and a new human reply in the thread.
Determine whether the human is directing their message AT the botline (asking it to do something, thanking it, or asking it a question) vs. reacting to the ideas for their own team, making a decision, praising/critiquing ideas as an internal discussion, or thinking out loud.

Return ONLY valid JSON, no markdown, no explanation:
{"directed_at_botline": true or false, "intent": "more" or "expand" or "social" or "other", "target_idea": "<concept name or null>"}

Rules:
- "more" = asking for additional/new/different ideas
- "expand" = asking to go deeper on ONE specific concept (set target_idea to the concept name)
- "social" = a thank-you, compliment, or greeting directed at the botline itself
- "other" = a directed question or instruction that doesn't fit the above
- If the person is discussing ideas with their team, making a decision ("let's go with #2"), expressing a preference ("love idea 3"), or reacting without asking the bot to act, set directed_at_botline to false.
- A thank-you TO the botline ("thanks botline!", "ty!") is social+directed. Praise OF the ideas as a team decision ("these are great, let's run with it") is NOT directed.
- When genuinely unsure, default to directed_at_botline false. Silence is safe; @mention is always available.`;

async function classifyFollowUp(replyText, lastBotResponse) {
  const contextSnippet = lastBotResponse
    ? lastBotResponse.substring(0, 1500)
    : "(no prior bot response)";

  const resp = await fetch(`${XAI_BASE}/responses`, {
    method: "POST",
    headers: xaiHeaders("application/json"),
    body: JSON.stringify({
      model: GROK_MODEL,
      input: [
        { role: "system", content: CLASSIFIER_SYSTEM },
        {
          role: "user",
          content: `LAST BOT RESPONSE (truncated):\n${contextSnippet}\n\nNEW HUMAN REPLY:\n${replyText}`,
        },
      ],
      max_output_tokens: 256,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    console.error(`[follow-up] Classifier API error ${resp.status}, defaulting to silent`);
    return { directed_at_botline: false, intent: "other", target_idea: null };
  }

  const data = await resp.json();
  const outputMsg = (data.output || []).find((o) => o.type === "message");
  const textBlock = outputMsg && (outputMsg.content || []).find((c) => c.type === "output_text");
  if (!textBlock) {
    console.error("[follow-up] Classifier returned no text, defaulting to silent");
    return { directed_at_botline: false, intent: "other", target_idea: null };
  }

  try {
    // Strip markdown fences if present
    const raw = textBlock.text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    return JSON.parse(raw);
  } catch {
    console.error("[follow-up] Classifier JSON parse failed, defaulting to silent:", textBlock.text);
    return { directed_at_botline: false, intent: "other", target_idea: null };
  }
}

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

    // 3. Intent gate — decide whether to respond
    const replyText = event.text || "";
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const mentions = [...replyText.matchAll(mentionPattern)].map((m) => m[1]);
    const mentionsBot = mentions.includes(BOT_USER_ID);
    const mentionsHuman = mentions.some((id) => id !== BOT_USER_ID);

    let intent = "other";
    let targetIdea = null;

    if (mentionsHuman && !mentionsBot) {
      // People talking to each other → stay silent
      console.log(`[follow-up] Intent: @mentions human only → silent`);
      return;
    }

    // Always classify intent (even on @mention — determines social/more/expand routing)
    const lastBotResponse = botResponses.length ? botResponses[botResponses.length - 1] : null;
    const classification = await classifyFollowUp(followUpText, lastBotResponse);
    const directed = !!classification.directed_at_botline;
    intent = classification.intent || "other";
    targetIdea = classification.target_idea || null;

    if (mentionsBot) {
      // @mention guarantees a response — override directed, keep classified intent
      console.log(
        `[follow-up] Intent: @mentions bot, classified intent=${intent}` +
        `${targetIdea ? ` target="${targetIdea}"` : ""} → responding`
      );
    } else {
      console.log(
        `[follow-up] Intent: directed=${directed} intent=${intent}` +
        `${targetIdea ? ` target="${targetIdea}"` : ""} → ${directed ? "responding" : "silent"}`
      );
      if (!directed) return;
    }

    // 4. Post thinking indicator (after intent gate, before Grok call)
    const thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `:brain: Working on it...`,
    });

    // 5. Handle "social" intent — short warm reply, no concepts
    if (intent === "social") {
      const socialResp = await fetch(`${XAI_BASE}/responses`, {
        method: "POST",
        headers: xaiHeaders("application/json"),
        body: JSON.stringify({
          model: GROK_MODEL,
          input: [
            {
              role: "system",
              content:
                "You are Creative Botline — a senior Creative Strategist. Reply warmly and wittily in 1-2 sentences. Do not generate new concepts or ideas. Keep it brief and human.",
            },
            { role: "user", content: followUpText },
          ],
          max_output_tokens: 256,
          temperature: 0.85,
        }),
      });

      if (!socialResp.ok) throw new Error(`Grok API ${socialResp.status}`);
      const socialData = await socialResp.json();
      const socialMsg = (socialData.output || []).find((o) => o.type === "message");
      const socialText = socialMsg && (socialMsg.content || []).find((c) => c.type === "output_text");
      await client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: socialText ? socialText.text : "Anytime! :slightly_smiling_face:",
      });
      return;
    }

    // 6. Fetch botline examples (hits 60-min cache from the initial brief)
    const examples = await fetchRecentExamples(client, HOTLINE_CHANNEL_ID, event.thread_ts);
    const examplesBlock = formatExamples(examples);

    // 7. Build single user turn with full context
    const content = [];

    // Reference files
    for (const ref of UPLOADED_REF_FILES) {
      content.push({ type: "input_file", file_id: ref.fileId });
    }

    // Past botline intelligence
    if (examplesBlock) {
      content.push({ type: "input_text", text: examplesBlock });
    }

    // Structured context as one input_text block
    const contextParts = [`ORIGINAL BRIEF:\n${originalBrief}`];

    if (botResponses.length) {
      contextParts.push(`PREVIOUS CREATIVE IDEAS:\n${botResponses.join("\n\n---\n\n")}`);
    }

    // Intent-specific instructions
    if (intent === "more" && botResponses.length) {
      contextParts.push(
        `MANDATORY — NET-NEW IDEAS ONLY:\n` +
        `The PREVIOUS CREATIVE IDEAS above are already delivered and OFF LIMITS. ` +
        `Do NOT repeat, rephrase, or create variations of any concept or primary tactic already used. ` +
        `You must generate completely new concepts built on DIFFERENT primary X tactics that have not ` +
        `appeared in this thread. Every idea must be a genuine net-new addition to the set.`
      );
    }

    if (intent === "expand" && targetIdea) {
      contextParts.push(
        `EXPAND REQUEST:\n` +
        `Take the concept "${targetIdea}" from the PREVIOUS CREATIVE IDEAS and go deeper. ` +
        `Provide a richer, more detailed version of this ONE concept — fuller creative execution, ` +
        `more sample creative, tactical nuance. Do not generate other concepts.`
      );
    }

    // Follow-up override: honor user's count and tactic constraints
    contextParts.push(
      `FOLLOW-UP OVERRIDE (applies to this response only — supersedes system prompt where they conflict):\n` +
      `This is a follow-up request, not an initial brief. Read the FOLLOW-UP REQUEST below carefully and honor it exactly:\n` +
      `- If the user specifies a NUMBER of ideas (e.g. "give me 2 more", "one more idea", "3 ideas"), ` +
      `generate exactly that number. Do NOT default to 5–7.\n` +
      `- If the user specifies a FORMAT or TACTIC (e.g. "vertical video", "RIN", "carousel", "thread"), ` +
      `every idea in this response must use that format/tactic. The "one idea per distinct primary tactic" rule does not apply.\n` +
      `- If the user specifies BOTH a count and a tactic, honor both.\n` +
      `- If the user does NOT specify a count, generate 5–7 ideas as usual.\n` +
      `- If the user does NOT specify a tactic, use a diverse mix as usual.\n` +
      `All other creative rules (output format, concept naming, no hashtags, no demographic targeting, product accuracy) still apply.`
    );

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

    // Diagnostic: summarize what we're sending to Grok
    const totalTextLen = content
      .filter((c) => c.type === "input_text")
      .reduce((sum, c) => sum + c.text.length, 0);
    console.log(
      `[grok] Sending follow-up: ${UPLOADED_REF_FILES.length} ref files, ${examples.length} examples, ` +
      `total text=${totalTextLen} chars`
    );

    // 8. Call Grok — system + single user turn (with file-ingest retry)
    const grokText = await sendGrokRequest([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ]);

    await postChunkedResponse(
      client, event.channel, event.thread_ts, thinking.ts,
      grokText
    );
  } catch (err) {
    console.error("[follow-up] Error:", err);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `:warning: Creative Botline is having technical issues. Please wait and respond - @CreativeBotline try again - in a moment.`,
      // text: `:warning: Creative Botline hit an error: ${err.message}`,
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

  // --- Guard: only the botline channel ---
  if (event.channel !== HOTLINE_CHANNEL_ID) {
    // Check for @mention in any non-hotline channel
    if (
      BOT_USER_ID &&
      event.text &&
      event.text.includes(`<@${BOT_USER_ID}>`)
    ) {
      if (processed.has(event.ts)) return;
      processed.add(event.ts);
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

  // --- Threaded reply in hotline channel → follow-up ---
  // Routes to handleThreadFollowUp if EITHER the thread is tracked (activeThreads)
  // OR the message @mentions the bot. @mention-in-thread always gets follow-up
  // routing (with classifier) regardless of activeThreads state.
  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
  const text = event.text || "";
  const mentionsBotInline = BOT_USER_ID && text.includes(`<@${BOT_USER_ID}>`);

  if (isThreadReply && (activeThreads.has(event.thread_ts) || mentionsBotInline)) {
    if (processed.has(event.ts)) return;
    processed.add(event.ts);
    return handleThreadFollowUp(event, client);
  }

  // --- Guard: must look like a botline submission ---
  if (!isHotlineSubmission(text, event.files)) {
    // Handle @mention in botline channel (top-level only — threaded @mentions handled above)
    if (mentionsBotInline) {
      if (processed.has(event.ts)) return;
      processed.add(event.ts);
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

  console.log(`[botline] New submission detected: ${event.ts}`);

  try {
    // 1. Parse the brief
    const brief = parseBrief(text);
    const briefText = formatBrief(brief);
    const requestId = brief.parsed.requestId || "NEW";
    const campaign = brief.parsed.campaign || "Botline Request";

    // Diagnostic: log parsed vs missing fields
    const allBriefKeys = ["requestId", "brand", "campaign", "handle", "valueProp", "cta", "objective", "kpi", "audience", "timeline", "additionalContext"];
    const found = allBriefKeys
      .filter((k) => brief.parsed[k])
      .map((k) => k === "additionalContext" ? `${k}=<${brief.parsed[k].length} chars>` : `${k}=${brief.parsed[k]}`)
      .join(", ");
    const missing = allBriefKeys.filter((k) => !brief.parsed[k]).join(", ");
    console.log(`[botline] Parsed fields: ${found || "(none)"} | missing: ${missing || "(none)"}`);

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
    console.log(`[botline] Fetched ${examples.length} past examples`);

    // 5. Call Grok
    const grokResponse = await callGrok(briefText, examples, { images, docs });

    // 6. Build header
    const header = `Creative ideas for *${requestId}* (${campaign}):`;

    // 7. Update the thinking message with the real response
    await postChunkedResponse(
      client, event.channel, event.ts, thinking.ts,
      `${header}\n\n${grokResponse}`
    );

    activeThreads.add(event.ts);
    console.log(`[botline] Response posted for ${requestId}`);
  } catch (err) {
    console.error("[botline] Error:", err);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `:warning: Creative Botline is having technical issues. Please wait and respond - @CreativeBotline try again - in a moment.`,
      // text: `:warning: Creative Botline hit an error: ${err.message}`,
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
