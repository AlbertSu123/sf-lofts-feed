# SF Lofts Feed

Static GitHub Pages feed for SF apartment/loft leads.

## Facebook Monitoring

Facebook private groups do not expose a clean public feed, so the efficient path is a human-in-the-browser monitor:

0. Prepare all local monitor pages and run a readiness check:

```sh
node scripts/facebook-monitor.mjs setup
```

This refreshes the bookmarklet installer, group-discovery page, watch batch, next-run briefing, review page, and doctor output. Add `--open` if you want those local pages opened after generation.

1. Discover or add private group URLs to `monitoring/facebook-groups.local.json` using the example in `monitoring/facebook-monitor.config.json`.

Bootstrap with public SF/Bay Area housing group seeds:

```sh
node scripts/facebook-monitor.mjs seed-groups
node scripts/facebook-monitor.mjs next --limit 60
```

The seed list is tracked in `monitoring/facebook-group-seeds.json`; it currently includes 21 public SF/Bay Area, USF, and SFSU housing-group surfaces. The imported local group file stays ignored by git. Keep adding your actual joined/private groups with the discovery flow below.

Generate a group-discovery page when `status.setupGaps` says no groups are configured:

```sh
node scripts/facebook-monitor.mjs discover --open
```

Open the discovery links while logged into Facebook, click the `Capture FB Housing` bookmarklet on joined-groups and group-search pages, then import the downloaded discovery captures with the normal loop:

```sh
node scripts/facebook-monitor.mjs run --open-group-watch --open-review
```

You can paste group URLs instead of editing JSON:

```sh
pbpaste | node scripts/facebook-monitor.mjs groups - --priority high
node scripts/facebook-monitor.mjs status
```

`status` includes `setupGaps`; if it reports no groups, no listing-like posts, or no candidates, the monitor still needs a logged-in Facebook capture before it can source real leads. Empty group sweeps count for group freshness but not as listing posts.

For a fuller readiness check, including pending capture downloads, generated local pages, and whether the 6-hour reminder is installed:

```sh
node scripts/facebook-monitor.mjs doctor
```

Check which configured groups have not produced a recent capture:

```sh
node scripts/facebook-monitor.mjs coverage --stale-hours 24
```

The full loop also refreshes `monitoring/facebook-coverage.html` and `monitoring/facebook-coverage.md`, which show every configured group, freshness status, last capture time, capture count, listing-post yield, pass/verify yield, and one-click group/search links. The HTML coverage page includes copy buttons for common `group-status` commands, so you can quickly mark groups as joined, pending, noisy, inaccessible, or skipped after checking them.

After opening a group, record access/quality locally so the watch queue gets sharper over time:

```sh
node scripts/facebook-monitor.mjs group-status --list
node scripts/facebook-monitor.mjs group-status sfhousing --status joined --quality good --notes "good SF-wide feed"
node scripts/facebook-monitor.mjs group-status "Bay Area Rooms and Apartments" --status noisy --watch false --notes "too many room-only posts"
```

Group status is stored in ignored `monitoring/facebook-group-status.local.json`. Statuses such as `inaccessible`, `noisy`, or `skip` default to `watch:false`, which removes that group from generated watch searches while leaving it visible in coverage.

You can also run the capture bookmarklet on Facebook Groups pages such as `facebook.com/groups/feed/` or your joined-groups list, then import only housing-like groups:

```sh
pbpaste | node scripts/facebook-monitor.mjs groups - --priority high --housing-only
```

Run the full monitoring loop. This imports any new `fb-housing-capture-*.json` files from Downloads, imports housing-like groups found in those captures, scores the inbox, refreshes the review page, and creates the next stale-prioritized watch batch:

```sh
node scripts/facebook-monitor.mjs run --limit 40 --open-group-watch --open-review
```

`--open-group-watch` opens the generated one-row-per-group sweep page, not every Facebook group URL. Open rows from that checklist as you work through them. The sweep is evidence-ranked: stale groups with prior pass/verify yield rise to the top, never-captured groups still get coverage, and low-yield/noisy groups sink unless they are overdue. Use `--open-watch` for the deeper term-search checklist, or use the generated `monitoring/facebook-open-watch.sh` / `--open-links` when you intentionally want to launch the whole search batch at once.

`run` dedupes downloaded captures by hash in `monitoring/facebook-monitor-state.json`. It does not mark scored posts as reviewed; use `scan --update-state` after you have looked at the review page. The generated watch batch advances local rotation cursors so large group lists are covered across multiple runs instead of showing the same first links every time. It also prioritizes stale or never-captured groups first and round-robins those groups so later groups do not get starved by a larger search-term list.

Create only the next-run briefing and refreshed local pages:

```sh
node scripts/facebook-monitor.mjs next --limit 40 --open-group-watch
```

Use `--no-focus-stale` to stop stale/never groups from jumping to the front, `--no-rotate` when you want a static batch, or `--open-links` when you deliberately want to open every search URL in the batch.

2. If you only need the watch batch without the next-run briefing:

```sh
node scripts/facebook-monitor.mjs watch --html monitoring/facebook-watch.html --limit 40
```

3. For a faster one-row-per-group pass, generate the group sweep page:

```sh
node scripts/facebook-monitor.mjs group-watch --open
```

Use the group sweep first when the inbox is empty or when all groups need a quick recent-post pass. Use the deeper watch batch for term-specific searches after that.

4. Install the capture bookmarklet once:

```sh
node scripts/facebook-monitor.mjs bookmarklet --out monitoring/facebook-capture-bookmarklet.html
open monitoring/facebook-capture-bookmarklet.html
```

5. Open `monitoring/facebook-group-watch.html` or `monitoring/facebook-watch.html`, then work through the links while logged into Facebook. The group sweep covers one row per watched group; the watch page covers term-specific group and Marketplace searches. Both pages include a capture checklist, bookmarklet/snippet links, persistent per-row checkoffs, and the import command. Click the `Capture FB Housing` bookmarklet on each group, results page, or group search page. It expands visible `See more` text first, prefers direct post/Marketplace/permalink URLs over group roots, downloads a `fb-housing-capture-*.json` file, and also copies the same JSON to the clipboard. Even if a group has no housing-like posts visible, importing that capture records the group as swept for freshness coverage. You can also run it on Facebook Groups pages to discover visible group links for import.
6. Import new capture downloads into the inbox, and optionally import housing-like groups from those same captures:

```sh
node scripts/facebook-monitor.mjs downloads --groups --housing-only
```

The full loop runs this import automatically, so this command is mainly useful when you only want to ingest downloads without rescoring or refreshing the watch batch.

7. If download import is awkward, save the copied JSON into the local inbox manually:

```sh
node scripts/facebook-monitor.mjs inbox --from-clipboard --name <group-or-search-name>
```

If clipboard access is awkward, paste into stdin instead:

```sh
pbpaste | node scripts/facebook-monitor.mjs inbox - --name <group-or-search-name>
```

8. Score, dedupe, and open the review page:

```sh
node scripts/facebook-monitor.mjs scan --open
```

This also refreshes `monitoring/facebook-digest.md`, a triage summary that groups pass/verify leads into ready-to-message, missing-price, missing-bedroom, shared-room, and skip queues.

9. After reviewing the scored output, mark scanned posts as seen:

```sh
node scripts/facebook-monitor.mjs scan --update-state
```

10. To manually run scoring with every option:

```sh
node scripts/facebook-monitor.mjs score monitoring/facebook-inbox/*.json --out monitoring/facebook-candidates.json --snippets monitoring/facebook-candidates.generated.js --review monitoring/facebook-review.html --digest monitoring/facebook-digest.md --state monitoring/facebook-monitor-state.json --new-only
open monitoring/facebook-review.html
```

11. Review candidates. The review page buckets leads into ready, verify, missing-info, shared-room, and skip queues; each candidate has a `Copy inquiry` button for quickly asking the poster to confirm availability, rent, bedroom count, move-in cash, address, and poster role. To preview an app-ready card for a selected handle or hash:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash>
```

The review page links to the digest and also lets you select multiple pass/verify cards and copy a batch publish command.

12. After verifying availability and poster identity, apply selected cards to the app:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash> --apply
```

`publish --apply` refuses known over-budget candidates and runs the feed audit after insertion, rolling back the edit if any known-priced card over `$2,500` per bedroom would become visible.

To get a lightweight reminder/open-loop every 6 hours on this Mac:

```sh
scripts/install-facebook-monitor-agent.sh
```

To remove it:

```sh
scripts/uninstall-facebook-monitor-agent.sh
```

The agent imports new capture downloads, refreshes `monitoring/facebook-review.html`, `monitoring/facebook-digest.md`, and `monitoring/facebook-coverage.html`, creates `monitoring/facebook-next.md`, refreshes the local group sweep and watch batch, opens the requested local page, and shows a macOS notification; it does not scrape Facebook in the background.

You can still run a single scan prompt manually:

```sh
scripts/facebook-monitor-run.sh
```

You can also still generate a plain search queue when you do not need the full watch batch:

```sh
node scripts/facebook-monitor.mjs searches --out monitoring/facebook-searches.md
```

The monitor enforces the current search rule: known-priced listings over `$2,500` per bedroom are rejected.

Before pushing feed changes, audit the rendered app data to confirm no known-priced card over that limit is visible:

```sh
node scripts/audit-feed.mjs
```
