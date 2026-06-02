# SF Lofts Feed

Static GitHub Pages feed for SF apartment/loft leads.

## Facebook Monitoring

Facebook private groups do not expose a clean public feed, so the efficient path is a human-in-the-browser monitor:

1. Add private group URLs to `monitoring/facebook-groups.local.json` using the example in `monitoring/facebook-monitor.config.json`.
2. Generate the watch batch:

```sh
node scripts/facebook-monitor.mjs watch --html monitoring/facebook-watch.html --limit 40
```

3. Install the capture bookmarklet once:

```sh
node scripts/facebook-monitor.mjs bookmarklet --out monitoring/facebook-capture-bookmarklet.html
open monitoring/facebook-capture-bookmarklet.html
```

4. Open `monitoring/facebook-watch.html`, then work through the links while logged into Facebook. Click the `Capture FB Housing` bookmarklet on each results page or group search page.
5. Save the copied JSON into `monitoring/facebook-inbox/YYYY-MM-DD-group-name.json`.
6. Score and dedupe the captures:

```sh
node scripts/facebook-monitor.mjs score monitoring/facebook-inbox/*.json --out monitoring/facebook-candidates.json --snippets monitoring/facebook-candidates.generated.js --review monitoring/facebook-review.html --state monitoring/facebook-monitor-state.json --new-only
open monitoring/facebook-review.html
```

7. After reviewing the scored output, mark scanned posts as seen:

```sh
node scripts/facebook-monitor.mjs score monitoring/facebook-inbox/*.json --state monitoring/facebook-monitor-state.json --update-state
```

8. Review candidates. To preview an app-ready card for a selected handle or hash:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash>
```

9. After verifying availability and poster identity, apply selected cards to the app:

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

The agent only opens the local watch batch and shows a macOS notification; it does not scrape Facebook in the background.

You can still run a single scan prompt manually:

```sh
scripts/facebook-monitor-run.sh
```

You can also still generate a plain search queue when you do not need the full watch batch:

```sh
node scripts/facebook-monitor.mjs searches --out monitoring/facebook-searches.md
```

The monitor enforces the current search rule: known-priced listings over `$2,500` per bedroom are rejected.
