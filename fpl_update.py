import json
import os
from datetime import datetime

import requests

BASE = 'https://fantasy.premierleague.com/api'
HEADERS = {'User-Agent': 'Mozilla/5.0'}
TOKEN = os.environ.get('TG_TOKEN')


def get(path):
    return requests.get(f'{BASE}/{path}', headers=HEADERS, timeout=20).json()


def get_history_rows(league_id):
    members = get(f'leagues-classic/{league_id}/standings/')['standings']['results']
    rows = []
    for member in members:
        hist = get(f"entry/{member['entry']}/history/")['current']
        rows.append((member['player_name'], hist))
    return rows


def net(event):
    return event['points'] - event['event_transfers_cost']


def build_quarter_message(data, gw):
    quarters = [(1, 9), (10, 18), (19, 27), (28, 38)]
    quarter_number, (start, end) = next(
        (number, bounds)
        for number, bounds in enumerate(quarters, start=1)
        if bounds[0] <= gw <= bounds[1]
    )

    rows = []
    for name, hist in data:
        quarter_points = sum(net(e) for e in hist if start <= e['event'] <= gw)
        season_points = sum(net(e) for e in hist if e['event'] <= gw)
        this_gw = sum(net(e) for e in hist if e['event'] == gw)
        rows.append((name, this_gw, quarter_points, season_points))

    quarter_rows = sorted(rows, key=lambda r: r[2], reverse=True)
    season_rows = sorted(rows, key=lambda r: r[3], reverse=True)

    lines = [
        f'⚽ FPL update: GW{gw}',
        f'Quarter {quarter_number} standings (GW{start}–{end}; through GW{gw}):',
    ]
    for i, (name, this_gw, quarter_points, _) in enumerate(quarter_rows, start=1):
        lines.append(f'{i}. {name}: {quarter_points} pts (GW: {this_gw})')

    top_two = quarter_rows[:2]
    bottom_two = quarter_rows[-2:]
    lines.extend([
        '',
        '🍗 Gets free Wingstop: ' + ', '.join(row[0] for row in top_two),
        '🍗 Pays for Wingstop (up to $15 each): ' + ', '.join(row[0] for row in bottom_two),
        '',
        f'🏆 Overall leader: {season_rows[0][0]} ({season_rows[0][3]} pts) — jersey winner; the rest split the cost evenly.',
    ])
    return '\n'.join(lines)


def build_four_week_message(data, gw):
    if gw >= 33:
        block_start, block_end = 33, 38
        block_label = 'GW33–GW38'
    else:
        block_start = (gw - 1) // 4 * 4 + 1
        block_end = min(block_start + 3, 32)
        block_label = f'GW{block_start}–GW{block_end}'

    rows = []
    for name, hist in data:
        block_points = sum(net(e) for e in hist if block_start <= e['event'] <= gw and e['event'] <= block_end)
        season_points = sum(net(e) for e in hist if e['event'] <= gw)
        this_gw = sum(net(e) for e in hist if e['event'] == gw)
        rows.append((name, this_gw, block_points, season_points))

    block_rows = sorted(rows, key=lambda r: r[2], reverse=True)
    season_rows = sorted(rows, key=lambda r: r[3], reverse=True)

    lines = [
        f'⚽ FPL update: GW{gw}',
        f'4GW block: {block_label} (through GW{gw})',
    ]
    for i, (name, this_gw, block_points, _) in enumerate(block_rows, start=1):
        lines.append(f'{i}. {name}: {block_points} pts (GW: {this_gw})')

    top_two = block_rows[:2]
    bottom_two = block_rows[-2:]
    overall_top_two = season_rows[:2]
    overall_bottom_two = season_rows[-2:]
    lines.extend([
        '',
        '☕ Top 2 get coffee: ' + ', '.join(row[0] for row in top_two),
        '☕ Bottom 2 pay for coffee (up to $5 each): ' + ', '.join(row[0] for row in bottom_two),
        '',
        '🍽️ Overall top 2 get meal: ' + ', '.join(row[0] for row in overall_top_two),
        '🍽️ Overall bottom 2 pay (up to $30 each): ' + ', '.join(row[0] for row in overall_bottom_two),
    ])
    return '\n'.join(lines)


def send_league_update(league_id, chat_id, mode):
    if not TOKEN:
        return

    data = get_history_rows(league_id)
    gw = max(e['event'] for _, hist in data for e in hist)
    if mode == 'quarter':
        text = build_quarter_message(data, gw)
    elif mode == 'four_week':
        text = build_four_week_message(data, gw)
    else:
        raise ValueError(f'Unsupported mode: {mode}')

    requests.post(
        f'https://api.telegram.org/bot{TOKEN}/sendMessage',
        data={'chat_id': chat_id, 'text': text},
    )


def build_snapshot_rows(data, gw, mode):
    if mode == 'quarter':
        quarters = [(1, 9), (10, 18), (19, 27), (28, 38)]
        quarter_number, (start, end) = next(
            (number, bounds)
            for number, bounds in enumerate(quarters, start=1)
            if bounds[0] <= gw <= bounds[1]
        )
        rows = []
        for name, hist in data:
            quarter_points = sum(net(e) for e in hist if start <= e['event'] <= gw)
            season_points = sum(net(e) for e in hist if e['event'] <= gw)
            this_gw = sum(net(e) for e in hist if e['event'] == gw)
            rows.append((name, this_gw, quarter_points, season_points))
        ranked = sorted(rows, key=lambda item: item[2], reverse=True)
        return [
            [
                datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'),
                gw,
                rank,
                name,
                this_gw,
                quarter_points,
                season_points,
                f'Quarter {quarter_number}',
            ]
            for rank, (name, this_gw, quarter_points, season_points) in enumerate(ranked, start=1)
        ]

    if mode == 'four_week':
        if gw >= 33:
            block_start, block_end = 33, 38
        else:
            block_start = (gw - 1) // 4 * 4 + 1
            block_end = min(block_start + 3, 32)
        rows = []
        for name, hist in data:
            block_score = sum(net(e) for e in hist if block_start <= e['event'] <= gw and e['event'] <= block_end)
            season_score = sum(net(e) for e in hist if e['event'] <= gw)
            this_gw = sum(net(e) for e in hist if e['event'] == gw)
            rows.append((name, this_gw, block_score, season_score))
        ranked = sorted(rows, key=lambda item: item[2], reverse=True)
        return [
            [
                datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'),
                gw,
                rank,
                name,
                this_gw,
                block_points,
                season_points,
                f'GW{block_start}–GW{block_end}',
            ]
            for rank, (name, this_gw, block_points, season_points) in enumerate(ranked, start=1)
        ]

    return []


def export_snapshot_to_google_sheet(league_id, spreadsheet_id, mode):
    if not spreadsheet_id:
        return

    creds_json = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON')
    if not creds_json:
        return

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        return

    service = build(
        'sheets',
        'v4',
        credentials=service_account.Credentials.from_service_account_info(
            json.loads(creds_json),
            scopes=['https://www.googleapis.com/auth/spreadsheets'],
        ),
    )

    data = get_history_rows(league_id)
    gw = max(e['event'] for _, hist in data for e in hist)
    rows = build_snapshot_rows(data, gw, mode)
    if not rows:
        return

    headers = ['timestamp', 'gw', 'rank', 'name', 'this_gw', 'block_points', 'season_points', 'period']
    service.spreadsheets().values().append(
        spreadsheetId=spreadsheet_id,
        range='Sheet1',
        valueInputOption='RAW',
        insertDataOption='INSERT_ROWS',
        body={'values': [headers] + rows},
    ).execute()


def run_configured_leagues():
    main_league_id = os.environ.get('FPL_LEAGUE_ID')
    main_chat_id = os.environ.get('TG_CHAT_ID')
    if main_league_id and main_chat_id:
        send_league_update(main_league_id, main_chat_id, os.environ.get('FPL_MODE', 'quarter'))
        export_snapshot_to_google_sheet(main_league_id, os.environ.get('FPL_LEAGUE_SHEET_ID'), 'quarter')

    second_league_id = os.environ.get('FPL_LEAGUE_ID_2')
    second_chat_id = os.environ.get('TG_CHAT_ID_2')
    if second_league_id and second_chat_id:
        send_league_update(second_league_id, second_chat_id, os.environ.get('FPL_MODE_2', 'four_week'))
        export_snapshot_to_google_sheet(second_league_id, os.environ.get('FPL_LEAGUE_SHEET_ID_2'), 'four_week')


if __name__ == '__main__':
    run_configured_leagues()

