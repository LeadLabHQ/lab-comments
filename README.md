# Lab Comments

**Free comments for a small website. No reader accounts. No tracking. Safe by design.**

Lab Comments is a tiny comment box you can add to your own website.
It is for small site owners, bloggers, and builders who want comments
without handing their readers to an ad company. It runs on Cloudflare's
free plans, so for a small site it costs nothing.

**See it live:** this exact code runs under the articles on
[leadlabhq.com](https://leadlabhq.com). Post a comment there and you
have tried it.

Three words you will meet below:

- A **Worker** is a small piece of code that runs on Cloudflare's
  computers, not on yours. It takes in comments and hands them back out.
- **D1** is Cloudflare's free database. It is where the comments are kept.
- **Deploy** just means "put the files online."

## Why it's safe

Most comment systems ask your readers to make an account, then track
them around the web. This one does the opposite:

- **No accounts.** A reader types a name and a comment. That is all.
- **No tracking, no cookies, no ads.** Nothing phones home.
- **Comments can't run code.** Comments are stored as plain text and
  shown on the page as text only — never as HTML. A comment can say
  anything, but it can never *do* anything.
- **Link comments wait for a human.** If a comment has a link in it
  (or a known spam word) — **in the text or in the name on it** — it
  is held back. It only shows after you OK it. You are the spam
  filter, and spam never reaches your page.
- **Double-posts collapse.** The same comment sent twice within 10
  minutes (a double-click, a retried phone post) is answered with the
  first copy's status. It is never posted twice.
- **Spam links earn nothing.** Links in comments are marked
  `nofollow ugc`, so they pass no search-engine value. Spammers gain
  nothing by posting them.
- **A trap for bots.** The form has a hidden field people never see.
  Bots fill it in. Their posts are quietly dropped.
- **A speed limit.** Each person can post 5 comments an hour. The
  limit counts a scrambled (SHA-256 hashed) address — real addresses
  are never stored.
- **Readers can flag a comment.** Every comment carries a small
  **Report** button. A report is counted once per reader, and when
  three readers report a comment that is showing, it goes back to
  waiting for a human OK. See "Reporting a comment" below.
- **A flood brake across pages.** If one person posts 10 comments
  across *all* pages in 10 minutes, the next one waits for a human
  OK instead of showing. See "The global velocity watch" below.
- **A token-gated queue for the OKs.** Held comments can be approved
  or rejected from one small web page, instead of database commands.
  See "The moderation queue" below.

## Quick start

You need a free [Cloudflare](https://www.cloudflare.com) account, your
site on Cloudflare Pages, and Wrangler — Cloudflare's free
command-line tool. About 10 minutes, in this order:

### 0. Before you start

- **Get the files.** On this repo's GitHub page, click the green
  **Code** button, then **Download ZIP**. Unzip it, and open that
  folder in a terminal. (Never used a terminal? It is the text window
  where you type the commands below. On Windows, open the folder,
  right-click inside it, and pick "Open in Terminal." On a Mac,
  right-click the folder and pick "New Terminal at Folder" under
  Services.)
- **Install Node.js.** Wrangler runs on Node.js. Get Node.js free
  from [nodejs.org](https://nodejs.org) and install it like any
  other program. Close and reopen your terminal when it finishes.
- **Install Wrangler.** In the terminal, in that unzipped folder,
  run:

  ```bash
  npm i -D wrangler@latest
  ```

- **Log in.** Run this, and when your browser opens a Cloudflare
  page, click **Allow**. That connects Wrangler to your account:

  ```bash
  npx wrangler login
  ```

One shortcut to know: the steps below write commands starting with
`wrangler` to keep them short. Because you installed Wrangler into
this folder, type `npx ` in front of each one — like the
`npx wrangler login` you just ran.

### 1. Create the database

```bash
wrangler d1 create lab-comments
```

Wrangler prints a `database_id`. Copy it into a note — you will
paste it in step 3.

### 2. Make the table (you can skip this one)

You can skip this step — the Worker creates the table on its own
the first time it runs. This step is only for people who like
things set up ahead of time.

```bash
wrangler d1 execute lab-comments --remote --file=./schema.sql
```

### 3. Connect the database to your site

Copy `wrangler.toml.example` to `wrangler.toml`, put in your project
name, and paste the `database_id` from step 1. Your project name is
the name listed for your site in your Cloudflare Pages dashboard —
it can be different from your website's name. The binding name must
be `DB` — that is the name the Worker looks for.

No `wrangler.toml`? Do it in the Cloudflare dashboard instead: your
Pages project → **Settings → Bindings → Add → D1 database**, variable
name `DB`, pick the database from step 1.

### 4. Add the Worker

Copy `worker.js` into the root of your Pages project and rename it to
`_worker.js`. It answers `/api/comments` and passes everything else
through to your normal pages.

> One catch: if your project already has a `_worker.js`, you need to
> merge the two. The comment routes are the parts marked "comments"
> in the file.

### 5. Add the comment box to a page

Copy `comments.css` and `comments.js` into your project, then put
this where the comments should go:

```html
<link rel="stylesheet" href="/comments.css">
<div id="lab-comments"></div>
<script src="/comments.js" defer></script>
```

The box builds itself — list, form, and all. Comments belong to the
page they are posted on. To pin a box to one set page, write
`<div id="lab-comments" data-path="/news/my-post"></div>`.

### 6. Deploy

Put your Pages project online the way you always do. Open a page and
post a test comment. A plain comment shows right away. A comment with
a link in it waits for your OK — that is the system working.

**One box per page.** The widget builds itself into the first
`<div id="lab-comments">` it finds. A page carries **one** comment
box — a second box on the same page will not build. If you want
comments in two places, they belong on two pages (each page's box
keeps its own comment list, or pin a box to a chosen list with
`data-path`).

## Try it locally first (no deploy needed)

You can run the whole thing on your own computer before anything
goes online. This is the path we test with ourselves:

1. Put your site's files in a folder, with `worker.js` copied in as
   `_worker.js` and a `wrangler.toml` (from step 3 above) naming the
   `DB` binding.
2. Make the table in the **local** database:

   ```bash
   wrangler d1 execute lab-comments --local --file=./schema.sql
   ```

   (You can skip this too — the Worker creates the table on first
   use, locally just like online.)
3. Start the local site:

   ```bash
   wrangler pages dev
   ```

4. Open the local address Wrangler prints (usually
   `http://localhost:8788`), go to a page with the comment box, and
   post. Local comments live in the local database only — nothing
   touches your real site or its real comments. When you're done,
   deploy the same files (step 6) and it behaves identically online.

## Run the tests

The repo carries a plain-Node test file (no packages to install)
that exercises the Worker end to end — holds, duplicates, the
homepage path, the flood brake, the lot:

```bash
node tests/comments.test.mjs
```

Point it at another copy of the worker to test that copy instead:
`node tests/comments.test.mjs /path/to/_worker.js`.

## What's in this repo

| File | What it does | Must you edit it? |
|---|---|---|
| `worker.js` | The Worker: takes in comments, serves them back, holds link comments | Only the settings at the top, if you want |
| `tests/` | Plain-Node regression tests for the Worker | No |
| `schema.sql` | Makes the comments table in the database | No |
| `comments.js` | Builds the comment box on your page | No |
| `comments.css` | How the comment box looks | Only if you want your own style |
| `share.js` | Bonus: a small share bar (see below) | No |
| `share.css` | How the share bar looks | Only if you want your own style |
| `wrangler.toml.example` | A starter settings file for Cloudflare | Copy it and fill in your values |
| `README.md` | This file | No |
| `LICENSE` | The MIT license | No |
| `.gitignore` | Tells git which local files to leave out | No |

## Settings

All settings sit at the top of the comments part of `worker.js`.

| Setting | Default | What it does |
|---|---|---|
| `COMMENT_NAME_MAX` | 40 | Longest name we accept (characters) |
| `COMMENT_BODY_MAX` | 1000 | Longest comment we accept (characters) |
| `COMMENT_BODY_BYTES_MAX` | 8192 | Biggest post we accept (8 KB) |
| `COMMENT_RATE_MAX` | 5 | Posts per hour, per person |
| `COMMENT_PATH_BURST_MAX` | 20 | Most comments one page can receive in 10 minutes, from everyone combined — a flood brake that works even if a spammer keeps changing addresses |
| `COMMENT_DEDUPE_MINUTES` | 10 | Window in which the exact same comment (same page, name, and text) counts as a double-post and is answered instead of re-posted |
| `COMMENT_HOLD_WORDS` | `viagra`, `cialis`, `casino`, `porn`, `escort`, `crypto giveaway`, `make money fast`, `free money`, `work from home scam` | Words that send a comment to the human-OK queue |
| `COMMENT_LINK_RE` | built in | The pattern that spots a link in a comment |
| `COMMENT_REPORT_RATE_MAX` | 10 | Reports per hour, per person |
| `COMMENT_REPORT_HOLD_THRESHOLD` | 2 | Reports that send a showing comment back to the human-OK queue |
| `COMMENTS_HOLD_FIRST` | `false` | When `true`, a person's first-ever comment waits for a human OK (hold reason `first`) |
| `COMMENTS_GLOBAL_VELOCITY_MAX` | 10 | Comments across all pages in the velocity window that hold the next one (hold reason `velocity`) |
| `COMMENTS_GLOBAL_VELOCITY_MINUTES` | 10 | The velocity window, in minutes |

## Checking and OK-ing held comments

Held comments have the status `pending`. How often should you
check? Once a day is fine — held comments simply wait, and nothing
goes live until you OK it. (The moderation queue further below is
the same job on a web page, once you have set its token.) And the first command below only *looks*
at the held comments. It changes nothing and cannot break anything.
See them:

```bash
wrangler d1 execute lab-comments --remote \
  --command "SELECT id, path, name, body, created_at FROM lab_comments WHERE status = 'pending' ORDER BY id;"
```

OK one (use its real `id`):

```bash
wrangler d1 execute lab-comments --remote \
  --command "UPDATE lab_comments SET status = 'approved' WHERE id = 12;"
```

Delete one:

```bash
wrangler d1 execute lab-comments --remote \
  --command "DELETE FROM lab_comments WHERE id = 12;"
```

## Reporting a comment (new in v2)

Every comment on the page has a small **Report** button under it.
Clicking it sends the comment's `id` to `POST /api/comments/report`.
There is nothing else to fill in.

- A report is recorded once per reader: the reports table keeps one
  row per comment per scrambled address, so the same person clicking
  again gets a quiet "already noted" (`{ok: true, duplicate: true}`)
  and the count does not move.
- One person can report at most **10 comments an hour**. Past that,
  reports answer `429` with the error `rate_limited` — and the page
  still thanks the reader, because flagging in good faith should
  never feel like an error.
- Each report adds 1 to the comment's `report_count`. When the
  count reaches **3** — three different readers, since one reader
  counts once — and the comment is showing (`approved`), it is
  set back to `pending` on the spot — it disappears from the page
  until a person reads it again and OKs it (or rejects it) in the
  moderation queue below. (The threshold is 3, not 2, on purpose:
  one person with a home network and a phone is two "readers", and
  two networks alone should not be able to hide a comment.)
- Reports carry the same guards as comment posts: same-origin check,
  `POST` + JSON only, the size cap, and the honeypot trap.

## Hold-first mode (new in v2, off by default)

At the top of the comments part of `worker.js` sits one switch:

```js
const COMMENTS_HOLD_FIRST = false;
```

Leave it `false` and nothing changes. Set it to `true` and a
person's **first-ever comment** on your site — the first one from
their scrambled address, in any state — waits for a human OK, with
the hold reason `first`. The reader is told plainly: *"Thanks —
first comments here get a quick read by a person before they
appear."* Once that person has any comment stored at all, later
comments follow the normal rules.

**Production note:** this package ships with hold-first **off**,
and off is the right default for most small sites — turning it on
means every brand-new reader waits for you, so the queue becomes
part of every first visit. Turn it on deliberately, for example
during a spam wave, and remember it is on.

## The global velocity watch (new in v2)

The per-page flood brake watches one page. The velocity watch
watches one *person* across **all** pages together:

- If a scrambled address already has **10 comments in the last 10
  minutes** across every page combined, the next comment is **held**
  for a person (status `pending`, hold reason `velocity`) instead of
  being shown — and instead of being refused. The reader is told:
  *"Thanks — a person will read this one first."*
- The thresholds are the `COMMENTS_GLOBAL_VELOCITY_MAX` (10) and
  `COMMENTS_GLOBAL_VELOCITY_MINUTES` (10) settings at the top of
  `worker.js`.
- Nothing existing got weaker: the 5-an-hour limit, the per-page
  burst brake, dedupe, and the link/word holds all still run. The
  velocity watch is checked right after the hourly count, and it
  only ever claims the comments that are moving far too fast for
  the hourly limit alone to describe.
- One precedence rule matters: the velocity hold only applies
  while the poster is **under** the hourly limit. Once the hourly
  limit is also hit, the answer is the hourly limit's `429` and
  nothing more is stored — a flood cannot turn refusals into an
  endless pile of held comments waiting in your queue.

## The moderation queue (new in v2)

Held comments used to mean database commands (they still work —
see "Checking and OK-ing held comments" above). The queue is the
same job on a web page: it lists every `pending` comment with its
page, name, text, time, and report count, each with **Approve** and
**Reject** buttons. Approve sets the comment to `approved` (it
shows); reject sets it to `rejected` (it never shows).

The queue is gated by a secret token. **If the token is not set,
the queue is off** and every queue address answers 403.

### Set the token

Pick a long, random token of your own. Never put it in `worker.js`
or in this repo — it belongs in a Pages secret named
`COMMENTS_MOD_TOKEN`.

#### In the Cloudflare dashboard

1. Open your Pages project → **Settings → Environment variables**.
2. Add a variable named `COMMENTS_MOD_TOKEN`, paste your token as
   the value, and encrypt it if Cloudflare offers the option.
3. Deploy again so the Worker picks the secret up.

#### With Wrangler

```bash
npx wrangler pages secret put COMMENTS_MOD_TOKEN
```

Wrangler asks for the value — paste your token there, not on the
command line.

### Open the queue

```text
https://your-site.example/api/comments/moderation?token=YOUR-TOKEN
```

Treat that address like a password — anyone who has it can approve
and reject comments. The page itself calls two JSON endpoints with
the token in an `x-mod-token` header. The endpoints accept the
token **only** in that header — the `?token=` form works on the
queue page alone, so the token stays out of URLs (and logs and
browser history) everywhere else. The token check itself is
constant-time, and every queue response is sent with
`Cache-Control: no-store`:

- `GET /api/comments/moderation/list` — the pending comments as
  JSON: `{ok: true, pending: [{id, path, name, body, created_at,
  report_count}], count}`.
- `POST /api/comments/moderation/act` — send `{id, action}` with
  `action` set to `"approve"` or `"reject"`; it answers
  `{ok: true, status}` with the new status.

A missing or wrong token gets `403` on all three addresses (the
page answers plain text; the two JSON endpoints answer
`{ok: false, error: "forbidden"}`).

**The queue page is the alert surface.** There is **no email alert
built in** — nothing will write to you when a comment is held or
reported. Check the queue page daily, the same rhythm as the
database commands above. A held comment simply waits; nothing goes
live until you OK it.

## Schema changes in v2

Two changes, both in `schema.sql`, and the Worker makes both on its
own the first time it runs (the column add is guarded, so older
databases gain it without an error):

- `lab_comments` gains a `report_count` column
  (`INTEGER NOT NULL DEFAULT 0`).
- A new `lab_comment_reports` table keeps one row per report —
  `comment_id`, the reporter's scrambled address (`ip_hash`), and
  `created_at` — with `UNIQUE(comment_id, ip_hash)` so one person
  reporting the same comment twice is counted once.

No existing rows change meaning: old comments start with a
`report_count` of 0, and statuses mean what they always meant.

## Security notes

- Posts are only accepted as `POST` + JSON, under the size cap. If
  the browser sends an `Origin` header, **its host must match the
  host the request was made to** — that is the exact check in
  `worker.js` (`commentOriginOk`). Everything else gets a plain
  "no".
- **Requests with no `Origin` header are accepted.** That is a
  plain trade-off, stated plainly: non-browser clients (a script, a
  feed tool, a plain HTTP call) send no `Origin` at all, so refusing
  them would break honest tools without stopping anyone determined
  — an `Origin` header is easy to write by hand outside a browser.
  The origin check is a browser guard, not proof of who sent a
  post. The compensating controls are the rest of the design:
  `POST` + JSON only, the size cap, the honeypot, the hourly and
  per-page limits, and the human holds.
- **The address fallback can be spoofed off Cloudflare.** The
  Worker reads the poster's address from `cf-connecting-ip` first —
  on Cloudflare, Cloudflare sets that header itself. Only when it
  is **absent** does the Worker fall back to `x-forwarded-for`, and
  a client can write anything it likes in `x-forwarded-for`. So on
  a path that does not run behind Cloudflare, the scrambled address
  (and every limit counted by it) can be faked. That is why the
  per-page burst brake exists: it counts a page's comments from
  everyone together and needs no address at all.
- No string-built SQL. Every database call is a prepared statement
  with bound values, so a comment can never twist a database command.
- The Worker sends a strong set of security headers on every response
  (HTTPS-only, no framing by other sites, no MIME sniffing, and a
  Content-Security-Policy that only trusts your own site). If your site
  uses outside forms or scripts, you may need to widen `form-action`
  or `connect-src` in `worker.js` — widen one thing at a time and test.
- The page never inserts comment HTML. Keep it that way if you edit
  `comments.js`: text nodes only.
- **IPv6 counts by the /64 block.** IPv6 addresses are handed out
  in /64 blocks, and one person usually controls the whole block.
  Before scrambling, an IPv6 address is reduced to its /64 prefix,
  so rotating addresses inside a block does not mint a fresh
  "person" for the hourly, report, and velocity limits. IPv4
  addresses are used exactly as they arrive.
- **Change the salt.** The scrambled addresses are hashed with the
  prefix `"lab-comments:"` (see `hashIp` in `worker.js`). Change it
  to a phrase of your own when you install. Then your site's
  scrambled addresses can never be matched against another site
  running this same code, and nobody can pre-compute the scramble
  for a known address. Changing it later is safe — it only resets
  who counts as "the same person" for the hourly limit.

## Honest limits

- **It is for small sites.** One list per page, in posting order. **At
  most 200 approved comments are shown per page** — anything past
  200 stays safe in the database but is not displayed. No threads,
  no replies, no likes, no avatars, no sign-in choices, no email
  alerts.
- **The link check is plain on purpose.** It holds anything that
  *looks* like a web address — including a bare domain typed without
  `https://` (like `example.com` on its own) and anything shaped like
  an email address (like `me@example.com`), because to a pattern
  they look the same as a link. A perfectly good comment that names
  a site that way waits for the same human OK. Held, never deleted —
  but you should know it happens, because your readers will meet it.
- **A human does the link OKs.** That is the price of "no spam links,
  ever." On a busy site the queue would grow teeth.
- **It is not a Disqus replacement at scale.** If you get hundreds of
  comments a day, you need a bigger tool. For a blog, a newsletter
  site, or a small business site, this is the right size.

## Bonus: a share bar

`share.js` + `share.css` are a small, honest share bar — the same one
we use. It builds real share links for X, Facebook, Reddit, LinkedIn,
WhatsApp, Telegram, and email. Instagram and TikTok have no
share-a-link web address, so on phones those buttons open the device
share sheet, and on desktops they copy the link. Drop it in like this:

```html
<link rel="stylesheet" href="/share.css">
<div id="lab-share"></div>
<script src="/share.js" defer></script>
```

## License

MIT — see `LICENSE`. Made by [The Lead Lab](https://leadlabhq.com).
Use it, change it, ship it. A link back is kind but not required.
