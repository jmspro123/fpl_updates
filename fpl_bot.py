import os
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


def handle_command(text, chat_id):
    command = text.strip().lower().split()[0]
    command = command.split('@')[0]
    chat_id_str = str(chat_id)

    if command == '/score':
        if MAIN_LEAGUE_ID and MAIN_CHAT_ID and chat_id_str == str(MAIN_CHAT_ID):
            send_message(chat_id, build_score_text(MAIN_LEAGUE_ID, 'quarter'))
            return
        if SECOND_LEAGUE_ID and SECOND_CHAT_ID and chat_id_str == str(SECOND_CHAT_ID):
            send_message(chat_id, build_score_text(SECOND_LEAGUE_ID, 'four_week'))
            return
        send_message(chat_id, 'This chat is not configured for this bot.')
        return

    if command in {'/help', '/start'}:
        help_text = 'Command:\n/score - get your league score for this chat'
        send_message(chat_id, help_text)


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
