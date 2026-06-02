(async () => {
  const housingPattern = /\$|rent|lease|sublet|sublease|takeover|bed|bd|br|loft|apartment|office|den|room/i;
  const groupHousingPattern = /housing|apartment|apartments|apt\b|room|roommate|roommates|sublet|sublease|lease|rent|rental|loft|live.?work/i;
  const linkPattern = /facebook\.com\/(groups|marketplace|permalink|posts|share|photo)/i;
  const expandPattern = /^(see|show|view)\s+more|more$/i;
  const clean = value => String(value || "").replace(/\n{3,}/g, "\n\n").trim();
  const fileSlug = value => String(value || "facebook")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "facebook";
  const captureStamp = () => new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "Z");
  const canonicalGroupUrl = href => {
    const match = String(href || "").match(/facebook\.com\/groups\/([^/?#]+)/i);
    return match ? `https://www.facebook.com/groups/${match[1]}` : "";
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function expandVisibleText() {
    const buttons = Array.from(document.querySelectorAll('[role="button"], button, span, a'))
      .filter(el => {
        const text = clean(el.innerText || el.textContent);
        if (!expandPattern.test(text)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .slice(0, 80);
    for (const button of buttons) {
      try {
        button.click();
      } catch {
        // Ignore controls Facebook refuses to click from a bookmarklet.
      }
    }
    if (buttons.length) await wait(600);
    return buttons.length;
  }
  const expandedControls = await expandVisibleText();
  function downloadPayload(payload) {
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `fb-housing-capture-${captureStamp()}-${fileSlug(document.title || location.hostname)}.json`;
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    return filename;
  }
  const linkSeeds = Array.from(document.querySelectorAll([
    'a[href*="/marketplace/item"]',
    'a[href*="/groups/"][href*="/posts/"]',
    'a[href*="/permalink/"]',
    'a[href*="/posts/"]',
    'a[href*="/share/"]'
  ].join(",")));
  function compactCardFromLink(link) {
    let node = link;
    let best = link;
    for (let i = 0; i < 7 && node.parentElement; i++) {
      node = node.parentElement;
      const text = clean(node.innerText || node.textContent);
      if (housingPattern.test(text) && text.length >= 35 && text.length <= 2600) best = node;
      if (text.length > 2600) break;
    }
    return best;
  }
  const articles = [
    ...document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"]'),
    ...linkSeeds.map(compactCardFromLink)
  ];
  const uniq = new Map();
  for (const article of articles) {
    const text = clean(article.innerText || article.textContent);
    if (!housingPattern.test(text) || text.length < 35) continue;
    const links = Array.from(article.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(href => linkPattern.test(href))
      .slice(0, 12);
    if (!links.length && !housingPattern.test(location.href)) continue;
    const images = Array.from(article.querySelectorAll('img[src]'))
      .map(img => img.src)
      .filter(src => /scontent|fbcdn/i.test(src))
      .slice(0, 6);
    const key = text.slice(0, 240).replace(/\s+/g, " ");
    uniq.set(key, {
      capturedAt: new Date().toISOString(),
      pageTitle: document.title,
      pageUrl: location.href,
      url: links[0] || location.href,
      links,
      images,
      sourceKind: links.some(href => /\/marketplace\//i.test(href)) || /\/marketplace\//i.test(location.href) ? "marketplace" : "post",
      expandedControls,
      text
    });
  }
  const posts = Array.from(uniq.values());
  const groups = Array.from(document.querySelectorAll('a[href*="/groups/"]'))
    .map(a => {
      const url = canonicalGroupUrl(a.href);
      if (!url || /\/(posts|permalink|search|media|files|members|about|photos)\b/i.test(a.href)) return null;
      const card = a.closest('[role="listitem"], [role="article"], [data-visualcompletion], li, div') || a;
      const cardText = clean(card.innerText || card.textContent);
      const linkText = clean(a.innerText || a.textContent);
      const name = (linkText.length >= 3 && linkText.length <= 120 ? linkText : cardText.split("\n").find(line => line.length >= 3 && line.length <= 120)) || url;
      return {
        name,
        url,
        housingLike: groupHousingPattern.test(`${name}\n${cardText}\n${url}`),
        capturedAt: new Date().toISOString(),
        pageTitle: document.title,
        pageUrl: location.href,
        sourceKind: "group"
      };
    })
    .filter(Boolean)
    .reduce((map, group) => map.set(group.url, group), new Map());
  const payload = JSON.stringify({
    capturedAt: new Date().toISOString(),
    pageTitle: document.title,
    pageUrl: location.href,
    posts,
    groups: Array.from(groups.values()),
    expandedControls
  }, null, 2);
  const filename = downloadPayload(payload);
  navigator.clipboard.writeText(payload).then(
    () => alert(`Downloaded ${filename} and copied ${posts.length} housing-like posts plus ${groups.size} visible groups to clipboard. Expanded ${expandedControls} visible controls first.`),
    () => {
      console.log(payload);
      alert(`Downloaded ${filename}. Clipboard write failed, but ${posts.length} posts and ${groups.size} groups were printed to the console. Expanded ${expandedControls} visible controls first.`);
    }
  );
})();
