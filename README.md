# Lab Comments

**Free comments for a small website. No reader accounts. No tracking. Safe by design.**

Lab Comments is a tiny comment box you can add to your own website.
It is for small site owners, bloggers, and builders who want comments
without handing their readers to an ad company. It runs on Cloudflare's
free plans, so for a small site it costs nothing.

**See it live:** this exact code runs under the articles on
[leadlabhq.com](https://leadlabhq.com). Post a comment there and you
have tried it.

Two words you will meet below:

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
  (or a known spam word), it is held back. It only shows after you
  OK it. You are the spam filter, and spam never reaches your page.
- **Spam links earn nothing.** Links in comments are marked
  `nofollow ugc`, so they pass no search-engine value. Spammers gain
  nothing by posting them.
- **A trap for bots.** The form has a hidden field people never see.
  Bots fill it in. Their posts are quietly dropped.
- **A speed limit.** Each person can post 5 comments an hour. The
  limit counts a scrambled (SHA-256 hashed) address — real addresses
  are never stored.

## Quick start

You need a free [Cloudflare](https://www.cloudflare.com) account, your
site on Cloudflare Pages, and Wrangler — Cloudflare's free
command-line tool. About 10 minutes, in this order:

**1. Create the database.**

```bash
wrangler d1 create lab-comments
```

Wrangler prints a `database_id`. Keep it for step 3.

**2. Make the table.**

```bash
wrangler d1 execute lab-comments --remote --file=./schema.sql
```

(Tidy path, not a hard step: the Worker also makes the table on its
own the first time it runs.)

**3. Connect the database to your site.**

Copy `wrangler.toml.example` to `wrangler.toml`, put in your project
name, and paste the `database_id` from step 1. The binding name must
be `DB` — that is the name the Worker looks for.

No `wrangler.toml`? Do it in the Cloudflare dashboard instead: your
Pages project → **Settings → Bindings → Add → D1 database**, variable
name `DB`, pick the database from step 1.

**4. Add the Worker.**

Copy `worker.js` into the root of your Pages project and rename it to
`_worker.js`. It answers `/api/comments` and passes everything else
through to your normal pages.

> One catch: if your project already has a `_worker.js`, you need to
> merge the two. The comment routes are the parts marked "comments"
> in the file.

**5. Add the comment box to a page.**

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

**6. Deploy.**

Put your Pages project online the way you always do. Open a page and
post a test comment. A plain comment shows right away. A comment with
a link in it waits for your OK — that is the system working.

## What's in this repo

| File | What it does | Must you edit it? |
|---|---|---|
| `worker.js` | The Worker: takes in comments, serves them back, holds link comments | Only the settings at the top, if you want |
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
| `COMMENT_NAME_MAX` | 40 | Longest name we accept (letters) |
| `COMMENT_BODY_MAX` | 1000 | Longest comment we accept (letters) |
| `COMMENT_BODY_BYTES_MAX` | 8192 | Biggest post we accept (8 KB) |
| `COMMENT_RATE_MAX` | 5 | Posts per hour, per person |
| `COMMENT_HOLD_WORDS` | a short list | Words that send a comment to the human-OK queue |
| `COMMENT_LINK_RE` | built in | The pattern that spots a link in a comment |

## Checking and OK-ing held comments

Held comments have the status `pending`. See them:

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

## Security notes

- Posts are only accepted as `POST` + JSON, from your own site's
  origin, under the size cap. Everything else gets a plain "no".
- No string-built SQL. Every database call is a prepared statement
  with bound values, so a comment can never twist a database command.
- The Worker sends a strong set of security headers on every response
  (HTTPS-only, no framing by other sites, no MIME sniffing, and a
  Content-Security-Policy that only trusts your own site). If your site
  uses outside forms or scripts, you may need to widen `form-action`
  or `connect-src` in `worker.js` — widen one thing at a time and test.
- The page never inserts comment HTML. Keep it that way if you edit
  `comments.js`: text nodes only.

## Honest limits

- **It is for small sites.** One list per page, newest last, up to 200
  shown per page. No threads, no replies, no likes, no avatars, no
  sign-in choices, no email alerts.
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
