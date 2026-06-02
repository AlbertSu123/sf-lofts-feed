# SF Lofts Feed

Static GitHub Pages feed for SF apartment/loft leads.

## Facebook Monitoring

Facebook private groups do not expose a clean public feed, so the efficient path is a human-in-the-browser monitor:

1. Add private group URLs to `monitoring/facebook-groups.local.json` using the example in `monitoring/facebook-monitor.config.json`.
2. Generate the watch batch:

```sh
node scripts/facebook-monitor.mjs watch --html monitoring/facebook-watch.html --limit 40
```

3. Open `monitoring/facebook-watch.html`, then work through the links while logged into Facebook. Use the capture snippet in `monitoring/facebook-capture-snippet.js` on each results page or group search page.
4. Save the copied JSON into `monitoring/facebook-inbox/YYYY-MM-DD-group-name.json`.
5. Score and dedupe the captures:

```sh
node scripts/facebook-monitor.mjs score monitoring/facebook-inbox/*.json --out monitoring/facebook-candidates.json --snippets monitoring/facebook-candidates.generated.js
```

6. Review candidates. To preview an app-ready card for a selected handle or hash:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash>
```

7. After verifying availability and poster identity, apply selected cards to the app:

```sh
node scripts/facebook-monitor.mjs publish monitoring/facebook-candidates.json --select <handle-or-hash> --apply
```

You can still generate a plain search queue when you do not need the full watch batch:

```sh
node scripts/facebook-monitor.mjs searches --out monitoring/facebook-searches.md
```

The monitor enforces the current search rule: known-priced listings over `$2,500` per bedroom are rejected.
