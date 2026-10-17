const FPL_API = 'https://fantasy.premierleague.com/api';
const TELEGRAM_API = 'https://api.telegram.org';
const FPL_HEADERS = { 'User-Agent': 'Mozilla/5.0' };

async function telegramCall(env, method, body) {
	const response = await fetch(`${TELEGRAM_API}/bot${env.TG_TOKEN}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const result = await response.json();
	if (!response.ok || !result.ok) {
		throw new Error(`Telegram ${method} failed: ${result.description || response.status}`);
	}
	return result.result;
}

async function fplGet(path) {
	const response = await fetch(`${FPL_API}/${path}`, { headers: FPL_HEADERS });
	if (!response.ok) {
		throw new Error(`FPL API request failed (${response.status})`);
	}
	return response.json();
}

function net(event) {
	return event.points - event.event_transfers_cost;
}

async function getHistoryRows(leagueId) {
	const standings = await fplGet(`leagues-classic/${leagueId}/standings/`);
	const members = standings?.standings?.results || [];
	if (members.length === 0) {
		throw new Error('No league members were returned by the FPL API.');
	}
	return Promise.all(members.map(async (member) => {
		const history = await fplGet(`entry/${member.entry}/history/`);
		return [member.player_name, history.current || []];
	}));
}

function getCurrentGameweek(data) {
	const events = data.flatMap(([, history]) => history.map((event) => event.event));
	if (events.length === 0) {
		throw new Error('No gameweek history is available yet.');
	}
	return Math.max(...events);
}

function buildQuarterMessage(data, gw) {
	const quarters = [[1, 9], [10, 18], [19, 27], [28, 38]];
	const quarterIndex = quarters.findIndex(([start, end]) => start <= gw && gw <= end);
	if (quarterIndex < 0) throw new Error(`Unsupported gameweek: ${gw}`);
	const [start, end] = quarters[quarterIndex];
	const rows = data.map(([name, history]) => ({
		name,
		thisGw: history.filter((event) => event.event === gw).reduce((total, event) => total + net(event), 0),
		quarterPoints: history.filter((event) => start <= event.event && event.event <= gw).reduce((total, event) => total + net(event), 0),
		seasonPoints: history.filter((event) => event.event <= gw).reduce((total, event) => total + net(event), 0),
	}));
	const quarterRows = [...rows].sort((a, b) => b.quarterPoints - a.quarterPoints);
	const seasonRows = [...rows].sort((a, b) => b.seasonPoints - a.seasonPoints);
	const lines = [
		`⚽ FPL update: GW${gw}`,
		`Quarter ${quarterIndex + 1} standings (GW${start}–${end}; through GW${gw}):`,
	];
	quarterRows.forEach((row, index) => {
		lines.push(`${index + 1}. ${row.name}: ${row.quarterPoints} pts (GW: ${row.thisGw})`);
	});
	const topTwo = quarterRows.slice(0, 2).map((row) => row.name).join(', ');
	const bottomTwo = quarterRows.slice(-2).map((row) => row.name).join(', ');
	lines.push(
		'',
		`🍗 Gets free Wingstop: ${topTwo}`,
		`🍗 Pays for Wingstop (up to $15 each): ${bottomTwo}`,
		'',
		`🏆 Overall leader: ${seasonRows[0].name} (${seasonRows[0].seasonPoints} pts) — jersey winner; the rest split the cost evenly.`,
	);
	return lines.join('\n');
}

function buildFourWeekMessage(data, gw) {
	let blockStart;
	let blockEnd;
	let blockLabel;
	if (gw >= 33) {
		blockStart = 33;
		blockEnd = 38;
		blockLabel = 'GW33–GW38';
	} else {
		blockStart = Math.floor((gw - 1) / 4) * 4 + 1;
		blockEnd = Math.min(blockStart + 3, 32);
		blockLabel = `GW${blockStart}–GW${blockEnd}`;
	}
	const rows = data.map(([name, history]) => ({
		name,
		thisGw: history.filter((event) => event.event === gw).reduce((total, event) => total + net(event), 0),
		blockPoints: history.filter((event) => blockStart <= event.event && event.event <= gw && event.event <= blockEnd).reduce((total, event) => total + net(event), 0),
		seasonPoints: history.filter((event) => event.event <= gw).reduce((total, event) => total + net(event), 0),
	}));
	const blockRows = [...rows].sort((a, b) => b.blockPoints - a.blockPoints);
	const seasonRows = [...rows].sort((a, b) => b.seasonPoints - a.seasonPoints);
	const lines = [
		`⚽ FPL update: GW${gw}`,
		`4GW block: ${blockLabel} (through GW${gw})`,
	];
	blockRows.forEach((row, index) => {
		lines.push(`${index + 1}. ${row.name}: ${row.blockPoints} pts (GW: ${row.thisGw})`);
	});
	lines.push(
		'',
		`☕ Top 2 get coffee: ${blockRows.slice(0, 2).map((row) => row.name).join(', ')}`,
		`☕ Bottom 2 pay for coffee (up to $5 each): ${blockRows.slice(-2).map((row) => row.name).join(', ')}`,
		'',
		`🍽️ Overall top 2 get meal: ${seasonRows.slice(0, 2).map((row) => row.name).join(', ')}`,
		`🍽️ Overall bottom 2 pay (up to $30 each): ${seasonRows.slice(-2).map((row) => row.name).join(', ')}`,
	);
	return lines.join('\n');
}

async function scoreText(leagueId, mode) {
	const data = await getHistoryRows(leagueId);
	const gw = getCurrentGameweek(data);
	return mode === 'quarter'
		? buildQuarterMessage(data, gw)
		: buildFourWeekMessage(data, gw);
}

async function handleTelegramUpdate(update, env) {
	const message = update.message;
	if (!message?.text || !message.chat?.id) return;
	const command = message.text.trim().split(/\s+/)[0].toLowerCase().split('@')[0];
	const chatId = String(message.chat.id);

	if (command === '/start' || command === '/help') {
		await telegramCall(env, 'sendMessage', {
			chat_id: chatId,
			text: 'Command:\n/score - get your league score for this chat',
		});
		return;
	}
	if (command !== '/score') return;

	let leagueId;
	let mode;
	if (env.TG_CHAT_ID && chatId === String(env.TG_CHAT_ID) && env.FPL_LEAGUE_ID) {
		leagueId = env.FPL_LEAGUE_ID;
		mode = 'quarter';
	} else if (env.TG_CHAT_ID_2 && chatId === String(env.TG_CHAT_ID_2) && env.FPL_LEAGUE_ID_2) {
		leagueId = env.FPL_LEAGUE_ID_2;
		mode = 'four_week';
	} else {
		await telegramCall(env, 'sendMessage', {
			chat_id: chatId,
			text: 'This chat is not configured for this bot.',
		});
		return;
	}

	try {
		const text = await scoreText(leagueId, mode);
		await telegramCall(env, 'sendMessage', { chat_id: chatId, text });
	} catch (error) {
		console.error('Failed to build score response:', error);
		await telegramCall(env, 'sendMessage', {
			chat_id: chatId,
			text: 'Sorry, I could not fetch the FPL score right now. Please try again shortly.',
		});
	}
}

function isAuthorized(request, secret) {
	return Boolean(secret) && request.headers.get('Authorization') === `Bearer ${secret}`;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/health' && request.method === 'GET') {
			return new Response('FPL score bot is ready.');
		}

		if (url.pathname === '/setup' && request.method === 'POST') {
			if (!isAuthorized(request, env.SETUP_SECRET)) {
				return new Response('Unauthorized', { status: 401 });
			}
			if (!env.TELEGRAM_WEBHOOK_SECRET) {
				return new Response('TELEGRAM_WEBHOOK_SECRET is not configured.', { status: 500 });
			}
			try {
				const result = await telegramCall(env, 'setWebhook', {
					url: `${url.origin}/telegram-webhook`,
					secret_token: env.TELEGRAM_WEBHOOK_SECRET,
					allowed_updates: ['message'],
				});
				return Response.json({ ok: true, webhook_registered: result });
			} catch (error) {
				console.error('Failed to register Telegram webhook:', error);
				return new Response('Could not register the Telegram webhook.', { status: 502 });
			}
		}

		if (url.pathname === '/telegram-webhook' && request.method === 'POST') {
			if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
				return new Response('Unauthorized', { status: 401 });
			}
			try {
				const update = await request.json();
				await handleTelegramUpdate(update, env);
				return new Response('ok');
			} catch (error) {
				console.error('Failed to process Telegram update:', error);
				return new Response('Webhook processing failed.', { status: 500 });
			}
		}

		return new Response('Not found', { status: 404 });
	},
};