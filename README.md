# Planalytics

AI model comparisons, including the share of a weekly subscription allowance used per task.

Website: https://auckiefenstermacher19-cmd.github.io/planalytics/

The charts and model data come from the existing Planalytics page. Model data is sourced from Artificial Analysis by way of slopalytics.com; the page credits both. Subscription allowances are measured estimates, not provider guarantees. Allowance overrides and model selections stay in the visitor's browser.

## Hosting

GitHub Pages serves index.html from the main branch. No installation or server is required. The repository and website are public, like Health Tracker.

This is a published snapshot, initially checked 2026-10-26. The existing Claude daily sync still updates the Claude artifact; it does not push to this repository or update this website. No new scheduled job has been installed.

## Update

Edit page.template.html rather than the generated index.html. Using Node.js 18 or later, refresh the upstream data and regenerate the page:

```sh
node build.js
git add page.template.html build.js data.json index.html
git commit -m "Refresh Planalytics"
git push origin main
```

Check the build's final STATUS before committing. GitHub Pages republishes pushed changes. build.js parses upstream data without executing upstream code. Keep private account logs, credentials, and meter-test files out of this repository.
