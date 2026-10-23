import os
import re
import time

import requests

from fpl_update import (
    build_four_week_message,
    build_quarter_message,
    get_history_rows,
)

TOKEN = os.environ.get('TG_TOKEN')
if not TOKEN:
    raise RuntimeError('TG_TOKEN must be set before starting the bot')

BASE = 'https://fantasy.premierleague.com/api'
HEADERS = {'User-Agent': 'Mozilla/5.0'}
TELEGRAM_BASE = f'https://api.telegram.org/bot{TOKEN}'

MAIN_LEAGUE_ID = os.environ.get('FPL_LEAGUE_ID')
MAIN_CHAT_ID = os.environ.get('TG_CHAT_ID')
SECOND_LEAGUE_ID = os.environ.get('FPL_LEAGUE_ID_2')
SECOND_CHAT_ID = os.environ.get('TG_CHAT_ID_2')


def get(path):
    return requests.get(f'{BASE}/{path}', headers=HEADERS, timeout=20).json()


def send_message(chat_id, text):
    requests.post(
        f'{TELEGRAM_BASE}/sendMessage',
        data={'chat_id': chat_id, 'text': text},
        timeout=20,
    )


def build_score_text(league_id, mode):
    data = get_history_rows(league_id)
    gw = max(e['event'] for _, hist in data for e in hist)
    if mode == 'quarter':
        return build_quarter_message(data, gw)
    return build_four_week_message(data, gw)


def net_points(event):
    return event['points'] - event['event_transfers_cost']


def season_rows(data, gw):
    rows = []
    for name, history in data:
        rows.append((
            name,
            sum(net_points(event) for event in history if event['event'] <= gw),
            sum(net_points(event) for event in history if event['event'] == gw),
        ))
    return sorted(rows, key=lambda row: row[1], reverse=True)


def build_table_text(data, gw):
    rows = season_rows(data, gw)
    lines = [f'🏆 Overall standings through GW{gw}:']
    for rank, (name, points, _) in enumerate(rows, start=1):
        gap = rows[0][1] - points
        suffix = f' (-{gap})' if gap else ''
        lines.append(f'{rank}. {name}: {points} pts{suffix}')
    return '\n'.join(lines)


def build_form_text(data, gw):
    weeks = sorted({event['event'] for _, history in data for event in history if event['event'] <= gw})[-5:]
    if not weeks:
        raise ValueError('No gameweek history is available yet.')
    rows = sorted((
        (name, sum(net_points(event) for event in history if event['event'] in weeks))
        for name, history in data
    ), key=lambda row: row[1], reverse=True)
    lines = [f'🔥 Form over GW{weeks[0]}–GW{weeks[-1]}:']
    lines.extend(f'{rank}. {name}: {points} pts' for rank, (name, points) in enumerate(rows, start=1))
    return '\n'.join(lines)


def build_gameweek_text(data, gw):
    rows = sorted((
        (name, sum(net_points(event) for event in history if event['event'] == gw))
        for name, history in data
    ), key=lambda row: row[1], reverse=True)
    lines = [f'⚡ GW{gw} league table:']
    lines.extend(f'{rank}. {name}: {points} pts' for rank, (name, points) in enumerate(rows, start=1))
    return '\n'.join(lines)


def find_manager(rows, query):
    query = query.strip().lower()
    if not query:
        return None, 'Please include a manager name, e.g. /rival Alex or /team Alex.'
    matches = [row for row in rows if query in row[0].lower()]
    if not matches:
        return None, f'No manager found matching “{query}”.'
    if len(matches) > 1:
        return None, f'More than one manager matches “{query}”. Please be more specific.'
    return matches[0], None


def build_rival_text(data, gw, query):
    weeks = sorted({event['event'] for _, rows in data for event in rows}, reverse=True)[:5]
    compare_names = re.split(r'\s+vs\s+', query, flags=re.IGNORECASE)
    if len(compare_names) > 2:
        return 'Use /rival <manager> or /rival <manager 1> vs <manager 2>.'
    managers = []
    for manager_query in compare_names:
        manager, error = find_manager(data, manager_query)
        if error:
            return error
        name, history = manager
        managers.append((
            name,
            sum(net_points(event) for event in history if event['event'] <= gw),
            sum(net_points(event) for event in history if event['event'] in weeks),
        ))
    if len(managers) == 2:
        first, second = managers
        season_leader = first[0] if first[1] >= second[1] else second[0]
        recent_leader = first[0] if first[2] >= second[2] else second[0]
        return '\n'.join([
            f'🆚 {first[0]} vs {second[0]} — GW{gw}',
            f'Season: {first[0]} {first[1]} pts, {second[0]} {second[1]} pts ({season_leader} +{abs(first[1] - second[1])})',
            f'Last {len(weeks)} GWs: {first[0]} {first[2]} pts, {second[0]} {second[2]} pts ({recent_leader} +{abs(first[2] - second[2])})',
        ])
    name, season, recent = managers[0]
    season_ranks = season_rows(data, gw)
    season_rank = next(rank for rank, row in enumerate(season_ranks, start=1) if row[0] == name)
    recent_rows = sorted((
        (manager_name, sum(net_points(event) for event in rows if event['event'] in weeks))
        for manager_name, rows in data
    ), key=lambda row: row[1], reverse=True)
    recent_rank = next(rank for rank, row in enumerate(recent_rows, start=1) if row[0] == name)
    return '\n'.join([
        f'🆚 {name} — GW{gw}',
        f'Season: {season} pts (rank {season_rank}/{len(data)})',
        f'Last {len(weeks)} GWs: {recent} pts (rank {recent_rank}/{len(data)})',
    ])


def build_banter_text(data, gw):
    season = season_rows(data, gw)
    weekly = sorted((
        (name, sum(net_points(event) for event in history if event['event'] == gw))
        for name, history in data
    ), key=lambda row: row[1], reverse=True)
    if len(season) < 2:
        return 'The league needs at least two managers before the banter can begin.'
    return '\n'.join([
        f'🎤 GW{gw} banter report:',
        f'{weekly[0][0]} takes this week’s bragging rights with {weekly[0][1]} pts.',
        f'{season[0][0]} is still top overall on {season[0][1]} pts.',
        f'{season[-1][0]}, there’s plenty of season left to turn it around!',
    ])


def build_fixtures_text():
    bootstrap = get('bootstrap-static/')
    fixtures = get('fixtures/')
    events = bootstrap.get('events', [])
    latest_gw = max((event['id'] for event in events if event.get('finished')), default=0)
    next_event = next((event for event in events if event.get('is_next')), None)
    if next_event is None:
        next_event = next((event for event in events if event['id'] > latest_gw), None)
    if next_event is None:
        return 'No upcoming fixtures are currently available.'

    teams = {team['id']: team for team in bootstrap.get('teams', [])}
    upcoming_weeks = [event['id'] for event in events if event['id'] >= next_event['id']][:5]
    next_fixtures = sorted(
        (fixture for fixture in fixtures if fixture.get('event') == next_event['id']),
        key=lambda fixture: fixture.get('kickoff_time') or '',
    )
    if not next_fixtures:
        return f"No fixtures are listed for GW{next_event['id']} yet."

    lines = [f"📅 GW{next_event['id']} fixtures:"]
    for fixture in next_fixtures:
        home = teams.get(fixture['team_h'], {}).get('short_name', 'TBC')
        away = teams.get(fixture['team_a'], {}).get('short_name', 'TBC')
        kickoff = fixture.get('kickoff_time')
        kickoff_text = f'{kickoff[:10]} {kickoff[11:16]} UTC' if kickoff else 'TBD'
        home_difficulty = fixture.get('team_h_difficulty', '?')
        away_difficulty = fixture.get('team_a_difficulty', '?')
        lines.append(f'{home} v {away} — {kickoff_text} (difficulty {home_difficulty}–{away_difficulty})')

    difficulties = {}
    for fixture in fixtures:
        if fixture.get('event') not in upcoming_weeks:
            continue
        for team_id, value in (
            (fixture['team_h'], fixture.get('team_h_difficulty')),
            (fixture['team_a'], fixture.get('team_a_difficulty')),
        ):
            if value is not None:
                difficulties.setdefault(team_id, []).append(value)
    hardest = sorted(
        ((team_id, sum(values) / len(values)) for team_id, values in difficulties.items()),
        key=lambda row: row[1], reverse=True,
    )[:3]
    if hardest:
        lines.extend(['', f'🧱 Toughest next {len(upcoming_weeks)}-GW run (avg difficulty):'])
        lines.extend(
            f"• {teams.get(team_id, {}).get('name', 'Team ' + str(team_id))}: {average:.1f}"
            for team_id, average in hardest
        )
    return '\n'.join(lines)


def build_team_text(league_id, query):
    standings = get(f'leagues-classic/{league_id}/standings/')
    members = standings.get('standings', {}).get('results', [])
    member, error = find_manager(
        [(item['player_name'], item['entry']) for item in members], query,
    )
    if error:
        return error
    name, entry_id = member
    bootstrap = get('bootstrap-static/')
    history = get(f'entry/{entry_id}/history/')
    current_event = next((event['id'] for event in bootstrap.get('events', []) if event.get('is_current')), None)
    gw = current_event or max((event['event'] for event in history.get('current', [])), default=0)
    if not gw:
        return 'No gameweek is currently available for that manager.'
    picks_data = get(f'entry/{entry_id}/event/{gw}/picks/')
    elements = bootstrap.get('elements', [])
    players = {player['id']: player['web_name'] for player in elements}
    positions = {player['id']: player['element_type'] for player in elements}
    picks = picks_data.get('picks', [])
    if not picks:
        return f'No picks are available for {name} in GW{gw} yet.'
    starters = [pick for pick in picks if pick['position'] <= 11]
    formation = '-'.join(str(sum(positions.get(pick['element']) == element_type for pick in starters))
                         for element_type in (2, 3, 4))
    lines = [f'🧢 {name}’s GW{gw} team ({formation}):']
    for pick in starters:
        player = players.get(pick['element'], f"Player {pick['element']}")
        label = ' (C)' if pick.get('is_captain') else ' (VC)' if pick.get('is_vice_captain') else ''
        lines.append(f'{"⭐ " if pick.get("is_captain") else ""}{player}{label}')
    bench = [players.get(pick['element'], f"Player {pick['element']}") for pick in picks if pick['position'] > 11]
    if bench:
        lines.extend(['', f"Bench: {', '.join(bench)}"])
    return '\n'.join(lines)


def build_command_text(command, args, league_id, mode):
    if command == '/score':
        return build_score_text(league_id, mode)
    if command in {'/table', '/form', '/gw', '/rival', '/banter'}:
        data = get_history_rows(league_id)
        gw = max(event['event'] for _, history in data for event in history)
        if command == '/table':
            return build_table_text(data, gw)
        if command == '/form':
            return build_form_text(data, gw)
        if command == '/gw':
            return build_gameweek_text(data, gw)
        if command == '/rival':
            return build_rival_text(data, gw, ' '.join(args))
        return build_banter_text(data, gw)
    if command == '/fixtures':
        return build_fixtures_text()
    if command == '/team':
        return build_team_text(league_id, ' '.join(args))
    return None


def handle_command(text, chat_id):
    parts = text.strip().split()
    if not parts:
        return
    command = parts[0].lower()
    command = command.split('@')[0]
    args = parts[1:]
    chat_id_str = str(chat_id)

    if command in {'/help', '/start'}:
        help_text = (
            'FPL commands:\n/score - league score and prizes\n/table - overall standings\n'
            '/form - points over the last 5 gameweeks\n/gw - latest gameweek standings\n'
            '/rival <name> [vs <name>] - compare managers\n/banter - weekly bragging rights\n'
            '/fixtures - next fixtures and toughest runs\n/team <name> - show a manager’s picks'
        )
        send_message(chat_id, help_text)
        return

    commands = {'/score', '/table', '/form', '/gw', '/rival', '/banter', '/fixtures', '/team'}
    if command not in commands:
        return

    if MAIN_LEAGUE_ID and MAIN_CHAT_ID and chat_id_str == str(MAIN_CHAT_ID):
        league_id, mode = MAIN_LEAGUE_ID, 'quarter'
    elif SECOND_LEAGUE_ID and SECOND_CHAT_ID and chat_id_str == str(SECOND_CHAT_ID):
        league_id, mode = SECOND_LEAGUE_ID, 'four_week'
    else:
        send_message(chat_id, 'This chat is not configured for this bot.')
        return

    send_message(chat_id, build_command_text(command, args, league_id, mode))


def poll_updates():
    last_update = 0
    while True:
        url = f'{TELEGRAM_BASE}/getUpdates'
        params = {'timeout': 30, 'offset': last_update + 1}
        try:
            response = requests.get(url, params=params, timeout=60)
            response.raise_for_status()
            updates = response.json().get('result', [])
        except requests.RequestException:
            time.sleep(5)
            continue

        for update in updates:
            last_update = max(last_update, update['update_id'])
            message = update.get('message')
            if not message:
                continue

            text = message.get('text', '')
            if not text or not text.startswith('/'):
                continue

            chat_id = message.get('chat', {}).get('id')
            if chat_id is None:
                continue

            handle_command(text, chat_id)

        time.sleep(1)


if __name__ == '__main__':
    poll_updates()
