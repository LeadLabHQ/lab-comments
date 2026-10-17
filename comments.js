/* Lab Comments — front-end widget. Plain JavaScript, no libraries,
   no trackers, loads nothing from anywhere else.
   Put <div id="lab-comments"></div> on any page, load comments.css and
   this file, and the widget builds itself: comment list + a small form.
   It talks to /api/comments on the same site (see worker.js).
   Safety: names and comments are drawn on the page as TEXT ONLY
   (textContent / createTextNode). Comment text is never treated as
   HTML, so a comment can never run code on your page. Links inside
   comments are drawn with rel="nofollow ugc noopener noreferrer". */
(function () {
  "use strict";

  var root = document.getElementById("lab-comments");
  if (!root) return;

  // Which page these comments belong to. Set data-path="/some/page" on
  // the div to pin it; otherwise the current page path is used (no
  // trailing slash — the worker counts "/a/b" and "/a/b/" as one page).
  var path = root.getAttribute("data-path") ||
    window.location.pathname.replace(/\/+$/, "") || "/";

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  root.classList.add("lab-comments");

  var title = el("h2", "lab-comments-title", "Comments ");
  var count = el("span", "lab-comments-count");
  title.appendChild(count);
  root.appendChild(title);
  root.appendChild(el("p", "lab-comments-note",
    "Say it plainly and be kind. Comments with links are read by a person before they appear. Links in comments are marked nofollow."));

  var list = el("div", "lab-comments-list");
  list.appendChild(el("p", "lab-comments-empty", "Loading comments…"));
  root.appendChild(list);

  // --- the form ---
  var form = document.createElement("form");
  form.className = "lab-comment-form";
  form.method = "post";
  form.action = "/api/comments";

  var nameLabel = el("label", "", "Your name");
  nameLabel.htmlFor = "lab-comment-name";
  var nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "lab-comment-name";
  nameInput.name = "name";
  nameInput.maxLength = 40;
  nameInput.required = true;
  nameInput.autocomplete = "name";

  var bodyLabel = el("label", "", "Your comment");
  bodyLabel.htmlFor = "lab-comment-body";
  var bodyInput = document.createElement("textarea");
  bodyInput.id = "lab-comment-body";
  bodyInput.name = "body";
  bodyInput.maxLength = 1000;
  bodyInput.required = true;

  // Character hint by the comment box, added from here so the page
  // markup needs no change: the limit, plus a live count as you type.
  var bodyHint = el("p", "lab-comment-count", "Up to 1,000 characters · 0 / 1,000");
  bodyInput.addEventListener("input", function () {
    bodyHint.textContent = "Up to 1,000 characters · " + bodyInput.value.length + " / 1,000";
  });

  // Honeypot: a field real people never see or fill. Bots fill it,
  // and the worker quietly drops those posts.
  var hp = el("span", "lab-hp");
  hp.setAttribute("aria-hidden", "true");
  var hpLabel = el("label", "", "Leave this blank");
  var hpInput = document.createElement("input");
  hpInput.type = "text";
  hpInput.name = "website";
  hpInput.tabIndex = -1;
  hpInput.autocomplete = "off";
  hpLabel.appendChild(hpInput);
  hp.appendChild(hpLabel);

  var submit = el("button", "", "Post comment");
  submit.type = "submit";
  var status = el("p", "lab-form-status");
  status.setAttribute("role", "status");

  form.appendChild(nameLabel);
  form.appendChild(nameInput);
  form.appendChild(bodyLabel);
  form.appendChild(bodyInput);
  form.appendChild(bodyHint);
  form.appendChild(hp);
  form.appendChild(submit);
  form.appendChild(status);
  root.appendChild(form);

  // --- drawing comments (text only, always) ---
  var URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;

  // Build a <p> from plain text: text nodes only; web addresses become
  // links that pass no search-engine value (nofollow + ugc).
  function bodyNode(text) {
    var p = document.createElement("p");
    p.className = "lab-comment-body";
    var parts = String(text).split(URL_RE);
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part) continue;
      if (URL_RE.test(part)) {
        URL_RE.lastIndex = 0;
        var a = document.createElement("a");
        a.href = part.indexOf("www.") === 0 ? "https://" + part : part;
        a.textContent = part;
        a.setAttribute("rel", "nofollow ugc noopener noreferrer");
        a.setAttribute("target", "_blank");
        p.appendChild(a);
      } else {
        URL_RE.lastIndex = 0;
        p.appendChild(document.createTextNode(part));
      }
    }
    return p;
  }

  // Times are stored as UTC "YYYY-MM-DD HH:MM:SS". Readers see human
  // relative text ("3 hours ago"); the <time datetime> element keeps
  // the exact moment for machines and screen readers.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function timeNode(createdAt) {
    var iso = String(createdAt || "").replace(" ", "T");
    if (iso && iso.indexOf("Z") === -1 && iso.indexOf("+") === -1) iso += "Z";
    var t = document.createElement("time");
    t.setAttribute("datetime", iso);
    var then = Date.parse(iso);
    var text;
    if (isNaN(then)) {
      text = String(createdAt || "");
    } else {
      var secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
      if (secs < 60) text = "just now";
      else if (secs < 3600) { var m = Math.floor(secs / 60); text = m + (m === 1 ? " minute ago" : " minutes ago"); }
      else if (secs < 86400) { var h = Math.floor(secs / 3600); text = h + (h === 1 ? " hour ago" : " hours ago"); }
      else if (secs < 86400 * 30) { var d = Math.floor(secs / 86400); text = d + (d === 1 ? " day ago" : " days ago"); }
      else { var dt = new Date(then); text = MONTHS[dt.getMonth()] + " " + dt.getDate() + ", " + dt.getFullYear(); }
    }
    t.textContent = text;
    return t;
  }

  function render(comments) {
    list.textContent = "";
    count.textContent = comments.length ? "(" + comments.length + ")" : "";
    if (!comments.length) {
      list.appendChild(el("p", "lab-comments-empty", "No comments yet — yours can be the first."));
      return;
    }
    comments.forEach(function (c) {
      var box = el("div", "lab-comment");
      var head = el("p", "lab-comment-head");
      head.appendChild(el("strong", "", c.name));
      head.appendChild(document.createTextNode(" · "));
      head.appendChild(timeNode(c.created_at));
      box.appendChild(head);
      box.appendChild(bodyNode(c.body));
      // A small Report button under each comment. One click flags the
      // comment for a person; the button then says so, in plain words.
      if (c.id !== undefined && c.id !== null) {
        var reportWrap = el("p", "lab-comment-report-wrap");
        var reportBtn = el("button", "lab-comment-report", "Report");
        reportBtn.type = "button";
        reportBtn.addEventListener("click", function () {
          reportBtn.disabled = true;
          fetch("/api/comments/report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: c.id })
          })
            .then(function (r) {
              return r.json().then(function (d) { return { status: r.status, data: d }; })
                .catch(function () { return { status: r.status, data: null }; });
            })
            .then(function (res) {
              var note = res.status === 429
                ? "Thanks — reports are noted."
                : "Thanks — a person will look at it.";
              reportWrap.textContent = "";
              reportWrap.appendChild(el("span", "lab-comment-report-note", note));
            })
            .catch(function () {
              reportBtn.disabled = false;
            });
        });
        reportWrap.appendChild(reportBtn);
        box.appendChild(reportWrap);
      }
      list.appendChild(box);
    });
  }

  function load() {
    fetch("/api/comments?path=" + encodeURIComponent(path), { headers: { "accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (data) { render((data && data.comments) || []); })
      .catch(function () {
        list.textContent = "";
        list.appendChild(el("p", "lab-comments-empty", "Comments could not load just now — please refresh."));
      });
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = nameInput.value.trim();
    var body = bodyInput.value.trim();
    if (!name || !body) {
      status.textContent = "Please add your name and a comment.";
      return;
    }
    submit.disabled = true;
    status.textContent = "Posting…";
    fetch("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path, name: name, body: body, website: hpInput.value })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        submit.disabled = false;
        if (res.data && res.data.ok && res.data.duplicate) {
          status.textContent = res.data.status === "pending"
            ? "That comment is already with a person to read — no need to send it twice."
            : "That comment is already posted — no need to send it twice.";
          bodyInput.value = "";
        } else if (res.data && res.data.ok && res.data.status === "approved") {
          status.textContent = "Posted — thank you.";
          bodyInput.value = "";
          load();
        } else if (res.data && res.data.ok && res.data.status === "pending") {
          if (res.data.held === "name_link") {
            status.textContent = "Thanks — your name includes a link, so a person reads your comment before it appears here.";
          } else if (res.data.held === "first") {
            status.textContent = "Thanks — first comments here get a quick read by a person before they appear.";
          } else if (res.data.held === "velocity") {
            status.textContent = "Thanks — a person will read this one first.";
          } else if (res.data.held === "word") {
            status.textContent = "Thanks — a person reads your comment before it appears here.";
          } else {
            status.textContent = "Thanks — your comment includes a link, so a person reads it before it appears here.";
          }
          bodyInput.value = "";
        } else if (res.data && res.data.error === "too_long") {
          status.textContent = "That comment is too long — please trim it a little.";
        } else if (res.data && res.data.error === "name_too_long") {
          status.textContent = "That name is too long — please shorten it a little.";
        } else if (res.data && res.data.error === "path_busy") {
          status.textContent = "This page is getting a lot of comments right now — try again in a few minutes.";
        } else if (res.status === 429) {
          status.textContent = "You have posted a few comments in the last hour — the limit is five an hour. Please wait a bit and try again.";
        } else {
          status.textContent = "That did not post. Please check the comment and try again.";
        }
      })
      .catch(function () {
        submit.disabled = false;
        status.textContent = "That did not post. Please try again in a moment.";
      });
  });

  load();
})();
