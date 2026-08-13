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
  BOT_USER_ID,
  PORT = "3000",
} = process.env;

// Botline channels that auto-trigger on submissions.
// Prefer HOTLINE_CHANNEL_IDS (comma-separated); fall back to single HOTLINE_CHANNEL_ID.
// First ID is the original botline channel and is always used for history/examples.
const HOTLINE_CHANNEL_IDS = (
  process.env.HOTLINE_CHANNEL_IDS ||
  process.env.HOTLINE_CHANNEL_ID ||
  ""
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const HOTLINE_CHANNELS = new Set(HOTLINE_CHANNEL_IDS);
// First ID = US / primary botline — always used for 12-month example history.
// Additional IDs (e.g. EMEA) auto-listen for submissions but borrow US history
// because those channels are new. Follow-ups still lock to the thread's own brief.
const HISTORY_CHANNEL_ID = HOTLINE_CHANNEL_IDS[0] || null;

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

/**
 * Detect when a brief or follow-up locks to a single X product/format.
 * Returns canonical tactic name or null.
 *
 * @param {string} text
 * @param {{ permissive?: boolean }} [opts] - permissive=true for short follow-up asks
 *   ("more Dynamic Cards", "with an animated profile") without requiring "using X solution".
 */
function detectLockedFormat(text, opts = {}) {
  if (!text) return null;
  const t = text;
  const permissive = !!opts.permissive;

  // Ordered: longer / more specific names first
  const catalog = [
    { name: "Animated Profiles (up to 5 Handles)", re: /animated profiles?/i },
    { name: "Sequential Instant Notifications (SIN)", re: /\bSIN\b|sequential instant notifications?/i },
    { name: "Randomized Instant Notifications (RIN)", re: /\bRIN\b|randomized instant notifications?/i },
    { name: "Scheduled Notification Program", re: /scheduled notification programs?/i },
    { name: "Branded Overlay", re: /branded overlay/i },
    { name: "Post Lens", re: /post lens/i },
    { name: "Trend Genius", re: /trend genius/i },
    { name: "Dynamic Cards", re: /dynamic cards?/i },
    { name: "Conversation Card", re: /conversation cards?/i },
    { name: "Website Card", re: /website cards?/i },
    { name: "Vertical Video Ads", re: /vertical videos?(?:\s+ads?)?/i },
    { name: "Carousel Ads", re: /carousels?(?:\s+ads?)?/i },
    { name: "Threaded Posts", re: /threaded posts?|thread ads?/i },
    { name: "Promoted Posts", re: /promoted posts?/i },
    { name: "X Live", re: /\bx live\b/i },
    { name: "Image Ads", re: /image ads?/i },
    { name: "Polls", re: /\bpolls?\b/i },
  ];

  const found = [];
  for (const item of catalog) {
    if (item.re.test(t)) found.push(item.name);
  }
  if (!found.length) return null;

  // Explicit exclusivity / "using X solution" / campaign framed around the product
  const exclusive =
    /using\s+[\w\s-]{0,40}solution/i.test(t) ||
    /\bonly\s+/i.test(t) ||
    /\bvia\s+/i.test(t) ||
    /must use|required format|format lock|exclusively/i.test(t) ||
    /\bwith (?:an? |the )?[\w\s-]{0,40}(?:profile|card|carousel|video|rin|sin|lens|overlay)/i.test(t);

  // Strong signal: "Using Dynamic Cards solution" style
  const usingSolution = /using\s+([^.!\n]{0,60}?)\s+solution/i.exec(t);
  if (usingSolution) {
    for (const item of catalog) {
      if (item.re.test(usingSolution[1]) || item.re.test(usingSolution[0])) {
        return item.name;
      }
    }
  }

  // Campaign name often encodes the product (e.g. "Ligue 1 Scoring Dynamic Cards")
  const campaignOnly = /Campaign(?: Name)?:\s*([^\n]+)/i.exec(t);
  if (campaignOnly) {
    for (const item of catalog) {
      if (item.re.test(campaignOnly[1])) return item.name;
    }
  }

  // Follow-up asks: if they name one product, lock to it
  if (permissive && found.length === 1) return found[0];
  if (permissive && found.length > 1) return found[0];

  // CTA / "want people to do" often says "Using Dynamic Cards solution..."
  if (exclusive && found.length >= 1) return found[0];

  // Single product mentioned in CTA/value-prop with "solution" nearby
  if (found.length === 1 && /solution/i.test(t)) return found[0];

  return null;
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
async function sendGrokRequest(input, { max_output_tokens = 16384, temperature = 0.72 } = {}) {
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

// In-memory cache for US botline history (shared by all hotline channels as style reference)
let historyCache = { examples: [], fetchedAt: 0, channelId: null };
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

async function fetchRecentExamples(client, channelId, currentTs) {
  if (!channelId) {
    console.warn("[history] No channelId provided — returning empty examples");
    return [];
  }

  // Return cache if fresh for the history channel
  if (
    historyCache.channelId === channelId &&
    Date.now() - historyCache.fetchedAt < CACHE_TTL_MS &&
    historyCache.examples.length
  ) {
    console.log(`[history] Cache hit for ${channelId} (${historyCache.examples.length} examples)`);
    return historyCache.examples.filter((e) => e.ts !== currentTs).slice(0, MAX_EXAMPLES);
  }

  console.log(`[history] Fetching up to ${HISTORY_MONTHS} months from US/history channel ${channelId}`);
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
    console.error(`[history] Failed to fetch channel ${channelId}:`, err.message);
  }

  // Sort newest-first, cache
  examples.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));
  historyCache = { examples, fetchedAt: Date.now(), channelId };

  const withReplies = examples.filter((e) => e.response).length;
  console.log(`[history] channel=${channelId} pages=${pagesUsed} scanned=${totalScanned}`);
  console.log(`[history] channel=${channelId} matched=${examples.length} withReplies=${withReplies}`);

  // Prefer examples with human replies, fill remaining slots with reply-less
  const replied = examples.filter((e) => e.ts !== currentTs && e.response);
  const noReply = examples.filter((e) => e.ts !== currentTs && !e.response);
  const selected = [...replied, ...noReply].slice(0, MAX_EXAMPLES);

  return selected;
}

function formatExamples(examples) {
  if (!examples.length) return "";

  const parts = [
    "BOTLINE INTELLIGENCE — past US botline submissions + strategist replies (last 12 months).\n" +
      "Use these ONLY for tone, quality bar, structure, and what worked for similar briefs.\n" +
      "CRITICAL: Never import another submission's brand, IP, characters, products, or campaign world into the CURRENT thread's brief " +
      "(e.g. never pull Peanuts/Snoopy/Burger King into a Betclic brief, or vice versa).\n" +
      "The ORIGINAL BRIEF / NEW BRIEF in this request is the only brand world allowed.\n",
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

  const lockedFormat = detectLockedFormat(briefText);
  if (lockedFormat) {
    console.log(`[grok] FORMAT LOCK detected: ${lockedFormat}`);
    content.push({
      type: "input_text",
      text:
        `FORMAT LOCK (non-negotiable for this brief):\n` +
        `The brief requires PRIMARY X TACTIC = "${lockedFormat}" for EVERY concept.\n` +
        `Do NOT use Website Cards, Vertical Video, Carousels, Conversation Cards, RIN, Trend Genius, or any other primary tactic.\n` +
        `Generate 5–7 DISTINCT creative concepts that all use "${lockedFormat}" as Primary X Tactic.\n` +
        `Vary hooks and sample creative — not the tactic. The diverse-mix / one-tactic-per-idea rule is suspended.`,
    });
  }

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
    text:
      "Generate 5–7 creative concepts for this brief following every rule in your system prompt. " +
      "Every concept must pass Brand World Fidelity and the Quality Bar. " +
      "BRIEF LOCK: Use ONLY the brand, IP, campaign, and product world from NEW BRIEF above. " +
      "Past botline submissions are style/quality reference only — never import another brief's brand or campaign. " +
      (lockedFormat
        ? `FORMAT LOCK is active: every Primary X Tactic must be "${lockedFormat}". `
        : "If no format is locked, use a diverse mix with one idea per distinct primary tactic. ") +
      "Clever and feed-stopping means brand-true insight — never abstract, spooky, or Lynchian when the brand world is warm/playful/nostalgic. " +
      "Never pitch Follower Ads or Collection Ads.",
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
    `formatLock=${lockedFormat || "none"}, total text=${totalTextLen} chars`
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
{"directed_at_botline": true or false, "intent": "more" or "revise" or "expand" or "social" or "chat" or "other", "target_idea": "<concept name or null>", "critique": "<short summary of what they disliked or want fixed, or null>"}

Rules:
- "more" = explicitly asking for additional/new/different creative concepts/ideas (e.g. "give me more ideas", "another round", "more ideas maybe with an animated profile"). No strong critique required.
- "revise" = critiquing prior ideas AND wanting a replacement set of better concepts (e.g. "these don't make sense, give me better ones", "make them good", "try again"). Fill "critique" with the key complaints. Must imply they want NEW ideas, not just an explanation.
- "expand" = asking to go deeper on ONE specific concept (set target_idea to the concept name)
- "social" = a pure thank-you, compliment, greeting, or light banter directed at the botline with NO request to regenerate and NO substantive question that needs answering (e.g. "thanks!", "Thank you Gronk", "YOU are it!!")
- "chat" = asking a question ABOUT prior ideas, process, or reasoning DIRECTED AT THE BOT — wants an explanation or conversation, NOT a new concept dump. Examples: "what were you thinking?", "what was going on with those spooky ideas?", "why did you suggest X?", "explain Concept 2", "how does RIN work?". Fill "critique" if they also name what was wrong, but do NOT treat explanation requests as revise.
- "other" = a directed instruction that doesn't fit the above (rare). Prefer "chat" for questions.
- CRITICAL: Quoting or naming bad concepts while asking "what/why/how were you thinking" = "chat", NOT "revise" or "more". Only "revise" if they clearly want new ideas generated.
- If the message BOTH critiques ideas AND asks for more/better ideas, prefer "revise" over "chat" or "social".
- Sarcastic praise of bad ideas ("bold", "Lynchian", "I admire that") with no ask for new ideas = "chat" or "social". With an ask for new ideas = "revise".
- Addressing the bot as "Grok", "Gronk", "botline", "CreativeBotline", or "you" (when clearly the bot) counts as directed even without an @mention — UNLESS the message clearly tells the bot to stay out.
- STAY SILENT (directed_at_botline false) when:
  • People are discussing ideas with their team, making a decision, or asking each other clarifying questions
  • Someone @mentions a human teammate (and not the bot) about the ideas
  • Someone says the bot should not answer / they will handle tweaks themselves (e.g. "not you grok", "I will make more tweaks not you", "don't answer", "stay out")
  • Someone asks "what is specifically weird?" in a teammate discussion after human feedback — that question is for the human who gave the feedback, not the bot, unless they clearly @ the bot
- A thank-you TO the botline ("thanks botline!", "ty!", "Thank you Gronk") is social+directed. Praise OF the ideas as a team decision ("these are great, let's run with it") is NOT directed.
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
    return { directed_at_botline: false, intent: "other", target_idea: null, critique: null };
  }

  const data = await resp.json();
  const outputMsg = (data.output || []).find((o) => o.type === "message");
  const textBlock = outputMsg && (outputMsg.content || []).find((c) => c.type === "output_text");
  if (!textBlock) {
    console.error("[follow-up] Classifier returned no text, defaulting to silent");
    return { directed_at_botline: false, intent: "other", target_idea: null, critique: null };
  }

  try {
    // Strip markdown fences if present
    const raw = textBlock.text.replace(/```json?\s*/g, "").replace(/```/g, "").trim();
    return JSON.parse(raw);
  } catch {
    console.error("[follow-up] Classifier JSON parse failed, defaulting to silent:", textBlock.text);
    return { directed_at_botline: false, intent: "other", target_idea: null, critique: null };
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
    let critique = null;

    if (mentionsHuman && !mentionsBot) {
      // People talking to each other → stay silent
      console.log(`[follow-up] Intent: @mentions human only → silent`);
      return;
    }

    // Hard silence: human tells the bot to stay out / they'll handle tweaks
    const stayOut =
      /\bnot you[, ]+(grok|gronk|botline|bot)\b/i.test(replyText) ||
      /\bi(?:'|’)ll (?:make|do|handle).{0,40}not you\b/i.test(replyText) ||
      /\b(?:don(?:'|’)t|do not) (?:answer|reply|respond)\b/i.test(replyText) ||
      /\bstay out\b/i.test(replyText);
    if (stayOut && !mentionsBot) {
      console.log(`[follow-up] Intent: stay-out phrasing → silent`);
      return;
    }

    // Always classify intent (even on @mention — determines social/more/revise/expand routing)
    const lastBotResponse = botResponses.length ? botResponses[botResponses.length - 1] : null;
    const classification = await classifyFollowUp(followUpText, lastBotResponse);
    const directed = !!classification.directed_at_botline;
    intent = classification.intent || "other";
    targetIdea = classification.target_idea || null;
    critique = classification.critique || null;

    if (mentionsBot) {
      // @mention guarantees a response — override directed, keep classified intent
      console.log(
        `[follow-up] Intent: @mentions bot, classified intent=${intent}` +
        `${targetIdea ? ` target="${targetIdea}"` : ""}` +
        `${critique ? ` critique="${String(critique).slice(0, 80)}"` : ""} → responding`
      );
    } else {
      console.log(
        `[follow-up] Intent: directed=${directed} intent=${intent}` +
        `${targetIdea ? ` target="${targetIdea}"` : ""}` +
        `${critique ? ` critique="${String(critique).slice(0, 80)}"` : ""} → ${directed ? "responding" : "silent"}`
      );
      if (!directed) return;
    }

    // 4. Post thinking indicator (after intent gate, before Grok call)
    const thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `:brain: Working on it...`,
    });

    // 5. Handle "social" / "chat" / non-regen "other" — conversational reply, NO concepts
    if (intent === "social" || intent === "chat" || intent === "other") {
      const priorIdeasSnippet = botResponses.length
        ? botResponses[botResponses.length - 1].substring(0, 3500)
        : "(no prior concepts in this thread)";
      const isSocial = intent === "social";
      const chatSystem = isSocial
        ? "You are Creative Botline — a senior Creative Strategist on Slack. Reply warmly and wittily in 1-2 sentences. You are the bot (sometimes called Grok / Gronk / Botline / \"it\"). Do not generate new concepts or ideas. Do not invent that nicknames or jokes were part of the creative concepts. Keep it brief and human."
        : `You are Creative Botline — a senior Creative Strategist on Slack. The human is asking a question about prior ideas or process — answer it conversationally.

Rules:
- Answer the question directly. Be honest, self-aware, and concise (2–6 sentences unless they need a bit more).
- If they ask what you were thinking / why ideas were off-tone or spooky, explain the likely miss plainly (e.g. over-indexed on "clever/feed-stopping" and drifted into abstract/surreal territory instead of staying in the brand world) and own it.
- ONLY reference concepts, names, or details that actually appear in PRIOR CONCEPTS below. Never invent that something (e.g. a nickname like "Gronk", a celebrity mashup, or a surreal motif) was "woven into" the ideas if it is not in the prior concepts text.
- If a human teammate said ideas were "weird," and someone asks what was weird, either stay high-level about possible tone/tactical issues visible in the prior concepts OR say you should let that teammate clarify — do not fabricate a specific critique that isn't supported by the thread.
- Do NOT generate a new set of creative concepts. Do NOT use the Concept 1 / Primary X Tactic output format.
- Do NOT append the Creative Strategy support closing note.
- If they also want new ideas, invite them to ask for another round — but do not generate them in this reply.
- You are the bot (Grok / Botline). Stay client-facing and professional, with light wit when it fits.`;

      const chatUser = isSocial
        ? followUpText
        : `ORIGINAL BRIEF (context):\n${originalBrief.substring(0, 2000)}\n\n` +
          `PRIOR CONCEPTS (truncated):\n${priorIdeasSnippet}\n\n` +
          (critique ? `NOTED CRITIQUE:\n${critique}\n\n` : "") +
          `HUMAN QUESTION:\n${followUpText}`;

      const chatResp = await fetch(`${XAI_BASE}/responses`, {
        method: "POST",
        headers: xaiHeaders("application/json"),
        body: JSON.stringify({
          model: GROK_MODEL,
          input: [
            { role: "system", content: chatSystem },
            { role: "user", content: chatUser },
          ],
          max_output_tokens: isSocial ? 256 : 800,
          temperature: 0.7,
        }),
      });

      if (!chatResp.ok) throw new Error(`Grok API ${chatResp.status}`);
      const chatData = await chatResp.json();
      const chatMsg = (chatData.output || []).find((o) => o.type === "message");
      const chatText = chatMsg && (chatMsg.content || []).find((c) => c.type === "output_text");
      await client.chat.update({
        channel: event.channel,
        ts: thinking.ts,
        text: chatText
          ? chatText.text
          : isSocial
            ? "Anytime! :slightly_smiling_face:"
            : "Fair question — I overreached on those. Want me to take another pass?",
      });
      return;
    }

    // 6. Fetch US botline examples for style/quality (EMEA has little history of its own).
    // Thread brief + prior ideas below are what keep this reply on the correct brand.
    const examples = await fetchRecentExamples(client, HISTORY_CHANNEL_ID, event.thread_ts);
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

    // Structured context as one input_text block — thread brief + prior ideas are authoritative
    const briefLockedFormat = detectLockedFormat(originalBrief);
    const followUpLockedFormat = detectLockedFormat(followUpText, { permissive: true });
    const lockedFormat = followUpLockedFormat || briefLockedFormat;

    const contextParts = [
      `THIS THREAD'S ORIGINAL BRIEF (authoritative — the only brand/campaign world allowed):\n${originalBrief}`,
      `BRIEF LOCK (non-negotiable):\n` +
        `You are continuing THIS Slack thread only. Ignore brands/campaigns from botline intelligence examples unless they match this brief.\n` +
        `If the follow-up only names a tactic (e.g. "Dynamic Cards" / "only Dynamic Cards"), keep that tactic AND this thread's brand/campaign — ` +
        `do not switch to any other brand/IP from US history examples.\n` +
        `Failure mode to avoid: answering a Betclic Ligue 1 brief with Peanuts/Snoopy/Burger King creatives.`,
    ];

    if (lockedFormat) {
      console.log(`[follow-up] FORMAT LOCK active: ${lockedFormat} (from ${followUpLockedFormat ? "follow-up" : "original brief"})`);
      contextParts.push(
        `FORMAT LOCK (non-negotiable):\n` +
          `PRIMARY X TACTIC for EVERY concept must be "${lockedFormat}".\n` +
          `Do not mix in other primary tactics. Deliver distinct creative hooks within "${lockedFormat}" only.`
      );
    }

    if (botResponses.length) {
      contextParts.push(
        `IDEAS ALREADY DELIVERED IN THIS THREAD (do not repeat; stay in the same brand world):\n` +
          `${botResponses.join("\n\n---\n\n")}`
      );
    }

    // Intent-specific instructions
    if (intent === "more" && botResponses.length) {
      contextParts.push(
        lockedFormat
          ? `MANDATORY — NET-NEW IDEAS ONLY (FORMAT LOCKED):\n` +
            `The IDEAS ALREADY DELIVERED IN THIS THREAD above are OFF LIMITS as creative hooks. ` +
            `Generate completely new concepts that ALL still use Primary X Tactic "${lockedFormat}". ` +
            `Do not switch tactics for variety. Stay in THIS THREAD'S ORIGINAL BRIEF brand world.`
          : `MANDATORY — NET-NEW IDEAS ONLY:\n` +
            `The IDEAS ALREADY DELIVERED IN THIS THREAD above are OFF LIMITS. ` +
            `Do NOT repeat, rephrase, or create variations of any concept or primary tactic already used in this thread. ` +
            `You must generate completely new concepts built on DIFFERENT primary X tactics that have not ` +
            `appeared in this thread (unless the follow-up locks you to one tactic). Every idea must be a genuine net-new addition. ` +
            `Stay in THIS THREAD'S ORIGINAL BRIEF brand world. Raise the quality bar: brand-world fidelity first, then cleverness. Do not drift into abstract, ` +
            `spooky, Lynchian, or brand-agnostic concepts to force novelty.`
      );
    }

    if (intent === "revise" && botResponses.length) {
      contextParts.push(
        `MANDATORY — REVISE AFTER CRITIQUE:\n` +
        `Prior ideas in THIS THREAD missed the mark. Generate a replacement set that fixes the feedback.\n` +
        `Critique to honor: ${critique || followUpText}\n` +
        `Rules for this revision:\n` +
        `- Stay locked to THIS THREAD'S ORIGINAL BRIEF brand/IP/campaign world. Every concept must name or clearly use those elements.\n` +
        `- Do NOT recycle the rejected concepts, even with new titles.\n` +
        `- Do NOT borrow brands/IPs from US botline history examples.\n` +
        (lockedFormat
          ? `- FORMAT LOCK: every Primary X Tactic must be "${lockedFormat}".\n`
          : `- Different primary tactics across the set are good, but only when they fit — never force a tactic that doesn't serve the brief.\n`) +
        `- Do NOT "fix" quality problems by going more abstract, uncanny, dreamlike, or avant-garde.\n` +
        `- Clever = sharp cultural insight + brand-true twist + platform-native mechanic. Not surrealism.\n` +
        `- Prefer currently available standard tactics. Never pitch Follower Ads or Collection Ads.\n` +
        `- If prior ideas were too generic (product grids / chase videos), invent a stronger hook inside the brand world.\n` +
        `- If prior ideas were off-tone for the brand, match the brand's emotional register exactly.`
      );
    }

    if (intent === "expand" && targetIdea) {
      contextParts.push(
        `EXPAND REQUEST:\n` +
        `Take the concept "${targetIdea}" from the IDEAS ALREADY DELIVERED IN THIS THREAD and go deeper. ` +
        `Provide a richer, more detailed version of this ONE concept — fuller creative execution, ` +
        `more sample creative, tactical nuance. Do not generate other concepts. ` +
        `Keep it firmly inside THIS THREAD'S ORIGINAL BRIEF brand world.`
      );
    }

    // Follow-up override: honor user's count and tactic constraints
    contextParts.push(
      `FOLLOW-UP OVERRIDE (applies to this response only — supersedes system prompt where they conflict):\n` +
      `This is a follow-up request, not an initial brief. Read the FOLLOW-UP REQUEST below carefully and honor it exactly:\n` +
      `- If the user specifies a NUMBER of ideas (e.g. "give me 2 more", "one more idea", "3 ideas"), ` +
      `generate exactly that number. Do NOT default to 5–7.\n` +
      `- If the user specifies a FORMAT or TACTIC (e.g. "vertical video", "RIN", "carousel", "thread", "animated profile"), ` +
      `every idea in this response must use that format/tactic. The "one idea per distinct primary tactic" rule does not apply.\n` +
      `- When the tactic is locked (e.g. all Animated Profiles), still make each concept a DISTINCT creative hook — not five reskins of the same animation beat.\n` +
      `- Stay product-accurate: Website Cards open a URL/menu destination (no invented builders); Conversation Cards can flip to a link after engagement; Animated Profiles = promoted entry into the profile animation experience (up to 5 handles).\n` +
      `- Prefer low-lift executions that use existing brand/IP assets unless the brief supports heavy production.\n` +
      `- If the user specifies BOTH a count and a tactic, honor both.\n` +
      `- If the user does NOT specify a count, generate 5–7 ideas as usual.\n` +
      `- If the user does NOT specify a tactic, use a diverse mix as usual.\n` +
      `- Brand World Fidelity, Quality Bar, DEPRECATED PRODUCTS, and tone-match rules from the system prompt ALWAYS apply — they are never overridden.\n` +
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

  // --- Guard: only configured botline channels ---
  if (!HOTLINE_CHANNELS.has(event.channel)) {
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

    // 4. Fetch US botline examples for style/quality reference (all regions share this pool)
    const examples = await fetchRecentExamples(
      client,
      HISTORY_CHANNEL_ID,
      event.ts
    );
    console.log(
      `[botline] Fetched ${examples.length} US history examples (request channel=${event.channel}, history=${HISTORY_CHANNEL_ID})`
    );

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
  console.log(
    `[startup] Hotline channels: ${[...HOTLINE_CHANNELS].join(", ") || "(none)"} | ` +
      `shared history from US/first channel: ${HISTORY_CHANNEL_ID || "(none)"}`
  );
})();
