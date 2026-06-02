(() => {
  const housingPattern = /\$|rent|lease|sublet|sublease|takeover|bed|bd|br|loft|apartment|office|den|room/i;
  const articles = Array.from(document.querySelectorAll('[role="article"], [data-pagelet*="FeedUnit"]'));
  const uniq = new Map();
  for (const article of articles) {
    const text = (article.innerText || article.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    if (!housingPattern.test(text) || text.length < 80) continue;
    const links = Array.from(article.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(href => /facebook\.com\/(groups|marketplace|permalink|posts|share|photo)/i.test(href))
      .slice(0, 12);
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
