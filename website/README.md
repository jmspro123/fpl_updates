# FPL League Room

This static dashboard tracks the two configured classic leagues. It shows current standings, recent form, rank movement, season/gameweek charts, and end-of-season forecasts.

The forecast uses only completed gameweeks, blending season scoring average with recent form. Simulated title chances and likely finishing-point ranges are illustrative estimates, not guaranteed outcomes.

The public FPL API data is refreshed and published by `.github/workflows/pages.yml` when the dashboard changes, on an hourly schedule, or when the workflow is run manually. The generated `data.json` is published with the page and is not committed to the repository.

Before the first deployment, open the repository's **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. The first workflow run cannot enable Pages itself with GitHub's default workflow token.

After deployment, the public dashboard is available at [jmspro123.github.io/fpl_updates](https://jmspro123.github.io/fpl_updates/).

To preview locally:

```sh
mkdir -p /tmp/fpl-dashboard
cp website/index.html /tmp/fpl-dashboard/index.html
python website/build_data.py --output /tmp/fpl-dashboard/data.json
python -m http.server 8000 --directory /tmp/fpl-dashboard
```

Open `http://localhost:8000`. The site and its league data are public when published with GitHub Pages.
