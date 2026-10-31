import json
import os
import re
import time
from datetime import datetime, timezone

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
PRIVATE_ENTRY_ID = os.environ.get('FPL_PRIVATE_ENTRY_ID')


def is_private_entry(entry_id):
    return PRIVATE_ENTRY_ID is not None and str(entry_id) == str(PRIVATE_ENTRY_ID)


def get(path):
    return requests.get(f'{BASE}/{path}', headers=HEADERS, timeout=20).json()


def send_message(chat_id, text, reply_markup=None):
    data = {'chat_id': chat_id, 'text': text}
    if reply_markup:
        data['reply_markup'] = json.dumps(reply_markup)
    requests.post(
        f'{TELEGRAM_BASE}/sendMessage',
        data=data,
        timeout=20,
    )


def answer_callback(callback_id):
    requests.post(
        f'{TELEGRAM_BASE}/answerCallbackQuery',
        data={'callback_query_id': callback_id},
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


def get_next_gameweek(bootstrap):
    events = bootstrap.get('events', [])
    latest_finished = max((event['id'] for event in events if event.get('finished')), default=0)
    return (
        next((event for event in events if event.get('is_next')), None)
        or next((event for event in events if event.get('is_current') and not event.get('finished')), None)
        or next((event for event in events if event['id'] > latest_finished), None)
    )


def rank_player_picks(bootstrap, fixtures, gameweek, positions):
    teams = {team['id']: team for team in bootstrap.get('teams', [])}
    fixture_by_team = {}
    for fixture in fixtures:
        if fixture.get('event') != gameweek:
            continue
        home = teams.get(fixture['team_h'])
        away = teams.get(fixture['team_a'])
        if home:
            fixture_by_team[fixture['team_h']] = {
                'opponent': away.get('short_name', 'TBC'),
                'venue': 'H',
                'difficulty': fixture.get('team_h_difficulty', 3),
            }
        if away:
            fixture_by_team[fixture['team_a']] = {
                'opponent': home.get('short_name', 'TBC'),
                'venue': 'A',
                'difficulty': fixture.get('team_a_difficulty', 3),
            }

    ranked = []
    for player in bootstrap.get('elements', []):
        if player.get('element_type') not in positions or not player.get('now_cost', 0):
            continue
        if player.get('status') not in (None, 'a') or player.get('chance_of_playing_next_round') == 0:
            continue
        fixture = fixture_by_team.get(player.get('team'))
        form = float(player.get('form') or 0)
        points_per_game = float(player.get('points_per_game') or 0)
        minutes = float(player.get('minutes') or 0)
        difficulty = fixture['difficulty'] if fixture else 3
        score = form * 0.45 + points_per_game * 0.35 + (5 - difficulty) * 0.45 + min(minutes / 1800, 1) * 0.75
        ranked.append({
            'id': player['id'],
            'name': player.get('web_name', f"Player {player.get('id', '?')}"),
            'position': player['element_type'],
            'team': teams.get(player.get('team'), {}).get('short_name', 'TBC'),
            'team_id': player.get('team'),
            'price': player['now_cost'] / 10,
            'form': form,
            'fixture': f"{fixture['venue']} {fixture['opponent']} (FDR {fixture['difficulty']})" if fixture else 'fixture TBD',
            'score': score,
        })
    return sorted(ranked, key=lambda player: player['score'], reverse=True)


def build_recommendations_text(captain_only=False):
    bootstrap = get('bootstrap-static/')
    fixtures = get('fixtures/')
    next_event = get_next_gameweek(bootstrap)
    if not next_event:
        return 'No upcoming gameweek is currently available for recommendations.'
    position_names = {1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD'}
    positions = (3, 4) if captain_only else (1, 2, 3, 4)
    ranked = rank_player_picks(bootstrap, fixtures, next_event['id'], positions)
    if not ranked:
        return 'No available player recommendations were found for the next gameweek.'
    if captain_only:
        lines = [f"© GW{next_event['id']} captain shortlist (form, minutes & fixture-based):"]
        for index, player in enumerate(ranked[:3]):
            label = '⭐ Suggested captain' if index == 0 else 'Vice-captain option' if index == 1 else 'Alternative'
            lines.append(f"{label}: {player['name']} ({player['team']}, {player['fixture']}; form {player['form']:g})")
        lines.extend([
            '',
            'Marcus Rashford — form 10/10.',
            'These are stats-based suggestions, not predictions or guarantees.',
        ])
        return '\n'.join(lines)

    lines = [f"💡 GW{next_event['id']} suggested picks (stats-based):"]
    for position, label in position_names.items():
        candidates = [player for player in ranked if player['position'] == position][:2]
        if candidates:
            lines.extend(['', f'{label}:'])
            lines.extend(
                f"• {player['name']} ({player['team']}, £{player['price']:.1f}m, form {player['form']:g}; {player['fixture']})"
                for player in candidates
            )
    lines.extend(['', 'Uses recent form, points per game, minutes, availability and fixture difficulty; not a guarantee of points.'])
    return '\n'.join(lines)


def build_transfer_suggestions(picks, elements, ranked, bank, limit=4):
    ranked_by_id = {player['id']: player for player in ranked}
    owned_ids = {pick['element'] for pick in picks}
    club_counts = {}
    outgoing_players = []

    for pick in picks:
        player = elements.get(pick['element'])
        selling_price = pick.get('selling_price')
        if not player:
            continue
        team_id = player.get('team')
        club_counts[team_id] = club_counts.get(team_id, 0) + 1
        if not isinstance(selling_price, (int, float)) or isinstance(selling_price, bool):
            continue
        outgoing_players.append({
            'id': player['id'],
            'name': player.get('web_name', f"Player {player['id']}"),
            'position': player['element_type'],
            'team_id': team_id,
            'selling_price': selling_price,
            'score': ranked_by_id.get(player['id'], {}).get('score', float('-inf')),
        })

    suggestions = []
    for outgoing in outgoing_players:
        budget = bank + outgoing['selling_price']
        for incoming in ranked:
            if incoming['id'] in owned_ids or incoming['position'] != outgoing['position']:
                continue
            if incoming['price'] * 10 > budget:
                continue
            club_count = club_counts.get(incoming['team_id'], 0)
            if incoming['team_id'] == outgoing['team_id']:
                club_count -= 1
            if club_count >= 3:
                continue
            suggestions.append({
                'outgoing': outgoing,
                'incoming': incoming,
                'score_change': incoming['score'] - outgoing['score'],
                'net_cost': incoming['price'] * 10 - outgoing['selling_price'],
            })

    suggestions.sort(
        key=lambda suggestion: (
            suggestion['score_change'],
            suggestion['incoming']['score'],
            -abs(suggestion['net_cost']),
        ),
        reverse=True,
    )
    selected = []
    selected_outgoing_ids = set()
    selected_incoming_ids = set()
    for suggestion in suggestions:
        outgoing_id = suggestion['outgoing']['id']
        incoming_id = suggestion['incoming']['id']
        if outgoing_id in selected_outgoing_ids or incoming_id in selected_incoming_ids:
            continue
        selected.append(suggestion)
        selected_outgoing_ids.add(outgoing_id)
        selected_incoming_ids.add(incoming_id)
        if len(selected) == limit:
            break
    return selected


def build_personalized_recommendations_text(league_id, query='', selected_entry_id=None):
    standings = get(f'leagues-classic/{league_id}/standings/')
    members = standings.get('standings', {}).get('results', [])
    if selected_entry_id is not None:
        member = next((item for item in members if str(item['entry']) == str(selected_entry_id)), None)
        if member is None:
            return 'That manager is no longer in this league. Please run /recommend again.'
    else:
        selected, error = find_manager(
            [(item['player_name'], item['entry']) for item in members], query,
        )
        if error:
            return error
        member = next(item for item in members if str(item['entry']) == str(selected[1]))
    if is_private_entry(member['entry']):
        return 'Personalized recommendations are not available for this manager.'

    bootstrap = get('bootstrap-static/')
    history = get(f"entry/{member['entry']}/history/")
    current_gameweek = next(
        (event['id'] for event in bootstrap.get('events', []) if event.get('is_current')),
        max((event['event'] for event in history.get('current', [])), default=0),
    )
    if not current_gameweek:
        return 'No current gameweek is available for this manager.'
    picks_data = get(f"entry/{member['entry']}/event/{current_gameweek}/picks/")
    picks = picks_data.get('picks', [])
    bank = picks_data.get('entry_history', {}).get('bank')
    if not picks:
        return f"No current squad picks are available for {member['player_name']}."
    if not isinstance(bank, (int, float)) or isinstance(bank, bool):
        return 'The FPL API did not provide this manager’s bank.'

    next_event = get_next_gameweek(bootstrap)
    if not next_event:
        return 'No upcoming gameweek is currently available for recommendations.'
    fixtures = get('fixtures/')
    ranked = rank_player_picks(bootstrap, fixtures, next_event['id'], (1, 2, 3, 4))
    elements = {player['id']: player for player in bootstrap.get('elements', [])}
    suggestions = build_transfer_suggestions(picks, elements, ranked, bank)

    transfer_limit = bootstrap.get('game_settings', {}).get('max_extra_free_transfers')
    free_transfers = calculate_free_transfers(
        history,
        next_event['id'],
        transfer_limit + 1
        if isinstance(transfer_limit, int) and not isinstance(transfer_limit, bool)
        else None,
    )
    lines = [f"💡 GW{next_event['id']} transfer options for {member['player_name']}:"]
    if free_transfers is not None:
        lines.append(f'Free transfers: {free_transfers}')
    lines.append('1. Marcus Rashford')
    if not suggestions:
        lines.append('No affordable same-position transfer options are available.')
        return '\n'.join(lines)
    for index, suggestion in enumerate(suggestions, start=2):
        outgoing = suggestion['outgoing']
        incoming = suggestion['incoming']
        remaining_bank = bank - suggestion['net_cost']
        lines.append(
            f"{index}. {outgoing['name']} → {incoming['name']} "
            f"(bank £{remaining_bank / 10:.1f}m after move; "
            f"form {incoming['form']:g}; {incoming['fixture']})"
        )
    lines.extend(['', 'Stats-based estimates from form, minutes and fixtures—not guaranteed points.'])
    return '\n'.join(lines)


def format_transfer_time(value):
    try:
        timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (AttributeError, ValueError):
        return 'time unavailable'
    return timestamp.astimezone(timezone.utc).strftime('%d %b %H:%M UTC')


def calculate_free_transfers(history, gameweek, max_free_transfers):
    if not isinstance(max_free_transfers, int) or isinstance(max_free_transfers, bool):
        return None
    if max_free_transfers < 1:
        return None

    events = {
        event.get('event'): event
        for event in history.get('current', [])
        if isinstance(event.get('event'), int)
    }
    preserved_transfer_events = {
        chip.get('event')
        for chip in history.get('chips', [])
        if chip.get('name') in {'wildcard', 'freehit'}
    }

    available = 1
    for event_id in range(1, gameweek + 1):
        event = events.get(event_id)
        if event is None:
            if event_id == gameweek:
                return available
            return None

        transfers = event.get('event_transfers')
        if not isinstance(transfers, int) or isinstance(transfers, bool):
            return None
        if event_id not in preserved_transfer_events:
            available = max(0, available - transfers)

        if event_id < gameweek:
            available = min(max_free_transfers, available + 1)

    return available


def build_moves_text(league_id):
    standings = get(f'leagues-classic/{league_id}/standings/')
    members = standings.get('standings', {}).get('results', [])
    if not members:
        return 'No managers were found in this league.'
    bootstrap = get('bootstrap-static/')
    player_names = {player['id']: player['web_name'] for player in bootstrap.get('elements', [])}
    transfers = []
    special_moves = []
    for member in members:
        entry_id = member['entry']
        if is_private_entry(entry_id):
            continue
        manager = member['player_name']
        history = get(f'entry/{entry_id}/history/')
        transfer_history = get(f'entry/{entry_id}/transfers/')
        transfers.extend({**transfer, 'manager': manager} for transfer in transfer_history)
        special_moves.extend({
            'type': 'chip',
            'manager': manager,
            'event': chip['event'],
            'name': chip['name'],
        } for chip in history.get('chips', []))
        special_moves.extend({
            'type': 'hit',
            'manager': manager,
            'event': event['event'],
            'cost': event['event_transfers_cost'],
        } for event in history.get('current', []) if event.get('event_transfers_cost', 0) > 0)
    transfers.sort(key=lambda transfer: transfer.get('time', ''), reverse=True)
    transfers = transfers[:15]
    special_moves.sort(key=lambda move: move['event'], reverse=True)
    special_moves = special_moves[:10]
    if not transfers and not special_moves:
        return 'No transfers, chips, or point hits have been recorded in this league yet.'
    lines = []
    if transfers:
        lines.append(f'🔄 Latest league transfers ({len(transfers)} shown):')
    for transfer in transfers:
        player_in = player_names.get(transfer['element_in'], f"Player {transfer['element_in']}")
        player_out = player_names.get(transfer['element_out'], f"Player {transfer['element_out']}")
        timestamp = format_transfer_time(transfer.get('time'))
        lines.append(
            f"GW{transfer['event']} · {transfer['manager']}: {player_out} → {player_in} · {timestamp}"
        )
    if special_moves:
        lines.extend(['', '⚡ Chips & hits (latest 10):'])
        chip_names = {
            'wildcard': 'Wildcard',
            'freehit': 'Free Hit',
            'bboost': 'Bench Boost',
            '3xc': 'Triple Captain',
            'assistant_manager': 'Assistant Manager',
        }
        for move in special_moves:
            if move['type'] == 'hit':
                lines.append(f"GW{move['event']} · {move['manager']}: took a -{move['cost']} point hit")
            else:
                chip = chip_names.get(move['name'], move['name'].replace('_', ' ').title())
                lines.append(f"GW{move['event']} · {move['manager']}: used {chip}")
    return '\n'.join(lines)


def build_team_text(league_id, query, selected_entry_id=None):
    standings = get(f'leagues-classic/{league_id}/standings/')
    members = standings.get('standings', {}).get('results', [])
    if selected_entry_id is not None:
        member = next((item for item in members if str(item['entry']) == str(selected_entry_id)), None)
        if member is None:
            return 'That manager is no longer in this league. Please run /team again.'
    else:
        selected, error = find_manager(
            [(item['player_name'], item['entry']) for item in members], query,
        )
        if error:
            return error
        member = next(item for item in members if str(item['entry']) == str(selected[1]))
    if is_private_entry(member['entry']):
        return 'This manager’s team is private.'
    name, entry_id = member['player_name'], member['entry']
    bootstrap = get('bootstrap-static/')
    history = get(f'entry/{entry_id}/history/')
    events = bootstrap.get('events', [])
    current_event = next((event for event in events if event.get('is_current')), None)
    next_event = next((event for event in events if event.get('is_next')), None)
    gw = current_event.get('id') if current_event else max(
        (event['event'] for event in history.get('current', [])), default=0,
    )
    if not gw:
        return 'No gameweek is currently available for that manager.'
    transfer_event = current_event if current_event and not current_event.get('finished') else next_event
    if transfer_event is None:
        transfer_event = current_event
    transfer_gameweek = transfer_event.get('id') if transfer_event else gw
    picks_data = get(f'entry/{entry_id}/event/{gw}/picks/')
    entry_history = picks_data.get('entry_history', {})
    if not isinstance(entry_history.get('bank'), (int, float)) or not isinstance(entry_history.get('value'), (int, float)):
        return 'The FPL API did not provide this manager’s bank and squad value.'
    elements = bootstrap.get('elements', [])
    players = {player['id']: player['web_name'] for player in elements}
    positions = {player['id']: player['element_type'] for player in elements}
    picks = picks_data.get('picks', [])
    if not picks:
        return f'No picks are available for {name} in GW{gw} yet.'
    starters = [pick for pick in picks if pick['position'] <= 11]
    formation = '-'.join(str(sum(positions.get(pick['element']) == element_type for pick in starters))
                         for element_type in (2, 3, 4))
    max_extra_free_transfers = bootstrap.get('game_settings', {}).get('max_extra_free_transfers')
    free_transfers = calculate_free_transfers(
        history,
        transfer_gameweek,
        max_extra_free_transfers + 1
        if isinstance(max_extra_free_transfers, int) and not isinstance(max_extra_free_transfers, bool)
        else None,
    )
    lines = [
        f'🧢 {name}’s GW{gw} team ({formation}):',
        f"Bank: £{entry_history['bank'] / 10:.1f}m · Squad value: £{entry_history['value'] / 10:.1f}m",
        f'Free transfers for GW{transfer_gameweek}: {free_transfers}'
        if free_transfers is not None
        else f'Free transfers for GW{transfer_gameweek}: unavailable',
    ]
    for pick in starters:
        player = players.get(pick['element'], f"Player {pick['element']}")
        label = ' (C)' if pick.get('is_captain') else ' (VC)' if pick.get('is_vice_captain') else ''
        lines.append(f'{"⭐ " if pick.get("is_captain") else ""}{player}{label}')
    bench = [players.get(pick['element'], f"Player {pick['element']}") for pick in picks if pick['position'] > 11]
    if bench:
        lines.extend(['', f"Bench: {', '.join(bench)}"])
    return '\n'.join(lines)


def manager_keyboard(members, action, first_entry_id=None):
    candidates = [
        member for member in members
        if (action not in {'team', 'recommend'} or not is_private_entry(member['entry']))
        and (first_entry_id is None or str(member['entry']) != str(first_entry_id))
    ]
    prefix = action if first_entry_id is None else f'{action}2:{first_entry_id}'
    buttons = []
    for member in candidates:
        team_name = member.get('entry_name')
        label = member['player_name']
        if team_name and team_name != label:
            label += f' · {team_name}'
        label = ''.join(list(label)[:64])
        buttons.append({
            'text': label,
            'callback_data': f"{prefix}:{member['entry']}",
        })
    return {'inline_keyboard': [buttons[index:index + 2] for index in range(0, len(buttons), 2)]}


def send_manager_choices(chat_id, league_id, action, first_entry_id=None):
    standings = get(f'leagues-classic/{league_id}/standings/')
    members = standings.get('standings', {}).get('results', [])
    candidates = [
        member for member in members
        if (action not in {'team', 'recommend'} or not is_private_entry(member['entry']))
        and (first_entry_id is None or str(member['entry']) != str(first_entry_id))
    ]
    if not candidates:
        if action == 'recommend':
            message = 'No managers are available for recommendations.'
        elif action == 'team':
            message = 'No managers were found in this league.'
        else:
            message = 'No other managers are available to compare.'
        send_message(chat_id, message)
        return
    if first_entry_id is None:
        if action == 'team':
            prompt = 'Choose a manager to view their team:'
        elif action == 'recommend':
            prompt = 'Choose a manager for personalized recommendations:'
        else:
            prompt = 'Choose the first manager to compare:'
    else:
        prompt = 'Choose the second manager to compare:'
    send_message(chat_id, prompt, manager_keyboard(candidates, action, first_entry_id))


def build_selected_rival_text(league_id, first_entry_id, second_entry_id):
    standings = get(f'leagues-classic/{league_id}/standings/')
    members = standings.get('standings', {}).get('results', [])
    selected = [next((member for member in members if str(member['entry']) == str(entry_id)), None)
                for entry_id in (first_entry_id, second_entry_id)]
    if any(member is None for member in selected):
        return 'A manager in that selection is no longer in this league. Please try /rival again.'
    league_data = get_history_rows(league_id)
    gw = max(event['event'] for _, history in league_data for event in history)
    weeks = sorted({event['event'] for _, history in league_data for event in history}, reverse=True)[:5]
    metrics = []
    for member in selected:
        history = get(f"entry/{member['entry']}/history/").get('current', [])
        metrics.append((
            member['player_name'],
            sum(net_points(event) for event in history if event['event'] <= gw),
            sum(net_points(event) for event in history if event['event'] in weeks),
        ))
    first, second = metrics
    season_leader = first[0] if first[1] >= second[1] else second[0]
    recent_leader = first[0] if first[2] >= second[2] else second[0]
    return '\n'.join([
        f'🆚 {first[0]} vs {second[0]} — GW{gw}',
        f'Season: {first[0]} {first[1]} pts, {second[0]} {second[1]} pts ({season_leader} +{abs(first[1] - second[1])})',
        f'Last {len(weeks)} GWs: {first[0]} {first[2]} pts, {second[0]} {second[2]} pts ({recent_leader} +{abs(first[2] - second[2])})',
    ])


def handle_callback(callback):
    answer_callback(callback['id'])
    chat_id = callback.get('message', {}).get('chat', {}).get('id')
    if chat_id is None:
        return
    chat_id_str = str(chat_id)
    if MAIN_LEAGUE_ID and MAIN_CHAT_ID and chat_id_str == str(MAIN_CHAT_ID):
        league_id = MAIN_LEAGUE_ID
    elif SECOND_LEAGUE_ID and SECOND_CHAT_ID and chat_id_str == str(SECOND_CHAT_ID):
        league_id = SECOND_LEAGUE_ID
    else:
        send_message(chat_id, 'This chat is not configured for this bot.')
        return

    parts = callback.get('data', '').split(':')
    if parts[0] == 'team' and len(parts) == 2 and parts[1].isdigit():
        send_message(chat_id, build_team_text(league_id, '', parts[1]))
    elif parts[0] == 'recommend' and len(parts) == 2 and parts[1].isdigit():
        send_message(chat_id, build_personalized_recommendations_text(league_id, selected_entry_id=parts[1]))
    elif parts[0] == 'rival' and len(parts) == 2 and parts[1].isdigit():
        send_manager_choices(chat_id, league_id, 'rival', parts[1])
    elif parts[0] == 'rival2' and len(parts) == 3 and all(part.isdigit() for part in parts[1:]):
        send_message(chat_id, build_selected_rival_text(league_id, parts[1], parts[2]))


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
    if command in {'/moves', '/transfers'}:
        return build_moves_text(league_id)
    if command == '/recommend':
        return build_personalized_recommendations_text(league_id, ' '.join(args))
    if command == '/captain':
        return build_recommendations_text(captain_only=True)
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
            '/rival - tap two managers to compare (or type names)\n/banter - weekly bragging rights\n'
            '/moves or /transfers - latest transfers, chips and hits\n'
            '/fixtures - next fixtures and toughest runs\n/recommend - personalized transfer ideas (choose or type a manager)\n'
            '/captain - captain shortlist\n/team - tap a manager to view picks (or type a name)'
        )
        send_message(chat_id, help_text)
        return

    commands = {'/score', '/table', '/form', '/gw', '/rival', '/moves', '/transfers', '/banter', '/fixtures', '/recommend', '/captain', '/team'}
    if command not in commands:
        return

    if MAIN_LEAGUE_ID and MAIN_CHAT_ID and chat_id_str == str(MAIN_CHAT_ID):
        league_id, mode = MAIN_LEAGUE_ID, 'quarter'
    elif SECOND_LEAGUE_ID and SECOND_CHAT_ID and chat_id_str == str(SECOND_CHAT_ID):
        league_id, mode = SECOND_LEAGUE_ID, 'four_week'
    else:
        send_message(chat_id, 'This chat is not configured for this bot.')
        return

    if command == '/team' and not args:
        send_manager_choices(chat_id, league_id, 'team')
        return
    if command == '/recommend' and not args:
        send_manager_choices(chat_id, league_id, 'recommend')
        return
    if command == '/rival' and not args:
        send_manager_choices(chat_id, league_id, 'rival')
        return

    send_message(chat_id, build_command_text(command, args, league_id, mode))


def poll_updates():
    last_update = 0
    while True:
        url = f'{TELEGRAM_BASE}/getUpdates'
        params = {
            'timeout': 30,
            'offset': last_update + 1,
            'allowed_updates': json.dumps(['message', 'callback_query']),
        }
        try:
            response = requests.get(url, params=params, timeout=60)
            response.raise_for_status()
            updates = response.json().get('result', [])
        except requests.RequestException:
            time.sleep(5)
            continue

        for update in updates:
            last_update = max(last_update, update['update_id'])
            callback = update.get('callback_query')
            if callback:
                handle_callback(callback)
                continue
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
