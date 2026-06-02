#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = path.join(ROOT, "monitoring/facebook-monitor.config.json");
const DEFAULT_CANDIDATES_PATH = "monitoring/facebook-candidates.json";
const DEFAULT_STATE_PATH = "monitoring/facebook-monitor-state.json";
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const GROUP_HOUSING_PATTERN = /housing|apartment|apartments|apt\b|room|roommate|roommates|sublet|sublease|lease|rent|rental|loft|live.?work/i;

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
  const groups = normalizeGroups(config.facebook.groupUrls)
    .concat(normalizeGroups(local.groupUrls))
    .concat(normalizeGroups(local.groups));
  const seen = new Set();
  const groupList = groups.filter(group => {
    if (!group.url || seen.has(group.url)) return false;
    seen.add(group.url);
    return true;
  });
  return {
    ...config,
    facebook: {
      ...config.facebook,
      groupUrls: groupList.map(group => group.url),
      groups: groupList
    }
  };
}

function normalizeGroups(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry, i) => typeof entry === "string" ? { name: `Group ${i + 1}`, url: entry } : entry)
    .filter(entry => entry && entry.url)
    .map((entry, i) => ({
      name: entry.name || `Group ${i + 1}`,
      url: canonicalGroupUrl(entry.url),
      priority: entry.priority || "normal",
      notes: entry.notes || ""
    }));
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
  node scripts/facebook-monitor.mjs watch [--out monitoring/facebook-watch.md] [--html monitoring/facebook-watch.html] [--open] [--limit 24] [--rotate] [--state monitoring/facebook-monitor-state.json]
  node scripts/facebook-monitor.mjs bookmarklet [--out monitoring/facebook-capture-bookmarklet.html]
  node scripts/facebook-monitor.mjs groups [group-urls.txt|-] [--from-clipboard] [--priority high|normal|low] [--housing-only] [--out monitoring/facebook-groups.local.json]
  node scripts/facebook-monitor.mjs status
  node scripts/facebook-monitor.mjs coverage [--inbox monitoring/facebook-inbox] [--stale-hours 24]
  node scripts/facebook-monitor.mjs next [--out monitoring/facebook-next.md] [--watch monitoring/facebook-watch.md] [--html monitoring/facebook-watch.html] [--script monitoring/facebook-open-watch.sh] [--limit 40] [--open] [--no-rotate] [--no-focus-stale] [--state monitoring/facebook-monitor-state.json]
  node scripts/facebook-monitor.mjs downloads [--downloads-dir ~/Downloads] [--out-dir monitoring/facebook-inbox] [--groups] [--housing-only] [--groups-out monitoring/facebook-groups.local.json] [--state monitoring/facebook-monitor-state.json] [--all]
  node scripts/facebook-monitor.mjs inbox [capture.json|-] [--from-clipboard] [--name source-name] [--out-dir monitoring/facebook-inbox]
  node scripts/facebook-monitor.mjs score <capture.json|capture.txt...> [--out monitoring/facebook-candidates.json] [--snippets monitoring/facebook-candidates.generated.js] [--review monitoring/facebook-review.html] [--state monitoring/facebook-monitor-state.json] [--new-only] [--update-state]
  node scripts/facebook-monitor.mjs scan [--inbox monitoring/facebook-inbox] [--open] [--all] [--update-state]
  node scripts/facebook-monitor.mjs publish <candidates.json> --select <handle-or-hash,...> [--apply] [--index index.html]

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

function canonicalGroupUrl(url) {
  const match = String(url || "").match(/facebook\.com\/groups\/([A-Za-z0-9._-]+)/i);
  return match ? `https://www.facebook.com/groups/${match[1]}` : String(url || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function generateSearches(config) {
  const terms = config.facebook.searchTerms || [];
  const city = config.facebook.cityMarketplace || "sanfrancisco";
  const rows = [];
  for (const term of terms) {
    rows.push({ surface: "posts", label: "Facebook posts", term, url: postSearchUrl(term), priority: "normal" });
    rows.push({ surface: "marketplace", label: "Marketplace", term, url: marketplaceSearchUrl(term, city), priority: "normal" });
    for (const group of config.facebook.groups || []) {
      rows.push({
        surface: "group",
        label: group.name,
        term,
        groupUrl: group.url,
        url: groupSearchUrl(group.url, term),
        priority: group.priority || "normal"
      });
    }
  }
  return rows;
}

function sortedSearchRows(rows, opts = {}) {
  const focusRank = new Map((opts.focusGroupUrls || []).map((url, i) => [url, i]));
  const rankFor = row => row.groupUrl && focusRank.has(row.groupUrl) ? focusRank.get(row.groupUrl) : Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => rankFor(a) - rankFor(b) || (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1));
}

function rotateRows(rows, cursor) {
  if (!rows.length) return [];
  const offset = ((Number(cursor) || 0) % rows.length + rows.length) % rows.length;
  return rows.slice(offset).concat(rows.slice(0, offset));
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
      ...rows.map(r => `| ${r.surface}${r.label ? ` · ${escapeMd(r.label)}` : ""} | ${escapeMd(r.term)} | ${r.url} |`)
    ].join("\n") + "\n";
  }
  if (opts.out) fs.writeFileSync(outputPath(opts.out), body);
  else process.stdout.write(body);
}

function generateWatchBatch(config, opts) {
  const allRows = generateSearches(config);
  const limit = Number(opts.limit || allRows.length);
  const focusGroupUrls = opts.focusGroupUrls || [];
  const focusGroupSet = new Set(focusGroupUrls);
  const isFocused = row => row.groupUrl && focusGroupSet.has(row.groupUrl);
  const sortedRows = sortedSearchRows(allRows, { focusGroupUrls });
  const focusedRows = sortedRows.filter(isFocused);
  const rotatedRows = sortedSearchRows(allRows.filter(row => !isFocused(row)));
  const statePath = outputPath(opts.state || DEFAULT_STATE_PATH);
  const state = opts.rotate ? readJsonIfExists(statePath, { seenHashes: [] }) : null;
  const cursor = state ? Number(state.watchCursor || 0) : 0;
  const sourceRows = opts.rotate ? focusedRows.concat(rotateRows(rotatedRows, cursor)) : sortedRows;
  const rows = sourceRows.slice(0, limit);
  const selectedRotatedRows = rows.filter(row => !isFocused(row)).length;
  const capturePath = "monitoring/facebook-capture-snippet.js";
  const mdOut = opts.out || "monitoring/facebook-watch.md";
  const htmlOut = opts.html || null;
  const openOut = opts.script || "monitoring/facebook-open-watch.sh";
  const now = new Date().toISOString();
  const nextCursor = rotatedRows.length ? (cursor + selectedRotatedRows) % rotatedRows.length : 0;

  const md = [
    "# Facebook Watch Batch",
    "",
    `Generated: ${now}`,
    `Scan cadence target: every ${config.facebook.scanCadenceHours || 6} hours`,
    "",
    "Workflow:",
    "",
    "1. Open each link while logged into Facebook.",
    "2. Sort or filter by recent posts where Facebook exposes that control.",
    `3. Run \`${capturePath}\` on the results page.`,
    "4. Save copied JSON under `monitoring/facebook-inbox/`.",
    "5. Run the score command from the README.",
    "",
    "| Priority | Surface | Term | URL |",
    "| --- | --- | --- | --- |",
    ...rows.map(r => `| ${r.priority || "normal"} | ${escapeMd(r.label || r.surface)} | ${escapeMd(r.term)} | ${r.url} |`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(mdOut), md);

  if (htmlOut) {
    const captureRel = path.relative(path.dirname(outputPath(htmlOut)), outputPath(capturePath)).replace(/\\/g, "/");
    const captureHref = captureRel.startsWith("..") ? pathToFileURL(outputPath(capturePath)).href : captureRel;
    const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Watch Batch</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;margin:24px;color:#111}
a{color:#06c} table{border-collapse:collapse;width:100%;max-width:1100px}td,th{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{background:#f6f6f6}.high{background:#fff3f3}.low{color:#666}
code,textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}textarea{width:100%;height:180px}
</style>
<h1>Facebook Watch Batch</h1>
<p>Generated ${escapeHtml(now)}. Run the capture snippet after each promising page loads.</p>
<p><a href="${escapeHtml(captureHref)}">Open capture snippet file</a></p>
<table>
<thead><tr><th>Priority</th><th>Surface</th><th>Term</th><th>Open</th></tr></thead>
<tbody>
${rows.map(r => `<tr class="${escapeHtml(r.priority || "normal")}"><td>${escapeHtml(r.priority || "normal")}</td><td>${escapeHtml(r.label || r.surface)}</td><td>${escapeHtml(r.term)}</td><td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">open search</a></td></tr>`).join("\n")}
</tbody>
</table>
`;
    fs.writeFileSync(outputPath(htmlOut), html);
  }

  const sh = [
    "#!/bin/sh",
    "set -eu",
    ...rows.map(r => `open ${shellQuote(r.url)}`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(openOut), sh, { mode: 0o755 });
  fs.chmodSync(outputPath(openOut), 0o755);

  if (opts.open) {
    for (const row of rows) childProcess.spawnSync("open", [row.url], { stdio: "ignore" });
  }

  if (opts.rotate) {
    const nextState = {
      ...state,
      watchUpdatedAt: now,
      watchCursor: nextCursor,
      watchTotalSearches: sortedRows.length,
      watchRotatedSearches: rotatedRows.length,
      watchLimit: limit
    };
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + "\n");
  }

  const summary = {
    generatedAt: now,
    searches: rows.length,
    totalSearches: sortedRows.length,
    groups: (config.facebook.groups || []).length,
    focusedGroups: focusGroupUrls.length,
    markdown: mdOut,
    html: htmlOut,
    openScript: openOut,
    opened: Boolean(opts.open),
    rotation: opts.rotate ? {
      enabled: true,
      state: path.relative(ROOT, statePath),
      cursor,
      nextCursor,
      totalSearches: sortedRows.length,
      rotatedSearches: rotatedRows.length
    } : { enabled: false }
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function generateBookmarklet(opts) {
  const source = fs.readFileSync(outputPath("monitoring/facebook-capture-snippet.js"), "utf8").trim();
  const href = `javascript:${encodeURIComponent(source)}`;
  const out = opts.out || "monitoring/facebook-capture-bookmarklet.html";
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Housing Capture Bookmarklet</title>
<style>
body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;margin:28px;max-width:880px;color:#111}
a.bookmarklet{display:inline-block;background:#0866ff;color:white;text-decoration:none;font-weight:700;padding:10px 14px;border-radius:8px}
textarea{width:100%;height:150px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<h1>Facebook Housing Capture Bookmarklet</h1>
<p>Drag this button to the browser bookmarks bar. On Facebook group lists, group searches, post searches, or Marketplace results pages, click it to copy visible group links and housing-like posts as JSON.</p>
<p><a class="bookmarklet" href="${href}">Capture FB Housing</a></p>
<p>If dragging does not work, create a new bookmark named <code>Capture FB Housing</code> and paste this URL:</p>
<textarea readonly>${escapeHtml(href)}</textarea>
`;
  fs.writeFileSync(outputPath(out), html);
  console.log(JSON.stringify({ out, bytes: html.length }, null, 2));
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function readCaptureInput(args, opts) {
  if (opts["from-clipboard"]) {
    const result = childProcess.spawnSync("pbpaste", { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error("Could not read clipboard with pbpaste.");
    }
    return result.stdout;
  }
  const first = args[0];
  if (!first || first === "-") return readStdin();
  return fs.readFileSync(path.resolve(process.cwd(), first), "utf8");
}

function resolveFsPath(file) {
  const value = String(file || "");
  if (value === "~") return process.env.HOME || value;
  if (value.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function normalizeCapturePayload(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Capture input is empty.");
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.posts || parsed.items || [parsed];
    return rows.map((row, i) => ({
      capturedAt: row.capturedAt || new Date().toISOString(),
      pageTitle: row.pageTitle || row.group || "",
      pageUrl: row.pageUrl || "",
      url: row.url || "",
      links: Array.isArray(row.links) ? row.links : [],
      images: Array.isArray(row.images) ? row.images : [],
      sourceKind: row.sourceKind || "",
      text: cleanText(row.text || row.body || row.content || "")
    })).filter(row => row.text);
  } catch {
    return [{
      capturedAt: new Date().toISOString(),
      pageTitle: "",
      pageUrl: "",
      url: "",
      links: [],
      images: [],
      sourceKind: "",
      text: cleanText(text)
    }];
  }
}

function extractGroupUrls(text) {
  const urls = new Set();
  for (const match of String(text || "").matchAll(/https?:\/\/(?:www\.)?facebook\.com\/groups\/[A-Za-z0-9._-]+\/?/gi)) {
    urls.add(canonicalGroupUrl(match[0]));
  }
  for (const match of String(text || "").matchAll(/facebook\.com\/groups\/([A-Za-z0-9._-]+)/gi)) {
    urls.add(canonicalGroupUrl(`https://www.facebook.com/groups/${match[1]}`));
  }
  return [...urls];
}

function normalizeGroupName(name, url) {
  const cleaned = cleanText(String(name || "").replace(/\s+/g, " "));
  return cleaned && cleaned.length <= 140 ? cleaned : inferGroupName(url);
}

function isHousingGroup(entry) {
  if (entry.housingLike === true) return true;
  if (entry.housingLike === false) return false;
  return GROUP_HOUSING_PATTERN.test(`${entry.name || ""}\n${entry.url || ""}\n${entry.notes || ""}`);
}

function extractGroupEntries(raw, opts = {}) {
  const text = String(raw || "");
  const entries = [];
  try {
    const parsed = JSON.parse(text);
    const groupRows = Array.isArray(parsed)
      ? parsed.filter(row => row && (row.sourceKind === "group" || row.groupUrl || row.url))
      : parsed.groups || parsed.groupUrls || [];
    for (const row of groupRows) {
      const entry = typeof row === "string" ? { url: row } : row;
      const url = canonicalGroupUrl(entry.url || entry.groupUrl || "");
      if (!url) continue;
      entries.push({
        name: normalizeGroupName(entry.name || entry.title || entry.label, url),
        url,
        priority: entry.priority || opts.priority || "normal",
        notes: entry.notes || (entry.pageTitle ? `Captured from ${entry.pageTitle}` : "Imported via facebook-monitor groups"),
        housingLike: isHousingGroup({ ...entry, url })
      });
    }
  } catch {
    // Fall through to URL extraction below.
  }
  for (const url of extractGroupUrls(text)) {
    entries.push({
      name: inferGroupName(url),
      url,
      priority: opts.priority || "normal",
      notes: "Imported via facebook-monitor groups",
      housingLike: isHousingGroup({ url })
    });
  }
  const seen = new Set();
  return entries.filter(entry => {
    if (!entry.url || seen.has(entry.url)) return false;
    seen.add(entry.url);
    return !opts["housing-only"] || isHousingGroup(entry);
  });
}

function inferGroupName(url) {
  const id = url.replace(/\/+$/, "").split("/").pop() || "Facebook group";
  return id
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim() || "Facebook group";
}

function runGroups(args, opts) {
  const raw = readCaptureInput(args, opts);
  const entries = extractGroupEntries(raw, opts);
  const result = importGroupEntries(entries, {
    ...opts,
    out: opts.out || opts["groups-out"]
  });
  console.log(JSON.stringify(result, null, 2));
}

function importGroupEntries(entries, opts) {
  const outFile = outputPath(opts.out || opts["groups-out"] || "monitoring/facebook-groups.local.json");
  if (!entries.length) {
    console.error("No matching facebook.com/groups/... entries found.");
    process.exit(1);
  }
  const existing = readJsonIfExists(outFile, { groups: [] });
  const groups = normalizeGroups(existing.groupUrls)
    .concat(normalizeGroups(existing.groups))
    .map(group => ({
      ...group,
      url: canonicalGroupUrl(group.url)
    }));
  const seen = new Set(groups.map(group => group.url));
  const added = [];
  for (const entry of entries) {
    if (seen.has(entry.url)) continue;
    const group = {
      name: entry.name || inferGroupName(entry.url),
      url: entry.url,
      priority: entry.priority || opts.priority || "normal",
      notes: entry.notes || "Imported via facebook-monitor groups"
    };
    groups.push(group);
    added.push(group);
    seen.add(entry.url);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ groups }, null, 2) + "\n");
  return {
    out: path.relative(ROOT, outFile),
    added: added.length,
    total: groups.length,
    housingOnly: Boolean(opts["housing-only"]),
    matched: entries.length,
    groups: added
  };
}

function slug(value) {
  return String(value || "facebook-capture")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "facebook-capture";
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "Z");
}

function runInbox(args, opts) {
  const rows = normalizeCapturePayload(readCaptureInput(args, opts));
  const result = writeInboxRows(rows, opts);
  console.log(JSON.stringify(result, null, 2));
}

function writeInboxRows(rows, opts) {
  const outDir = outputPath(opts["out-dir"] || "monitoring/facebook-inbox");
  fs.mkdirSync(outDir, { recursive: true });
  const name = slug(opts.name || rows[0]?.pageTitle || rows[0]?.sourceKind || "facebook-capture");
  const out = path.join(outDir, `${timestampForFile()}-${name}.json`);
  fs.writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
  return {
    saved: path.relative(ROOT, out),
    posts: rows.length,
    sourceName: name
  };
}

function inboxFiles(dir) {
  const root = outputPath(dir || "monitoring/facebook-inbox");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => /\.(json|txt)$/i.test(name))
    .map(name => path.join(root, name))
    .sort();
}

function downloadCaptureFiles(opts = {}) {
  const downloadsDir = resolveFsPath(opts["downloads-dir"] || path.join(process.env.HOME || ".", "Downloads"));
  if (!fs.existsSync(downloadsDir)) return { downloadsDir, files: [] };
  const files = fs.readdirSync(downloadsDir)
    .filter(name => /^fb-housing-capture-.+\.json$/i.test(name))
    .map(name => path.join(downloadsDir, name))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  return { downloadsDir, files };
}

function runDownloads(opts = {}) {
  const { downloadsDir, files } = downloadCaptureFiles(opts);
  const statePath = outputPath(opts.state || DEFAULT_STATE_PATH);
  const state = readJsonIfExists(statePath, { seenHashes: [], importedDownloadHashes: [] });
  const importedHashes = new Set(state.importedDownloadHashes || []);
  const imported = [];
  const skipped = [];
  const groupImports = [];
  let postCount = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const hash = crypto.createHash("sha1").update(raw).digest("hex");
    if (importedHashes.has(hash) && !opts.all) {
      skipped.push({ file: path.relative(downloadsDir, file), reason: "already-imported" });
      continue;
    }

    const rows = normalizeCapturePayload(raw);
    const record = {
      file: path.relative(downloadsDir, file),
      hash,
      posts: rows.length,
      inbox: null,
      groups: null
    };
    if (rows.length) {
      record.inbox = writeInboxRows(rows, {
        ...opts,
        name: opts.name || path.basename(file, ".json")
      });
      postCount += rows.length;
    }
    if (opts.groups) {
      const entries = extractGroupEntries(raw, opts);
      if (entries.length) {
        record.groups = importGroupEntries(entries, {
          ...opts,
          out: opts["groups-out"]
        });
        groupImports.push(record.groups);
      }
    }

    imported.push(record);
    importedHashes.add(hash);
  }

  const nextState = {
    ...state,
    importedDownloadHashes: [...importedHashes].sort(),
    downloadImportsUpdatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + "\n");

  console.log(JSON.stringify({
    downloadsDir,
    scanned: files.length,
    imported: imported.length,
    skipped: skipped.length,
    posts: postCount,
    groupFilesImported: groupImports.length,
    state: path.relative(ROOT, statePath),
    inboxDir: opts["out-dir"] || "monitoring/facebook-inbox",
    groupsOut: opts["groups-out"] || "monitoring/facebook-groups.local.json",
    imports: imported,
    skippedFiles: skipped
  }, null, 2));
}

function captureTimestamp(post, file) {
  const parsed = Date.parse(post.capturedAt || "");
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return null;
  }
}

function postGroupUrl(post) {
  const candidates = [post.pageUrl, post.url, ...(post.links || [])];
  for (const candidate of candidates) {
    if (!/facebook\.com\/groups\//i.test(String(candidate || ""))) continue;
    const url = canonicalGroupUrl(candidate);
    if (url) return url;
  }
  return "";
}

function groupCaptureCoverage(config = loadConfig(), opts = {}) {
  const staleHours = Number(opts["stale-hours"] || opts.staleHours || 24);
  const parsedNow = opts.now ? Date.parse(opts.now) : NaN;
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const groups = config.facebook.groups || [];
  const byUrl = new Map(groups.map(group => [group.url, {
    name: group.name,
    url: group.url,
    priority: group.priority || "normal",
    captureCount: 0,
    lastCapturedAt: null,
    lastSourceFile: null
  }]));

  for (const file of inboxFiles(opts.inbox)) {
    for (const post of parseCaptureFile(file)) {
      const groupUrl = postGroupUrl(post);
      const row = byUrl.get(groupUrl);
      if (!row) continue;
      row.captureCount += 1;
      const capturedAt = captureTimestamp(post, file);
      if (capturedAt && (!row.lastCapturedAt || Date.parse(capturedAt) > Date.parse(row.lastCapturedAt))) {
        row.lastCapturedAt = capturedAt;
        row.lastSourceFile = path.relative(ROOT, file);
      }
    }
  }

  const rows = [...byUrl.values()].map(row => {
    const ageHours = row.lastCapturedAt ? Math.max(0, (now - Date.parse(row.lastCapturedAt)) / 36e5) : null;
    const status = row.captureCount === 0 ? "never" : ageHours > staleHours ? "stale" : "fresh";
    return {
      ...row,
      status,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10
    };
  }).sort((a, b) => {
    const statusRank = { never: 0, stale: 1, fresh: 2 };
    return (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3)
      || (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
      || a.name.localeCompare(b.name);
  });

  return {
    staleHours,
    totalGroups: rows.length,
    freshGroups: rows.filter(row => row.status === "fresh").length,
    staleGroups: rows.filter(row => row.status === "stale").length,
    neverCapturedGroups: rows.filter(row => row.status === "never").length,
    groups: rows
  };
}

function runScan(opts) {
  const files = inboxFiles(opts.inbox);
  const scoreOpts = {
    ...opts,
    out: opts.out || DEFAULT_CANDIDATES_PATH,
    snippets: opts.snippets || "monitoring/facebook-candidates.generated.js",
    review: opts.review || "monitoring/facebook-review.html",
    state: opts.state || "monitoring/facebook-monitor-state.json"
  };
  if (!opts.all) scoreOpts["new-only"] = true;
  runScore(files, scoreOpts);
  if (opts.open) childProcess.spawnSync("open", [outputPath(scoreOpts.review)], { stdio: "ignore" });
}

function countStatuses(candidates) {
  const counts = { pass: 0, verify: 0, review: 0, reject: 0, duplicate: 0 };
  for (const candidate of candidates) {
    counts[candidate.status] = (counts[candidate.status] || 0) + 1;
  }
  return counts;
}

function relativeOut(file) {
  return path.relative(ROOT, outputPath(file));
}

function monitorSnapshot(config = loadConfig(), opts = {}) {
  const inboxDir = opts.inbox || "monitoring/facebook-inbox";
  const files = inboxFiles(inboxDir);
  const candidatesFile = opts.candidates || DEFAULT_CANDIDATES_PATH;
  const candidatesPath = outputPath(candidatesFile);
  const statePath = outputPath(opts.state || DEFAULT_STATE_PATH);
  const state = readJsonIfExists(statePath, { seenHashes: [] });
  const watchRows = generateSearches(config);
  const candidates = fs.existsSync(candidatesPath) ? readJson(candidatesPath) : [];
  const coverage = groupCaptureCoverage(config, opts);
  return {
    groups: config.facebook.groups.length,
    groupNames: config.facebook.groups.map(group => group.name),
    baselineSearches: (config.facebook.searchTerms || []).length * 2,
    totalWatchSearches: watchRows.length,
    inboxFiles: files.length,
    candidates: candidates.length,
    candidateStatus: countStatuses(candidates),
    seenHashes: (state.seenHashes || []).length,
    watchCursor: state.watchCursor || 0,
    watchTotalSearches: state.watchTotalSearches || watchRows.length,
    watchRotatedSearches: state.watchRotatedSearches || null,
    watchLimit: state.watchLimit || null,
    watchUpdatedAt: state.watchUpdatedAt || null,
    groupCoverage: {
      staleHours: coverage.staleHours,
      freshGroups: coverage.freshGroups,
      staleGroups: coverage.staleGroups,
      neverCapturedGroups: coverage.neverCapturedGroups,
      needsCapture: coverage.groups.filter(group => group.status !== "fresh").slice(0, 12)
    },
    cadenceHours: config.facebook.scanCadenceHours || 6
  };
}

function runStatus(opts = {}) {
  console.log(JSON.stringify(monitorSnapshot(loadConfig(), opts), null, 2));
}

function runCoverage(opts = {}) {
  console.log(JSON.stringify(groupCaptureCoverage(loadConfig(), opts), null, 2));
}

function runNext(opts) {
  const config = loadConfig();
  const out = opts.out || "monitoring/facebook-next.md";
  const rotate = !opts["no-rotate"];
  const coverage = groupCaptureCoverage(config, opts);
  const staleRows = coverage.groups.filter(group => group.status !== "fresh");
  const focusRows = opts["no-focus-stale"] ? [] : staleRows;
  const watch = generateWatchBatch(config, {
    out: opts.watch || "monitoring/facebook-watch.md",
    html: opts.html || "monitoring/facebook-watch.html",
    script: opts.script || "monitoring/facebook-open-watch.sh",
    limit: opts.limit || 40,
    state: opts.state || DEFAULT_STATE_PATH,
    focusGroupUrls: focusRows.map(group => group.url),
    rotate,
    quiet: true
  });
  const snapshot = monitorSnapshot(config, opts);
  const generatedAt = new Date().toISOString();
  const groupLines = config.facebook.groups.length
    ? config.facebook.groups.map(group => `- ${group.name} (${group.priority || "normal"}): ${group.url}`)
    : [
      "- No private groups configured yet.",
      "- Paste copied group links into the local group list: `pbpaste | node scripts/facebook-monitor.mjs groups - --priority high`"
    ];
  const commands = {
    nextRun: "node scripts/facebook-monitor.mjs next --limit 40 --open",
    importGroups: "pbpaste | node scripts/facebook-monitor.mjs groups - --priority high",
    coverage: "node scripts/facebook-monitor.mjs coverage",
    captureInbox: "pbpaste | node scripts/facebook-monitor.mjs inbox - --name <group-or-search-name>",
    scan: "node scripts/facebook-monitor.mjs scan --open",
    markSeen: "node scripts/facebook-monitor.mjs scan --update-state",
    publishPreview: "node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash>",
    publishApply: "node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash> --apply"
  };
  const counts = snapshot.candidateStatus;
  const freshnessLines = !coverage.groups.length
    ? ["- No groups configured yet."]
    : staleRows.length
      ? staleRows.slice(0, 12).map(group =>
        `- ${group.status}: ${group.name} (${group.priority})${group.lastCapturedAt ? ` · last ${group.lastCapturedAt}` : ""}`
      )
      : ["- All configured groups are fresh."];
  const md = [
    "# Facebook Housing Monitor Next Run",
    "",
    `Generated: ${generatedAt}`,
    `Cadence target: every ${snapshot.cadenceHours} hours`,
    `Bedroom budget gate: $2,500 per bedroom`,
    "",
    "## Coverage",
    "",
    `Configured private groups: ${snapshot.groups}`,
    `Watch searches this run: ${watch.searches} of ${watch.totalSearches}`,
    `Rotation: ${watch.rotation.enabled ? `cursor ${watch.rotation.cursor} -> ${watch.rotation.nextCursor}` : "off"}`,
    `Focused stale/never groups: ${watch.focusedGroups}`,
    "",
    ...groupLines,
    "",
    "## Current Queue",
    "",
    `Inbox capture files: ${snapshot.inboxFiles}`,
    `Candidates: ${snapshot.candidates}`,
    `Candidate status counts: pass ${counts.pass || 0}, verify ${counts.verify || 0}, review ${counts.review || 0}, reject ${counts.reject || 0}, duplicate ${counts.duplicate || 0}`,
    `Seen post hashes: ${snapshot.seenHashes}`,
    "",
    "## Group Freshness",
    "",
    `Fresh groups: ${coverage.freshGroups}`,
    `Stale groups: ${coverage.staleGroups}`,
    `Never captured groups: ${coverage.neverCapturedGroups}`,
    `Stale threshold: ${coverage.staleHours} hours`,
    "",
    ...freshnessLines,
    "",
    "## Files",
    "",
    `Watch page: ${relativeOut(watch.html || "monitoring/facebook-watch.html")}`,
    `Watch markdown: ${relativeOut(watch.markdown)}`,
    `Open script: ${relativeOut(watch.openScript)}`,
    `Review page: ${relativeOut("monitoring/facebook-review.html")}`,
    "",
    "## Next Commands",
    "",
    "```sh",
    commands.nextRun,
    commands.importGroups,
    commands.coverage,
    `open ${shellQuote(outputPath(watch.html || "monitoring/facebook-watch.html"))}`,
    commands.captureInbox,
    commands.scan,
    commands.markSeen,
    commands.publishPreview,
    commands.publishApply,
    "```",
    "",
    "Private Facebook group posts still need a logged-in browser session. This monitor only organizes the watch/capture/review loop."
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(out), md);
  if (opts.open) childProcess.spawnSync("open", [outputPath(watch.html || "monitoring/facebook-watch.html")], { stdio: "ignore" });
  console.log(JSON.stringify({
    out: relativeOut(out),
    watchHtml: relativeOut(watch.html || "monitoring/facebook-watch.html"),
    openScript: relativeOut(watch.openScript),
    groups: snapshot.groups,
    searches: watch.searches,
    totalSearches: watch.totalSearches,
    rotation: watch.rotation,
    focusedGroups: watch.focusedGroups,
    inboxFiles: snapshot.inboxFiles,
    candidates: snapshot.candidates,
    candidateStatus: snapshot.candidateStatus,
    groupCoverage: {
      freshGroups: coverage.freshGroups,
      staleGroups: coverage.staleGroups,
      neverCapturedGroups: coverage.neverCapturedGroups
    },
    commands
  }, null, 2));
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
    sourceKind: item.sourceKind || "",
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
    sourceKind: post.sourceKind,
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

function generateReviewHtml(candidates, opts) {
  const out = opts.review || "monitoring/facebook-review.html";
  const generatedAt = new Date().toISOString();
  const candidateFile = opts.out || DEFAULT_CANDIDATES_PATH;
  const rows = candidates.map(c => {
    const shortHash = c.textHash.slice(0, 10);
    const publishable = c.status === "pass" || c.status === "verify";
    const publishCommand = `node scripts/facebook-monitor.mjs publish ${candidateFile} --select ${shortHash}`;
    return `<article class="card ${escapeHtml(c.status)}">
  <header>
    ${publishable ? `<label class="pick"><input type="checkbox" data-hash="${escapeHtml(shortHash)}"> select</label>` : ""}
    <strong>${escapeHtml(c.status.toUpperCase())}</strong>
    <span>score ${escapeHtml(c.score)}</span>
    <span>${escapeHtml(priceLabel(c.price))}</span>
    <span>${escapeHtml(ppbLabel(c.pricePerBedroom))}</span>
  </header>
  <h2>${escapeHtml(c.location)}</h2>
  <p>${escapeHtml(c.summary)}</p>
  <dl>
    <dt>Handle</dt><dd><code>${escapeHtml(c.handle)}</code></dd>
    <dt>Hash</dt><dd><code>${escapeHtml(c.textHash.slice(0, 12))}</code></dd>
    <dt>Beds/Baths/Sqft</dt><dd>${escapeHtml(c.bedrooms ?? "?")} / ${escapeHtml(c.bathrooms ?? "?")} / ${escapeHtml(c.sqft ?? "?")}</dd>
    <dt>Signals</dt><dd>${escapeHtml(c.signals.join(", ") || "none")}</dd>
    <dt>Seen Before</dt><dd>${c.seenBefore ? "yes" : "no"}</dd>
  </dl>
  <p class="actions">${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">open lead</a>` : ""}${c.pageUrl ? `<a href="${escapeHtml(c.pageUrl)}" target="_blank" rel="noopener">source page</a>` : ""}</p>
  <label>Publish command</label>
  <input readonly value="${escapeHtml(publishCommand)}">
</article>`;
  }).join("\n");
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Housing Candidate Review</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111;background:#f7f7f7}
h1{margin:0 0 4px}.meta{color:#555;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.toolbar{position:sticky;top:0;z-index:2;background:#ffffffe8;border:1px solid #ddd;border-radius:8px;padding:10px;margin:0 0 16px;box-shadow:0 2px 8px #0001;display:grid;grid-template-columns:auto auto auto 1fr auto;gap:8px;align-items:center;backdrop-filter:blur(8px)}
.toolbar button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:7px 10px;cursor:pointer}.toolbar label{color:#555}
.card{background:white;border:1px solid #ddd;border-left:7px solid #999;border-radius:8px;padding:14px;box-shadow:0 1px 3px #0001}
.pass{border-left-color:#179b55}.verify{border-left-color:#c47f17}.reject{opacity:.72;border-left-color:#cc3333}.duplicate{opacity:.65;border-left-color:#777}
header{display:flex;flex-wrap:wrap;gap:8px;color:#555}.pick{color:#111;font-weight:600}header strong{color:#111}h2{font-size:17px;margin:10px 0 8px}p{line-height:1.45}dl{display:grid;grid-template-columns:90px 1fr;gap:5px;margin:12px 0}dt{color:#666}dd{margin:0}code,input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}input{width:100%;padding:7px;border:1px solid #ccc;border-radius:5px}.actions{display:flex;gap:10px}.actions a{color:#06c}
@media(max-width:720px){.toolbar{grid-template-columns:1fr 1fr}.toolbar input,.toolbar label{grid-column:1/-1}}
</style>
<h1>Facebook Housing Candidate Review</h1>
<div class="meta">Generated ${escapeHtml(generatedAt)} · ${candidates.length} candidates</div>
<section class="toolbar">
  <button type="button" id="selectPass">Select pass</button>
  <button type="button" id="clearPicks">Clear</button>
  <span id="pickedCount">0 selected</span>
  <label>Batch publish command</label>
  <input id="batchCommand" readonly value="">
  <button type="button" id="copyBatch">Copy command</button>
</section>
<main class="grid">
${rows || "<p>No candidates.</p>"}
</main>
<script>
const candidateFile=${js(candidateFile)};
const picks=[...document.querySelectorAll('input[data-hash]')];
const count=document.getElementById('pickedCount');
const batch=document.getElementById('batchCommand');
function updateBatch(){
  const selected=picks.filter(p=>p.checked).map(p=>p.dataset.hash);
  count.textContent=selected.length+" selected";
  batch.value=selected.length ? "node scripts/facebook-monitor.mjs publish "+candidateFile+" --select "+selected.join(",") : "";
}
picks.forEach(p=>p.addEventListener('change',updateBatch));
document.getElementById('selectPass').addEventListener('click',()=>{picks.forEach(p=>{if(p.closest('.pass')) p.checked=true});updateBatch();});
document.getElementById('clearPicks').addEventListener('click',()=>{picks.forEach(p=>p.checked=false);updateBatch();});
document.getElementById('copyBatch').addEventListener('click',()=>{if(batch.value) navigator.clipboard.writeText(batch.value);});
updateBatch();
</script>
`;
  fs.writeFileSync(outputPath(out), html);
  return out;
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
  const statePath = opts.state ? outputPath(opts.state) : null;
  const state = statePath ? readJsonIfExists(statePath, { seenHashes: [] }) : { seenHashes: [] };
  const seenBefore = new Set(state.seenHashes || []);
  const posts = files.flatMap(parseCaptureFile);
  const seen = new Set();
  let candidates = posts
    .map(post => scorePost(post, config, existing))
    .map(c => ({ ...c, seenBefore: seenBefore.has(c.textHash) }))
    .filter(c => {
      if (seen.has(c.textHash)) return false;
      seen.add(c.textHash);
      return true;
    })
    .sort((a, b) => b.score - a.score);
  if (opts["new-only"]) candidates = candidates.filter(c => !c.seenBefore);

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

  const review = opts.review ? generateReviewHtml(candidates, opts) : null;

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
    seenBefore: candidates.filter(c => c.seenBefore).length,
    pass: candidates.filter(c => c.status === "pass").length,
    verify: candidates.filter(c => c.status === "verify").length,
    rejected: candidates.filter(c => c.status === "reject").length,
    duplicate: candidates.filter(c => c.status === "duplicate").length,
    out: opts.out || null,
    snippets: opts.snippets || null,
    review,
    state: opts.state || null,
    stateUpdated: Boolean(opts["update-state"] && statePath),
    top
  }, null, 2));

  if (opts["update-state"] && statePath) {
    const next = {
      ...state,
      updatedAt: new Date().toISOString(),
      seenHashes: [...new Set([...(state.seenHashes || []), ...posts.map(post => crypto.createHash("sha1").update(post.text).digest("hex"))])].sort()
    };
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n");
  }
}

function selectCandidates(candidates, select) {
  const selectors = String(select || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (!selectors.length) return [];
  return candidates.filter(c => selectors.some(s =>
    c.handle === s ||
    c.textHash === s ||
    c.textHash.startsWith(s) ||
    c.handle.includes(s)
  ));
}

function insertSnippetsIntoIndex(indexText, snippets) {
  const marker = "\n{\n  rank:\"#2 of 100";
  const at = indexText.indexOf(marker);
  if (at === -1) {
    throw new Error("Could not find the insertion point before the non-Facebook apartment cards.");
  }
  return `${indexText.slice(0, at)}\n${snippets.join("\n")}${indexText.slice(at)}`;
}

function runPublish(file, opts) {
  if (!opts.select) {
    console.error("publish requires --select <handle-or-hash,...>");
    process.exit(1);
  }
  const candidates = readJson(path.resolve(process.cwd(), file || DEFAULT_CANDIDATES_PATH));
  const selected = selectCandidates(candidates, opts.select)
    .filter(c => c.status === "pass" || c.status === "verify");
  if (!selected.length) {
    console.error("No pass/verify candidates matched the selector.");
    process.exit(1);
  }
  const snippets = selected.map(generateSnippet);
  const indexFile = outputPath(opts.index || "index.html");
  const indexText = fs.readFileSync(indexFile, "utf8");
  const existing = loadExisting(opts.index || "index.html");
  const dupes = selected.filter(c => existing.handles.has(c.handle) || (c.url && existing.urls.has(c.url)));
  if (dupes.length) {
    console.error(`Refusing to publish duplicates: ${dupes.map(c => c.handle).join(", ")}`);
    process.exit(1);
  }

  if (opts.apply) {
    fs.writeFileSync(indexFile, insertSnippetsIntoIndex(indexText, snippets));
  }

  console.log(JSON.stringify({
    selected: selected.map(c => ({ handle: c.handle, status: c.status, score: c.score, price: priceLabel(c.price), ppb: ppbLabel(c.pricePerBedroom) })),
    applied: Boolean(opts.apply),
    index: opts.index || "index.html",
    snippets: snippets.join("\n")
  }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const { args, opts } = parseArgs(rest);

if (!cmd || cmd === "help") {
  usage();
} else if (cmd === "searches") {
  writeSearches(generateSearches(loadConfig()), opts);
} else if (cmd === "watch") {
  generateWatchBatch(loadConfig(), opts);
} else if (cmd === "bookmarklet") {
  generateBookmarklet(opts);
} else if (cmd === "groups") {
  try {
    runGroups(args, opts);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
} else if (cmd === "status") {
  runStatus(opts);
} else if (cmd === "coverage") {
  runCoverage(opts);
} else if (cmd === "next") {
  runNext(opts);
} else if (cmd === "downloads") {
  runDownloads(opts);
} else if (cmd === "inbox") {
  try {
    runInbox(args, opts);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
} else if (cmd === "score") {
  if (!args.length) {
    usage();
    process.exit(1);
  }
  runScore(args.map(file => path.resolve(process.cwd(), file)), opts);
} else if (cmd === "scan") {
  runScan(opts);
} else if (cmd === "publish") {
  runPublish(args[0] || DEFAULT_CANDIDATES_PATH, opts);
} else {
  usage();
  process.exit(1);
}
