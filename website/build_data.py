import argparse
import concurrent.futures
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


FPL_API = 'https://fantasy.premierleague.com/api'
LEAGUE_IDS = (216460, 559661)
HEADERS = {'User-Agent': 'FPL League Dashboard/1.0'}


def fpl_get(path):
    request = Request(f'{FPL_API}/{path}', headers=HEADERS)
    try:
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f'FPL API request failed for {path}: {error}') from error


def get_members(league_id):
    members = []
    page = 1
    league_name = None

    while True:
        data = fpl_get(f'leagues-classic/{league_id}/standings/?page_standings={page}')
        league_name = league_name or data.get('league', {}).get('name')
        standings = data.get('standings', {})
        members.extend(standings.get('results', []))
        if not standings.get('has_next'):
            break
        page += 1

    if not members:
        raise RuntimeError(f'FPL returned no managers for league {league_id}.')
    return league_name or f'League {league_id}', members


def get_entry_history(entry_id):
    data = fpl_get(f'entry/{entry_id}/history/')
    return data.get('current', [])


def build_league(league_id, finished_gameweeks):
    league_name, members = get_members(league_id)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        histories = list(executor.map(get_entry_history, (member['entry'] for member in members)))

    managers = []
    for member, history in zip(members, histories):
        managers.append({
            'entry': member['entry'],
            'manager': member['player_name'],
            'team': member.get('entry_name', ''),
            'rank': member.get('rank'),
            'lastRank': member.get('last_rank'),
            'totalPoints': member.get('total', 0),
            'history': [
                {
                    'gameweek': event['event'],
                    'points': event['points'],
                    'transferCost': event['event_transfers_cost'],
                    'netPoints': event['points'] - event['event_transfers_cost'],
                    'finished': event['event'] in finished_gameweeks,
                }
                for event in history
            ],
        })

    return {'id': league_id, 'name': league_name, 'managers': managers}


def build_dashboard_data():
    bootstrap = fpl_get('bootstrap-static/')
    events = bootstrap.get('events', [])
    finished_gameweeks = {event['id'] for event in events if event.get('finished')}
    current_event = next((event['id'] for event in events if event.get('is_current')), None)
    if current_event is None:
        current_event = max(
            (event['id'] for event in events if event.get('finished')),
            default=None,
        )

    leagues = [build_league(league_id, finished_gameweeks) for league_id in LEAGUE_IDS]
    all_gameweeks = [
        event['gameweek']
        for league in leagues
        for manager in league['managers']
        for event in manager['history']
    ]
    gameweek = current_event or max(all_gameweeks, default=0)

    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'gameweek': gameweek,
        'finishedGameweeks': max(finished_gameweeks, default=0),
        'leagues': leagues,
    }


def main():
    parser = argparse.ArgumentParser(description='Fetch public FPL league data for the dashboard.')
    parser.add_argument('--output', type=Path, required=True, help='Path to write dashboard JSON.')
    args = parser.parse_args()

    data = build_dashboard_data()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    print(f"Generated dashboard data for GW{data['gameweek']} at {args.output}")


if __name__ == '__main__':
    main()
