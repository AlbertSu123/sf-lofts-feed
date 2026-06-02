# SF Lofts Feed

Static GitHub Pages feed for SF apartment/loft leads.

## Facebook Monitoring

Facebook private groups do not expose a clean public feed, so the efficient path is a human-in-the-browser monitor:

1. Add private group URLs to `monitoring/facebook-groups.local.json` using the example in `monitoring/facebook-monitor.config.json`.

You can paste group URLs instead of editing JSON:

```sh
pbpaste | node scripts/facebook-monitor.mjs groups - --priority high
node scripts/facebook-monitor.mjs status
```

Check which configured groups have not produced a recent capture:

```sh
node scripts/facebook-monitor.mjs coverage --stale-hours 24
```

You can also run the capture bookmarklet on Facebook Groups pages such as `facebook.com/groups/feed/` or your joined-groups list, then import only housing-like groups:

```sh
pbpaste | node scripts/facebook-monitor.mjs groups - --priority high --housing-only
```

Run the full monitoring loop. This imports any new `fb-housing-capture-*.json` files from Downloads, imports housing-like groups found in those captures, scores the inbox, refreshes the review page, and creates the next stale-prioritized watch batch:

```sh
node scripts/facebook-monitor.mjs run --limit 40 --open-watch --open-review
```

`run` dedupes downloaded captures by hash in `monitoring/facebook-monitor-state.json`. It does not mark scored posts as reviewed; use `scan --update-state` after you have looked at the review page. The generated watch batch advances a local rotation cursor so large group lists are covered across multiple runs instead of showing the same first links every time. It also prioritizes stale or never-captured groups first.

Create only the next-run briefing and refreshed watch page:

```sh
node scripts/facebook-monitor.mjs next --limit 40 --open
```

Use `--no-focus-stale` to stop stale/never groups from jumping to the front, or `--no-rotate` when you want a static batch.

2. If you only need the watch batch without the next-run briefing:

```sh
node scripts/facebook-monitor.mjs watch --html monitoring/facebook-watch.html --limit 40
```

3. Install the capture bookmarklet once:

```sh
node scripts/facebook-monitor.mjs bookmarklet --out monitoring/facebook-capture-bookmarklet.html
open monitoring/facebook-capture-bookmarklet.html
```

4. Open `monitoring/facebook-watch.html`, then work through the links while logged into Facebook. Click the `Capture FB Housing` bookmarklet on each results page or group search page. It downloads a `fb-housing-capture-*.json` file and also copies the same JSON to the clipboard. You can also run it on Facebook Groups pages to discover visible group links for import.
5. Import new capture downloads into the inbox, and optionally import housing-like groups from those same captures:

```sh
node scripts/facebook-monitor.mjs downloads --groups --housing-only
```

The full loop runs this import automatically, so this command is mainly useful when you only want to ingest downloads without rescoring or refreshing the watch batch.

6. If download import is awkward, save the copied JSON into the local inbox manually:

```sh
node scripts/facebook-monitor.mjs inbox --from-clipboard --name <group-or-search-name>
```

If clipboard access is awkward, paste into stdin instead:

```sh
pbpaste | node scripts/facebook-monitor.mjs inbox - --name <group-or-search-name>
```

7. Score, dedupe, and open the review page:

```sh
node scripts/facebook-monitor.mjs scan --open
```

8. After reviewing the scored output, mark scanned posts as seen:

```sh
node scripts/facebook-monitor.mjs scan --update-state
```

9. To manually run scoring with every option:

```sh
node scripts/facebook-monitor.mjs score monitoring/facebook-inbox/*.json --out monitoring/facebook-candidates.json --snippets monitoring/facebook-candidates.generated.js --review monitoring/facebook-review.html --state monitoring/facebook-monitor-state.json --new-only
open monitoring/facebook-review.html
```

10. Review candidates. To preview an app-ready card for a selected handle or hash:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash>
```

The review page also lets you select multiple pass/verify cards and copy a batch publish command.

11. After verifying availability and poster identity, apply selected cards to the app:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash> --apply
```

To get a lightweight reminder/open-loop every 6 hours on this Mac:

```sh
scripts/install-facebook-monitor-agent.sh
```

To remove it:

```sh
scripts/uninstall-facebook-monitor-agent.sh
```

The agent imports new capture downloads, refreshes `monitoring/facebook-review.html`, creates `monitoring/facebook-next.md`, refreshes the local watch batch, opens the watch page, and shows a macOS notification; it does not scrape Facebook in the background.

You can still run a single scan prompt manually:

```sh
scripts/facebook-monitor-run.sh
```

You can also still generate a plain search queue when you do not need the full watch batch:

```sh
node scripts/facebook-monitor.mjs searches --out monitoring/facebook-searches.md
```

The monitor enforces the current search rule: known-priced listings over `$2,500` per bedroom are rejected.
