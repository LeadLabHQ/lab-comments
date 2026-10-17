// Lab Comments — a small, safe comment system for static sites on
// Cloudflare Pages + D1. Save this file as `_worker.js` in the root of
// your Pages project (next to your HTML files).
//
// What it does:
// - GET  /api/comments?path=/your-page  -> the approved comments for a page
// - POST /api/comments                  -> add a comment
// - POST /api/comments/report           -> a reader flags a comment for a person
// - GET  /api/comments/moderation       -> the token-gated moderation queue page
// Everything else is passed through to your site's static files.
//
// Safety design (the short version):
// - No accounts for readers. No cookies. No tracking. No ads.
// - Comments are stored as plain text. The web page shows them with
//   text-only rendering, so comment text can never turn into code.
// - Any comment with a link in it — in the text OR in the name — waits
//   for a human OK before it shows. Names are screened for spam words
//   too. The reply names the hold reason so the reader hears the truth.
// - The same comment sent twice (same page + name + text, within 10
//   minutes) is answered with the first copy's status, never posted
//   twice — double-clicks and retries are safe.
// - A page flooded with comments answers new posters with a message
//   that blames the busy page, never the reader.
// - The homepage path "/" is a valid comment path (an earlier version
//   refused it, which broke commenting from a site's front page).
// - A hidden trap field catches simple spam bots.
// - Each person can post 5 comments an hour. We count by a scrambled
//   (SHA-256 hashed) address — the real address is never stored.
// - Too-long names/comments are refused with a clear error, never
//   silently cut off — nobody's words get quietly changed.
// - A page can take at most 20 comments in 10 minutes from everyone
//   combined. Real pages never move that fast; a spam flood hits this
//   wall even if it keeps changing addresses.
// - Every database call uses prepared statements. No string-built SQL.
// - Comment links are shown with rel="nofollow ugc noopener noreferrer",
//   so spam links earn nothing.

// ---------- small helpers ----------

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------- security headers ----------
// Sent on every response. If your site needs more (for example a
// newsletter form on another domain), extend form-action / connect-src
// here — this list is the safe starting point.
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "font-src 'self' data:; connect-src 'self'; " +
    "media-src 'self'; object-src 'none'; base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'none'; worker-src 'self'; upgrade-insecure-requests",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-permitted-cross-domain-policies": "none",
};

function withSecurityHeaders(response) {
  const wrapped = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    wrapped.headers.set(name, value);
  }
  // Our API is same-origin only and needs no CORS.
  wrapped.headers.delete("access-control-allow-origin");
  return wrapped;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(text, limit) {
  const s = String(text || "");
  return s.length > limit ? s.slice(0, limit) : s;
}

// ---------- comments ----------

const COMMENT_NAME_MAX = 40; // longest name we accept
const COMMENT_BODY_MAX = 1000; // longest comment we accept
const COMMENT_BODY_BYTES_MAX = 8192; // biggest request body: 8 KB
const COMMENT_RATE_MAX = 5; // posts per hour per person
const COMMENT_PATH_BURST_MAX = 20; // comments per page per 10 minutes, everyone combined
const COMMENT_PATH_BURST_MINUTES = 10; // the burst window, in minutes
const COMMENT_DEDUPE_MINUTES = 10; // exact-duplicate window (same page + name + text)
const COMMENT_REPORT_RATE_MAX = 10; // reports per hour per person
const COMMENT_REPORT_HOLD_THRESHOLD = 3; // reports (from 3 different readers) that send an approved comment back to a person

// Hold-first mode. When this is true, a person's very first comment
// on your site (the first one ever from their address, in any state —
// shown, held, or rejected) waits for a human OK before it shows,
// with the hold reason "first". People who have commented before are
// not affected. It is a strong setting: on a busy site it means every
// new reader waits. It ships off — turn it on only if you want that.
const COMMENTS_HOLD_FIRST = false;

// Global velocity watch. If one person posts this many comments
// across ALL pages (not just one page) inside the window below, the
// next comment is held for a person instead of shown — reason
// "velocity". It is held, never refused outright: a keen reader
// having a busy ten minutes still gets read by a person.
const COMMENTS_GLOBAL_VELOCITY_MAX = 10; // comments across all pages
const COMMENTS_GLOBAL_VELOCITY_MINUTES = 10; // the velocity window, in minutes

// A comment that looks like it holds a link waits for a human OK.
const COMMENT_LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|xyz|info|biz|ru|top|click|link)\b)/i;

// Words that also send a comment to the human-OK queue. Edit freely.
const COMMENT_HOLD_WORDS = [
  "viagra", "cialis", "casino", "porn", "escort", "crypto giveaway",
  "make money fast", "free money", "work from home scam",
];

// Creates the table on first use, so a missed setup step still works.
// (Running schema.sql yourself is the tidy path; this is the safety net.)
async function ensureCommentsTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS lab_comments (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "path TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, " +
      "ip_hash TEXT, status TEXT NOT NULL DEFAULT 'approved', " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_lab_comments_path ON lab_comments (path, status)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_lab_comments_ip ON lab_comments (ip_hash, created_at)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_lab_comments_path_time ON lab_comments (path, created_at)"
  ).run();
  // v2: how many readers have reported this comment. Older tables do
  // not have the column yet, so the add is guarded — if the column
  // is already there, the database says no and we carry on.
  try {
    await env.DB.prepare(
      "ALTER TABLE lab_comments ADD COLUMN report_count INTEGER NOT NULL DEFAULT 0"
    ).run();
  } catch {
    // Column already exists — that is the normal case after v2 runs once.
  }
  // One row per report. The UNIQUE pair means the same person
  // reporting the same comment twice is counted once.
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS lab_comment_reports (" +
      "comment_id INTEGER NOT NULL, ip_hash TEXT, " +
      "created_at TEXT NOT NULL DEFAULT (datetime('now')), " +
      "UNIQUE(comment_id, ip_hash))"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_lab_comment_reports_ip ON lab_comment_reports (ip_hash, created_at)"
  ).run();
}

// Accepts "/news/x", "/news/x/" — returns "/news/x"; null when malformed.
function normalizeCommentPath(raw) {
  if (typeof raw !== "string") return null;
  let p;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  p = p.split(/[?#]/)[0].trim();
  if (p === "") return "/"; // an empty path can only mean the homepage
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  if (!/^\/[A-Za-z0-9\-._~\/]*$/.test(p)) return null;
  if (p.length > 200) return null;
  p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return p || "/";
}

// Plain-text hygiene: drop control characters (newlines stay in comment
// bodies), squash extra spaces in names. This is tidiness only — the
// real safety rule is that pages render comments as text, never HTML.
function cleanCommentText(value, keepNewlines) {
  let s = typeof value === "string" ? value : "";
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!keepNewlines) s = s.replace(/\s+/g, " ");
  return s.trim();
}

// IPv6 addresses are handed out in /64 blocks: one person (or one
// attacker) usually controls every address in their /64 and can
// rotate through them freely. Per-person limits therefore key on
// the /64 prefix for IPv6, so rotating inside the block does not
// mint a fresh "person" per address. IPv4 addresses are used
// exactly as they arrive.
function normalizeIpForHash(rawIp) {
  const value = String(rawIp || "").trim();
  if (!value.includes(":")) return value; // IPv4 or a placeholder
  // IPv4-mapped IPv6 (::ffff:203.0.113.7): key on the IPv4 part.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  // Expand "::" so the first four groups (the /64 prefix) are plain.
  const halves = value.split("::");
  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return value;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = value.split(":");
  }
  if (groups.length !== 8) return value;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toLowerCase().padStart(4, "0"))
      .join(":") + "::/64"
  );
}

async function hashIp(request) {
  const rawIp =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
  const ip = normalizeIpForHash(rawIp);
  // PER-INSTALL SALT: the "lab-comments:" prefix below is the salt for
  // the address scramble. Change it to a word or phrase of your own
  // when you install — then your site's scrambled addresses can never
  // be matched against anyone else's copy of this code, and nobody can
  // pre-compute the scramble for a known address. (Changing it later
  // is safe: it only resets who counts as "the same person" for the
  // hourly limit.)
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("lab-comments:" + ip)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Posts must come from your own site. If the browser sends an Origin
// header, its host must match the host the request was made to.
function commentOriginOk(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser callers send none; POST+JSON still required.
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.host === new URL(request.url).host;
}

async function handleCommentsGet(request, env) {
  try {
    const url = new URL(request.url);
    const path = normalizeCommentPath(url.searchParams.get("path") || "");
    if (!path) return json({ ok: false, error: "invalid" }, 400);
    await ensureCommentsTable(env);
    const rows = await env.DB.prepare(
      "SELECT id, name, body, created_at FROM lab_comments WHERE path = ? AND status = 'approved' ORDER BY id ASC LIMIT 200"
    )
      .bind(path)
      .all();
    return json({ ok: true, comments: rows.results || [] });
  } catch {
    return json({ ok: false, error: "server" }, 500);
  }
}

async function handleCommentsPost(request, env) {
  try {
    if (!commentOriginOk(request)) {
      return json({ ok: false, error: "origin" }, 403);
    }
    const ctype = request.headers.get("content-type") || "";
    if (!ctype.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "content_type" }, 415);
    }
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > COMMENT_BODY_BYTES_MAX) {
      return json({ ok: false, error: "too_large" }, 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > COMMENT_BODY_BYTES_MAX) {
      return json({ ok: false, error: "too_large" }, 413);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "invalid" }, 400);
    }
    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "invalid" }, 400);
    }

    // Honeypot: a filled hidden field means a bot. Pretend success.
    if (cleanString(body.website)) return json({ ok: true, status: "approved" });

    const path = normalizeCommentPath(body.path || "");
    const name = cleanCommentText(body.name, false);
    const text = cleanCommentText(body.body, true);
    // "/" (the homepage) is a valid path — refusing it broke posting
    // from a site's front page, whose canonical path IS "/".
    if (!path || !name || !text) {
      return json({ ok: false, error: "invalid" }, 400);
    }
    // Too long? Refuse it with a clear error. We never cut a comment
    // down quietly — the writer deserves to know.
    if (name.length > COMMENT_NAME_MAX) {
      return json({ ok: false, error: "name_too_long" }, 400);
    }
    if (text.length > COMMENT_BODY_MAX) {
      return json({ ok: false, error: "too_long" }, 400);
    }

    await ensureCommentsTable(env);

    const ipHash = await hashIp(request);
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lab_comments WHERE ip_hash = ? AND created_at >= datetime('now', '-1 hour')"
    )
      .bind(ipHash)
      .first();

    // Global velocity watch: this person's comments on every page
    // together in the last few minutes. The count is taken here so
    // the hold below can use it, but precedence is deliberate: the
    // hourly refusal answers whenever the hourly cap is hit —
    // including when the velocity watch has also tripped. An
    // earlier version let a velocity trip convert every refusal
    // into another pending insert, so a flood could fill the
    // moderation queue forever without ever being refused. Now the
    // velocity hold only claims a comment while its author is still
    // under the hourly cap; past the cap the honest 429 below is
    // the answer and nothing is stored.
    const velocity = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lab_comments WHERE ip_hash = ? AND created_at >= datetime('now', ?)"
    )
      .bind(ipHash, "-" + COMMENTS_GLOBAL_VELOCITY_MINUTES + " minutes")
      .first();
    const velocityHeld =
      velocity && typeof velocity.n === "number" && velocity.n >= COMMENTS_GLOBAL_VELOCITY_MAX;

    if (recent && typeof recent.n === "number" && recent.n >= COMMENT_RATE_MAX) {
      return json({
        ok: false,
        error: "rate_limited",
        message: "You have posted a few comments in the last hour — the limit is five an hour. Please wait a bit and try again.",
      }, 429);
    }

    // Hold-first mode (off unless the setting at the top says on):
    // has this person ever commented here before, in any state?
    let firstEver = false;
    if (COMMENTS_HOLD_FIRST) {
      const prior = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM lab_comments WHERE ip_hash = ?"
      )
        .bind(ipHash)
        .first();
      firstEver = !prior || typeof prior.n !== "number" || prior.n === 0;
    }

    // Flood brake for the whole page: counts every accepted comment on
    // this page in the last few minutes (shown and held alike), from
    // all addresses together — changing addresses cannot dodge it. Its
    // error is 'path_busy', not 'rate_limited': the reader did nothing
    // wrong, the page is simply flooded, and the message says so.
    const pathRecent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lab_comments WHERE path = ? AND created_at >= datetime('now', ?)"
    )
      .bind(path, "-" + COMMENT_PATH_BURST_MINUTES + " minutes")
      .first();
    if (pathRecent && typeof pathRecent.n === "number" && pathRecent.n >= COMMENT_PATH_BURST_MAX) {
      return json({
        ok: false,
        error: "path_busy",
        message: "This page is getting a lot of comments right now — try again in a few minutes.",
      }, 429);
    }

    // Sent twice? The exact same comment (page + name + text) inside
    // the dedupe window is answered with the original's status —
    // idempotent, never double-posted.
    const dupe = await env.DB.prepare(
      "SELECT status FROM lab_comments WHERE path = ? AND name = ? AND body = ? AND created_at >= datetime('now', ?) ORDER BY id ASC LIMIT 1"
    )
      .bind(path, name, text, "-" + COMMENT_DEDUPE_MINUTES + " minutes")
      .first();
    if (dupe && typeof dupe.status === "string") {
      return json({ ok: true, status: dupe.status, duplicate: true });
    }

    // The name is screened like the text: a link or a spam word in
    // either one sends the comment to a human first. The reason
    // travels with the reply ('held') so the page can say plainly
    // what happened.
    const lower = text.toLowerCase();
    const nameLower = name.toLowerCase();
    let held = null;
    if (COMMENT_LINK_RE.test(text)) held = "link";
    else if (COMMENT_LINK_RE.test(name)) held = "name_link";
    else if (
      COMMENT_HOLD_WORDS.some((w) => lower.includes(w)) ||
      COMMENT_HOLD_WORDS.some((w) => nameLower.includes(w))
    ) held = "word";
    // Hold-first and the velocity watch hold a comment the same way;
    // the velocity reason is named first because it says the most
    // about what just happened.
    if (velocityHeld) held = "velocity";
    else if (firstEver) held = "first";
    const status = held ? "pending" : "approved";

    await env.DB.prepare(
      "INSERT INTO lab_comments (path, name, body, ip_hash, status) VALUES (?, ?, ?, ?, ?)"
    )
      // The truncate() calls are a safety net only — the length checks
      // above refuse anything too long first, so they never cut text.
      .bind(path, truncate(name, COMMENT_NAME_MAX), truncate(text, COMMENT_BODY_MAX), ipHash, status)
      .run();

    return held ? json({ ok: true, status, held }) : json({ ok: true, status });
  } catch {
    return json({ ok: false, error: "server" }, 500);
  }
}

// ---------- reports (v2) ----------

// A reader flags a comment. The report is counted once per person
// (the same scrambled address reporting the same comment again is a
// quiet "already noted"), reports are limited to 10 an hour per
// person, and when a shown comment reaches the report threshold it
// goes back to pending so a person reads it again.
async function handleCommentsReport(request, env) {
  try {
    if (!commentOriginOk(request)) {
      return json({ ok: false, error: "origin" }, 403);
    }
    const ctype = request.headers.get("content-type") || "";
    if (!ctype.toLowerCase().startsWith("application/json")) {
      return json({ ok: false, error: "content_type" }, 415);
    }
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > COMMENT_BODY_BYTES_MAX) {
      return json({ ok: false, error: "too_large" }, 413);
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > COMMENT_BODY_BYTES_MAX) {
      return json({ ok: false, error: "too_large" }, 413);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "invalid" }, 400);
    }
    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "invalid" }, 400);
    }

    // Honeypot: a filled hidden field means a bot. Pretend success.
    if (cleanString(body.website)) return json({ ok: true });

    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: "invalid" }, 400);
    }

    await ensureCommentsTable(env);

    const comment = await env.DB.prepare(
      "SELECT id, status, report_count FROM lab_comments WHERE id = ?"
    )
      .bind(id)
      .first();
    if (!comment) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const ipHash = await hashIp(request);

    // Already reported by this person? Counted once, answered plainly.
    const existing = await env.DB.prepare(
      "SELECT comment_id FROM lab_comment_reports WHERE comment_id = ? AND ip_hash = ?"
    )
      .bind(id, ipHash)
      .first();
    if (existing) return json({ ok: true, duplicate: true });

    const reportRecent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lab_comment_reports WHERE ip_hash = ? AND created_at >= datetime('now', '-1 hour')"
    )
      .bind(ipHash)
      .first();
    if (reportRecent && typeof reportRecent.n === "number" && reportRecent.n >= COMMENT_REPORT_RATE_MAX) {
      return json({
        ok: false,
        error: "rate_limited",
        message: "You have reported a few comments in the last hour — the limit is ten an hour. Thank you for flagging them; please wait a bit before reporting more.",
      }, 429);
    }

    await env.DB.prepare(
      "INSERT INTO lab_comment_reports (comment_id, ip_hash) VALUES (?, ?)"
    )
      .bind(id, ipHash)
      .run();

    await env.DB.prepare(
      "UPDATE lab_comments SET report_count = report_count + 1 WHERE id = ?"
    )
      .bind(id)
      .run();

    const newCount = (typeof comment.report_count === "number" ? comment.report_count : 0) + 1;
    if (newCount >= COMMENT_REPORT_HOLD_THRESHOLD && comment.status === "approved") {
      await env.DB.prepare(
        "UPDATE lab_comments SET status = 'pending' WHERE id = ?"
      )
        .bind(id)
        .run();
    }

    return json({ ok: true });
  } catch {
    return json({ ok: false, error: "server" }, 500);
  }
}

// ---------- moderation queue (v2) ----------

// The queue is gated by a secret token the site owner sets as the
// COMMENTS_MOD_TOKEN environment variable (a Pages secret — never in
// this file). If it is not set, the queue is off and every route
// below answers 403. Three hardening details:
// - The comparison is constant-time (tokenEqual below), so a wrong
//   guess leaks nothing about how close it was.
// - The token travels in the x-mod-token header. A ?token= query
//   value is accepted ONLY on the queue page itself, so the page
//   can be opened from a bookmark; the list/act endpoints are
//   header-only, which keeps the token out of URLs (browser
//   history, logs) everywhere it does not have to be.
// - Every moderation response — page, list, act, and their 403s —
//   carries Cache-Control: no-store (modJson / the page responses).

// Constant-time string comparison: the loop always runs the full
// length, so response timing says nothing about the token.
function tokenEqual(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function modTokenOk(request, env, allowQueryToken = false) {
  const expected = env && typeof env.COMMENTS_MOD_TOKEN === "string"
    ? env.COMMENTS_MOD_TOKEN : "";
  if (!expected) return false;
  let given = request.headers.get("x-mod-token") || "";
  if (!given && allowQueryToken) {
    given = new URL(request.url).searchParams.get("token") || "";
  }
  return given !== "" && tokenEqual(given, expected);
}

// JSON the way moderation routes answer: never stored, never cached.
function modJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

async function handleModerationList(request, env) {
  if (!modTokenOk(request, env)) {
    return modJson({ ok: false, error: "forbidden" }, 403);
  }
  try {
    await ensureCommentsTable(env);
    const rows = await env.DB.prepare(
      "SELECT id, path, name, body, created_at, report_count FROM lab_comments WHERE status = 'pending' ORDER BY id ASC LIMIT 200"
    ).all();
    const pending = rows.results || [];
    return modJson({ ok: true, pending, count: pending.length });
  } catch {
    return modJson({ ok: false, error: "server" }, 500);
  }
}

async function handleModerationAct(request, env) {
  if (!modTokenOk(request, env)) {
    return modJson({ ok: false, error: "forbidden" }, 403);
  }
  try {
    const ctype = request.headers.get("content-type") || "";
    if (!ctype.toLowerCase().startsWith("application/json")) {
      return modJson({ ok: false, error: "content_type" }, 415);
    }
    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return modJson({ ok: false, error: "invalid" }, 400);
    }
    if (!body || typeof body !== "object") {
      return modJson({ ok: false, error: "invalid" }, 400);
    }
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return modJson({ ok: false, error: "invalid" }, 400);
    }
    if (body.action !== "approve" && body.action !== "reject") {
      return modJson({ ok: false, error: "invalid" }, 400);
    }
    const status = body.action === "approve" ? "approved" : "rejected";
    await ensureCommentsTable(env);
    const comment = await env.DB.prepare(
      "SELECT id, status, report_count FROM lab_comments WHERE id = ?"
    )
      .bind(id)
      .first();
    if (!comment) {
      return modJson({ ok: false, error: "not_found" }, 404);
    }
    await env.DB.prepare(
      "UPDATE lab_comments SET status = ? WHERE id = ?"
    )
      .bind(status, id)
      .run();
    return modJson({ ok: true, status });
  } catch {
    return modJson({ ok: false, error: "server" }, 500);
  }
}

// The queue page: one small self-contained page. It holds no comment
// text of its own — its script asks the list endpoint (with the token
// from this page's own address) and draws each comment as text only.
function handleModerationPage(request, env) {
  if (!modTokenOk(request, env, true)) {
    return new Response("Forbidden", {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Comment moderation</title>",
    "<style>",
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#14211a;max-width:720px;margin:24px auto;padding:0 16px}",
    "h1{font-family:Georgia,'Times New Roman',serif;color:#003d1a;font-size:26px}",
    ".item{border:1px solid #e3e0d4;border-radius:10px;padding:12px 14px;margin:0 0 10px}",
    ".meta{font-size:13px;color:#5a6a60;margin:0 0 4px}",
    ".body{font-size:16px;line-height:1.55;margin:0;white-space:pre-wrap;word-wrap:break-word}",
    "button{font:inherit;font-size:14px;font-weight:bold;cursor:pointer;border:none;border-radius:999px;padding:8px 16px;margin:10px 8px 0 0;min-height:40px}",
    ".approve{background:#015224;color:#fff}.reject{background:#e3e0d4;color:#14211a}",
    "button:disabled{opacity:.55;cursor:wait}",
    "</style></head><body>",
    "<h1>Comments waiting for a person</h1>",
    '<p id="count">Loading…</p>',
    '<div id="list"></div>',
    "<script>",
    "var token = new URLSearchParams(window.location.search).get('token') || '';",
    "function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }",
    "function act(id, action, btn) {",
    "  btn.disabled = true;",
    "  fetch('/api/comments/moderation/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mod-token': token }, body: JSON.stringify({ id: id, action: action }) })",
    "    .then(function () { load(); }).catch(function () { btn.disabled = false; });",
    "}",
    "function load() {",
    "  fetch('/api/comments/moderation/list', { headers: { 'x-mod-token': token, 'accept': 'application/json' } })",
    "    .then(function (r) { return r.json(); })",
    "    .then(function (data) {",
    "      var list = document.getElementById('list'); list.textContent = '';",
    "      var pending = (data && data.pending) || [];",
    "      document.getElementById('count').textContent = pending.length === 1 ? '1 comment waiting' : pending.length + ' comments waiting';",
    "      if (!pending.length) { list.appendChild(el('p', '', 'Nothing waiting. All caught up.')); return; }",
    "      pending.forEach(function (c) {",
    "        var box = el('div', 'item');",
    "        var meta = c.path + ' · ' + c.name + ' · ' + c.created_at + (c.report_count ? ' · reported ' + c.report_count + (c.report_count === 1 ? ' time' : ' times') : '');",
    "        box.appendChild(el('p', 'meta', meta));",
    "        box.appendChild(el('p', 'body', c.body));",
    "        var ok = el('button', 'approve', 'Approve'); ok.type = 'button';",
    "        ok.addEventListener('click', function () { act(c.id, 'approve', ok); });",
    "        var no = el('button', 'reject', 'Reject'); no.type = 'button';",
    "        no.addEventListener('click', function () { act(c.id, 'reject', no); });",
    "        box.appendChild(ok); box.appendChild(no);",
    "        list.appendChild(box);",
    "      });",
    "    })",
    "    .catch(function () { document.getElementById('count').textContent = 'The queue could not load just now — please refresh.'; });",
    "}",
    "load();",
    "</script></body></html>",
  ].join("\n");
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// ---------- entry point ----------

export default {
  async fetch(request, env) {
    return withSecurityHeaders(await route(request, env));
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  if (!path.startsWith("/api/")) {
    // Static site files. (Pages advanced mode provides env.ASSETS.)
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }

  if (path === "/api/comments") {
    if (request.method === "GET") return handleCommentsGet(request, env);
    if (request.method === "POST") return handleCommentsPost(request, env);
    return json({ ok: false, error: "method" }, 405);
  }

  if (path === "/api/comments/report") {
    if (request.method === "POST") return handleCommentsReport(request, env);
    return json({ ok: false, error: "method" }, 405);
  }

  if (path === "/api/comments/moderation") {
    if (request.method === "GET") return handleModerationPage(request, env);
    return json({ ok: false, error: "method" }, 405);
  }

  if (path === "/api/comments/moderation/list") {
    if (request.method === "GET") return handleModerationList(request, env);
    return json({ ok: false, error: "method" }, 405);
  }

  if (path === "/api/comments/moderation/act") {
    if (request.method === "POST") return handleModerationAct(request, env);
    return json({ ok: false, error: "method" }, 405);
  }

  return json({ ok: false, error: "not_found" }, 404);
}
