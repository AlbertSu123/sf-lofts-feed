#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG_PATH = path.join(ROOT, "monitoring/facebook-monitor.config.json");
const DEFAULT_CANDIDATES_PATH = "monitoring/facebook-candidates.json";
const DEFAULT_DIGEST_PATH = "monitoring/facebook-digest.md";
const DEFAULT_COVERAGE_PATH = "monitoring/facebook-coverage.md";
const DEFAULT_COVERAGE_HTML_PATH = "monitoring/facebook-coverage.html";
const DEFAULT_GROUP_WATCH_PATH = "monitoring/facebook-group-watch.md";
const DEFAULT_GROUP_WATCH_HTML_PATH = "monitoring/facebook-group-watch.html";
const DEFAULT_GROUP_OPEN_SCRIPT_PATH = "monitoring/facebook-open-groups.sh";
const DEFAULT_STATE_PATH = "monitoring/facebook-monitor-state.json";
const DEFAULT_GROUP_SEEDS_PATH = "monitoring/facebook-group-seeds.json";
const DEFAULT_GROUP_STATUS_PATH = "monitoring/facebook-group-status.local.json";
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const SKIPPED_GROUP_STATUSES = new Set(["skip", "skipped", "inaccessible", "dead", "noisy"]);
const GROUP_HOUSING_PATTERN = /housing|apartment|apartments|apt\b|room|roommate|roommates|sublet|sublease|lease|rent|rental|loft|live.?work/i;
const DEFAULT_GROUP_DISCOVERY_TERMS = [
  "San Francisco housing",
  "SF housing",
  "San Francisco apartments",
  "SF apartments",
  "Bay Area housing",
  "Bay Area apartments",
  "San Francisco sublet",
  "SF sublet",
  "San Francisco roommates",
  "SF lease takeover",
  "San Francisco loft",
  "live work loft San Francisco"
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonIfExists(file, fallback) {
  return fs.existsSync(file) ? readJson(file) : fallback;
}

function loadConfig(opts = {}) {
  const config = readJson(CONFIG_PATH);
  const localGroupsPath = outputPath(opts["groups-out"] || opts["groups-file"] || config.facebook.localGroupsFile || "monitoring/facebook-groups.local.json");
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
  const groupsWithStatus = applyGroupStatuses(groupList, config, opts);
  return {
    ...config,
    facebook: {
      ...config.facebook,
      groupUrls: groupsWithStatus.map(group => group.url),
      groups: groupsWithStatus,
      includeSkippedGroups: Boolean(opts["include-skipped-groups"]),
      groupStatusFile: opts["group-status"] || opts["group-status-file"] || config.facebook.groupStatusFile || DEFAULT_GROUP_STATUS_PATH
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

function groupStatusFile(config = readJson(CONFIG_PATH), opts = {}) {
  return outputPath(opts["group-status"] || opts["group-status-file"] || config.facebook?.groupStatusFile || DEFAULT_GROUP_STATUS_PATH);
}

function shouldWatchStatus(status) {
  return !SKIPPED_GROUP_STATUSES.has(String(status || "").toLowerCase());
}

function parseWatchValue(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !/^(false|0|no|off|skip)$/i.test(String(value));
}

function normalizeGroupStatusRows(input) {
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input?.groups) ? input.groups
      : Array.isArray(input?.statuses) ? input.statuses
        : [];
  return rows
    .filter(row => row && (row.url || row.groupUrl))
    .map(row => {
      const status = String(row.status || row.accessStatus || "unverified").toLowerCase();
      return {
        name: row.name || "",
        url: canonicalGroupUrl(row.url || row.groupUrl),
        status,
        watch: parseWatchValue(row.watch, shouldWatchStatus(status)),
        priority: row.priority || null,
        quality: row.quality || "",
        notes: row.notes || "",
        checkedAt: row.checkedAt || row.updatedAt || ""
      };
    })
    .filter(row => row.url);
}

function readGroupStatusMap(config, opts = {}) {
  const file = groupStatusFile(config, opts);
  const rows = normalizeGroupStatusRows(readJsonIfExists(file, { groups: [] }));
  return new Map(rows.map(row => [row.url, row]));
}

function applyGroupStatuses(groups, config, opts = {}) {
  const statusMap = readGroupStatusMap(config, opts);
  return groups.map(group => {
    const row = statusMap.get(group.url);
    const accessStatus = row?.status || "unverified";
    return {
      ...group,
      priority: row?.priority || group.priority || "normal",
      accessStatus,
      watch: row ? row.watch : true,
      quality: row?.quality || "",
      statusNotes: row?.notes || "",
      accessCheckedAt: row?.checkedAt || ""
    };
  });
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
  node scripts/facebook-monitor.mjs setup [--limit 40] [--open] [--rotate] [--bookmarklet monitoring/facebook-capture-bookmarklet.html] [--discovery monitoring/facebook-discovery.md] [--discovery-html monitoring/facebook-discovery.html]
  node scripts/facebook-monitor.mjs discover [--out monitoring/facebook-discovery.md] [--html monitoring/facebook-discovery.html] [--script monitoring/facebook-open-discovery.sh] [--open] [--terms "SF housing,SF apartments"]
  node scripts/facebook-monitor.mjs watch [--out monitoring/facebook-watch.md] [--html monitoring/facebook-watch.html] [--open] [--open-links] [--limit 24] [--rotate] [--state monitoring/facebook-monitor-state.json]
  node scripts/facebook-monitor.mjs group-watch [--out monitoring/facebook-group-watch.md] [--html monitoring/facebook-group-watch.html] [--script monitoring/facebook-open-groups.sh] [--open] [--open-links] [--limit 40]
  node scripts/facebook-monitor.mjs bookmarklet [--out monitoring/facebook-capture-bookmarklet.html]
  node scripts/facebook-monitor.mjs seed-groups [--seeds monitoring/facebook-group-seeds.json] [--out monitoring/facebook-groups.local.json]
  node scripts/facebook-monitor.mjs groups [group-urls.txt|-] [--from-clipboard] [--priority high|normal|low] [--housing-only] [--out monitoring/facebook-groups.local.json]
  node scripts/facebook-monitor.mjs group-status [group-url-or-name] [--list] [--status joined|pending|inaccessible|noisy|skip|unverified] [--watch true|false] [--quality good|ok|low] [--priority high|normal|low] [--notes "..."] [--group-status monitoring/facebook-group-status.local.json]
  node scripts/facebook-monitor.mjs status
  node scripts/facebook-monitor.mjs doctor [--downloads-dir ~/Downloads] [--state monitoring/facebook-monitor-state.json] [--candidates monitoring/facebook-candidates.json] [--inbox monitoring/facebook-inbox]
  node scripts/facebook-monitor.mjs coverage [--inbox monitoring/facebook-inbox] [--stale-hours 24] [--out monitoring/facebook-coverage.md] [--html monitoring/facebook-coverage.html]
  node scripts/facebook-monitor.mjs run [--downloads-dir ~/Downloads] [--limit 40] [--out monitoring/facebook-candidates.json] [--snippets monitoring/facebook-candidates.generated.js] [--digest monitoring/facebook-digest.md] [--coverage monitoring/facebook-coverage.md] [--coverage-html monitoring/facebook-coverage.html] [--group-watch monitoring/facebook-group-watch.md] [--group-watch-html monitoring/facebook-group-watch.html] [--next monitoring/facebook-next.md] [--watch monitoring/facebook-watch.md] [--html monitoring/facebook-watch.html] [--review monitoring/facebook-review.html] [--discovery monitoring/facebook-discovery.md] [--discovery-html monitoring/facebook-discovery.html] [--open] [--open-watch] [--open-group-watch] [--open-links] [--open-review] [--open-discovery] [--no-downloads] [--no-groups] [--no-housing-only] [--no-discovery] [--all] [--state monitoring/facebook-monitor-state.json]
  node scripts/facebook-monitor.mjs next [--out monitoring/facebook-next.md] [--watch monitoring/facebook-watch.md] [--html monitoring/facebook-watch.html] [--script monitoring/facebook-open-watch.sh] [--group-watch monitoring/facebook-group-watch.md] [--group-watch-html monitoring/facebook-group-watch.html] [--group-watch-script monitoring/facebook-open-groups.sh] [--limit 40] [--group-limit 40] [--open] [--open-group-watch] [--open-links] [--no-rotate] [--no-focus-stale] [--state monitoring/facebook-monitor-state.json]
  node scripts/facebook-monitor.mjs downloads [--downloads-dir ~/Downloads] [--out-dir monitoring/facebook-inbox] [--groups] [--housing-only] [--groups-out monitoring/facebook-groups.local.json] [--state monitoring/facebook-monitor-state.json] [--all]
  node scripts/facebook-monitor.mjs inbox [capture.json|-] [--from-clipboard] [--name source-name] [--out-dir monitoring/facebook-inbox]
  node scripts/facebook-monitor.mjs score <capture.json|capture.txt...> [--out monitoring/facebook-candidates.json] [--snippets monitoring/facebook-candidates.generated.js] [--review monitoring/facebook-review.html] [--digest monitoring/facebook-digest.md] [--state monitoring/facebook-monitor-state.json] [--new-only] [--update-state]
  node scripts/facebook-monitor.mjs scan [--inbox monitoring/facebook-inbox] [--digest monitoring/facebook-digest.md] [--open] [--all] [--update-state]
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

function groupDirectorySearchUrl(term) {
  return `https://www.facebook.com/search/groups/?q=${encodeURIComponent(term)}`;
}

function canonicalGroupUrl(url) {
  const match = String(url || "").match(/facebook\.com\/groups\/([A-Za-z0-9._-]+)/i);
  return match ? `https://www.facebook.com/groups/${match[1]}` : String(url || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function facebookLeadUrlRank(url) {
  const value = String(url || "");
  if (/\/marketplace\/item\//i.test(value)) return 0;
  if (/\/groups\/[^/?#]+\/(?:posts|permalink)\//i.test(value)) return 1;
  if (/\/(?:permalink|posts)\//i.test(value) || /\/permalink\.php\b/i.test(value)) return 2;
  if (/\/share\/(?:p|r|v)\//i.test(value)) return 3;
  if (/\/photo\.php\b/i.test(value)) return 4;
  if (/\/marketplace\//i.test(value)) return 8;
  if (/\/groups\//i.test(value)) return 10;
  return 20;
}

function primaryFacebookLeadUrl(values, fallback = "") {
  const rows = (Array.isArray(values) ? values : [values])
    .concat(fallback ? [fallback] : [])
    .map((url, i) => ({ url: String(url || "").trim(), i }))
    .filter(row => /facebook\.com\//i.test(row.url))
    .filter(row => !/\/groups\/[^/?#]+\/(?:search|members|about|media|files|photos)\b/i.test(row.url))
    .sort((a, b) => facebookLeadUrlRank(a.url) - facebookLeadUrlRank(b.url) || a.i - b.i);
  return rows[0]?.url || fallback || "";
}

function discoveryTerms(opts = {}) {
  if (!opts.terms) return DEFAULT_GROUP_DISCOVERY_TERMS;
  return String(opts.terms)
    .split(",")
    .map(term => term.trim())
    .filter(Boolean);
}

function generateGroupDiscoveryRows(opts = {}) {
  const rows = [
    {
      surface: "joined",
      label: "Joined groups feed",
      term: "groups feed",
      url: "https://www.facebook.com/groups/feed/",
      priority: "high",
      action: "Run the bookmarklet here to capture visible joined group links."
    },
    {
      surface: "discover",
      label: "Groups discover",
      term: "groups discover",
      url: "https://www.facebook.com/groups/discover/",
      priority: "normal",
      action: "Run the bookmarklet after Facebook shows group suggestions."
    }
  ];
  for (const term of discoveryTerms(opts)) {
    rows.push({
      surface: "group-search",
      label: "Facebook group search",
      term,
      url: groupDirectorySearchUrl(term),
      priority: GROUP_HOUSING_PATTERN.test(term) ? "high" : "normal",
      action: "Open likely housing groups or run the bookmarklet on the search results."
    });
  }
  return rows;
}

function generateGroupDiscovery(opts = {}) {
  const rows = generateGroupDiscoveryRows(opts);
  const mdOut = opts.out || "monitoring/facebook-discovery.md";
  const htmlOut = opts.html || "monitoring/facebook-discovery.html";
  const openOut = opts.script || "monitoring/facebook-open-discovery.sh";
  const now = new Date().toISOString();
  const md = [
    "# Facebook Housing Group Discovery",
    "",
    `Generated: ${now}`,
    "",
    "Use this before the normal watch loop when `status.setupGaps` says there are no configured groups.",
    "",
    "Workflow:",
    "",
    "1. Open the discovery page while logged into Facebook.",
    "2. Click the `Capture FB Housing` bookmarklet on joined-groups and group-search pages.",
    "3. Let the downloaded `fb-housing-capture-*.json` files land in Downloads.",
    "4. Run `node scripts/facebook-monitor.mjs run --open-group-watch --open-review` to import housing-like groups and refresh the sweep/watch loop.",
    "",
    "| Priority | Surface | Term | URL | Action |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map(row => `| ${row.priority} | ${escapeMd(row.label)} | ${escapeMd(row.term)} | ${row.url} | ${escapeMd(row.action)} |`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(mdOut), md);

  if (htmlOut) {
    const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Housing Group Discovery</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;margin:24px;color:#111}
a{color:#06c} table{border-collapse:collapse;width:100%;max-width:1160px}td,th{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{background:#f6f6f6}.high{background:#fff3f3}.low{color:#666}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
</style>
<h1>Facebook Housing Group Discovery</h1>
<p>Generated ${escapeHtml(now)}. Use this when the monitor has no configured Facebook groups yet.</p>
<p>Open each link while logged into Facebook, click the <code>Capture FB Housing</code> bookmarklet, then run <code>node scripts/facebook-monitor.mjs run --open-group-watch --open-review</code>.</p>
<div class="actions">
  <a href="facebook-capture-bookmarklet.html">Open bookmarklet installer</a>
  <a href="facebook-watch.html">Open current watch batch</a>
  <a href="facebook-review.html">Open review page</a>
</div>
<table>
<thead><tr><th>Priority</th><th>Surface</th><th>Term</th><th>Action</th><th>Open</th></tr></thead>
<tbody>
${rows.map(row => `<tr class="${escapeHtml(row.priority)}"><td>${escapeHtml(row.priority)}</td><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.term)}</td><td>${escapeHtml(row.action)}</td><td><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener">open</a></td></tr>`).join("\n")}
</tbody>
</table>
`;
    fs.writeFileSync(outputPath(htmlOut), html);
  }

  const sh = [
    "#!/bin/sh",
    "set -eu",
    ...rows.map(row => `open ${shellQuote(row.url)}`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(openOut), sh, { mode: 0o755 });
  fs.chmodSync(outputPath(openOut), 0o755);

  if (opts.open) childProcess.spawnSync("open", [outputPath(htmlOut)], { stdio: "ignore" });

  const summary = {
    generatedAt: now,
    searches: rows.length,
    markdown: mdOut,
    html: htmlOut,
    openScript: openOut,
    opened: Boolean(opts.open),
    nextCommand: "node scripts/facebook-monitor.mjs run --open-group-watch --open-review"
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function generateSearches(config) {
  const terms = config.facebook.searchTerms || [];
  const city = config.facebook.cityMarketplace || "sanfrancisco";
  const rows = [];
  for (const term of terms) {
    rows.push({ surface: "posts", label: "Facebook posts", term, url: postSearchUrl(term), priority: "normal" });
    rows.push({ surface: "marketplace", label: "Marketplace", term, url: marketplaceSearchUrl(term, city), priority: "normal" });
    for (const group of config.facebook.groups || []) {
      if (group.watch === false && !config.facebook.includeSkippedGroups) continue;
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

function interleaveRowsByKey(rows, keyFn, cursor = 0) {
  const buckets = [];
  const byKey = new Map();
  for (const row of rows) {
    const key = keyFn(row) || "__default";
    if (!byKey.has(key)) {
      const bucket = { key, rows: [] };
      byKey.set(key, bucket);
      buckets.push(bucket);
    }
    byKey.get(key).rows.push(row);
  }
  for (const bucket of buckets) {
    bucket.rows = rotateRows(bucket.rows, cursor);
    bucket.index = 0;
  }
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const bucket of buckets) {
      if (bucket.index >= bucket.rows.length) continue;
      out.push(bucket.rows[bucket.index++]);
      added = true;
    }
  }
  return {
    rows: out,
    buckets: buckets.length,
    maxBucketRows: buckets.reduce((max, bucket) => Math.max(max, bucket.rows.length), 0)
  };
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
  const focusCursor = state ? Number(state.watchFocusCursor || 0) : 0;
  const focusedPlan = opts.rotate
    ? interleaveRowsByKey(focusedRows, row => row.groupUrl, focusCursor)
    : { rows: focusedRows, buckets: focusGroupUrls.length, maxBucketRows: focusedRows.length };
  const sourceRows = opts.rotate ? focusedPlan.rows.concat(rotateRows(rotatedRows, cursor)) : sortedRows;
  const rows = sourceRows.slice(0, limit);
  const selectedFocusedRows = rows.filter(isFocused).length;
  const selectedFocusedGroups = new Set(rows.filter(isFocused).map(row => row.groupUrl)).size;
  const selectedRotatedRows = rows.filter(row => !isFocused(row)).length;
  const capturePath = "monitoring/facebook-capture-snippet.js";
  const mdOut = opts.out || "monitoring/facebook-watch.md";
  const htmlOut = opts.html || (opts.open ? "monitoring/facebook-watch.html" : null);
  const openOut = opts.script || "monitoring/facebook-open-watch.sh";
  const openLinks = Boolean(opts.openLinks || opts["open-links"]);
  const now = new Date().toISOString();
  const nextCursor = rotatedRows.length ? (cursor + selectedRotatedRows) % rotatedRows.length : 0;
  const focusAdvance = selectedFocusedGroups ? Math.ceil(selectedFocusedRows / selectedFocusedGroups) : 0;
  const nextFocusCursor = focusedPlan.maxBucketRows ? (focusCursor + focusAdvance) % focusedPlan.maxBucketRows : 0;

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
    "3. Click the `Capture FB Housing` bookmarklet on the loaded page.",
    "4. Let the downloaded `fb-housing-capture-*.json` file land in Downloads.",
    "5. Run `node scripts/facebook-monitor.mjs run --open-review` to import downloads, score leads, and refresh the next batch.",
    "",
    "| Priority | Surface | Term | URL |",
    "| --- | --- | --- | --- |",
    ...rows.map(r => `| ${r.priority || "normal"} | ${escapeMd(r.label || r.surface)} | ${escapeMd(r.term)} | ${r.url} |`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(mdOut), md);

  if (htmlOut) {
    const captureRel = path.relative(path.dirname(outputPath(htmlOut)), outputPath(capturePath)).replace(/\\/g, "/");
    const captureHref = captureRel.startsWith("..") ? pathToFileURL(outputPath(capturePath)).href : captureRel;
    const bookmarkletPath = "monitoring/facebook-capture-bookmarklet.html";
    const bookmarkletRel = path.relative(path.dirname(outputPath(htmlOut)), outputPath(bookmarkletPath)).replace(/\\/g, "/");
    const bookmarkletHref = bookmarkletRel.startsWith("..") ? pathToFileURL(outputPath(bookmarkletPath)).href : bookmarkletRel;
    const reviewPath = "monitoring/facebook-review.html";
    const reviewRel = path.relative(path.dirname(outputPath(htmlOut)), outputPath(reviewPath)).replace(/\\/g, "/");
    const reviewHref = reviewRel.startsWith("..") ? pathToFileURL(outputPath(reviewPath)).href : reviewRel;
    const coveragePath = DEFAULT_COVERAGE_HTML_PATH;
    const coverageRel = path.relative(path.dirname(outputPath(htmlOut)), outputPath(coveragePath)).replace(/\\/g, "/");
    const coverageHref = coverageRel.startsWith("..") ? pathToFileURL(outputPath(coveragePath)).href : coverageRel;
    const doneKey = `sf-lofts-facebook-watch:${crypto.createHash("sha1").update(rows.map(row => row.url).join("\n")).digest("hex").slice(0, 12)}`;
    const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Watch Batch</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;margin:24px;color:#111;background:#fafafa}
a{color:#06c}.toolbar{position:sticky;top:0;z-index:3;background:#fffffff0;border:1px solid #ddd;border-radius:8px;padding:12px;margin:14px 0 16px;box-shadow:0 2px 10px #0001;backdrop-filter:blur(8px)}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:8px 0}.step{background:#f6f7f8;border:1px solid #e1e1e1;border-radius:7px;padding:10px}.step b{display:block;margin-bottom:3px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px}.progress{font-weight:700}.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid #ddd;border-radius:6px;padding:7px 9px}
button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:7px 10px;cursor:pointer}table{border-collapse:collapse;width:100%;max-width:1180px;background:#fff}td,th{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{background:#f6f6f6}.high{background:#fff3f3}.low{color:#666}.done{opacity:.45;background:#f1f5f1}.done a{text-decoration:line-through}
code,textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}textarea{width:100%;height:180px}.check{width:44px;text-align:center}
</style>
<h1>Facebook Watch Batch</h1>
<p>Generated ${escapeHtml(now)}. Work through these while logged into Facebook, then import the downloaded captures.</p>
<section class="toolbar">
  <div class="steps">
    <div class="step"><b>1. Bookmarklet</b><a href="${escapeHtml(bookmarkletHref)}">Open installer</a> or <a href="${escapeHtml(captureHref)}">open snippet</a>.</div>
    <div class="step"><b>2. Capture</b>Open a row, sort recent where possible, click <code>Capture FB Housing</code>, then check it off here.</div>
    <div class="step"><b>3. Import</b><span class="cmd">node scripts/facebook-monitor.mjs run --open-review</span></div>
    <div class="step"><b>4. Review</b><a href="${escapeHtml(reviewHref)}">Open review page</a> after imports finish.</div>
    <div class="step"><b>5. Curate</b><a href="${escapeHtml(coverageHref)}">Open coverage</a> to mark joined, noisy, or inaccessible groups.</div>
  </div>
  <div class="controls">
    <span class="progress" id="progress">0/${rows.length} captured</span>
    <button type="button" id="copyImport">Copy import command</button>
    <button type="button" id="clearDone">Clear checkoffs</button>
  </div>
</section>
<table>
<thead><tr><th class="check">Done</th><th>Priority</th><th>Surface</th><th>Term</th><th>Open</th></tr></thead>
<tbody>
${rows.map((r, i) => `<tr class="${escapeHtml(r.priority || "normal")}" data-url="${escapeHtml(r.url)}"><td class="check"><input type="checkbox" data-done="${i}"></td><td>${escapeHtml(r.priority || "normal")}</td><td>${escapeHtml(r.label || r.surface)}</td><td>${escapeHtml(r.term)}</td><td><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">open search</a></td></tr>`).join("\n")}
</tbody>
</table>
<script>
const doneKey=${js(doneKey)};
const importCommand="node scripts/facebook-monitor.mjs run --open-review";
const checks=[...document.querySelectorAll('[data-done]')];
const rows=[...document.querySelectorAll('tr[data-url]')];
const progress=document.getElementById('progress');
function readDone(){
  try{return new Set(JSON.parse(localStorage.getItem(doneKey)||"[]"))}catch{return new Set()}
}
function writeDone(done){localStorage.setItem(doneKey,JSON.stringify([...done]));}
function sync(){
  const done=readDone();
  rows.forEach((row,i)=>{
    const checked=done.has(row.dataset.url);
    row.classList.toggle('done',checked);
    checks[i].checked=checked;
  });
  progress.textContent=done.size+"/"+rows.length+" captured";
}
checks.forEach((box,i)=>box.addEventListener('change',()=>{
  const done=readDone();
  const url=rows[i].dataset.url;
  if(box.checked) done.add(url); else done.delete(url);
  writeDone(done);
  sync();
}));
document.getElementById('clearDone').addEventListener('click',()=>{localStorage.removeItem(doneKey);sync();});
document.getElementById('copyImport').addEventListener('click',()=>navigator.clipboard.writeText(importCommand));
sync();
</script>
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

  const openedPage = Boolean(opts.open && htmlOut);
  if (openedPage) childProcess.spawnSync("open", [outputPath(htmlOut)], { stdio: "ignore" });

  if (openLinks) {
    for (const row of rows) childProcess.spawnSync("open", [row.url], { stdio: "ignore" });
  }

  if (opts.rotate) {
    const nextState = {
      ...state,
      watchUpdatedAt: now,
      watchCursor: nextCursor,
      watchFocusCursor: nextFocusCursor,
      watchTotalSearches: sortedRows.length,
      watchFocusedSearches: focusedRows.length,
      watchFocusedGroups: focusedPlan.buckets,
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
    opened: openedPage || openLinks,
    openedPage,
    openedLinks: openLinks,
    rotation: opts.rotate ? {
      enabled: true,
      state: path.relative(ROOT, statePath),
      cursor,
      nextCursor,
      focusCursor,
      nextFocusCursor,
      totalSearches: sortedRows.length,
      focusedSearches: focusedRows.length,
      focusedGroups: focusedPlan.buckets,
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

function escapeAttr(value) {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function generateBookmarklet(opts) {
  const source = fs.readFileSync(outputPath("monitoring/facebook-capture-snippet.js"), "utf8").trim();
  const href = `javascript:${encodeURIComponent(source)}`;
  const deepSource = `window.__SF_LOFTS_FB_CAPTURE_OPTIONS={deep:true,scrollSteps:5};\n${source}`;
  const deepHref = `javascript:${encodeURIComponent(deepSource)}`;
  const out = opts.out || "monitoring/facebook-capture-bookmarklet.html";
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Housing Capture Bookmarklet</title>
<style>
body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;margin:28px;max-width:880px;color:#111}
a.bookmarklet{display:inline-block;background:#0866ff;color:white;text-decoration:none;font-weight:700;padding:10px 14px;border-radius:8px;margin:0 8px 8px 0}
a.deep{background:#116b42}
textarea{width:100%;height:135px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<h1>Facebook Housing Capture Bookmarklet</h1>
<p>Drag these buttons to the browser bookmarks bar. On Facebook group lists, group searches, post searches, or Marketplace results pages, click quick capture for the currently visible page, or deep capture to scroll several pagefuls before exporting.</p>
<p><a class="bookmarklet" href="${href}">Capture FB Housing</a><a class="bookmarklet deep" href="${deepHref}">Capture FB Housing Deep</a></p>
<p>If dragging does not work, create a new bookmark named <code>Capture FB Housing</code> and paste this URL:</p>
<textarea readonly>${escapeHtml(href)}</textarea>
<p>For the deeper scroll-and-capture bookmark, create one named <code>Capture FB Housing Deep</code> and paste this URL:</p>
<textarea readonly>${escapeHtml(deepHref)}</textarea>
`;
  fs.writeFileSync(outputPath(out), html);
  const summary = { out, bytes: html.length };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
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
    const posts = rows.map((row, i) => ({
      capturedAt: row.capturedAt || new Date().toISOString(),
      pageTitle: row.pageTitle || row.group || "",
      pageUrl: row.pageUrl || "",
      url: row.url || "",
      links: Array.isArray(row.links) ? row.links : [],
      images: Array.isArray(row.images) ? row.images : [],
      sourceKind: row.sourceKind || "",
      text: cleanText(row.text || row.body || row.content || "")
    })).filter(row => row.text);
    const marker = Array.isArray(parsed) ? null : captureMarkerRow(parsed);
    return marker ? [marker, ...posts] : posts;
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

function captureMarkerRow(payload) {
  const pageUrl = payload?.pageUrl || payload?.url || "";
  const groupUrl = /facebook\.com\/groups\//i.test(String(pageUrl)) ? canonicalGroupUrl(pageUrl) : "";
  if (!groupUrl) return null;
  return {
    capturedAt: payload.capturedAt || new Date().toISOString(),
    pageTitle: payload.pageTitle || payload.group || "",
    pageUrl: groupUrl,
    url: groupUrl,
    links: [groupUrl],
    images: [],
    sourceKind: "capture-marker",
    text: ""
  };
}

function isCaptureMarker(row) {
  return row?.sourceKind === "capture-marker";
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

function findConfiguredGroup(config, selector) {
  const query = String(selector || "").trim();
  if (!query) return null;
  const canonical = /facebook\.com\/groups\//i.test(query) ? canonicalGroupUrl(query) : "";
  const lower = query.toLowerCase();
  return (config.facebook.groups || []).find(group =>
    (canonical && group.url === canonical) ||
    group.url.toLowerCase().includes(lower) ||
    group.name.toLowerCase().includes(lower)
  ) || null;
}

function readGroupStatusFile(config, opts = {}) {
  const file = groupStatusFile(config, opts);
  const raw = readJsonIfExists(file, { groups: [] });
  return {
    file,
    groups: normalizeGroupStatusRows(raw)
  };
}

function writeGroupStatusFile(file, groups) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ groups }, null, 2) + "\n");
}

function runGroupStatus(args, opts = {}) {
  const baseConfig = readJson(CONFIG_PATH);
  const config = loadConfig({ ...opts, "include-skipped-groups": true });
  const { file, groups } = readGroupStatusFile(baseConfig, opts);
  const groupByUrl = new Map(groups.map(group => [group.url, group]));

  if (opts.list || !args.length) {
    const rows = (config.facebook.groups || []).map(group => ({
      name: group.name,
      url: group.url,
      priority: group.priority,
      status: group.accessStatus || "unverified",
      watch: group.watch !== false,
      quality: group.quality || "",
      notes: group.statusNotes || "",
      checkedAt: group.accessCheckedAt || ""
    }));
    console.log(JSON.stringify({
      file: path.relative(ROOT, file),
      groups: rows.length,
      watched: rows.filter(row => row.watch).length,
      skipped: rows.filter(row => !row.watch).length,
      rows
    }, null, 2));
    return;
  }

  const group = findConfiguredGroup(config, args.join(" "));
  if (!group) {
    console.error("No configured group matched that URL/name/slug.");
    process.exit(1);
  }

  const status = opts.status ? String(opts.status).toLowerCase() : group.accessStatus || "unverified";
  const existing = groupByUrl.get(group.url) || {};
  const watch = opts.watch !== undefined
    ? parseWatchValue(opts.watch, true)
    : existing.watch !== undefined ? existing.watch : shouldWatchStatus(status);
  const row = {
    name: group.name,
    url: group.url,
    status,
    watch,
    priority: opts.priority || existing.priority || group.priority || "normal",
    quality: opts.quality || existing.quality || "",
    notes: opts.notes || existing.notes || "",
    checkedAt: new Date().toISOString()
  };
  groupByUrl.set(group.url, row);
  const sorted = [...groupByUrl.values()].sort((a, b) => a.name.localeCompare(b.name));
  writeGroupStatusFile(file, sorted);
  const nextConfig = loadConfig({ ...opts, "include-skipped-groups": true });
  const allGroups = nextConfig.facebook.groups || [];
  console.log(JSON.stringify({
    file: path.relative(ROOT, file),
    updated: row,
    groups: allGroups.length,
    watched: allGroups.filter(item => item.watch !== false).length,
    skipped: allGroups.filter(item => item.watch === false).length
  }, null, 2));
}

function runSeedGroups(opts = {}) {
  const config = readJson(CONFIG_PATH);
  const seedFile = opts.seeds || opts.seed || DEFAULT_GROUP_SEEDS_PATH;
  const out = opts.out || opts["groups-out"] || config.facebook.localGroupsFile || "monitoring/facebook-groups.local.json";
  const raw = fs.readFileSync(outputPath(seedFile), "utf8");
  const entries = extractGroupEntries(raw, {
    ...opts,
    "housing-only": true
  });
  const result = importGroupEntries(entries, {
    ...opts,
    "housing-only": true,
    out
  });
  console.log(JSON.stringify({
    ...result,
    seeds: seedFile
  }, null, 2));
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
    posts: rows.filter(row => !isCaptureMarker(row)).length,
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
    const postRows = rows.filter(row => !isCaptureMarker(row));
    const record = {
      file: path.relative(downloadsDir, file),
      hash,
      posts: postRows.length,
      inbox: null,
      groups: null
    };
    if (rows.length) {
      record.inbox = writeInboxRows(rows, {
        ...opts,
        name: opts.name || path.basename(file, ".json")
      });
      postCount += postRows.length;
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

  const summary = {
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
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
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

function zeroYieldStats() {
  return {
    listingPosts: 0,
    candidates: 0,
    passVerifyCandidates: 0,
    rejectedCandidates: 0,
    duplicateCandidates: 0,
    overBudgetCandidates: 0
  };
}

function groupYieldStats(config = loadConfig(), opts = {}) {
  const groups = config.facebook.groups || [];
  const byUrl = new Map(groups.map(group => [group.url, zeroYieldStats()]));
  for (const file of inboxFiles(opts.inbox)) {
    for (const post of parseCaptureFile(file)) {
      const row = byUrl.get(postGroupUrl(post));
      if (row) row.listingPosts += 1;
    }
  }

  const candidatesFile = opts.candidates || opts.out || DEFAULT_CANDIDATES_PATH;
  const candidatesPath = outputPath(candidatesFile);
  const candidates = fs.existsSync(candidatesPath) ? readJson(candidatesPath) : [];
  for (const candidate of candidates) {
    const row = byUrl.get(postGroupUrl(candidate));
    if (!row) continue;
    row.candidates += 1;
    if (candidate.status === "pass" || candidate.status === "verify") row.passVerifyCandidates += 1;
    if (candidate.status === "reject") row.rejectedCandidates += 1;
    if (candidate.status === "duplicate") row.duplicateCandidates += 1;
    if (isKnownOverBudget(candidate, config)) row.overBudgetCandidates += 1;
  }
  return byUrl;
}

function normalizeCoveragePost(item, file) {
  if (isCaptureMarker(item)) {
    return {
      file,
      capturedAt: item.capturedAt || null,
      pageTitle: item.pageTitle || "",
      pageUrl: item.pageUrl || item.url || "",
      url: item.url || item.pageUrl || "",
      links: Array.isArray(item.links) ? item.links : [],
      images: [],
      sourceKind: "capture-marker",
      text: ""
    };
  }
  return normalizePost(item, file);
}

function parseCoverageFile(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : parsed.posts || parsed.items || [];
    const posts = rows.map(item => normalizeCoveragePost(item, file)).filter(Boolean);
    if (!Array.isArray(parsed)) {
      const marker = captureMarkerRow(parsed);
      if (marker) posts.push(normalizeCoveragePost(marker, file));
    }
    return posts;
  } catch {
    return parseCaptureFile(file);
  }
}

function groupCaptureCoverage(config = loadConfig(), opts = {}) {
  const staleHours = Number(opts["stale-hours"] || opts.staleHours || 24);
  const parsedNow = opts.now ? Date.parse(opts.now) : NaN;
  const now = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const groups = config.facebook.groups || [];
  const yieldByUrl = groupYieldStats(config, opts);
  const byUrl = new Map(groups.map(group => [group.url, {
    name: group.name,
    url: group.url,
    priority: group.priority || "normal",
    accessStatus: group.accessStatus || "unverified",
    watch: group.watch !== false,
    quality: group.quality || "",
    statusNotes: group.statusNotes || "",
    accessCheckedAt: group.accessCheckedAt || "",
    captureCount: 0,
    lastCapturedAt: null,
    lastSourceFile: null,
    ...zeroYieldStats(),
    ...(yieldByUrl.get(group.url) || {})
  }]));

  for (const file of inboxFiles(opts.inbox)) {
    const groupsInFile = new Map();
    for (const post of parseCoverageFile(file)) {
      const groupUrl = postGroupUrl(post);
      const row = byUrl.get(groupUrl);
      if (!row) continue;
      const capturedAt = captureTimestamp(post, file);
      const previous = groupsInFile.get(groupUrl);
      if (!previous || (capturedAt && (!previous.capturedAt || Date.parse(capturedAt) > Date.parse(previous.capturedAt)))) {
        groupsInFile.set(groupUrl, {
          capturedAt,
          sourceFile: path.relative(ROOT, file)
        });
      }
    }
    for (const [groupUrl, capture] of groupsInFile) {
      const row = byUrl.get(groupUrl);
      row.captureCount += 1;
      if (capture.capturedAt && (!row.lastCapturedAt || Date.parse(capture.capturedAt) > Date.parse(row.lastCapturedAt))) {
        row.lastCapturedAt = capture.capturedAt;
        row.lastSourceFile = capture.sourceFile;
      } else if (!row.lastSourceFile) {
        row.lastCapturedAt = capture.capturedAt || null;
        row.lastSourceFile = capture.sourceFile;
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
    watchedGroups: rows.filter(row => row.watch).length,
    skippedGroups: rows.filter(row => !row.watch).length,
    listingPosts: rows.reduce((sum, row) => sum + row.listingPosts, 0),
    candidates: rows.reduce((sum, row) => sum + row.candidates, 0),
    passVerifyCandidates: rows.reduce((sum, row) => sum + row.passVerifyCandidates, 0),
    rejectedCandidates: rows.reduce((sum, row) => sum + row.rejectedCandidates, 0),
    duplicateCandidates: rows.reduce((sum, row) => sum + row.duplicateCandidates, 0),
    overBudgetCandidates: rows.reduce((sum, row) => sum + row.overBudgetCandidates, 0),
    groups: rows
  };
}

function coverageSearchUrl(row, config) {
  const term = (config.facebook.searchTerms || [])[0] || "San Francisco housing";
  return groupSearchUrl(row.url, term);
}

function yieldLabel(row) {
  return `${row.passVerifyCandidates || 0}/${row.listingPosts || 0}`;
}

function groupSweepScore(row) {
  const statusScore = row.status === "never" ? 600
    : row.status === "stale" ? 500
      : row.status === "fresh" ? 50
        : 0;
  const priorityScore = row.priority === "high" ? 40
    : row.priority === "normal" ? 20
      : 0;
  const accessScore = row.accessStatus === "joined" ? 30
    : row.accessStatus === "pending" ? -20
      : shouldWatchStatus(row.accessStatus) ? 0
        : -200;
  const qualityScore = row.quality === "good" ? 25
    : row.quality === "ok" ? 10
      : row.quality === "low" ? -40
        : 0;
  const passScore = Math.min(row.passVerifyCandidates || 0, 5) * 120;
  const listingScore = Math.min(row.listingPosts || 0, 20) * 6;
  const rejectPenalty = Math.min((row.rejectedCandidates || 0) + (row.duplicateCandidates || 0), 20) * 8;
  const budgetPenalty = Math.min(row.overBudgetCandidates || 0, 10) * 20;
  const freshnessNudge = row.ageHours === null ? 0
    : row.status === "stale" ? Math.min(row.ageHours, 168)
      : row.status === "fresh" ? Math.min(row.ageHours, 24)
        : 0;
  return Math.round(statusScore + priorityScore + accessScore + qualityScore + passScore + listingScore + freshnessNudge - rejectPenalty - budgetPenalty);
}

function groupSweepReason(row) {
  const parts = [];
  if (row.status === "never") parts.push("needs first capture");
  else if (row.status === "stale") parts.push(`stale ${ageLabel(row)}`);
  else parts.push(`fresh ${ageLabel(row)}`);
  if (row.passVerifyCandidates) parts.push(`${row.passVerifyCandidates} pass/verify`);
  if (row.listingPosts) parts.push(`${row.listingPosts} listing posts`);
  if ((row.rejectedCandidates || 0) + (row.duplicateCandidates || 0)) {
    parts.push(`${(row.rejectedCandidates || 0) + (row.duplicateCandidates || 0)} reject/dup`);
  }
  if (row.overBudgetCandidates) parts.push(`${row.overBudgetCandidates} over budget`);
  if (row.priority === "high") parts.push("high priority");
  if (row.quality) parts.push(`${row.quality} quality`);
  if (row.accessStatus && row.accessStatus !== "unverified") parts.push(row.accessStatus);
  return parts.join("; ");
}

function ageLabel(row) {
  return row.ageHours === null ? "never" : `${row.ageHours}h`;
}

function lastLabel(row) {
  return row.lastCapturedAt || "never";
}

function rankedGroupSweepRows(rows) {
  return rows
    .map(row => ({
      ...row,
      sweepScore: groupSweepScore(row)
    }))
    .sort((a, b) =>
      b.sweepScore - a.sweepScore ||
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
      a.name.localeCompare(b.name)
    );
}

function groupStatusCommand(row, status, opts = {}) {
  const parts = [
    "node",
    "scripts/facebook-monitor.mjs",
    "group-status",
    shellQuote(row.url),
    "--status",
    shellQuote(status)
  ];
  if (opts.watch !== undefined) parts.push("--watch", opts.watch ? "true" : "false");
  if (opts.quality) parts.push("--quality", shellQuote(opts.quality));
  return parts.join(" ");
}

function groupStatusActions(row) {
  return [
    ["Joined", groupStatusCommand(row, "joined", { watch: true, quality: "good" })],
    ["Pending", groupStatusCommand(row, "pending", { watch: true })],
    ["Noisy", groupStatusCommand(row, "noisy", { watch: false, quality: "low" })],
    ["Inaccessible", groupStatusCommand(row, "inaccessible", { watch: false })],
    ["Skip", groupStatusCommand(row, "skip", { watch: false })]
  ].map(([label, command]) => `<button type="button" data-copy-cmd="${escapeHtml(command)}">${escapeHtml(label)}</button>`).join("");
}

function localHref(fromFile, toFile) {
  const rel = path.relative(path.dirname(outputPath(fromFile)), outputPath(toFile)).replace(/\\/g, "/");
  return rel.startsWith("..") ? pathToFileURL(outputPath(toFile)).href : rel;
}

function generateGroupWatchBatch(config, opts = {}) {
  const coverage = groupCaptureCoverage(config, opts);
  const watchedRows = rankedGroupSweepRows(coverage.groups.filter(row => row.watch !== false));
  const limit = Number(opts.limit || opts["group-limit"] || watchedRows.length);
  const rows = watchedRows.slice(0, limit);
  const mdOut = opts.out || opts["group-watch"] || DEFAULT_GROUP_WATCH_PATH;
  const htmlOut = opts.html || opts["group-watch-html"] || DEFAULT_GROUP_WATCH_HTML_PATH;
  const openOut = opts.script || opts["group-watch-script"] || DEFAULT_GROUP_OPEN_SCRIPT_PATH;
  const openLinks = Boolean(opts.openLinks || opts["open-links"]);
  const now = new Date().toISOString();
  const notesLabel = row => row.statusNotes || row.quality || "";
  const md = [
    "# Facebook Group Sweep",
    "",
    `Generated: ${now}`,
    `Watched groups in this sweep: ${rows.length} of ${watchedRows.length}`,
    "",
    "Workflow:",
    "",
    "1. Open each group while logged into Facebook.",
    "2. Sort or filter by recent posts where Facebook exposes that control.",
    "3. Click the `Capture FB Housing` bookmarklet on the group feed.",
    "4. If a group is inaccessible, noisy, or pending, record it with `group-status` so future sweeps get sharper.",
    "5. Run `node scripts/facebook-monitor.mjs run --open-review` to import downloads, score leads, and refresh the next sweep.",
    "",
    "Sweep order is evidence-ranked: stale productive groups first, never-captured groups next, and low-yield/noisy groups lower unless they are overdue.",
    "",
    "| Score | Why | Freshness | Access | Priority | Yield | Group | Last captured | Age | Group | Core search | Notes |",
    "| ---: | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |",
    ...rows.map(row => `| ${row.sweepScore} | ${escapeMd(groupSweepReason(row))} | ${escapeMd(row.status)} | ${escapeMd(row.accessStatus)} | ${escapeMd(row.priority)} | ${escapeMd(yieldLabel(row))} | ${escapeMd(row.name)} | ${escapeMd(lastLabel(row))} | ${escapeMd(ageLabel(row))} | [group](${row.url}) | [search](${coverageSearchUrl(row, config)}) | ${escapeMd(notesLabel(row))} |`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(mdOut), md);

  if (htmlOut) {
    const capturePath = "monitoring/facebook-capture-snippet.js";
    const bookmarkletPath = "monitoring/facebook-capture-bookmarklet.html";
    const reviewPath = "monitoring/facebook-review.html";
    const coveragePath = DEFAULT_COVERAGE_HTML_PATH;
    const deepWatchPath = "monitoring/facebook-watch.html";
    const doneKey = `sf-lofts-facebook-group-watch:${crypto.createHash("sha1").update(rows.map(row => row.url).join("\n")).digest("hex").slice(0, 12)}`;
    const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Group Sweep</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;margin:24px;color:#111;background:#fafafa}
a{color:#06c}.toolbar{position:sticky;top:0;z-index:3;background:#fffffff0;border:1px solid #ddd;border-radius:8px;padding:12px;margin:14px 0 16px;box-shadow:0 2px 10px #0001;backdrop-filter:blur(8px)}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:8px 0}.step{background:#f6f7f8;border:1px solid #e1e1e1;border-radius:7px;padding:10px}.step b{display:block;margin-bottom:3px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px}.progress{font-weight:700}.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid #ddd;border-radius:6px;padding:7px 9px}
button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:7px 10px;cursor:pointer}table{border-collapse:collapse;width:100%;max-width:1280px;background:#fff}td,th{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{background:#f6f6f6}.never{background:#fff3f3}.stale{background:#fff8e8}.fresh{background:#eef8ef}.low{color:#666}.done{opacity:.45;background:#f1f5f1}.done a{text-decoration:line-through}.check{width:44px;text-align:center}.links{white-space:nowrap}
.actions{display:flex;gap:5px;flex-wrap:wrap;min-width:190px}.actions button{padding:5px 7px;font-size:12px}.actions button.copied{background:#eaf7ed;border-color:#9bc69f}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<h1>Facebook Group Sweep</h1>
<p>Generated ${escapeHtml(now)}. Open one row per watched group first; use the deeper search batch when you want a term-by-term pass.</p>
<section class="toolbar">
  <div class="steps">
    <div class="step"><b>1. Bookmarklet</b><a href="${escapeHtml(localHref(htmlOut, bookmarkletPath))}">Open installer</a> or <a href="${escapeHtml(localHref(htmlOut, capturePath))}">open snippet</a>.</div>
    <div class="step"><b>2. Capture</b>Open a group, sort recent where possible, click <code>Capture FB Housing</code>, then check it off.</div>
    <div class="step"><b>3. Import</b><span class="cmd">node scripts/facebook-monitor.mjs run --open-review</span></div>
    <div class="step"><b>4. Review</b><a href="${escapeHtml(localHref(htmlOut, reviewPath))}">Open review page</a> after imports finish.</div>
    <div class="step"><b>5. Deep Search</b><a href="${escapeHtml(localHref(htmlOut, deepWatchPath))}">Open search batch</a> for term-specific scans.</div>
    <div class="step"><b>6. Coverage</b><a href="${escapeHtml(localHref(htmlOut, coveragePath))}">Open coverage</a> to inspect stale/skipped groups.</div>
  </div>
  <div class="controls">
    <span class="progress" id="progress">0/${rows.length} groups captured</span>
    <button type="button" id="copyImport">Copy import command</button>
    <button type="button" id="clearDone">Clear checkoffs</button>
  </div>
</section>
<table>
<thead><tr><th class="check">Done</th><th>Score</th><th>Why</th><th>Freshness</th><th>Access</th><th>Priority</th><th>Yield</th><th>Group</th><th>Last captured</th><th>Age</th><th>Links</th><th>Notes</th><th>Curation</th></tr></thead>
<tbody>
${rows.map((row, i) => `<tr class="${escapeHtml(row.status)}" data-url="${escapeHtml(row.url)}"><td class="check"><input type="checkbox" data-done="${i}"></td><td>${row.sweepScore}</td><td>${escapeHtml(groupSweepReason(row))}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.accessStatus)}</td><td class="${escapeHtml(row.priority)}">${escapeHtml(row.priority)}</td><td>${escapeHtml(yieldLabel(row))}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(lastLabel(row))}</td><td>${escapeHtml(ageLabel(row))}</td><td class="links"><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener">group</a> · <a href="${escapeHtml(coverageSearchUrl(row, config))}" target="_blank" rel="noopener">search</a></td><td>${escapeHtml(notesLabel(row))}</td><td class="actions">${groupStatusActions(row)}</td></tr>`).join("\n")}
</tbody>
</table>
<script>
const doneKey=${js(doneKey)};
const importCommand="node scripts/facebook-monitor.mjs run --open-review";
const checks=[...document.querySelectorAll("[data-done]")];
const rows=[...document.querySelectorAll("tr[data-url]")];
const progress=document.getElementById("progress");
function readDone(){
  try{return new Set(JSON.parse(localStorage.getItem(doneKey)||"[]"))}catch{return new Set()}
}
function writeDone(done){localStorage.setItem(doneKey,JSON.stringify([...done]));}
function sync(){
  const done=readDone();
  rows.forEach((row,i)=>{
    const checked=done.has(row.dataset.url);
    row.classList.toggle("done",checked);
    checks[i].checked=checked;
  });
  progress.textContent=done.size+"/"+rows.length+" groups captured";
}
checks.forEach((box,i)=>box.addEventListener("change",()=>{
  const done=readDone();
  const url=rows[i].dataset.url;
  if(box.checked) done.add(url); else done.delete(url);
  writeDone(done);
  sync();
}));
document.querySelectorAll("[data-copy-cmd]").forEach(button => {
  const label = button.textContent;
  button.addEventListener("click", async () => {
    const command = button.dataset.copyCmd;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      window.prompt("Copy command", command);
    }
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("copied");
    }, 1200);
  });
});
document.getElementById("clearDone").addEventListener("click",()=>{localStorage.removeItem(doneKey);sync();});
document.getElementById("copyImport").addEventListener("click",()=>navigator.clipboard.writeText(importCommand));
sync();
</script>
`;
    fs.writeFileSync(outputPath(htmlOut), html);
  }

  const sh = [
    "#!/bin/sh",
    "set -eu",
    ...rows.map(row => `open ${shellQuote(row.url)}`)
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(openOut), sh, { mode: 0o755 });
  try { fs.chmodSync(outputPath(openOut), 0o755); } catch {}

  if (opts.open) childProcess.spawnSync("open", [outputPath(htmlOut)], { stdio: "ignore" });
  if (openLinks) {
    for (const row of rows) childProcess.spawnSync("open", [row.url], { stdio: "ignore" });
  }

  const summary = {
    generatedAt: now,
    groups: rows.length,
    totalGroups: watchedRows.length,
    skippedGroups: coverage.skippedGroups,
    markdown: mdOut,
    html: htmlOut,
    openScript: openOut,
    opened: Boolean(opts.open),
    openedLinks: openLinks
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function coverageFiles(config, coverage, opts = {}) {
  const mdOut = opts.out || opts.coverage || DEFAULT_COVERAGE_PATH;
  const htmlOut = opts.html || opts["coverage-html"] || DEFAULT_COVERAGE_HTML_PATH;
  const now = new Date().toISOString();
  const ageLabel = row => row.ageHours === null ? "never" : `${row.ageHours}h`;
  const lastLabel = row => row.lastCapturedAt || "never";
  const sourceLabel = row => row.lastSourceFile || "none";
  const notesLabel = row => row.statusNotes || row.quality || "";
  const md = [
    "# Facebook Group Capture Coverage",
    "",
    `Generated: ${now}`,
    `Stale threshold: ${coverage.staleHours} hours`,
    "",
    "## Snapshot",
    "",
    `- Configured groups: ${coverage.totalGroups}`,
    `- Watched groups: ${coverage.watchedGroups}`,
    `- Skipped groups: ${coverage.skippedGroups}`,
    `- Fresh groups: ${coverage.freshGroups}`,
    `- Stale groups: ${coverage.staleGroups}`,
    `- Never captured groups: ${coverage.neverCapturedGroups}`,
    `- Listing-like posts: ${coverage.listingPosts}`,
    `- Pass/verify candidates: ${coverage.passVerifyCandidates}`,
    `- Rejected/duplicate candidates: ${coverage.rejectedCandidates + coverage.duplicateCandidates}`,
    "",
    "## Groups",
    "",
    "| Freshness | Access | Watch | Priority | Group | Captures | Posts | Pass/verify | Reject/dup | Last captured | Age | Source | Notes | Links |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |",
    ...coverage.groups.map(row => {
      const links = `[group](${row.url}) · [search](${coverageSearchUrl(row, config)})`;
      return `| ${escapeMd(row.status)} | ${escapeMd(row.accessStatus)} | ${row.watch ? "yes" : "no"} | ${escapeMd(row.priority)} | ${escapeMd(row.name)} | ${row.captureCount} | ${row.listingPosts} | ${row.passVerifyCandidates} | ${row.rejectedCandidates + row.duplicateCandidates} | ${escapeMd(lastLabel(row))} | ${escapeMd(ageLabel(row))} | ${escapeMd(sourceLabel(row))} | ${escapeMd(notesLabel(row))} | ${links} |`;
    })
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(mdOut), md);

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Facebook Group Capture Coverage</title>
<style>
body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;margin:24px;color:#111;background:#fafafa}
a{color:#06c}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.pill{background:#fff;border:1px solid #ddd;border-radius:999px;padding:6px 10px}
table{border-collapse:collapse;width:100%;max-width:1220px;background:#fff}td,th{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{background:#f6f6f6}
.never{background:#fff3f3}.stale{background:#fff8e8}.fresh{background:#eef8ef}.low{color:#666}.links{white-space:nowrap}
.actions{display:flex;gap:5px;flex-wrap:wrap;min-width:190px}.actions button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:5px 7px;cursor:pointer;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.actions button.copied{background:#eaf7ed;border-color:#9bc69f}
</style>
<h1>Facebook Group Capture Coverage</h1>
<p>Generated ${escapeHtml(now)}. Stale threshold: ${escapeHtml(coverage.staleHours)} hours.</p>
<section class="summary">
  <span class="pill">${coverage.totalGroups} configured</span>
  <span class="pill">${coverage.watchedGroups} watched</span>
  <span class="pill">${coverage.skippedGroups} skipped</span>
  <span class="pill">${coverage.freshGroups} fresh</span>
  <span class="pill">${coverage.staleGroups} stale</span>
  <span class="pill">${coverage.neverCapturedGroups} never captured</span>
  <span class="pill">${coverage.listingPosts} listing posts</span>
  <span class="pill">${coverage.passVerifyCandidates} pass/verify</span>
  <span class="pill">${coverage.rejectedCandidates + coverage.duplicateCandidates} reject/dup</span>
</section>
<table>
<thead><tr><th>Freshness</th><th>Access</th><th>Watch</th><th>Priority</th><th>Group</th><th>Captures</th><th>Posts</th><th>Pass/verify</th><th>Reject/dup</th><th>Last captured</th><th>Age</th><th>Source</th><th>Notes</th><th>Links</th><th>Curation</th></tr></thead>
<tbody>
${coverage.groups.map(row => `<tr class="${escapeHtml(row.status)}"><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.accessStatus)}</td><td>${row.watch ? "yes" : "no"}</td><td class="${escapeHtml(row.priority)}">${escapeHtml(row.priority)}</td><td>${escapeHtml(row.name)}</td><td>${row.captureCount}</td><td>${row.listingPosts}</td><td>${row.passVerifyCandidates}</td><td>${row.rejectedCandidates + row.duplicateCandidates}</td><td>${escapeHtml(lastLabel(row))}</td><td>${escapeHtml(ageLabel(row))}</td><td>${escapeHtml(sourceLabel(row))}</td><td>${escapeHtml(notesLabel(row))}</td><td class="links"><a href="${escapeHtml(row.url)}" target="_blank" rel="noopener">group</a> · <a href="${escapeHtml(coverageSearchUrl(row, config))}" target="_blank" rel="noopener">search</a></td><td class="actions">${groupStatusActions(row)}</td></tr>`).join("\n")}
</tbody>
</table>
<script>
document.querySelectorAll("[data-copy-cmd]").forEach(button => {
  const label = button.textContent;
  button.addEventListener("click", async () => {
    const command = button.dataset.copyCmd;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      window.prompt("Copy command", command);
    }
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("copied");
    }, 1200);
  });
});
</script>
`;
  fs.writeFileSync(outputPath(htmlOut), html);

  return {
    markdown: mdOut,
    html: htmlOut,
    generatedAt: now
  };
}

function runScan(opts) {
  const files = inboxFiles(opts.inbox);
  const scoreOpts = {
    ...opts,
    out: opts.out || DEFAULT_CANDIDATES_PATH,
    snippets: opts.snippets || "monitoring/facebook-candidates.generated.js",
    review: opts.review || "monitoring/facebook-review.html",
    digest: opts.digest || DEFAULT_DIGEST_PATH,
    state: opts.state || "monitoring/facebook-monitor-state.json"
  };
  if (!opts.all) scoreOpts["new-only"] = true;
  const summary = runScore(files, scoreOpts);
  if (opts.open) childProcess.spawnSync("open", [outputPath(scoreOpts.review)], { stdio: "ignore" });
  return summary;
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

function inboxCaptureStats(files) {
  let posts = 0;
  let sweepMarkers = 0;
  for (const file of files) {
    posts += parseCaptureFile(file).length;
    sweepMarkers += parseCoverageFile(file).filter(isCaptureMarker).length;
  }
  return {
    files: files.length,
    posts,
    sweepMarkers
  };
}

function monitorSnapshot(config = loadConfig(), opts = {}) {
  const inboxDir = opts.inbox || "monitoring/facebook-inbox";
  const files = inboxFiles(inboxDir);
  const inboxStats = inboxCaptureStats(files);
  const candidatesFile = opts.candidates || DEFAULT_CANDIDATES_PATH;
  const candidatesPath = outputPath(candidatesFile);
  const statePath = outputPath(opts.state || DEFAULT_STATE_PATH);
  const state = readJsonIfExists(statePath, { seenHashes: [] });
  const watchRows = generateSearches(config);
  const candidates = fs.existsSync(candidatesPath) ? readJson(candidatesPath) : [];
  const coverage = groupCaptureCoverage(config, opts);
  const setupGaps = [];
  if (!config.facebook.groups.length) {
    setupGaps.push("No configured Facebook housing groups yet.");
  }
  if (!files.length) {
    setupGaps.push("No imported Facebook capture files yet.");
  } else if (!inboxStats.posts) {
    setupGaps.push("Imported Facebook sweeps have not produced listing-like posts yet.");
  }
  if (!candidates.length) {
    setupGaps.push("No scored Facebook candidates yet.");
  }
  return {
    groups: config.facebook.groups.length,
    watchedGroups: config.facebook.groups.filter(group => group.watch !== false).length,
    skippedGroups: config.facebook.groups.filter(group => group.watch === false).length,
    groupNames: config.facebook.groups.map(group => group.name),
    baselineSearches: (config.facebook.searchTerms || []).length * 2,
    totalWatchSearches: watchRows.length,
    inboxFiles: inboxStats.files,
    inboxPosts: inboxStats.posts,
    sweepMarkers: inboxStats.sweepMarkers,
    candidates: candidates.length,
    candidateStatus: countStatuses(candidates),
    seenHashes: (state.seenHashes || []).length,
    watchCursor: state.watchCursor || 0,
    watchFocusCursor: state.watchFocusCursor || 0,
    watchTotalSearches: state.watchTotalSearches || watchRows.length,
    watchFocusedSearches: state.watchFocusedSearches || null,
    watchFocusedGroups: state.watchFocusedGroups || null,
    watchRotatedSearches: state.watchRotatedSearches || null,
    watchLimit: state.watchLimit || null,
    watchUpdatedAt: state.watchUpdatedAt || null,
    groupCoverage: {
      staleHours: coverage.staleHours,
      freshGroups: coverage.freshGroups,
      staleGroups: coverage.staleGroups,
      neverCapturedGroups: coverage.neverCapturedGroups,
      listingPosts: coverage.listingPosts,
      passVerifyCandidates: coverage.passVerifyCandidates,
      rejectedCandidates: coverage.rejectedCandidates,
      duplicateCandidates: coverage.duplicateCandidates,
      overBudgetCandidates: coverage.overBudgetCandidates,
      needsCapture: coverage.groups.filter(group => group.status !== "fresh").slice(0, 12)
    },
    cadenceHours: config.facebook.scanCadenceHours || 6,
    setupGaps
  };
}

function runStatus(opts = {}) {
  console.log(JSON.stringify(monitorSnapshot(loadConfig(opts), opts), null, 2));
}

function fileInfo(file) {
  const resolved = outputPath(file);
  if (!fs.existsSync(resolved)) {
    return { file, path: resolved, exists: false, updatedAt: null, bytes: 0 };
  }
  const stat = fs.statSync(resolved);
  return {
    file,
    path: resolved,
    exists: true,
    updatedAt: stat.mtime.toISOString(),
    bytes: stat.size
  };
}

function launchAgentStatus() {
  const plist = path.join(process.env.HOME || ".", "Library/LaunchAgents/com.sf-lofts-feed.facebook-monitor.plist");
  const installed = fs.existsSync(plist);
  return {
    installed,
    plist,
    command: installed ? `launchctl unload ${shellQuote(plist)}` : "scripts/install-facebook-monitor-agent.sh"
  };
}

function captureDownloadStatus(opts = {}) {
  const { downloadsDir, files } = downloadCaptureFiles(opts);
  const statePath = outputPath(opts.state || DEFAULT_STATE_PATH);
  const state = readJsonIfExists(statePath, { importedDownloadHashes: [] });
  const importedHashes = new Set(state.importedDownloadHashes || []);
  const rows = files.map(file => {
    const raw = fs.readFileSync(file, "utf8");
    const hash = crypto.createHash("sha1").update(raw).digest("hex");
    const stat = fs.statSync(file);
    return {
      file: path.relative(downloadsDir, file),
      path: file,
      hash,
      imported: importedHashes.has(hash),
      mtime: stat.mtime.toISOString(),
      bytes: stat.size
    };
  });
  return {
    downloadsDir,
    total: rows.length,
    imported: rows.filter(row => row.imported).length,
    unimported: rows.filter(row => !row.imported).length,
    state: path.relative(ROOT, statePath),
    files: rows
  };
}

function generatedMonitorFiles(opts = {}) {
  return [
    opts.bookmarklet || "monitoring/facebook-capture-bookmarklet.html",
    opts.discovery || "monitoring/facebook-discovery.md",
    opts["discovery-html"] || "monitoring/facebook-discovery.html",
    opts["discovery-script"] || "monitoring/facebook-open-discovery.sh",
    opts.next || "monitoring/facebook-next.md",
    opts.watch || "monitoring/facebook-watch.md",
    opts.html || "monitoring/facebook-watch.html",
    opts.script || "monitoring/facebook-open-watch.sh",
    opts["group-watch"] || DEFAULT_GROUP_WATCH_PATH,
    opts["group-watch-html"] || DEFAULT_GROUP_WATCH_HTML_PATH,
    opts["group-watch-script"] || DEFAULT_GROUP_OPEN_SCRIPT_PATH,
    opts.coverage || DEFAULT_COVERAGE_PATH,
    opts["coverage-html"] || DEFAULT_COVERAGE_HTML_PATH,
    opts.review || "monitoring/facebook-review.html",
    opts.digest || DEFAULT_DIGEST_PATH,
    opts.candidates || DEFAULT_CANDIDATES_PATH
  ].map(fileInfo);
}

function monitorNextActions(snapshot, downloads, generatedFiles, launchAgent, opts = {}) {
  const candidatesFile = opts.candidates || opts.out || DEFAULT_CANDIDATES_PATH;
  const actions = [];
  const missingBookmarklet = generatedFiles.find(file => /facebook-capture-bookmarklet\.html$/.test(file.file) && !file.exists);
  if (missingBookmarklet) {
    actions.push("Generate/install the bookmarklet: node scripts/facebook-monitor.mjs bookmarklet --out monitoring/facebook-capture-bookmarklet.html");
  }
  if (!snapshot.groups) {
    actions.push("Bootstrap public SF/Bay Area housing groups: node scripts/facebook-monitor.mjs seed-groups");
    actions.push("Discover joined/private housing groups: node scripts/facebook-monitor.mjs discover --open");
  }
  if (downloads.unimported) {
    actions.push("Import pending Facebook captures: node scripts/facebook-monitor.mjs run --open-group-watch --open-review");
  } else if (snapshot.groups && !snapshot.inboxFiles) {
    actions.push("Fast-sweep configured groups: node scripts/facebook-monitor.mjs group-watch --open");
    actions.push("Capture listings from configured groups: node scripts/facebook-monitor.mjs run --open-group-watch");
  } else if (snapshot.groups && snapshot.inboxFiles && !snapshot.inboxPosts) {
    actions.push("Sweeps imported but no listing-like posts found yet: continue the group sweep or open the deeper search batch.");
    actions.push("Deep-search configured groups: node scripts/facebook-monitor.mjs next --open-watch");
  }
  if (snapshot.inboxPosts && !snapshot.candidates) {
    actions.push("Score imported captures: node scripts/facebook-monitor.mjs scan --open");
  }
  const reviewable = (snapshot.candidateStatus.pass || 0) + (snapshot.candidateStatus.verify || 0);
  if (reviewable) {
    actions.push(`Review pass/verify candidates, then publish selected handles with node scripts/facebook-monitor.mjs publish ${candidatesFile} --select <handle-or-hash> --apply`);
  }
  if (!launchAgent.installed) {
    actions.push("Install the 6-hour reminder loop: scripts/install-facebook-monitor-agent.sh");
  }
  if (!actions.length) {
    actions.push("Monitor is ready. Continue the loop with node scripts/facebook-monitor.mjs run --open-group-watch --open-review");
  }
  return actions;
}

function runDoctor(opts = {}) {
  const config = loadConfig(opts);
  const snapshot = monitorSnapshot(config, opts);
  const downloads = captureDownloadStatus(opts);
  const generatedFiles = generatedMonitorFiles(opts);
  const launchAgent = launchAgentStatus();
  const readiness = {
    groupsConfigured: snapshot.groups > 0,
    captureFilesImported: snapshot.inboxFiles > 0,
    listingCapturesImported: snapshot.inboxPosts > 0,
    sweepMarkersImported: snapshot.sweepMarkers > 0,
    candidatesScored: snapshot.candidates > 0,
    hasReviewableCandidates: (snapshot.candidateStatus.pass || 0) + (snapshot.candidateStatus.verify || 0) > 0,
    unimportedDownloads: downloads.unimported,
    reminderInstalled: launchAgent.installed
  };
  const nextActions = monitorNextActions(snapshot, downloads, generatedFiles, launchAgent, opts);
  const summary = {
    generatedAt: new Date().toISOString(),
    criteria: {
      maxPricePerBedroom: config.criteria.maxPricePerBedroom,
      minBedrooms: config.criteria.minBedrooms,
      allowSharedRooms: config.criteria.allowSharedRooms
    },
    readiness,
    status: snapshot,
    downloads,
    generatedFiles,
    launchAgent,
    nextActions
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function runSetup(opts = {}) {
  const candidatesFile = opts.candidates || opts.out || DEFAULT_CANDIDATES_PATH;
  const inboxDir = opts.inbox || "monitoring/facebook-inbox";
  const state = opts.state || DEFAULT_STATE_PATH;
  const review = opts.review || "monitoring/facebook-review.html";
  const bookmarklet = generateBookmarklet({
    ...opts,
    out: opts.bookmarklet || "monitoring/facebook-capture-bookmarklet.html",
    quiet: true
  });
  const discovery = generateGroupDiscovery({
    ...opts,
    out: opts.discovery || "monitoring/facebook-discovery.md",
    html: opts["discovery-html"] || "monitoring/facebook-discovery.html",
    script: opts["discovery-script"] || "monitoring/facebook-open-discovery.sh",
    open: false,
    quiet: true
  });
  const nextOpts = {
    ...opts,
    out: opts.next || "monitoring/facebook-next.md",
    watch: opts.watch || "monitoring/facebook-watch.md",
    html: opts.html || "monitoring/facebook-watch.html",
    script: opts.script || "monitoring/facebook-open-watch.sh",
    candidates: candidatesFile,
    review,
    limit: opts.limit || 40,
    state,
    open: false,
    quiet: true
  };
  if (!opts.rotate) nextOpts["no-rotate"] = true;
  const next = runNext(nextOpts);
  const scan = runScan({
    ...opts,
    inbox: inboxDir,
    out: candidatesFile,
    snippets: opts.snippets || "monitoring/facebook-candidates.generated.js",
    review,
    state,
    open: false,
    quiet: true
  });
  const doctor = runDoctor({
    ...opts,
    inbox: inboxDir,
    candidates: candidatesFile,
    state,
    bookmarklet: bookmarklet.out,
    discovery: discovery.markdown,
    "discovery-html": discovery.html,
    "discovery-script": discovery.openScript,
    next: next.out,
    watch: next.watchHtml ? opts.watch || "monitoring/facebook-watch.md" : opts.watch,
    html: next.watchHtml,
    script: next.openScript,
    review,
    quiet: true
  });
  const opened = {
    bookmarklet: false,
    discovery: false,
    watch: false,
    review: false
  };
  if (opts.open) {
    childProcess.spawnSync("open", [outputPath(bookmarklet.out)], { stdio: "ignore" });
    childProcess.spawnSync("open", [outputPath(discovery.html)], { stdio: "ignore" });
    childProcess.spawnSync("open", [outputPath(next.watchHtml || "monitoring/facebook-watch.html")], { stdio: "ignore" });
    childProcess.spawnSync("open", [outputPath(review)], { stdio: "ignore" });
    opened.bookmarklet = true;
    opened.discovery = true;
    opened.watch = true;
    opened.review = true;
  }
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    bookmarklet,
    discovery,
    next,
    scan,
    doctor,
    opened,
    nextCommand: "node scripts/facebook-monitor.mjs run --open-group-watch --open-review"
  }, null, 2));
}

function runCoverage(opts = {}) {
  const config = loadConfig(opts);
  const coverage = groupCaptureCoverage(config, opts);
  const files = (opts.out || opts.html || opts.coverage || opts["coverage-html"])
    ? coverageFiles(config, coverage, opts)
    : null;
  console.log(JSON.stringify({
    ...coverage,
    files
  }, null, 2));
}

function runNext(opts) {
  const config = loadConfig(opts);
  const out = opts.out || "monitoring/facebook-next.md";
  const candidatesFile = opts.candidates || DEFAULT_CANDIDATES_PATH;
  const reviewFile = opts.review || "monitoring/facebook-review.html";
  const digestFile = opts.digest || DEFAULT_DIGEST_PATH;
  const rotate = !opts["no-rotate"];
  const coverage = groupCaptureCoverage(config, opts);
  const staleRows = coverage.groups.filter(group => group.status !== "fresh" && group.watch !== false);
  const staleRankedRows = rankedGroupSweepRows(staleRows);
  const focusRows = opts["no-focus-stale"] ? [] : staleRankedRows;
  const groupWatch = generateGroupWatchBatch(config, {
    ...opts,
    out: opts["group-watch"] || DEFAULT_GROUP_WATCH_PATH,
    html: opts["group-watch-html"] || DEFAULT_GROUP_WATCH_HTML_PATH,
    script: opts["group-watch-script"] || DEFAULT_GROUP_OPEN_SCRIPT_PATH,
    limit: opts["group-limit"] || config.facebook.groups.length || 40,
    open: Boolean(opts["open-group-watch"]),
    "open-links": opts["open-group-links"],
    quiet: true
  });
  const watch = generateWatchBatch(config, {
    out: opts.watch || "monitoring/facebook-watch.md",
    html: opts.html || "monitoring/facebook-watch.html",
    script: opts.script || "monitoring/facebook-open-watch.sh",
    limit: opts.limit || 40,
    state: opts.state || DEFAULT_STATE_PATH,
    focusGroupUrls: focusRows.map(group => group.url),
    rotate,
    "open-links": opts["open-links"] || opts.openLinks,
    quiet: true
  });
  const snapshot = monitorSnapshot(config, { ...opts, candidates: candidatesFile });
  const generatedAt = new Date().toISOString();
  const groupLines = config.facebook.groups.length
    ? config.facebook.groups.map(group => `- ${group.name} (${group.priority || "normal"}): ${group.url}`)
    : [
      "- No private groups configured yet.",
      "- Generate the group discovery page with `node scripts/facebook-monitor.mjs discover --open`, then run the bookmarklet on joined-groups and group-search pages.",
      "- Import downloaded discovery captures with `node scripts/facebook-monitor.mjs run --open-group-watch --open-review`.",
      "- You can also paste copied group links into the local group list: `pbpaste | node scripts/facebook-monitor.mjs groups - --priority high --housing-only`"
    ];
  const commands = {
    monitorRun: "node scripts/facebook-monitor.mjs run --limit 40 --open-group-watch --open-review",
    nextRun: "node scripts/facebook-monitor.mjs next --limit 40 --open-group-watch",
    groupWatch: "node scripts/facebook-monitor.mjs group-watch --open",
    importGroups: "pbpaste | node scripts/facebook-monitor.mjs groups - --priority high",
    importDownloads: "node scripts/facebook-monitor.mjs downloads --groups --housing-only",
    coverage: "node scripts/facebook-monitor.mjs coverage",
    captureInbox: "pbpaste | node scripts/facebook-monitor.mjs inbox - --name <group-or-search-name>",
    scan: "node scripts/facebook-monitor.mjs scan --open",
    markSeen: "node scripts/facebook-monitor.mjs scan --update-state",
    digest: `open ${shellQuote(outputPath(digestFile))}`,
    publishPreview: `node scripts/facebook-monitor.mjs publish ${candidatesFile} --select <handle-or-hash>`,
    publishApply: `node scripts/facebook-monitor.mjs publish ${candidatesFile} --select <handle-or-hash> --apply`
  };
  const counts = snapshot.candidateStatus;
  const setupLines = [];
  if (!snapshot.groups) {
    setupLines.push("Group discovery is still empty. Run `node scripts/facebook-monitor.mjs discover --open`, capture joined-groups/search pages with the bookmarklet, then rerun the monitor loop.");
  }
  if (!snapshot.inboxFiles) {
    setupLines.push("Listing capture inbox is still empty. Open the group sweep while logged into Facebook, click the bookmarklet on each group feed, then rerun `node scripts/facebook-monitor.mjs run --open-review`.");
  } else if (!snapshot.inboxPosts) {
    setupLines.push("Capture files are imported, but none include listing-like posts yet. Continue group sweeps, mark noisy/inaccessible groups, or use the deeper search batch.");
  }
  if (!snapshot.candidates) {
    setupLines.push(snapshot.inboxPosts
      ? "Review queue is empty. Run `node scripts/facebook-monitor.mjs scan --open` to score imported listing posts."
      : "Review queue is empty. It will populate after the first imported capture with housing-like posts.");
  }
  const freshnessLines = !coverage.groups.length
    ? ["- No groups configured yet."]
    : staleRows.length
      ? staleRankedRows.slice(0, 12).map(group =>
        `- ${group.status}: ${group.name} (${group.priority}, score ${group.sweepScore})${group.lastCapturedAt ? ` · last ${group.lastCapturedAt}` : ""} · ${groupSweepReason(group)}`
      )
      : ["- All configured groups are fresh."];
  const yieldLines = coverage.groups
    .filter(group => group.listingPosts || group.passVerifyCandidates || group.candidates)
    .sort((a, b) =>
      b.passVerifyCandidates - a.passVerifyCandidates ||
      b.listingPosts - a.listingPosts ||
      a.name.localeCompare(b.name)
    )
    .slice(0, 12)
    .map(group => `- ${group.name}: ${group.passVerifyCandidates} pass/verify from ${group.listingPosts} listing-like posts (${group.candidates} scored)`);
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
    `Watched groups: ${snapshot.watchedGroups}`,
    `Skipped groups: ${snapshot.skippedGroups}`,
    `Watch searches this run: ${watch.searches} of ${watch.totalSearches}`,
    `Rotation: ${watch.rotation.enabled ? `cursor ${watch.rotation.cursor} -> ${watch.rotation.nextCursor}` : "off"}`,
    `Focused term rotation: ${watch.rotation.enabled ? `cursor ${watch.rotation.focusCursor} -> ${watch.rotation.nextFocusCursor}` : "off"}`,
    `Focused stale/never groups: ${watch.focusedGroups}`,
    `Fast group sweep: ${groupWatch.groups} watched groups`,
    "",
    ...groupLines,
    "",
    "## Setup Gaps",
    "",
    ...(setupLines.length ? setupLines.map(line => `- ${line}`) : ["- No setup gaps detected in local monitor state."]),
    "",
    "## Current Queue",
    "",
    `Inbox capture files: ${snapshot.inboxFiles}`,
    `Listing-like posts: ${snapshot.inboxPosts}`,
    `Sweep markers: ${snapshot.sweepMarkers}`,
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
    `Listing-like posts: ${coverage.listingPosts}`,
    `Pass/verify candidates: ${coverage.passVerifyCandidates}`,
    `Rejected/duplicate candidates: ${coverage.rejectedCandidates + coverage.duplicateCandidates}`,
    "",
    ...freshnessLines,
    "",
    "## Group Yield",
    "",
    ...(yieldLines.length ? yieldLines : ["- No listing-like posts have been captured from configured groups yet."]),
    "",
    "## Files",
    "",
    `Watch page: ${relativeOut(watch.html || "monitoring/facebook-watch.html")}`,
    `Watch markdown: ${relativeOut(watch.markdown)}`,
    `Open script: ${relativeOut(watch.openScript)}`,
    `Group sweep page: ${relativeOut(groupWatch.html)}`,
    `Group sweep markdown: ${relativeOut(groupWatch.markdown)}`,
    `Group open script: ${relativeOut(groupWatch.openScript)}`,
    `Review page: ${relativeOut(reviewFile)}`,
    `Digest: ${relativeOut(digestFile)}`,
    `Candidates file: ${relativeOut(candidatesFile)}`,
    "",
    "## Next Commands",
    "",
    "```sh",
    commands.monitorRun,
    commands.groupWatch,
    commands.importGroups,
    commands.importDownloads,
    commands.coverage,
    `open ${shellQuote(outputPath(watch.html || "monitoring/facebook-watch.html"))}`,
    commands.captureInbox,
    commands.scan,
    commands.digest,
    commands.markSeen,
    commands.publishPreview,
    commands.publishApply,
    "```",
    "",
    "Private Facebook group posts still need a logged-in browser session. This monitor only organizes the watch/capture/review loop."
  ].join("\n") + "\n";
  fs.writeFileSync(outputPath(out), md);
  if (opts.open) childProcess.spawnSync("open", [outputPath(watch.html || "monitoring/facebook-watch.html")], { stdio: "ignore" });
  const summary = {
    out: relativeOut(out),
    watchHtml: relativeOut(watch.html || "monitoring/facebook-watch.html"),
    openScript: relativeOut(watch.openScript),
    groupWatchHtml: relativeOut(groupWatch.html),
    groupWatchOpenScript: relativeOut(groupWatch.openScript),
    digest: relativeOut(digestFile),
    groups: snapshot.groups,
    watchedGroups: snapshot.watchedGroups,
    skippedGroups: snapshot.skippedGroups,
    searches: watch.searches,
    groupSweepGroups: groupWatch.groups,
    totalSearches: watch.totalSearches,
    rotation: watch.rotation,
    focusedGroups: watch.focusedGroups,
    inboxFiles: snapshot.inboxFiles,
    inboxPosts: snapshot.inboxPosts,
    sweepMarkers: snapshot.sweepMarkers,
    candidates: snapshot.candidates,
    candidateStatus: snapshot.candidateStatus,
    groupCoverage: {
      freshGroups: coverage.freshGroups,
      staleGroups: coverage.staleGroups,
      neverCapturedGroups: coverage.neverCapturedGroups,
      listingPosts: coverage.listingPosts,
      passVerifyCandidates: coverage.passVerifyCandidates,
      rejectedCandidates: coverage.rejectedCandidates,
      duplicateCandidates: coverage.duplicateCandidates,
      overBudgetCandidates: coverage.overBudgetCandidates
    },
    opened: Boolean(opts.open),
    openedGroupWatch: Boolean(opts["open-group-watch"]),
    openedLinks: Boolean(opts["open-links"] || opts.openLinks),
    setupGaps: setupLines,
    commands
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function runMonitorLoop(opts = {}) {
  const inboxDir = opts.inbox || opts["out-dir"] || "monitoring/facebook-inbox";
  const state = opts.state || DEFAULT_STATE_PATH;
  const groupsOut = opts["groups-out"] || "monitoring/facebook-groups.local.json";
  const candidatesFile = opts.out || opts.candidates || DEFAULT_CANDIDATES_PATH;
  const snippetsFile = opts.snippets || "monitoring/facebook-candidates.generated.js";
  const review = opts.review || "monitoring/facebook-review.html";
  const digest = opts.digest || DEFAULT_DIGEST_PATH;
  const coverageMd = opts.coverage || DEFAULT_COVERAGE_PATH;
  const coverageHtml = opts["coverage-html"] || DEFAULT_COVERAGE_HTML_PATH;
  const watchHtml = opts.html || "monitoring/facebook-watch.html";
  const groupWatchMd = opts["group-watch"] || DEFAULT_GROUP_WATCH_PATH;
  const groupWatchHtml = opts["group-watch-html"] || DEFAULT_GROUP_WATCH_HTML_PATH;
  const groupWatchScript = opts["group-watch-script"] || DEFAULT_GROUP_OPEN_SCRIPT_PATH;
  const discoveryMd = opts.discovery || "monitoring/facebook-discovery.md";
  const discoveryHtml = opts["discovery-html"] || "monitoring/facebook-discovery.html";
  const discoveryScript = opts["discovery-script"] || "monitoring/facebook-open-discovery.sh";
  const openWatch = Boolean(opts.open || opts["open-watch"]) && !opts["no-open-watch"];
  const openGroupWatch = Boolean(opts.open || opts["open-group-watch"]) && !opts["no-open-group-watch"];
  const openReview = Boolean(opts.open || opts["open-review"]) && !opts["no-open-review"];
  const importDownloads = !opts["no-downloads"];
  const importGroups = !opts["no-groups"];
  const housingOnly = !opts["no-housing-only"];
  const generateDiscovery = !opts["no-discovery"];
  const downloads = importDownloads ? runDownloads({
    ...opts,
    groups: importGroups,
    "housing-only": housingOnly,
    "out-dir": inboxDir,
    "groups-out": groupsOut,
    state,
    quiet: true
  }) : {
    downloadsDir: resolveFsPath(opts["downloads-dir"] || path.join(process.env.HOME || ".", "Downloads")),
    scanned: 0,
    imported: 0,
    skipped: 0,
    posts: 0,
    groupFilesImported: 0,
    state,
    inboxDir,
    groupsOut,
    imports: [],
    skippedFiles: []
  };
  const scan = runScan({
    ...opts,
    inbox: inboxDir,
    out: candidatesFile,
    snippets: snippetsFile,
    review,
    digest,
    state,
    open: false,
    quiet: true
  });
  const next = runNext({
    ...opts,
    out: opts.next || "monitoring/facebook-next.md",
    watch: opts.watch || "monitoring/facebook-watch.md",
    html: watchHtml,
    script: opts.script || "monitoring/facebook-open-watch.sh",
    "group-watch": groupWatchMd,
    "group-watch-html": groupWatchHtml,
    "group-watch-script": groupWatchScript,
    candidates: candidatesFile,
    review,
    limit: opts.limit || 40,
    state,
    open: openWatch,
    "open-group-watch": openGroupWatch,
    "open-links": opts["open-links"] || opts.openLinks,
    quiet: true
  });
  const loopConfig = loadConfig({ ...opts, "groups-out": groupsOut });
  const snapshot = monitorSnapshot(loopConfig, {
    ...opts,
    inbox: inboxDir,
    candidates: candidatesFile,
    state
  });
  const coverageReport = coverageFiles(loopConfig, groupCaptureCoverage(loopConfig, {
    ...opts,
    inbox: inboxDir,
    state
  }), {
    ...opts,
    out: coverageMd,
    html: coverageHtml
  });
  const discovery = generateDiscovery ? generateGroupDiscovery({
    ...opts,
    out: discoveryMd,
    html: discoveryHtml,
    script: discoveryScript,
    open: false,
    quiet: true
  }) : null;
  const openDiscovery = Boolean(opts.open || opts["open-discovery"] || (openWatch && !snapshot.groups)) && !opts["no-open-discovery"];
  if (openDiscovery && discovery) childProcess.spawnSync("open", [outputPath(discovery.html)], { stdio: "ignore" });
  if (openReview) childProcess.spawnSync("open", [outputPath(review)], { stdio: "ignore" });
  const summary = {
    generatedAt: new Date().toISOString(),
    downloads,
    scan,
    next,
    coverage: coverageReport,
    discovery,
    status: snapshot,
    opened: {
      watch: openWatch,
      groupWatch: openGroupWatch,
      watchLinks: Boolean(opts["open-links"] || opts.openLinks),
      review: openReview,
      discovery: openDiscovery
    },
    commands: {
      run: "node scripts/facebook-monitor.mjs run --open-group-watch --open-review",
      discover: "node scripts/facebook-monitor.mjs discover --open",
      review: `open ${shellQuote(outputPath(review))}`,
      digest: `open ${shellQuote(outputPath(digest))}`,
      coverage: `open ${shellQuote(outputPath(coverageHtml))}`,
      groupWatch: `open ${shellQuote(outputPath(groupWatchHtml))}`,
      watch: `open ${shellQuote(outputPath(watchHtml))}`,
      discovery: discovery ? `open ${shellQuote(outputPath(discovery.html))}` : null,
      markSeen: "node scripts/facebook-monitor.mjs scan --update-state",
      publish: `node scripts/facebook-monitor.mjs publish ${candidatesFile} --select <handle-or-hash> --apply`
    }
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
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
  const url = primaryFacebookLeadUrl([item.url, ...links], item.pageUrl);
  return {
    file,
    capturedAt: item.capturedAt || null,
    pageTitle: item.pageTitle || item.group || "",
    pageUrl: item.pageUrl || "",
    url,
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

function candidateShortHash(c) {
  return String(c.textHash || "").slice(0, 10);
}

function isPublishable(c) {
  return c.status === "pass" || c.status === "verify";
}

function isKnownOverBudget(c, config) {
  return c.pricePerBedroom !== null &&
    c.pricePerBedroom !== undefined &&
    c.pricePerBedroom > config.criteria.maxPricePerBedroom;
}

function primaryTriageBucket(c, config) {
  if (c.status === "duplicate") return "duplicates";
  if (isKnownOverBudget(c, config)) return "overBudget";
  if (c.status === "reject") return "rejected";
  if (!isPublishable(c)) return "manualReview";
  if (!c.price || c.pricePerBedroom === null || c.pricePerBedroom === undefined) return "needsPrice";
  if (!c.budgetBedrooms) return "needsBedrooms";
  if (!c.url) return "needsSource";
  if (c.shared) return "sharedRooms";
  if (c.status === "pass") return "ready";
  return "worthVerifying";
}

function triageCandidates(candidates, config) {
  const buckets = {
    ready: [],
    worthVerifying: [],
    needsPrice: [],
    needsBedrooms: [],
    needsSource: [],
    sharedRooms: [],
    manualReview: [],
    overBudget: [],
    rejected: [],
    duplicates: []
  };
  for (const candidate of candidates) {
    buckets[primaryTriageBucket(candidate, config)].push(candidate);
  }
  return buckets;
}

function triageBucketLabel(bucket) {
  return ({
    ready: "ready",
    worthVerifying: "verify",
    needsPrice: "needs price",
    needsBedrooms: "needs beds",
    needsSource: "needs source",
    sharedRooms: "shared room",
    manualReview: "manual review",
    overBudget: "over budget",
    rejected: "rejected",
    duplicates: "duplicate"
  })[bucket] || bucket;
}

function candidateInquiryMessage(c, config) {
  const details = [
    c.bedrooms ? `${c.bedrooms} bedroom` : "the listing",
    c.price ? priceLabel(c.price) : "price TBD",
    c.location || "San Francisco"
  ].filter(Boolean).join(" · ");
  const questions = [
    "Is it still available, and when could I tour it?",
    "What is the exact monthly rent, lease term, and total move-in cash due?",
    "What is the exact address or nearest cross streets?",
    "Are you the owner, manager, current tenant, or agent?"
  ];
  if (!c.price || c.pricePerBedroom === null || c.pricePerBedroom === undefined) {
    questions.unshift(`Can you confirm the rent is at or below $${config.criteria.maxPricePerBedroom.toLocaleString()}/bedroom?`);
  }
  if (!c.budgetBedrooms) {
    questions.unshift("How many bedrooms are included in the unit?");
  }
  if (c.shared) {
    questions.push("Is this a private room/shared apartment, or the full unit?");
  }
  if (c.signals.length) {
    questions.push(`Can you confirm these features: ${c.signals.slice(0, 4).join(", ")}?`);
  }
  return [
    `Hi, I saw your ${details} post and am interested.`,
    "",
    ...questions.map(question => `- ${question}`),
    "",
    "Thanks."
  ].join("\n");
}

function digestTable(candidates, config, limit = 12) {
  if (!candidates.length) return "_None right now._";
  const rows = candidates.slice(0, limit).map(c => [
    c.status,
    c.score,
    priceLabel(c.price),
    ppbLabel(c.pricePerBedroom),
    c.bedrooms ?? "?",
    c.location,
    c.signals.slice(0, 4).join(", ") || "none",
    candidateShortHash(c),
    c.url || c.pageUrl || ""
  ]);
  return [
    "| Status | Score | Price | $/bd | Beds | Location | Signals | Hash | Link |",
    "| --- | ---: | --- | --- | ---: | --- | --- | --- | --- |",
    ...rows.map(row => {
      const link = row[8] ? `[open](${row[8]})` : "verify";
      return `| ${escapeMd(row[0])} | ${row[1]} | ${escapeMd(row[2])} | ${escapeMd(row[3])} | ${escapeMd(row[4])} | ${escapeMd(row[5])} | ${escapeMd(row[6])} | \`${escapeMd(row[7])}\` | ${link} |`;
    })
  ].join("\n");
}

function generateDigestMarkdown(candidates, opts) {
  const config = loadConfig(opts);
  const out = opts.digest || DEFAULT_DIGEST_PATH;
  const generatedAt = new Date().toISOString();
  const candidateFile = opts.out || DEFAULT_CANDIDATES_PATH;
  const buckets = triageCandidates(candidates, config);
  const publishable = candidates.filter(isPublishable);
  const knownFit = publishable.filter(c => !isKnownOverBudget(c, config));
  const readyHashes = buckets.ready.map(candidateShortHash);
  const verifyHashes = buckets.worthVerifying.concat(buckets.needsPrice, buckets.needsBedrooms, buckets.needsSource).map(candidateShortHash);
  const lines = [
    "# Facebook Housing Triage Digest",
    "",
    `Generated: ${generatedAt}`,
    `Criteria: at least ${config.criteria.minBedrooms} bedrooms, known price at or below $${config.criteria.maxPricePerBedroom.toLocaleString()}/bedroom, with loft/workspace signals favored.`,
    "",
    "## Snapshot",
    "",
    `- Total scored candidates: ${candidates.length}`,
    `- Pass/verify candidates: ${publishable.length}`,
    `- Known or potentially in-budget pass/verify candidates: ${knownFit.length}`,
    `- Ready to message/review: ${buckets.ready.length}`,
    `- Worth verifying after quick source check: ${buckets.worthVerifying.length}`,
    `- Missing price: ${buckets.needsPrice.length}`,
    `- Missing bedroom count: ${buckets.needsBedrooms.length}`,
    `- Missing direct lead URL: ${buckets.needsSource.length}`,
    `- Shared-room leads: ${buckets.sharedRooms.length}`,
    `- Known over-budget/rejected/duplicate: ${buckets.overBudget.length + buckets.rejected.length + buckets.duplicates.length}`,
    "",
    "## Best Leads",
    "",
    digestTable(buckets.ready.concat(buckets.worthVerifying), config, 15),
    "",
    "## Needs Critical Info",
    "",
    digestTable(buckets.needsPrice.concat(buckets.needsBedrooms, buckets.needsSource), config, 15),
    "",
    "## Shared-Room Leads",
    "",
    digestTable(buckets.sharedRooms, config, 10),
    "",
    "## Skip Queue",
    "",
    digestTable(buckets.overBudget.concat(buckets.rejected, buckets.duplicates), config, 15),
    "",
    "## Next Actions",
    "",
    readyHashes.length
      ? `- Message or verify ready leads, then preview them with \`node scripts/facebook-monitor.mjs publish ${candidateFile} --select ${readyHashes.join(",")}\`.`
      : "- No ready leads yet; keep capturing stale groups from the watch checklist.",
    verifyHashes.length
      ? `- For missing-info leads, confirm rent, bedroom count, and direct post URL before publishing: \`${verifyHashes.slice(0, 12).join(",")}\`.`
      : "- No missing-info pass/verify leads right now.",
    "- After reviewing the digest and review page, run `node scripts/facebook-monitor.mjs scan --update-state` so old captures do not keep resurfacing.",
    "- `publish --apply` still blocks known over-budget cards and audits the feed before leaving changes in `index.html`."
  ];
  fs.writeFileSync(outputPath(out), lines.join("\n") + "\n");
  return out;
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

function extractAppScript(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  if (!match) throw new Error("Could not find the app <script> block.");
  const script = match[1];
  const cutoff = script.indexOf("const feed=document.getElementById('feed')");
  if (cutoff === -1) throw new Error("Could not find the feed render boundary.");
  return script.slice(0, cutoff);
}

function auditFeedIndex(file) {
  const html = fs.readFileSync(outputPath(file), "utf8");
  const setupScript = extractAppScript(html);
  const context = { console, result: null };
  vm.createContext(context);
  vm.runInContext(`${setupScript}
function auditRow(apt){
  return {
    handle: apt.handle,
    location: apt.location,
    price: apt.price,
    bedrooms: budgetBedroomCount(apt),
    pricePerBedroom: pricePerBedroom(apt)
  };
}
result = {
  limit: BEDROOM_BUDGET_LIMIT,
  visibleCount: ALL.length,
  overBudgetVisible: ALL.map(auditRow).filter(a => a.pricePerBedroom !== null && a.pricePerBedroom > BEDROOM_BUDGET_LIMIT),
  unknownVisible: ALL.map(auditRow).filter(a => a.pricePerBedroom === null)
};`, context);
  return context.result;
}

function generateReviewHtml(candidates, opts) {
  const config = loadConfig(opts);
  const out = opts.review || "monitoring/facebook-review.html";
  const generatedAt = new Date().toISOString();
  const candidateFile = opts.out || DEFAULT_CANDIDATES_PATH;
  const digestHref = opts.digest
    ? path.relative(path.dirname(outputPath(out)), outputPath(opts.digest)).replace(/\\/g, "/")
    : null;
  const buckets = triageCandidates(candidates, config);
  const bucketOrder = ["ready", "worthVerifying", "needsPrice", "needsBedrooms", "needsSource", "sharedRooms", "manualReview", "overBudget", "rejected", "duplicates"];
  const filterButtons = [
    `<button type="button" class="filter active" data-filter="all">All ${candidates.length}</button>`,
    ...bucketOrder
      .filter(bucket => buckets[bucket]?.length)
      .map(bucket => `<button type="button" class="filter" data-filter="${escapeHtml(bucket)}">${escapeHtml(triageBucketLabel(bucket))} ${buckets[bucket].length}</button>`)
  ].join("\n  ");
  const rows = candidates.map(c => {
    const shortHash = candidateShortHash(c);
    const publishable = isPublishable(c);
    const bucket = primaryTriageBucket(c, config);
    const publishCommand = `node scripts/facebook-monitor.mjs publish ${candidateFile} --select ${shortHash}`;
    const inquiryMessage = candidateInquiryMessage(c, config);
    return `<article class="card ${escapeHtml(c.status)} bucket-${escapeHtml(bucket)}" data-status="${escapeHtml(c.status)}" data-bucket="${escapeHtml(bucket)}">
  <header>
    ${publishable ? `<label class="pick"><input type="checkbox" data-hash="${escapeHtml(shortHash)}"> select</label>` : ""}
    <strong>${escapeHtml(c.status.toUpperCase())}</strong>
    <span class="bucket">${escapeHtml(triageBucketLabel(bucket))}</span>
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
  <p class="actions">${c.url ? `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">open lead</a>` : ""}${c.pageUrl ? `<a href="${escapeHtml(c.pageUrl)}" target="_blank" rel="noopener">source page</a>` : ""}<button type="button" data-copy-message="${escapeAttr(inquiryMessage)}">Copy inquiry</button></p>
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
.filters{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap}.toolbar button,.actions button{border:1px solid #bbb;background:#fff;border-radius:6px;padding:7px 10px;cursor:pointer}.toolbar button.active{background:#111;color:#fff;border-color:#111}.toolbar label{color:#555}.toolbar a.digest{color:#06c;white-space:nowrap}
.card{background:white;border:1px solid #ddd;border-left:7px solid #999;border-radius:8px;padding:14px;box-shadow:0 1px 3px #0001}
.pass{border-left-color:#179b55}.verify{border-left-color:#c47f17}.reject{opacity:.72;border-left-color:#cc3333}.duplicate{opacity:.65;border-left-color:#777}
header{display:flex;flex-wrap:wrap;gap:8px;color:#555}.pick{color:#111;font-weight:600}header strong{color:#111}.bucket{background:#eef1f4;border:1px solid #d8dde3;border-radius:999px;padding:1px 7px;color:#333}h2{font-size:17px;margin:10px 0 8px}p{line-height:1.45}dl{display:grid;grid-template-columns:90px 1fr;gap:5px;margin:12px 0}dt{color:#666}dd{margin:0}code,input{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}input{width:100%;padding:7px;border:1px solid #ccc;border-radius:5px}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.actions a{color:#06c}.actions button.copied{background:#eaf7ed;border-color:#9bc69f}
.hidden{display:none}
@media(max-width:720px){.toolbar{grid-template-columns:1fr 1fr}.toolbar input,.toolbar label{grid-column:1/-1}}
</style>
<h1>Facebook Housing Candidate Review</h1>
<div class="meta">Generated ${escapeHtml(generatedAt)} · ${candidates.length} candidates</div>
<section class="toolbar">
  <div class="filters">
  ${filterButtons}
  </div>
  <button type="button" id="selectPass">Select pass</button>
  <button type="button" id="selectVisible">Select visible</button>
  <button type="button" id="clearPicks">Clear</button>
  <span id="pickedCount">0 selected</span>
  <label>Batch publish command</label>
  <input id="batchCommand" readonly value="">
  <button type="button" id="copyBatch">Copy command</button>
  ${digestHref ? `<a class="digest" href="${escapeHtml(digestHref)}">Open digest</a>` : ""}
</section>
<main class="grid">
${rows || "<p>No candidates yet. Open the watch batch while logged into Facebook, click the Capture FB Housing bookmarklet on promising pages, then rerun <code>node scripts/facebook-monitor.mjs run --open-review</code>.</p>"}
</main>
<script>
const candidateFile=${js(candidateFile)};
const picks=[...document.querySelectorAll('input[data-hash]')];
const cards=[...document.querySelectorAll('.card')];
const count=document.getElementById('pickedCount');
const batch=document.getElementById('batchCommand');
function updateBatch(){
  const selected=picks.filter(p=>p.checked).map(p=>p.dataset.hash);
  count.textContent=selected.length+" selected";
  batch.value=selected.length ? "node scripts/facebook-monitor.mjs publish "+candidateFile+" --select "+selected.join(",") : "";
}
picks.forEach(p=>p.addEventListener('change',updateBatch));
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{
  const filter=button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));
  cards.forEach(card=>card.classList.toggle('hidden',filter!=='all' && card.dataset.bucket!==filter));
}));
document.getElementById('selectPass').addEventListener('click',()=>{picks.forEach(p=>{if(p.closest('.pass')) p.checked=true});updateBatch();});
document.getElementById('selectVisible').addEventListener('click',()=>{picks.forEach(p=>{if(!p.closest('.card').classList.contains('hidden')) p.checked=true});updateBatch();});
document.getElementById('clearPicks').addEventListener('click',()=>{picks.forEach(p=>p.checked=false);updateBatch();});
document.getElementById('copyBatch').addEventListener('click',()=>{if(batch.value) navigator.clipboard.writeText(batch.value);});
document.querySelectorAll('[data-copy-message]').forEach(button=>{
  const label=button.textContent;
  button.addEventListener('click',async()=>{
    const message=button.dataset.copyMessage;
    try{await navigator.clipboard.writeText(message);}
    catch{window.prompt('Copy inquiry',message);}
    button.textContent='Copied';
    button.classList.add('copied');
    setTimeout(()=>{button.textContent=label;button.classList.remove('copied');},1200);
  });
});
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
  const config = loadConfig(opts);
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

  const digest = opts.digest ? generateDigestMarkdown(candidates, opts) : null;
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
  const summary = {
    scannedPosts: posts.length,
    candidates: candidates.length,
    seenBefore: candidates.filter(c => c.seenBefore).length,
    pass: candidates.filter(c => c.status === "pass").length,
    verify: candidates.filter(c => c.status === "verify").length,
    rejected: candidates.filter(c => c.status === "reject").length,
    duplicate: candidates.filter(c => c.status === "duplicate").length,
    out: opts.out || null,
    snippets: opts.snippets || null,
    digest,
    review,
    state: opts.state || null,
    stateUpdated: Boolean(opts["update-state"] && statePath),
    top
  };
  if (!opts.quiet) console.log(JSON.stringify(summary, null, 2));

  if (opts["update-state"] && statePath) {
    const next = {
      ...state,
      updatedAt: new Date().toISOString(),
      seenHashes: [...new Set([...(state.seenHashes || []), ...posts.map(post => crypto.createHash("sha1").update(post.text).digest("hex"))])].sort()
    };
    fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n");
  }
  return summary;
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
  const config = loadConfig(opts);
  const overBudgetSelected = selected.filter(c =>
    c.pricePerBedroom !== null &&
    c.pricePerBedroom !== undefined &&
    c.pricePerBedroom > config.criteria.maxPricePerBedroom
  );
  if (overBudgetSelected.length) {
    console.error(`Refusing to publish over-budget candidates: ${overBudgetSelected.map(c => `${c.handle} (${ppbLabel(c.pricePerBedroom)})`).join(", ")}`);
    process.exit(1);
  }

  let audit = null;
  if (opts.apply) {
    const nextIndexText = insertSnippetsIntoIndex(indexText, snippets);
    fs.writeFileSync(indexFile, nextIndexText);
    audit = auditFeedIndex(indexFile);
    if (audit.overBudgetVisible.length) {
      fs.writeFileSync(indexFile, indexText);
      console.error(`Refusing to publish because the feed audit found visible over-budget cards: ${audit.overBudgetVisible.map(c => `${c.handle} (${ppbLabel(Math.round(c.pricePerBedroom))})`).join(", ")}`);
      process.exit(1);
    }
  }

  console.log(JSON.stringify({
    selected: selected.map(c => ({ handle: c.handle, status: c.status, score: c.score, price: priceLabel(c.price), ppb: ppbLabel(c.pricePerBedroom) })),
    applied: Boolean(opts.apply),
    index: opts.index || "index.html",
    audit: audit ? {
      visibleCount: audit.visibleCount,
      overBudgetVisible: audit.overBudgetVisible.length,
      unknownVisible: audit.unknownVisible.length
    } : null,
    snippets: snippets.join("\n")
  }, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
const { args, opts } = parseArgs(rest);

if (!cmd || cmd === "help") {
  usage();
} else if (cmd === "searches") {
  writeSearches(generateSearches(loadConfig(opts)), opts);
} else if (cmd === "setup") {
  runSetup(opts);
} else if (cmd === "discover") {
  generateGroupDiscovery(opts);
} else if (cmd === "watch") {
  generateWatchBatch(loadConfig(opts), opts);
} else if (cmd === "group-watch") {
  generateGroupWatchBatch(loadConfig(opts), opts);
} else if (cmd === "bookmarklet") {
  generateBookmarklet(opts);
} else if (cmd === "seed-groups") {
  try {
    runSeedGroups(opts);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
} else if (cmd === "groups") {
  try {
    runGroups(args, opts);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
} else if (cmd === "group-status") {
  try {
    runGroupStatus(args, opts);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
} else if (cmd === "status") {
  runStatus(opts);
} else if (cmd === "doctor") {
  runDoctor(opts);
} else if (cmd === "coverage") {
  runCoverage(opts);
} else if (cmd === "run") {
  runMonitorLoop(opts);
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
