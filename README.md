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
5. Save the copied JSON into the local inbox:

```sh
node scripts/facebook-monitor.mjs inbox --from-clipboard --name <group-or-search-name>
```

If clipboard access is awkward, paste into stdin instead:

```sh
pbpaste | node scripts/facebook-monitor.mjs inbox - --name <group-or-search-name>
```

6. Score, dedupe, and open the review page:

```sh
node scripts/facebook-monitor.mjs scan --open
```

7. After reviewing the scored output, mark scanned posts as seen:

```sh
node scripts/facebook-monitor.mjs scan --update-state
```

8. To manually run scoring with every option:

```sh
node scripts/facebook-monitor.mjs score monitoring/facebook-inbox/*.json --out monitoring/facebook-candidates.json --snippets monitoring/facebook-candidates.generated.js --review monitoring/facebook-review.html --state monitoring/facebook-monitor-state.json --new-only
open monitoring/facebook-review.html
```

9. Review candidates. To preview an app-ready card for a selected handle or hash:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash>
```

The review page also lets you select multiple pass/verify cards and copy a batch publish command.

10. After verifying availability and poster identity, apply selected cards to the app:

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
