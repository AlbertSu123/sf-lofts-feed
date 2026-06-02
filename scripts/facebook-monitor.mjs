#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = path.join(ROOT, "monitoring/facebook-monitor.config.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonIfExists(file, fallback) {
  return fs.existsSync(file) ? readJson(file) : fallback;
}

function loadConfig() {
  const config = readJson(CONFIG_PATH);
  const localGroupsPath = path.join(ROOT, config.facebook.localGroupsFile || "monitoring/facebook-groups.local.json");
  const local = readJsonIfExists(localGroupsPath, {});
  const groupUrls = [
    ...(config.facebook.groupUrls || []),
    ...(local.groupUrls || []),
    ...(local.groups || []).map(g => g.url).filter(Boolean)
  ];
  return {
    ...config,
    facebook: {
      ...config.facebook,
      groupUrls: [...new Set(groupUrls)]
    }
  };
}

function parseArgs(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) opts[key] = true;
    else opts[key] = argv[++i];
  }
  return { args, opts };
}

function usage() {
  console.log(`Usage:
  node scripts/facebook-monitor.mjs searches [--out monitoring/facebook-searches.md] [--format json|markdown]
  node scripts/facebook-monitor.mjs score <capture.json|capture.txt...> [--out monitoring/facebook-candidates.json] [--snippets monitoring/facebook-candidates.generated.js] [--existing index.html]

Raw captures and generated candidates are ignored by git. Review and verify before publishing any private-group lead.`);
}

function postSearchUrl(term) {
  return `https://www.facebook.com/search/posts/?q=${encodeURIComponent(term)}`;
}

function marketplaceSearchUrl(term, city) {
  return `https://www.facebook.com/marketplace/${city}/search/?query=${encodeURIComponent(term)}`;
}

function groupSearchUrl(groupUrl, term) {
  const clean = groupUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return `${clean}/search/?q=${encodeURIComponent(term)}`;
}

function generateSearches(config) {
  const terms = config.facebook.searchTerms || [];
  const city = config.facebook.cityMarketplace || "sanfrancisco";
  const rows = [];
  for (const term of terms) {
    rows.push({ surface: "posts", term, url: postSearchUrl(term) });
    rows.push({ surface: "marketplace", term, url: marketplaceSearchUrl(term, city) });
    for (const groupUrl of config.facebook.groupUrls || []) {
      rows.push({ surface: "group", term, groupUrl, url: groupSearchUrl(groupUrl, term) });
    }
  }
  return rows;
}

function writeSearches(rows, opts) {
  const format = opts.format || (opts.out && opts.out.endsWith(".json") ? "json" : "markdown");
  let body;
  if (format === "json") {
    body = JSON.stringify(rows, null, 2) + "\n";
  } else {
    body = [
      "# Facebook Housing Search Queue",
      "",
      "Open these while logged into Facebook, sort/filter by recent posts where the UI allows it, then run `monitoring/facebook-capture-snippet.js` on promising result pages.",
      "",
      "| Surface | Term | URL |",
      "| --- | --- | --- |",
      ...rows.map(r => `| ${r.surface} | ${escapeMd(r.term)} | ${r.url} |`)
    ].join("\n") + "\n";
  }
  if (opts.out) fs.writeFileSync(path.join(ROOT, opts.out), body);
  else process.stdout.write(body);
}

function escapeMd(value) {
  return String(value).replace(/\|/g, "\\|");
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function parseCaptureFile(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.posts || parsed.items || [parsed];
    return rows.map(item => normalizePost(item, file)).filter(Boolean);
  } catch {
    return raw
      .split(/\n(?:-{3,}|={3,})\n|(?:\n\s*\n){2,}/g)
      .map(text => normalizePost({ text }, file))
      .filter(Boolean);
  }
}

function normalizePost(item, file) {
  const text = cleanText(item.text || item.body || item.content || "");
  if (text.length < 60) return null;
  const links = Array.isArray(item.links) ? item.links : [];
  const images = Array.isArray(item.images) ? item.images : [];
  return {
    file,
    capturedAt: item.capturedAt || null,
    pageTitle: item.pageTitle || item.group || "",
    pageUrl: item.pageUrl || "",
    url: item.url || links[0] || item.pageUrl || "",
    links,
    images,
    text
  };
}

function numberFromMatch(match) {
  return Number(String(match).replace(/[^\d.]/g, ""));
}

function extractPrice(text) {
  const prices = Array.from(text.matchAll(/\$\s*([0-9][0-9,]{2,5})(?:\s*(?:\/|per)?\s*(?:mo|month|mth|monthly))?/gi))
    .map(m => Number(m[1].replace(/,/g, "")))
    .filter(n => n >= 1000 && n <= 20000);
  if (!prices.length) return null;
  return Math.min(...prices);
}

function extractBedrooms(text) {
  const matches = [
    ...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:bd|br|bed(?:room)?s?|bdrm)s?\b/gi),
    ...text.matchAll(/\b(\d+)b(?:\/|\s*)\d+b\b/gi)
  ];
  if (!matches.length) return /\bstudio\b/i.test(text) ? 0 : null;
  return Math.max(...matches.map(m => numberFromMatch(m[1])));
}

function extractBathrooms(text) {
  const matches = [
    ...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:ba|bath(?:room)?s?)\b/gi),
    ...text.matchAll(/\b\d+b(?:\/|\s*)(\d+)b\b/gi)
  ];
  if (!matches.length) return null;
  return Math.max(...matches.map(m => numberFromMatch(m[1])));
}

function extractSqft(text) {
  const matches = Array.from(text.matchAll(/([0-9][0-9,]{2,4})\s*(?:sq\.?\s*ft|sqft|square feet|sf)\b/gi))
    .map(m => Number(m[1].replace(/,/g, "")))
    .filter(n => n >= 250 && n <= 5000);
  return matches.length ? Math.max(...matches) : null;
}

function hasSharedSignal(text) {
  return /\b(room in|private room|room available|shared|roommate|housemate)\b/i.test(text);
}

function inferLocation(text, config) {
  const neighborhoods = config.criteria.preferredNeighborhoods || [];
  const found = neighborhoods.find(n => new RegExp(`\\b${escapeRegex(n)}\\b`, "i").test(text));
  const address = text.match(/\b\d{2,5}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ct|Court|Pl|Place|Way|Ter|Terrace)\b/);
  if (address && found) return `${address[0]} · ${found}`;
  return address ? address[0] : found || "San Francisco";
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function signalHits(text, config) {
  const lower = text.toLowerCase();
  return (config.criteria.preferredSignals || [])
    .filter(signal => lower.includes(signal.toLowerCase()));
}

function rejectHits(text, config) {
  const lower = text.toLowerCase();
  return (config.criteria.rejectSignals || [])
    .filter(signal => lower.includes(signal.toLowerCase()));
}

function buildHandle(location, text) {
  const base = (location !== "San Francisco" ? location : text.slice(0, 50))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 32) || "facebook.lead";
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 5);
  return `${base}.${hash}`;
}

function summarize(text, max = 230) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1).trim()}…`;
}

function scorePost(post, config, existing) {
  const text = post.text;
  const price = extractPrice(text);
  const rawBeds = extractBedrooms(text);
  const shared = hasSharedSignal(text);
  const budgetBeds = shared ? 1 : rawBeds;
  const baths = extractBathrooms(text);
  const sqft = extractSqft(text);
  const ppb = price && budgetBeds ? price / budgetBeds : null;
  const location = inferLocation(text, config);
  const signals = signalHits(text, config);
  const rejects = rejectHits(text, config);
  const handle = buildHandle(location, text);
  const duplicate = existing.handles.has(handle) || (post.url && existing.urls.has(post.url));

  let score = 0;
  if (price && budgetBeds && ppb <= config.criteria.maxPricePerBedroom) score += 8;
  if (!price || !budgetBeds) score += 2;
  if (rawBeds >= config.criteria.minBedrooms) score += 4;
  if (rawBeds >= 3) score += 2;
  if (baths >= 2) score += 3;
  if (sqft >= 1000) score += 3;
  if (sqft >= 1400) score += 2;
  for (const signal of signals) {
    if (/loft|live\/work|live work|warehouse/i.test(signal)) score += 5;
    else if (/office|den|workspace|wfh/i.test(signal)) score += 4;
    else score += 1;
  }
  if (shared) score -= 3;
  if (duplicate) score -= 20;
  score -= rejects.length * 8;

  let status = "review";
  if (duplicate) status = "duplicate";
  else if (rejects.length) status = "reject";
  else if (ppb !== null && ppb > config.criteria.maxPricePerBedroom) status = "reject";
  else if (rawBeds !== null && rawBeds < config.criteria.minBedrooms && !(shared && config.criteria.allowSharedRooms)) status = "reject";
  else if (score >= 12 && signals.length) status = "pass";
  else if (!price || !budgetBeds || signals.length) status = "verify";

  return {
    status,
    score,
    duplicate,
    handle,
    price,
    bedrooms: rawBeds,
    budgetBedrooms: budgetBeds,
    bathrooms: baths,
    sqft,
    pricePerBedroom: ppb === null ? null : Math.round(ppb),
    location,
    shared,
    signals,
    rejects,
    url: post.url,
    pageUrl: post.pageUrl,
    capturedAt: post.capturedAt,
    sourceFile: post.file,
    summary: summarize(text),
    textHash: crypto.createHash("sha1").update(text).digest("hex")
  };
}

function loadExisting(file) {
  const out = { handles: new Set(), urls: new Set() };
  const target = path.join(ROOT, file || "index.html");
  if (!fs.existsSync(target)) return out;
  const text = fs.readFileSync(target, "utf8");
  for (const m of text.matchAll(/handle:\s*"([^"]+)"/g)) out.handles.add(m[1]);
  for (const m of text.matchAll(/link:\s*"([^"]+)"/g)) out.urls.add(m[1]);
  return out;
}

function priceLabel(n) {
  return n ? `$${n.toLocaleString()}/mo` : "Price TBD";
}

function ppbLabel(n) {
  return n ? `$${n.toLocaleString()}/bd` : "verify";
}

function specObjects(c) {
  const specs = [];
  if (c.bedrooms !== null) specs.push({ t: `${c.shared ? "Shared " : ""}${c.bedrooms} bd`, hot: c.bedrooms >= 3 });
  if (c.bathrooms !== null) specs.push({ t: `${c.bathrooms} ba`, hot: c.bathrooms >= 2 });
  if (c.sqft) specs.push({ t: `${c.sqft.toLocaleString()} sqft`, hot: c.sqft >= 1000 });
  if (c.signals.some(s => /loft|live\/work|live work|warehouse/i.test(s))) specs.push({ t: "Loft/work signal", hot: true });
  if (c.signals.some(s => /office|den|workspace|wfh/i.test(s))) specs.push({ t: "Office signal", hot: true });
  specs.push({ t: "FB monitor", hot: true });
  return specs;
}

function js(value) {
  return JSON.stringify(value);
}

function outputPath(file) {
  return path.isAbsolute(file) ? file : path.join(ROOT, file);
}

function generateSnippet(c) {
  const query = `${c.location} ${c.bedrooms || ""} bedroom ${c.signals.slice(0, 3).join(" ")} San Francisco rent`.trim();
  const linkExpr = c.url ? js(c.url) : `FB_POSTS(${js(query)})`;
  const features = [
    c.pricePerBedroom ? `✔︎ ${ppbLabel(c.pricePerBedroom)} estimated price per bedroom` : "✔︎ Price/bedroom needs verification",
    c.bedrooms ? `✔︎ ${c.bedrooms} bedroom signal from Facebook text` : "✔︎ Bedroom count needs verification",
    c.sqft ? `✔︎ ${c.sqft.toLocaleString()} sqft signal` : "✔︎ Square footage not captured yet",
    c.signals.length ? `✔︎ Strong signals: ${c.signals.slice(0, 5).join(", ")}` : "✔︎ Needs feature verification"
  ].join("\n");
  const tags = ["#facebookHousing", "#monitorLead"]
    .concat(c.signals.slice(0, 4).map(s => `#${s.toLowerCase().replace(/[^a-z0-9]+/g, "")}`))
    .join(" ");
  return `fbLead({
  handle:${js(c.handle)},
  location:${js(`${c.location} · Facebook monitor`)},
  price:${js(priceLabel(c.price))},
  ${c.shared ? "budgetBedrooms:1,\n  " : ""}specs:${js(specObjects(c))},
  caption:${js(`Facebook monitor candidate: ${c.summary}`)},
  features:${js(features)},
  tags:${js(tags)},
  likes:${js("monitor")},
  mapq:${js(`${c.location}, San Francisco, CA`)},
  link:${linkExpr},
  linktext:${js(c.url ? "Open Facebook lead" : "Open Facebook search")},
  source:${js(`Facebook monitor · ${c.status} · captured ${c.capturedAt || "date unknown"}`)},
  comments:${js([
    "Monitor lead: verify direct availability, exact address, and poster identity before sending money or documents.",
    c.pricePerBedroom ? `${ppbLabel(c.pricePerBedroom)} is within the current $2,500/bedroom rule.` : "Missing price or bedroom count, so keep in verify mode.",
    "Ask for tour timing, lease terms, total move-in cash, pets/parking, and whether the poster is owner/manager."
  ])}
}),`;
}

function runScore(files, opts) {
  const config = loadConfig();
  const existing = loadExisting(opts.existing);
  const posts = files.flatMap(parseCaptureFile);
  const seen = new Set();
  const candidates = posts
    .map(post => scorePost(post, config, existing))
    .filter(c => {
      if (seen.has(c.textHash)) return false;
      seen.add(c.textHash);
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const outPath = opts.out ? outputPath(opts.out) : null;
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(candidates, null, 2) + "\n");

  if (opts.snippets) {
    const publishable = candidates.filter(c => c.status === "pass" || c.status === "verify");
    const body = [
      "// Review, verify, and curate before copying these into index.html.",
      "// Generated by scripts/facebook-monitor.mjs.",
      "",
      ...publishable.map(generateSnippet)
    ].join("\n") + "\n";
    fs.writeFileSync(outputPath(opts.snippets), body);
  }

  const top = candidates.slice(0, 20).map(c => ({
    status: c.status,
    score: c.score,
    price: priceLabel(c.price),
    beds: c.bedrooms ?? "?",
    ppb: ppbLabel(c.pricePerBedroom),
    location: c.location,
    signals: c.signals.slice(0, 5).join(", "),
    summary: c.summary
  }));
  console.log(JSON.stringify({
    scannedPosts: posts.length,
    candidates: candidates.length,
    pass: candidates.filter(c => c.status === "pass").length,
    verify: candidates.filter(c => c.status === "verify").length,
    rejected: candidates.filter(c => c.status === "reject").length,
    duplicate: candidates.filter(c => c.status === "duplicate").length,
    out: opts.out || null,
    snippets: opts.snippets || null,
    top
  }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const { args, opts } = parseArgs(rest);

if (!cmd || cmd === "help") {
  usage();
} else if (cmd === "searches") {
  writeSearches(generateSearches(loadConfig()), opts);
} else if (cmd === "score") {
  if (!args.length) {
    usage();
    process.exit(1);
  }
  runScore(args.map(file => path.resolve(process.cwd(), file)), opts);
} else {
  usage();
  process.exit(1);
}
