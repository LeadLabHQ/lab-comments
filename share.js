/* OPTIONAL BONUS — Lab Share Bar. Plain JavaScript, no libraries.
   Put <div id="lab-share"></div> on a page, load share.css and this
   file, and a row of share buttons builds itself.
   How sharing works, honestly:
   - X, Facebook, Reddit, LinkedIn, WhatsApp, Telegram and email all
     have real "share this link" web addresses. The buttons use them.
   - Instagram and TikTok have NO share-a-link web address. On a phone,
     their buttons open the device share sheet (where the apps live).
     On a desktop, they copy the link and tell the reader to paste it.
   - No button pretends to do something it cannot do. */
(function () {
  "use strict";

  var root = document.getElementById("lab-share");
  if (!root) return;

  var pageUrl = root.getAttribute("data-url") || window.location.href;
  var pageTitle = root.getAttribute("data-title") || document.title;

  function q(s) { return encodeURIComponent(s); }
  var urls = {
    x: "https://twitter.com/intent/tweet?text=" + q(pageTitle) + "&url=" + q(pageUrl),
    facebook: "https://www.facebook.com/sharer/sharer.php?u=" + q(pageUrl),
    reddit: "https://www.reddit.com/submit?url=" + q(pageUrl) + "&title=" + q(pageTitle),
    linkedin: "https://www.linkedin.com/sharing/share-offsite/?url=" + q(pageUrl),
    whatsapp: "https://wa.me/?text=" + q(pageTitle + " " + pageUrl),
    telegram: "https://t.me/share/url?url=" + q(pageUrl) + "&text=" + q(pageTitle),
    email: "mailto:?subject=" + q(pageTitle) + "&body=" + q(pageUrl)
  };

  root.classList.add("lab-share");

  var label = document.createElement("p");
  label.className = "lab-share-label";
  label.textContent = "Share this";
  root.appendChild(label);

  var row = document.createElement("div");
  row.className = "lab-share-btns";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Share this page");
  root.appendChild(row);

  var note = document.createElement("p");
  note.className = "lab-share-note";
  note.hidden = true;
  root.appendChild(note);

  function showNote(text) {
    note.textContent = text;
    note.hidden = false;
  }

  function copyLink(afterText) {
    function done() { showNote(afterText); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(pageUrl).then(done, function () { showNote(pageUrl); });
    } else {
      showNote(pageUrl);
    }
  }

  function nativeShare(fallbackText) {
    if (navigator.share) {
      navigator.share({ title: pageTitle, url: pageUrl }).catch(function () {});
    } else {
      copyLink(fallbackText);
    }
  }

  function link(href, text) {
    var a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.target = "_blank";
    a.rel = "noopener nofollow";
    return a;
  }

  function button(text, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  var nativeBtn = button("Share", function () {
    nativeShare("Link copied — share it anywhere.");
  });
  if (!navigator.share) nativeBtn.hidden = true;
  row.appendChild(nativeBtn);
  row.appendChild(link(urls.x, "X"));
  row.appendChild(link(urls.facebook, "Facebook"));
  row.appendChild(link(urls.reddit, "Reddit"));
  row.appendChild(link(urls.linkedin, "LinkedIn"));
  row.appendChild(link(urls.whatsapp, "WhatsApp"));
  row.appendChild(link(urls.telegram, "Telegram"));
  row.appendChild(button("Instagram", function () {
    nativeShare("Link copied — paste it in Instagram.");
    if (navigator.share) showNote("Pick Instagram in the share sheet.");
  }));
  row.appendChild(button("TikTok", function () {
    nativeShare("Link copied — paste it in TikTok.");
    if (navigator.share) showNote("Pick TikTok in the share sheet.");
  }));
  row.appendChild(link(urls.email, "Email"));
  row.appendChild(button("Copy link", function () {
    copyLink("Link copied.");
  }));
})();
