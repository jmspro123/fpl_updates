import os, requests

LEAGUE = os.environ["FPL_LEAGUE_ID"]
TOKEN = os.environ["TG_TOKEN"]
CHAT = os.environ["TG_CHAT_ID"]
BASE = "https://fantasy.premierleague.com/api"
H = {"User-Agent": "Mozilla/5.0"}

def get(path):
    return requests.get(f"{BASE}/{path}", headers=H, timeout=20).json()

members = get(f"leagues-classic/{LEAGUE}/standings/")["standings"]["results"]
data = []
for m in members:
    hist = get(f"entry/{m['entry']}/history/")["current"]
    data.append((m["player_name"], hist))

gw = max(e["event"] for e in data[0][1])
start = (gw - 1) // 4 * 4 + 1  # block start: GW1, 5, 9...
net = lambda e: e["points"] - e["event_transfers_cost"]

rows = []
for name, hist in data:
    block = sum(net(e) for e in hist if start <= e["event"] <= gw)
    this_gw = sum(net(e) for e in hist if e["event"] == gw)
    rows.append((name, this_gw, block))
rows.sort(key=lambda r: r[2], reverse=True)

lines = [f"⚽ FPL update: GW{gw}", f"Block: GW{start}–{start+3}", ""]
medals = ["🥇", "🥈", "🥉", "4️⃣"]
for i, (n, g, b) in enumerate(rows):
    lines.append(f"{medals[i]} {n}: {b} pts (GW: {g})")

requests.post(
    f"https://api.telegram.org/bot{TOKEN}/sendMessage",
    data={"chat_id": CHAT, "text": "\n".join(lines)},
)