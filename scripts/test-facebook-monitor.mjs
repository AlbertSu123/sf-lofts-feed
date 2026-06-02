#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function run(args, opts = {}) {
  const result = childProcess.spawnSync(process.execPath, ["scripts/facebook-monitor.mjs", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    ...opts
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    throw new Error(`facebook-monitor ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  assert(actualText === expectedText, `${label}\nexpected ${expectedText}\nactual   ${actualText}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sf-lofts-facebook-monitor-test-"));

const priceCases = path.join(tmp, "price-cases.json");
fs.writeFileSync(priceCases, JSON.stringify([
  {
    capturedAt: "2026-06-02T11:10:00.000Z",
    pageTitle: "Synthetic",
    pageUrl: "https://www.facebook.com/groups/synthetic.sf.housing",
    url: "https://www.facebook.com/groups/synthetic.sf.housing/posts/1",
    text: "Available now: 2 bedroom loft in SoMa with office nook and live work feel. Rent is $5,500 per month, security deposit is $1,000. Garage parking and rooftop included."
  },
  {
    capturedAt: "2026-06-02T11:10:00.000Z",
    pageTitle: "Synthetic",
    pageUrl: "https://www.facebook.com/groups/synthetic.sf.housing",
    url: "https://www.facebook.com/groups/synthetic.sf.housing/posts/2",
    text: "Lease takeover for a 2 bedroom Mission loft with den and patio. $4,200/mo rent, $1,500 deposit. Great workspace, warehouse windows, and in-unit laundry."
  },
  {
    capturedAt: "2026-06-02T11:10:00.000Z",
    pageTitle: "Synthetic",
    pageUrl: "https://www.facebook.com/groups/synthetic.sf.housing",
    url: "https://www.facebook.com/groups/synthetic.sf.housing/posts/3",
    text: "Application post for a 2 bedroom apartment with office in San Francisco. Security deposit $2,500 and application fee due after tour; rent details will be shared later."
  },
  {
    capturedAt: "2026-06-02T11:10:00.000Z",
    pageTitle: "Synthetic",
    pageUrl: "https://www.facebook.com/groups/synthetic.sf.housing",
    url: "https://www.facebook.com/groups/synthetic.sf.housing/posts/4",
    text: "Two bedroom live work apartment near Dogpatch. $5,200 total rent, or $2,600 each, plus $1,000 security deposit. Loft ceilings and garage parking."
  }
], null, 2));

const candidatesFile = path.join(tmp, "candidates.json");
run([
  "score",
  priceCases,
  "--out", candidatesFile,
  "--snippets", path.join(tmp, "snippets.js"),
  "--digest", path.join(tmp, "digest.md"),
  "--review", path.join(tmp, "review.html"),
  "--all",
  "--quiet"
]);
const candidates = JSON.parse(fs.readFileSync(candidatesFile, "utf8"));
assertJsonEqual(
  candidates.map(c => [c.price, c.bedrooms, c.pricePerBedroom, c.status, c.shared]),
  [
    [4200, 2, 2100, "pass", false],
    [5500, 2, 2750, "reject", false],
    [5200, 2, 2600, "reject", false],
    [null, 2, null, "verify", false]
  ],
  "price/deposit scoring cases"
);

const joinedCapture = path.join(tmp, "joined-groups.json");
const groupsFile = path.join(tmp, "groups.json");
const statusFile = path.join(tmp, "status.json");
fs.writeFileSync(joinedCapture, JSON.stringify({
  pageTitle: "Groups Feed | Facebook",
  pageUrl: "https://www.facebook.com/groups/feed/",
  groups: [
    {
      name: "SF Loft Housing Test",
      url: "https://www.facebook.com/groups/sf.loft.housing.test",
      sourceKind: "group"
    }
  ]
}, null, 2));
run([
  "groups",
  joinedCapture,
  "--housing-only",
  "--out", groupsFile,
  "--group-status", statusFile
]);
const statuses = JSON.parse(fs.readFileSync(statusFile, "utf8"));
assertJsonEqual(
  statuses.groups.map(group => [group.url, group.status, group.watch, group.quality]),
  [["https://www.facebook.com/groups/sf.loft.housing.test", "joined", true, "ok"]],
  "joined-group capture status import"
);

console.log("facebook monitor self-test passed");
