# Caltrain Watch

A small installable website for selecting a Caltrain origin and destination, viewing upcoming scheduled and realtime trains, and receiving browser notifications when a newly published cancellation or service alert affects that route.

The browser never receives the 511 API token. GitHub Actions fetches official GTFS schedules, GTFS-Realtime trip updates, and service alerts; generates `public/data/caltrain.json`; and deploys the static app to GitHub Pages.

## Features

- Saves selected stops locally.
- Shows upcoming departures, arrival times, delays, skipped stops, and cancelled trains.
- Filters service alerts to the selected stops, matching trips, and matching route.
- Offers browser notifications for newly detected relevant cancellations and alerts while the site or installed PWA is running.
- Refreshes the deployed snapshot every five minutes.
- Downloads the full official GTFS schedule at most once per day; realtime feeds refresh each run.
- Warns when updates are over 15 minutes old and suppresses outdated live status and notifications.
- Archives a real snapshot weekly to keep source useful and prevent GitHub's 60-day inactivity cutoff.
- Keeps official scheduled trains if realtime feeds fail. Demo data is only generated explicitly for development.

## Configure live data

1. Request or retrieve a token from the 511 SF Bay Open Data portal.
2. In this repository, open **Settings → Secrets and variables → Actions**.
3. Add a repository secret named `TRANSIT_511_API_KEY` containing the token.
4. Optional: add an Actions variable named `TRANSIT_511_OPERATOR_ID`. It defaults to `CT` for Caltrain.
5. Run **Refresh data and deploy Pages** from the Actions tab.

The live site is `https://diegocarra.github.io/caltrain-watch/`.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python scripts/build_data.py --demo
npm test
python -m unittest discover -s tests -p "test_*.py"
npm run serve
```

## Limitations

GitHub Actions schedules can be delayed during periods of high load, and browser notifications are not true server push. Do not rely on this project as the only source for time-critical travel decisions.

The refresh workflow needs `contents: write` for the weekly data archive. If repository policy blocks that push, scheduled workflows can become inactive again after 60 days without repository activity. In **Actions → Refresh data and deploy Pages**, enable the workflow and run it manually to recover. A cron change by a writer also reactivates it. The browser's minute-by-minute refresh only reads GitHub Pages; it never calls 511 directly.

If the official schedule download or API key fails, the deployment fails visibly and the last published site stays in place. It will show an update warning instead of claiming old trains are live or publishing fictional demo trains.

## License

MIT
