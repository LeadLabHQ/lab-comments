// Lab Comments — worker regression tests (plain Node, no dependencies).
//
//   node tests/comments.test.mjs [path-to-worker.js]
//
// Defaults to ../worker.js (the OSS worker). Point it at a site's
// production _worker.js to test that copy instead — the Lab's own
// production worker is tested exactly this way.
//
// The D1 database is faked in memory: every SQL statement the worker
// issues is matched by shape, and the datetime() windows are treated
// as "everything is recent", which is what the tests exercise.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerPath = process.argv[2] || path.join(here, "..", "worker.js");
const tmpWorker = path.join(tmpdir(), `lab-comments-worker-${process.pid}.mjs`);
writeFileSync(tmpWorker, readFileSync(workerPath, "utf-8"));
const worker = (await import(tmpWorker)).default;
unlinkSync(tmpWorker);

// ---------- fake D1 ----------
function makeDb() {
  const rows = [];
  const reports = [];
  let nextId = 1;
  const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  return {
    rows,
    reports,
    // Seed a stored comment directly (used by the velocity test).
    seed(row) {
      const full = {
        id: nextId++, path: "/news/seed", name: "Seed", body: "seeded",
        ip_hash: null, status: "approved", report_count: 0, created_at: now(),
        ...row,
      };
      rows.push(full);
      return full;
    },
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() {
          if (sql.startsWith("CREATE")) return { success: true };
          if (sql.startsWith("ALTER TABLE")) return { success: true };
          if (sql.startsWith("INSERT INTO lab_comment_reports")) {
            reports.push({ comment_id: args[0], ip_hash: args[1], created_at: now() });
            return { success: true };
          }
          if (sql.startsWith("INSERT INTO lab_comments")) {
            rows.push({
              id: nextId++,
              path: args[0], name: args[1], body: args[2],
              ip_hash: args[3], status: args[4], report_count: 0,
              created_at: now(),
            });
            return { success: true };
          }
          if (sql.includes("UPDATE lab_comments SET report_count")) {
            const row = rows.find((r) => r.id === args[0]);
            if (row) row.report_count = (row.report_count || 0) + 1;
            return { success: true };
          }
          if (sql.includes("UPDATE lab_comments SET status = 'pending'")) {
            const row = rows.find((r) => r.id === args[0]);
            if (row) row.status = "pending";
            return { success: true };
          }
          if (sql.includes("UPDATE lab_comments SET status = ?")) {
            const row = rows.find((r) => r.id === args[1]);
            if (row) row.status = args[0];
            return { success: true };
          }
          throw new Error("fake D1: unhandled run SQL: " + sql);
        },
        async first() {
          if (sql.includes("COUNT(*)") && sql.includes("lab_comment_reports")) {
            return { n: reports.filter((r) => r.ip_hash === args[0]).length };
          }
          if (sql.includes("FROM lab_comment_reports")) {
            const row = reports.find(
              (r) => r.comment_id === args[0] && r.ip_hash === args[1]);
            return row || null;
          }
          if (sql.includes("SELECT id, status, report_count FROM lab_comments")) {
            const row = rows.find((r) => r.id === args[0]);
            return row
              ? { id: row.id, status: row.status, report_count: row.report_count || 0 }
              : null;
          }
          if (sql.includes("COUNT(*)") && sql.includes("ip_hash")) {
            return { n: rows.filter((r) => r.ip_hash === args[0]).length };
          }
          if (sql.includes("COUNT(*)") && sql.includes("path")) {
            return { n: rows.filter((r) => r.path === args[0]).length };
          }
          if (sql.includes("SELECT status FROM lab_comments")) {
            const row = rows.find(
              (r) => r.path === args[0] && r.name === args[1] && r.body === args[2]);
            return row ? { status: row.status } : null;
          }
          throw new Error("fake D1: unhandled first SQL: " + sql);
        },
        async all() {
          if (sql.includes("status = 'pending'")) {
            return {
              results: rows
                .filter((r) => r.status === "pending")
                .slice(0, 200)
                .map((r) => ({
                  id: r.id, path: r.path, name: r.name, body: r.body,
                  created_at: r.created_at, report_count: r.report_count || 0,
                })),
            };
          }
          if (sql.includes("SELECT id, name, body, created_at")) {
            return {
              results: rows
                .filter((r) => r.path === args[0] && r.status === "approved")
                .slice(0, 200)
                .map((r) => ({ id: r.id, name: r.name, body: r.body, created_at: r.created_at })),
            };
          }
          throw new Error("fake D1: unhandled all SQL: " + sql);
        },
      };
      return stmt;
    },
  };
}

// ---------- helpers ----------
let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log("  ok  " + label);
  else { failures++; console.log("FAIL  " + label + (extra ? " — " + extra : "")); }
}

async function post(env, body, ip) {
  const req = new Request("https://leadlabhq.com/api/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://leadlabhq.com",
      "cf-connecting-ip": ip || "203.0.113.1",
    },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

async function get(env, p) {
  const req = new Request("https://leadlabhq.com/api/comments?path=" + encodeURIComponent(p), {
    headers: { origin: "https://leadlabhq.com" },
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

// The same scramble the worker applies to an address (see hashIp).
// The salt is read out of the worker under test, so the suite also
// passes against a production copy whose per-install salt differs.
const saltMatch = readFileSync(workerPath, "utf-8")
  .match(/encode\("([^"]+):" \+ ip\)/);
const IP_SALT = saltMatch ? saltMatch[1] : "lab-comments";
async function hashIpFor(ip) {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(IP_SALT + ":" + ip));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function postWith(w, env, body, ip) {
  const req = new Request("https://leadlabhq.com/api/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://leadlabhq.com",
      "cf-connecting-ip": ip || "203.0.113.1",
    },
    body: JSON.stringify(body),
  });
  const res = await w.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

async function report(env, id, ip) {
  const req = new Request("https://leadlabhq.com/api/comments/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://leadlabhq.com",
      "cf-connecting-ip": ip || "203.0.113.1",
    },
    body: JSON.stringify({ id }),
  });
  const res = await worker.fetch(req, env);
  return { status: res.status, data: await res.json() };
}

async function modRequest(env, pathAndQuery, opts) {
  const o = opts || {};
  const headers = {};
  if (o.tokenHeader) headers["x-mod-token"] = o.tokenHeader;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request("https://leadlabhq.com" + pathAndQuery, {
    method: o.method || "GET",
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* the queue page is HTML */ }
  return { status: res.status, data, text };
}

// A copy of the worker with hold-first switched on, for its tests.
async function loadHoldFirstWorker() {
  const src = readFileSync(workerPath, "utf-8");
  const flipped = src.replace(
    "const COMMENTS_HOLD_FIRST = false;", "const COMMENTS_HOLD_FIRST = true;");
  if (flipped === src) throw new Error("hold-first flag not found in worker source");
  const p = path.join(tmpdir(), `lab-comments-worker-holdfirst-${process.pid}.mjs`);
  writeFileSync(p, flipped);
  const w = (await import(p)).default;
  unlinkSync(p);
  return w;
}

// ---------- tests ----------
console.log("worker under test:", workerPath);

// 1. Plain comment posts and shows.
{
  const env = { DB: makeDb() };
  const r = await post(env, { path: "/news/x", name: "Sam", body: "Nice piece." });
  check("plain comment approved", r.status === 200 && r.data.status === "approved", JSON.stringify(r.data));
  const g = await get(env, "/news/x");
  check("GET returns it", g.data.comments.length === 1 && g.data.comments[0].name === "Sam");
}

// 2. Link in the body is held, with the reason named.
{
  const env = { DB: makeDb() };
  const r = await post(env, { path: "/news/x", name: "Sam", body: "See https://example.com" });
  check("link body held", r.data.status === "pending" && r.data.held === "link", JSON.stringify(r.data));
  const g = await get(env, "/news/x");
  check("held comment hidden", g.data.comments.length === 0);
}

// 3. A URL in the NAME is held too (name-field screening).
{
  const env = { DB: makeDb() };
  const r = await post(env, { path: "/news/x", name: "www.spammy-deals.com", body: "Great post" });
  check("link name held", r.data.status === "pending" && r.data.held === "name_link", JSON.stringify(r.data));
  const g = await get(env, "/news/x");
  check("link-name comment hidden", g.data.comments.length === 0);
}

// 4. A hold word in the name is held.
{
  const env = { DB: makeDb() };
  const r = await post(env, { path: "/news/x", name: "Casino Fan", body: "Great post" });
  check("hold-word name held", r.data.status === "pending" && r.data.held === "word", JSON.stringify(r.data));
}

// 5. Markup in a name/body is stored byte-for-byte as plain text
//    (rendering safety lives in the text-only client; the worker must
//    neither mangle nor strip the words).
{
  const env = { DB: makeDb() };
  const name = "<script>alert(1)</script>";
  const r = await post(env, { path: "/news/x", name, body: "a <b>bold</b> claim" });
  check("markup comment accepted as text", r.data.status === "approved", JSON.stringify(r.data));
  check("name stored verbatim", env.DB.rows[0].name === name, env.DB.rows[0].name);
  check("body stored verbatim", env.DB.rows[0].body === "a <b>bold</b> claim");
}

// 6. Exact duplicate inside the window: idempotent, never double-posted.
{
  const env = { DB: makeDb() };
  const body = { path: "/news/x", name: "Sam", body: "Same words." };
  const r1 = await post(env, body);
  const r2 = await post(env, body);
  check("first posts", r1.data.status === "approved" && !r1.data.duplicate);
  check("second is a duplicate answer", r2.data.duplicate === true && r2.data.status === "approved", JSON.stringify(r2.data));
  check("only one row stored", env.DB.rows.length === 1, "rows=" + env.DB.rows.length);
}

// 7. Regression: the homepage path "/" posts fine (the canonical-path
//    bug — an earlier version rejected exactly "/"), "" normalizes to
//    "/", and a trailing slash canonicalizes to the same page.
{
  const env = { DB: makeDb() };
  const r1 = await post(env, { path: "/", name: "Home", body: "From the homepage" });
  check("POST / accepted", r1.status === 200 && r1.data.status === "approved", JSON.stringify(r1.data));
  const r2 = await post(env, { path: "", name: "Home", body: "Empty path form" });
  check("POST '' accepted as /", r2.status === 200 && r2.data.ok === true, JSON.stringify(r2.data));
  const r3 = await post(env, { path: "/news/x/", name: "Trail", body: "Slash form" });
  check("trailing slash accepted", r3.data.status === "approved", JSON.stringify(r3.data));
  const g = await get(env, "/news/x");
  check("slash form lands on canonical page", g.data.comments.length === 1);
}

// 8. Per-path velocity brake: the 21st comment on one page inside the
//    window (from a fresh address) gets path_busy, whose copy blames
//    the busy page — not the reader.
{
  const env = { DB: makeDb() };
  for (let i = 0; i < 20; i++) {
    await post(env, { path: "/news/hot", name: "P" + i, body: "comment " + i }, "198.51.100." + i);
  }
  const r = await post(env, { path: "/news/hot", name: "Bystander", body: "just reading" }, "203.0.113.99");
  check("21st is 429 path_busy", r.status === 429 && r.data.error === "path_busy", JSON.stringify(r.data));
  check("path_busy copy is honest", /getting a lot of comments/.test(r.data.message || ""), r.data.message);
}

// 9. Per-person hourly limit still fires, with its own error.
{
  const env = { DB: makeDb() };
  for (let i = 0; i < 5; i++) {
    await post(env, { path: "/news/p" + i, name: "Fast", body: "post " + i }, "203.0.113.7");
  }
  const r = await post(env, { path: "/news/other", name: "Fast", body: "sixth" }, "203.0.113.7");
  check("6th in an hour is rate_limited", r.status === 429 && r.data.error === "rate_limited", JSON.stringify(r.data));
}

// 10. Over-limit input is refused, never truncated.
{
  const env = { DB: makeDb() };
  const r1 = await post(env, { path: "/news/x", name: "x".repeat(41), body: "hi" });
  check("long name refused", r1.status === 400 && r1.data.error === "name_too_long", JSON.stringify(r1.data));
  const r2 = await post(env, { path: "/news/x", name: "Sam", body: "y".repeat(1001) });
  check("long body refused", r2.status === 400 && r2.data.error === "too_long", JSON.stringify(r2.data));
}

// 11. Honeypot: fake success, nothing stored.
{
  const env = { DB: makeDb() };
  const r = await post(env, { path: "/news/x", name: "Bot", body: "spam", website: "http://spam" });
  check("honeypot fake-succeeds", r.data.ok === true && env.DB.rows.length === 0);
}

// 12. GET now includes each comment's id (the report button needs it).
{
  const env = { DB: makeDb() };
  await post(env, { path: "/news/x", name: "Sam", body: "With an id." });
  const g = await get(env, "/news/x");
  check("GET includes comment id", g.data.comments.length === 1 && g.data.comments[0].id === env.DB.rows[0].id,
    JSON.stringify(g.data.comments));
}

// 13. Report flow: first report counts, the same person reporting
//     again is idempotent, and a second person reporting sends an
//     approved comment back to pending at the threshold of 2.
{
  const env = { DB: makeDb() };
  await post(env, { path: "/news/x", name: "Sam", body: "Report me." });
  const id = env.DB.rows[0].id;
  const r1 = await report(env, id, "198.51.100.10");
  check("first report ok", r1.status === 200 && r1.data.ok === true && !r1.data.duplicate, JSON.stringify(r1.data));
  check("report_count is 1", env.DB.rows[0].report_count === 1, "count=" + env.DB.rows[0].report_count);
  check("one report does not hold", env.DB.rows[0].status === "approved");
  const r2 = await report(env, id, "198.51.100.10");
  check("same-person report is a duplicate", r2.data.ok === true && r2.data.duplicate === true, JSON.stringify(r2.data));
  check("duplicate does not recount", env.DB.rows[0].report_count === 1 && env.DB.reports.length === 1);
  const r3 = await report(env, id, "198.51.100.11");
  check("second person's report ok", r3.data.ok === true && !r3.data.duplicate, JSON.stringify(r3.data));
  check("report_count reaches 2", env.DB.rows[0].report_count === 2);
  check("approved comment auto-held at 2 reports", env.DB.rows[0].status === "pending", env.DB.rows[0].status);
  const g = await get(env, "/news/x");
  check("auto-held comment hidden", g.data.comments.length === 0);
  const r4 = await report(env, 9999, "198.51.100.12");
  check("report for a missing comment is 404", r4.status === 404 && r4.data.error === "not_found", JSON.stringify(r4.data));
  const r5 = await report(env, "nope", "198.51.100.12");
  check("report with a bad id is 400", r5.status === 400 && r5.data.error === "invalid", JSON.stringify(r5.data));
}

// 14. Report rate limit: 10 reports an hour per person, then 429.
{
  const env = { DB: makeDb() };
  const ids = [];
  for (let i = 0; i < 11; i++) {
    await post(env, { path: "/news/r" + i, name: "P" + i, body: "comment " + i }, "198.51.100." + (20 + i));
    ids.push(env.DB.rows[env.DB.rows.length - 1].id);
  }
  let allOk = true;
  for (let i = 0; i < 10; i++) {
    const r = await report(env, ids[i], "203.0.113.50");
    if (!(r.status === 200 && r.data.ok === true)) allOk = false;
  }
  check("first 10 reports ok", allOk);
  const r = await report(env, ids[10], "203.0.113.50");
  check("11th report in an hour is 429 rate_limited", r.status === 429 && r.data.error === "rate_limited", JSON.stringify(r.data));
  check("rate-limited report not stored", env.DB.reports.length === 10, "reports=" + env.DB.reports.length);
}

// 15. Hold-first off by default, on when the flag is flipped: a
//     person's first-ever comment waits; their next one does not.
{
  const envOff = { DB: makeDb() };
  const rOff = await post(envOff, { path: "/news/x", name: "New", body: "First ever, mode off." }, "203.0.113.60");
  check("hold-first off: first comment approved", rOff.data.status === "approved" && !rOff.data.held, JSON.stringify(rOff.data));

  const holdWorker = await loadHoldFirstWorker();
  const envOn = { DB: makeDb() };
  const r1 = await postWith(holdWorker, envOn, { path: "/news/x", name: "New", body: "First ever, mode on." }, "203.0.113.61");
  check("hold-first on: first comment held as first", r1.data.status === "pending" && r1.data.held === "first", JSON.stringify(r1.data));
  const g = await get(envOn, "/news/x");
  check("hold-first comment hidden", g.data.comments.length === 0);
  const r2 = await postWith(holdWorker, envOn, { path: "/news/y", name: "New", body: "Second comment, mode on." }, "203.0.113.61");
  check("hold-first on: second comment approved", r2.data.status === "approved" && !r2.data.held, JSON.stringify(r2.data));
}

// 16. Global velocity watch: more than 10 comments from one person
//     across different pages in the window (seeded directly, the way
//     a flood that slipped past the hourly limit would look) — the
//     next comment is held as velocity, not refused.
{
  const env = { DB: makeDb() };
  const ip = "203.0.113.70";
  const ipHash = await hashIpFor(ip);
  for (let i = 0; i < 10; i++) {
    env.DB.seed({ path: "/news/v" + i, name: "Fast", body: "seeded " + i, ip_hash: ipHash });
  }
  const r = await post(env, { path: "/news/elsewhere", name: "Fast", body: "One more, somewhere new." }, ip);
  check("velocity comment held, not refused", r.status === 200 && r.data.status === "pending" && r.data.held === "velocity",
    JSON.stringify(r.data));
  check("velocity comment stored as pending",
    env.DB.rows[env.DB.rows.length - 1].status === "pending");
  const g = await get(env, "/news/elsewhere");
  check("velocity comment hidden", g.data.comments.length === 0);
}

// 17. Moderation queue: token auth on list, page, and act; approve
//     and reject move a pending comment to its new state.
{
  const env = { DB: makeDb(), COMMENTS_MOD_TOKEN: "test-mod-token" };
  await post(env, { path: "/news/x", name: "Sam", body: "See https://example.com" });
  const pendingId = env.DB.rows[0].id;
  check("setup: comment is pending", env.DB.rows[0].status === "pending");

  const noTok = await modRequest(env, "/api/comments/moderation/list");
  check("list without token is 403", noTok.status === 403 && noTok.data.error === "forbidden", JSON.stringify(noTok.data));
  const badTok = await modRequest(env, "/api/comments/moderation/list", { tokenHeader: "wrong" });
  check("list with wrong token is 403", badTok.status === 403 && badTok.data.error === "forbidden");
  const list = await modRequest(env, "/api/comments/moderation/list", { tokenHeader: "test-mod-token" });
  check("list with token ok", list.status === 200 && list.data.ok === true && list.data.count === 1, JSON.stringify(list.data));
  check("list entry carries the queue fields",
    list.data.pending[0].id === pendingId && list.data.pending[0].path === "/news/x" &&
    list.data.pending[0].name === "Sam" && list.data.pending[0].report_count === 0 &&
    typeof list.data.pending[0].created_at === "string", JSON.stringify(list.data.pending[0]));
  const listQuery = await modRequest(env, "/api/comments/moderation/list?token=test-mod-token");
  check("list also accepts ?token=", listQuery.status === 200 && listQuery.data.count === 1);

  const pageNo = await modRequest(env, "/api/comments/moderation");
  check("queue page without token is 403", pageNo.status === 403, "status=" + pageNo.status);
  const page = await modRequest(env, "/api/comments/moderation?token=test-mod-token");
  check("queue page with token loads", page.status === 200 && page.text.includes("Comments waiting for a person"), "status=" + page.status);
  check("queue page talks to the list and act endpoints",
    page.text.includes("/api/comments/moderation/list") && page.text.includes("/api/comments/moderation/act"));

  const actBad = await modRequest(env, "/api/comments/moderation/act",
    { method: "POST", tokenHeader: "wrong", body: { id: pendingId, action: "approve" } });
  check("act with wrong token is 403", actBad.status === 403 && actBad.data.error === "forbidden", JSON.stringify(actBad.data));
  check("bad-token act changed nothing", env.DB.rows[0].status === "pending");

  const approve = await modRequest(env, "/api/comments/moderation/act",
    { method: "POST", tokenHeader: "test-mod-token", body: { id: pendingId, action: "approve" } });
  check("approve answers the new status", approve.status === 200 && approve.data.ok === true && approve.data.status === "approved",
    JSON.stringify(approve.data));
  check("approved row updated", env.DB.rows[0].status === "approved");
  const g = await get(env, "/news/x");
  check("approved comment now shows", g.data.comments.length === 1);

  await post(env, { path: "/news/x", name: "Spam", body: "cheap casino deals" });
  const secondId = env.DB.rows[1].id;
  check("setup: second comment pending", env.DB.rows[1].status === "pending");
  const reject = await modRequest(env, "/api/comments/moderation/act",
    { method: "POST", tokenHeader: "test-mod-token", body: { id: secondId, action: "reject" } });
  check("reject answers the new status", reject.data.ok === true && reject.data.status === "rejected", JSON.stringify(reject.data));
  check("rejected row updated", env.DB.rows[1].status === "rejected");
  const listAfter = await modRequest(env, "/api/comments/moderation/list", { tokenHeader: "test-mod-token" });
  check("queue empties after decisions", listAfter.data.count === 0, JSON.stringify(listAfter.data));
}

// 18. Moderation with the token unset: the feature is off, all
//     routes answer 403 even if a token is offered.
{
  const env = { DB: makeDb() };
  await post(env, { path: "/news/x", name: "Sam", body: "See https://example.com" });
  const id = env.DB.rows[0].id;
  const list = await modRequest(env, "/api/comments/moderation/list", { tokenHeader: "anything" });
  check("unset token: list is 403", list.status === 403 && list.data.error === "forbidden", JSON.stringify(list.data));
  const page = await modRequest(env, "/api/comments/moderation?token=anything");
  check("unset token: page is 403", page.status === 403, "status=" + page.status);
  const act = await modRequest(env, "/api/comments/moderation/act",
    { method: "POST", tokenHeader: "anything", body: { id, action: "approve" } });
  check("unset token: act is 403", act.status === 403 && act.data.error === "forbidden");
  check("unset token: nothing changed", env.DB.rows[0].status === "pending");
}

console.log(failures ? `\n${failures} FAILURES` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
