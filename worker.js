// Lab Comments — a small, safe comment system for static sites on
// Cloudflare Pages + D1. Save this file as `_worker.js` in the root of
// your Pages project (next to your HTML files).
//
// What it does:
// - GET  /api/comments?path=/your-page  -> the approved comments for a page
// - POST /api/comments                  -> add a comment
// Everything else is passed through to your site's static files.
//
// Safety design (the short version):
// - No accounts for readers. No cookies. No tracking. No ads.
// - Comments are stored as plain text. The web page shows them with
//   text-only rendering, so comment text can never turn into code.
// - Any comment with a link in it waits for a human OK before it shows.
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

async function hashIp(request) {
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "unknown";
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
      "SELECT name, body, created_at FROM lab_comments WHERE path = ? AND status = 'approved' ORDER BY id ASC LIMIT 200"
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
    if (!path || path === "/" || !name || !text) {
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
    if (recent && typeof recent.n === "number" && recent.n >= COMMENT_RATE_MAX) {
      return json({ ok: false, error: "rate_limited" }, 429);
    }

    // Flood brake for the whole page: counts every accepted comment on
    // this page in the last few minutes (shown and held alike), from
    // all addresses together — changing addresses cannot dodge it.
    const pathRecent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lab_comments WHERE path = ? AND created_at >= datetime('now', ?)"
    )
      .bind(path, "-" + COMMENT_PATH_BURST_MINUTES + " minutes")
      .first();
    if (pathRecent && typeof pathRecent.n === "number" && pathRecent.n >= COMMENT_PATH_BURST_MAX) {
      return json({ ok: false, error: "rate_limited" }, 429);
    }

    const lower = text.toLowerCase();
    const held =
      COMMENT_LINK_RE.test(text) ||
      COMMENT_HOLD_WORDS.some((w) => lower.includes(w));
    const status = held ? "pending" : "approved";

    await env.DB.prepare(
      "INSERT INTO lab_comments (path, name, body, ip_hash, status) VALUES (?, ?, ?, ?, ?)"
    )
      // The truncate() calls are a safety net only — the length checks
      // above refuse anything too long first, so they never cut text.
      .bind(path, truncate(name, COMMENT_NAME_MAX), truncate(text, COMMENT_BODY_MAX), ipHash, status)
      .run();

    return json({ ok: true, status });
  } catch {
    return json({ ok: false, error: "server" }, 500);
  }
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

  return json({ ok: false, error: "not_found" }, 404);
}
