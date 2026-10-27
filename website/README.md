# FPL League Room

This static dashboard tracks the two configured classic leagues. It shows current standings, recent form, rank movement, and season/gameweek charts.

The public FPL API data is refreshed and published by `.github/workflows/pages.yml` when the dashboard changes, on an hourly schedule, or when the workflow is run manually. The generated `data.json` is published with the page and is not committed to the repository.

To preview locally:

```sh
mkdir -p /tmp/fpl-dashboard
cp website/index.html /tmp/fpl-dashboard/index.html
python website/build_data.py --output /tmp/fpl-dashboard/data.json
python -m http.server 8000 --directory /tmp/fpl-dashboard
```

Open `http://localhost:8000`. The site and its league data are public when published with GitHub Pages.
