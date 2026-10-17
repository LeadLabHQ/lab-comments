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
  return {
    rows,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() {
          if (sql.startsWith("CREATE")) return { success: true };
          if (sql.startsWith("INSERT INTO lab_comments")) {
            rows.push({
              id: rows.length + 1,
              path: args[0], name: args[1], body: args[2],
              ip_hash: args[3], status: args[4],
              created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
            });
            return { success: true };
          }
          throw new Error("fake D1: unhandled run SQL: " + sql);
        },
        async first() {
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
          if (sql.includes("SELECT name, body, created_at")) {
            return {
              results: rows
                .filter((r) => r.path === args[0] && r.status === "approved")
                .slice(0, 200)
                .map((r) => ({ name: r.name, body: r.body, created_at: r.created_at })),
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

console.log(failures ? `\n${failures} FAILURES` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
