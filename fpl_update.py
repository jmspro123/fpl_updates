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
quarters = [(1, 9), (10, 18), (19, 27), (28, 38)]
quarter_number, (start, end) = next(
    (number, bounds)
    for number, bounds in enumerate(quarters, start=1)
    if bounds[0] <= gw <= bounds[1]
)
net = lambda e: e["points"] - e["event_transfers_cost"]

rows = []
for name, hist in data:
    quarter_points = sum(net(e) for e in hist if start <= e["event"] <= gw)
    season_points = sum(net(e) for e in hist if e["event"] <= gw)
    this_gw = sum(net(e) for e in hist if e["event"] == gw)
    rows.append((name, this_gw, quarter_points, season_points))
quarter_rows = sorted(rows, key=lambda row: row[2], reverse=True)
season_rows = sorted(rows, key=lambda row: row[3], reverse=True)

lines = [
    f"⚽ FPL update: GW{gw}",
    f"Quarter {quarter_number} standings (GW{start}–{end}; through GW{gw}):",
]
for i, (name, this_gw, quarter_points, _) in enumerate(quarter_rows, start=1):
    lines.append(f"{i}. {name}: {quarter_points} pts (GW: {this_gw})")

top_two = quarter_rows[:2]
bottom_two = quarter_rows[-2:]
lines.extend([
    "",
    "🍗 Gets free Wingstop: " + ", ".join(row[0] for row in top_two),
    "🍗 Pays for Wingstop (up to $15 each): " + ", ".join(row[0] for row in bottom_two),
    "",
    f"🏆 Overall leader: {season_rows[0][0]} ({season_rows[0][3]} pts) — jersey winner; "
    "the rest split the cost evenly.",
])

requests.post(
    f"https://api.telegram.org/bot{TOKEN}/sendMessage",
    data={"chat_id": CHAT, "text": "\n".join(lines)},
)