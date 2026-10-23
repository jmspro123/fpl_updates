import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
const telegramReplies = [];
const telegramCalls = [];
const fplCalls = [];

const env = {
	TG_TOKEN: 'test-token',
	FPL_LEAGUE_ID: 'main-league',
	TG_CHAT_ID: '-1001',
	FPL_LEAGUE_ID_2: 'second-league',
	TG_CHAT_ID_2: '-1002',
	TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret',
	SETUP_SECRET: 'test_setup_secret',
};

beforeEach(() => {
	telegramReplies.length = 0;
	telegramCalls.length = 0;
	fplCalls.length = 0;
	globalThis.fetch = async (input, init = {}) => {
		const url = String(input);
		if (url.includes('/bootstrap-static/')) {
			fplCalls.push(url);
			return Response.json({
				events: [1, 2, 3, 4].map((id) => ({ id, finished: true, is_current: id === 4, is_next: false }))
					.concat([{ id: 5, finished: false, is_current: false, is_next: true }, { id: 6, finished: false, is_current: false, is_next: false }]),
				teams: [
					{ id: 1, name: 'Alpha FC', short_name: 'ALP' },
					{ id: 2, name: 'Beta FC', short_name: 'BET' },
				],
				elements: [
					{ id: 101, web_name: 'Keeper', element_type: 1, team: 1, now_cost: 45, form: '5', points_per_game: '4', minutes: 1000, status: 'a' },
					{ id: 102, web_name: 'Captain', element_type: 2, team: 1, now_cost: 55, form: '8', points_per_game: '6', minutes: 1000, status: 'a' },
					{ id: 103, web_name: 'Midfielder', element_type: 3, team: 2, now_cost: 85, form: '12', points_per_game: '9', minutes: 1500, status: 'a' },
					{ id: 104, web_name: 'Forward', element_type: 4, team: 2, now_cost: 90, form: '10', points_per_game: '8', minutes: 1200, status: 'a' },
					...Array.from({ length: 11 }, (_, i) => ({ id: 105 + i, web_name: `Player${i}`, element_type: i < 3 ? 2 : i < 7 ? 3 : 4, team: 1, now_cost: 50, form: '2', points_per_game: '2', minutes: 800, status: 'a' })),
				],
			});
		}
		if (url.includes('/fixtures/')) {
			fplCalls.push(url);
			return Response.json([
				{ event: 5, team_h: 1, team_a: 2, team_h_difficulty: 5, team_a_difficulty: 2, kickoff_time: '2026-10-24T12:30:00Z' },
				{ event: 6, team_h: 2, team_a: 1, team_h_difficulty: 3, team_a_difficulty: 4, kickoff_time: '2026-10-31T12:30:00Z' },
			]);
		}
		if (url.includes('/event/4/picks/')) {
			fplCalls.push(url);
			return Response.json({ picks: [
				{ element: 101, position: 1 },
				{ element: 102, position: 2, is_captain: true },
				{ element: 103, position: 3, is_vice_captain: true },
				{ element: 104, position: 4 },
				...Array.from({ length: 7 }, (_, i) => ({ element: 105 + i, position: 5 + i })),
				{ element: 113, position: 12 },
			] });
		}
		if (url.includes('/transfers/')) {
			fplCalls.push(url);
			const entry = Number(url.match(/entry\/(\d+)/)[1]);
			return Response.json(entry === 11
				? [{ event: 5, element_in: 103, element_out: 102, time: '2026-10-24T10:00:00Z' }]
				: [{ event: 5, element_in: 104, element_out: 101, time: '2026-10-24T11:00:00Z' }]);
		}
		if (url.includes('/leagues-classic/')) {
			fplCalls.push(url);
			return Response.json({ standings: { results: [
				{ entry: 11, player_name: 'Alpha' },
				{ entry: 22, player_name: 'Beta' },
			] } });
		}
		if (url.includes('/entry/')) {
			fplCalls.push(url);
			const entry = Number(url.match(/entry\/(\d+)/)[1]);
			const current = [1, 2, 3, 4].map((event) => ({
				event,
				points: entry === 11 ? 10 + event : 20 + event,
				event_transfers_cost: 0,
			}));
			return Response.json({ current });
		}
		if (url.includes('api.telegram.org')) {
			const body = JSON.parse(init.body || '{}');
			telegramCalls.push({ url, body });
			if (url.endsWith('/sendMessage')) telegramReplies.push(body);
			return Response.json({ ok: true, result: true });
		}
		throw new Error(`Unexpected URL: ${url}`);
	};
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function postUpdate(chatId, text, secret = env.TELEGRAM_WEBHOOK_SECRET) {
	return worker.fetch(new Request('https://test.workers.dev/telegram-webhook', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Telegram-Bot-Api-Secret-Token': secret,
		},
		body: JSON.stringify({ message: { text, chat: { id: chatId } } }),
	}), env);
}

async function postCallback(chatId, data, secret = env.TELEGRAM_WEBHOOK_SECRET) {
	return worker.fetch(new Request('https://test.workers.dev/telegram-webhook', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Telegram-Bot-Api-Secret-Token': secret,
		},
		body: JSON.stringify({ callback_query: {
			id: `callback-${data}`,
			data,
			message: { chat: { id: chatId } },
		} }),
	}), env);
}

test('main group gets quarter standings, including a bot command suffix', async () => {
	const response = await postUpdate(-1001, '/score@fpl_update_bot');
	assert.equal(response.status, 200);
	assert.match(telegramReplies.at(-1).text, /Quarter 1 standings/);
	assert.match(fplCalls[0], /main-league/);
});

test('second group gets four-week standings only', async () => {
	const response = await postUpdate(-1002, '/score');
	assert.equal(response.status, 200);
	assert.match(telegramReplies.at(-1).text, /4GW block: GW1–GW4/);
	assert.match(fplCalls[0], /second-league/);
});

test('table, form, and gameweek commands show the expected rankings', async () => {
	await postUpdate(-1001, '/table');
	assert.match(telegramReplies.at(-1).text, /Overall standings through GW4/);
	assert.match(telegramReplies.at(-1).text, /1\. Beta: 90 pts/);

	await postUpdate(-1001, '/form');
	assert.match(telegramReplies.at(-1).text, /Form over GW1–GW4/);
	assert.match(telegramReplies.at(-1).text, /Beta: 90 pts/);

	await postUpdate(-1001, '/gw');
	assert.match(telegramReplies.at(-1).text, /GW4 league table/);
	assert.match(telegramReplies.at(-1).text, /Beta: 24 pts/);
});

test('rival and banter commands use the configured league', async () => {
	await postUpdate(-1001, '/rival alpha');
	assert.match(telegramReplies.at(-1).text, /Alpha — GW4/);
	assert.match(telegramReplies.at(-1).text, /Last 4 GWs: 50 pts/);

	await postUpdate(-1001, '/rival Alpha vs Beta');
	assert.match(telegramReplies.at(-1).text, /Alpha vs Beta — GW4/);
	assert.match(telegramReplies.at(-1).text, /Beta \+40/);

	await postUpdate(-1001, '/banter');
	assert.match(telegramReplies.at(-1).text, /Beta takes this week’s bragging rights/);
	assert.match(telegramReplies.at(-1).text, /Alpha, there’s plenty of season left/);
});

test('fixtures command shows the next round and difficult runs', async () => {
	await postUpdate(-1001, '/fixtures');
	assert.match(telegramReplies.at(-1).text, /GW5 fixtures/);
	assert.match(telegramReplies.at(-1).text, /ALP v BET/);
	assert.match(telegramReplies.at(-1).text, /Toughest next 2-GW run/);
});

test('/recommend lists available players by position with prices and fixtures', async () => {
	await postUpdate(-1001, '/recommend');
	const text = telegramReplies.at(-1).text;
	assert.match(text, /GW5 suggested picks/);
	assert.match(text, /GK:/);
	assert.match(text, /DEF:/);
	assert.match(text, /MID:/);
	assert.match(text, /FWD:/);
	assert.match(text, /Midfielder \(BET, £8\.5m, form 12; A ALP \(FDR 2\)\)/);
	assert.match(text, /not a guarantee of points/);
});

test('/captain returns a top three shortlist with a form caveat', async () => {
	await postUpdate(-1001, '/captain');
	const text = telegramReplies.at(-1).text;
	assert.match(text, /GW5 captain shortlist/);
	assert.match(text, /Suggested captain: Midfielder/);
	assert.match(text, /Vice-captain option: Forward/);
	assert.match(text, /not predictions or guarantees/);
});

test('/moves shows the latest league transfers first with player names', async () => {
	await postUpdate(-1001, '/moves');
	const text = telegramReplies.at(-1).text;
	assert.match(text, /Latest league transfers \(2 shown\)/);
	assert.ok(text.indexOf('Beta: Keeper → Forward') < text.indexOf('Alpha: Captain → Midfielder'));
	assert.match(text, /GW5 · Beta: Keeper → Forward · 24 Oct 11:00 UTC/);
});

test('team command displays a manager’s starting picks, captain, and bench', async () => {
	await postUpdate(-1001, '/team Alpha');
	assert.match(telegramReplies.at(-1).text, /Alpha’s GW4 team/);
	assert.match(telegramReplies.at(-1).text, /Captain \(C\)/);
	assert.match(telegramReplies.at(-1).text, /Midfielder \(VC\)/);
	assert.match(telegramReplies.at(-1).text, /Bench: Player8/);
});

test('/team without a name offers tappable manager choices', async () => {
	await postUpdate(-1001, '/team');
	const menu = telegramReplies.at(-1);
	assert.match(menu.text, /Choose a manager/);
	assert.deepEqual(menu.reply_markup.inline_keyboard[0].map((button) => button.text), ['Alpha', 'Beta']);
	assert.equal(menu.reply_markup.inline_keyboard[0][0].callback_data, 'team:11');

	await postCallback(-1001, 'team:11');
	assert.match(telegramReplies.at(-1).text, /Alpha’s GW4 team/);
	assert.equal(telegramCalls.some((call) => call.url.endsWith('/answerCallbackQuery')), true);
});

test('/rival without names lets the user select both managers', async () => {
	await postUpdate(-1001, '/rival');
	assert.match(telegramReplies.at(-1).text, /Choose the first manager/);

	await postCallback(-1001, 'rival:11');
	const secondMenu = telegramReplies.at(-1);
	assert.match(secondMenu.text, /Choose the second manager/);
	assert.deepEqual(secondMenu.reply_markup.inline_keyboard.flat().map((button) => button.callback_data), ['rival2:11:22']);

	await postCallback(-1001, 'rival2:11:22');
	assert.match(telegramReplies.at(-1).text, /Alpha vs Beta — GW4/);
	assert.match(telegramReplies.at(-1).text, /Beta \+40/);
});

test('/help lists the expanded command set', async () => {
	await postUpdate(-1001, '/help');
	assert.match(telegramReplies.at(-1).text, /\/fixtures/);
	assert.match(telegramReplies.at(-1).text, /\/team - tap a manager/);
	assert.match(telegramReplies.at(-1).text, /\/rival - tap two managers/);
	assert.match(telegramReplies.at(-1).text, /\/recommend/);
	assert.match(telegramReplies.at(-1).text, /\/captain/);
	assert.match(telegramReplies.at(-1).text, /\/moves/);
});

test('unconfigured group cannot receive either league score', async () => {
	const response = await postUpdate(-9999, '/score');
	assert.equal(response.status, 200);
	assert.equal(telegramReplies.at(-1).text, 'This chat is not configured for this bot.');
	assert.equal(telegramCalls.length, 1);
	assert.equal(fplCalls.length, 0);
	assert.match(telegramCalls[0].url, /sendMessage/);
});

test('webhook rejects a missing or incorrect Telegram secret', async () => {
	const response = await postUpdate(-1001, '/score', 'wrong_secret');
	assert.equal(response.status, 401);
	assert.equal(telegramCalls.length, 0);
});

test('protected setup registers the HTTPS webhook with Telegram', async () => {
	const response = await worker.fetch(new Request('https://test.workers.dev/setup', {
		method: 'POST',
		headers: { Authorization: `Bearer ${env.SETUP_SECRET}` },
	}), env);
	assert.equal(response.status, 200);
	assert.equal(telegramCalls[0].url.endsWith('/setWebhook'), true);
	assert.equal(telegramCalls[0].body.url, 'https://test.workers.dev/telegram-webhook');
	assert.equal(telegramCalls[0].body.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
	assert.deepEqual(telegramCalls[0].body.allowed_updates, ['message', 'callback_query']);
});
