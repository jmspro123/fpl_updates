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
});
