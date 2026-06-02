(() => {
  const housingPattern = /\$|rent|lease|sublet|sublease|takeover|bed|bd|br|loft|apartment|office|den|room/i;
  const linkPattern = /facebook\.com\/(groups|marketplace|permalink|posts|share|photo)/i;
  const clean = value => String(value || "").replace(/\n{3,}/g, "\n\n").trim();
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
      text
    });
  }
  const posts = Array.from(uniq.values());
  const payload = JSON.stringify(posts, null, 2);
  navigator.clipboard.writeText(payload).then(
    () => alert(`Copied ${posts.length} housing-like Facebook posts to clipboard.`),
    () => {
      console.log(payload);
      alert(`Clipboard write failed, but ${posts.length} posts were printed to the console.`);
    }
  );
})();
