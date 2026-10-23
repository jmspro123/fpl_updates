# FPL Telegram bot on Cloudflare Workers

This Worker receives Telegram webhooks and answers FPL commands for the league associated with the current chat. It replaces the continuously polling `fpl_bot.py` process for hosted command replies. The Tuesday scheduled update remains in GitHub Actions and is unchanged.

Available Telegram commands:

- `/score` — league score and prize summary.
- `/table` — overall standings and points behind the leader.
- `/form` — standings over the last five available gameweeks.
- `/gw` — latest gameweek standings.
- `/rival` — select two managers from Telegram buttons to compare them; typed names still work as well.
- `/banter` — friendly weekly bragging-rights recap.
- `/fixtures` — next gameweek’s fixtures and the toughest upcoming fixture runs.
- `/team` — select a manager from Telegram buttons to view their picks, captain, vice-captain, and bench when FPL makes the picks available. A typed manager name still works too.

After deploying a version that adds callback buttons, call the protected `/setup` endpoint once again so Telegram registers callback-query updates with the webhook. No new secret or Cloudflare variable is needed.

## Deploy from GitHub

1. Create/sign in to a Cloudflare account and open **Workers & Pages**.
2. Choose **Create application** → **GitHub** and select `jmspro123/fpl_updates`.
3. Set the root directory to `cloudflare`, leave the build command blank, and set the deploy command to `npm run deploy`. The Worker configuration and its matching Worker name are in `wrangler.jsonc`.
4. Deploy the Worker. In its **Settings → Variables and Secrets**, add these as encrypted secrets:
   - `TG_TOKEN`
   - `FPL_LEAGUE_ID`
   - `TG_CHAT_ID`
   - `FPL_LEAGUE_ID_2`
   - `TG_CHAT_ID_2`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `SETUP_SECRET`

Generate two different random values for `TELEGRAM_WEBHOOK_SECRET` and `SETUP_SECRET`. Telegram webhook secrets must use only letters, numbers, underscores, and hyphens. Do not put any secret in this repository or paste it into chat.

5. After deployment, test `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/health`; it should return `FPL score bot is ready.`
6. Register Telegram's webhook by making a POST request to `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/setup` with an `Authorization: Bearer YOUR_SETUP_SECRET` header. For example, in a terminal, replace the URL, then enter your setup secret when prompted (input is hidden):

   ```sh
   read -s "SETUP_SECRET?Cloudflare SETUP_SECRET: "
   echo
   curl -X POST "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/setup" \
     -H "Authorization: Bearer $SETUP_SECRET"
   unset SETUP_SECRET
   ```

   A successful response contains `"ok":true`. The setup endpoint uses the token stored in Cloudflare to register the Worker webhook with Telegram.

7. Test `/score` in both configured Telegram groups. The main chat maps to the quarter standings, and the second chat maps to the four-week standings.

## Important

- Telegram allows either webhook delivery or `getUpdates` polling, not both. Stop any local `python fpl_bot.py` process before registering the webhook. The GitHub scheduled script can continue sending messages with the same Telegram token; it does not poll updates.
- If you later switch back to polling, delete the webhook first using Telegram's `deleteWebhook` method.
- Cloudflare's Free Workers plan has published request and CPU limits. This low-volume bot should be within them, but review the current [Workers pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/) for the current terms.
- The FPL API may return the latest available snapshot rather than live points.