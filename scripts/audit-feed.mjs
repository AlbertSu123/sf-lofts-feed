#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) opts[key] = true;
    else opts[key] = argv[++i];
  }
  return opts;
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

function auditIndex(file) {
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
    pricePerBedroom: pricePerBedroom(apt),
    facebook: /facebook/i.test([apt.tags, apt.source, apt.handle].join(" "))
  };
}
const sourceRows = APTS.concat(COMPACT.map(expand)).filter(a => !DEAD.includes(a.handle));
result = {
  limit: BEDROOM_BUDGET_LIMIT,
  sourceCount: sourceRows.length,
  visibleCount: ALL.length,
  facebookVisibleCount: ALL.filter(a => /facebook/i.test([a.tags, a.source, a.handle].join(" "))).length,
  overBudgetVisible: ALL.map(auditRow).filter(a => a.pricePerBedroom !== null && a.pricePerBedroom > BEDROOM_BUDGET_LIMIT),
  unknownVisible: ALL.map(auditRow).filter(a => a.pricePerBedroom === null),
  hiddenByBudget: sourceRows.map(auditRow).filter(a => a.pricePerBedroom !== null && a.pricePerBedroom > BEDROOM_BUDGET_LIMIT)
};`, context);
  return context.result;
}

function formatMoney(value) {
  return `$${Number(value).toLocaleString()}`;
}

function rowLabel(row) {
  const ppb = row.pricePerBedroom === null ? "unknown ppb" : `${formatMoney(Math.round(row.pricePerBedroom))}/bedroom`;
  return `${row.handle} | ${row.price} | ${row.bedrooms ?? "?"} bd | ${ppb} | ${row.location}`;
}

const opts = parseArgs(process.argv.slice(2));
const indexFile = opts.index || "index.html";
const audit = auditIndex(indexFile);
const failUnknown = Boolean(opts["fail-unknown"]);
const failed = audit.overBudgetVisible.length || (failUnknown && audit.unknownVisible.length);

if (opts.json) {
  console.log(JSON.stringify({
    index: indexFile,
    passed: !failed,
    failUnknown,
    ...audit
  }, null, 2));
} else {
  console.log(`Feed audit ${failed ? "failed" : "passed"} for ${indexFile}`);
  console.log(`Visible cards: ${audit.visibleCount} (${audit.facebookVisibleCount} Facebook-sourced)`);
  console.log(`Bedroom budget gate: <= ${formatMoney(audit.limit)} per bedroom`);
  console.log(`Visible over-budget cards: ${audit.overBudgetVisible.length}`);
  console.log(`Visible unknown price/bedroom cards: ${audit.unknownVisible.length}`);
  console.log(`Source cards hidden by budget filter: ${audit.hiddenByBudget.length}`);

  if (audit.overBudgetVisible.length) {
    console.log("\nOver-budget visible cards:");
    for (const row of audit.overBudgetVisible) console.log(`- ${rowLabel(row)}`);
  }
  if (audit.unknownVisible.length) {
    console.log("\nUnknown price/bedroom visible cards:");
    for (const row of audit.unknownVisible) console.log(`- ${rowLabel(row)}`);
  }
}

if (failed) process.exit(1);
