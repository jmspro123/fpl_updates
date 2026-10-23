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

function seasonRows(data, gw) {
	return data.map(([name, history]) => ({
		name,
		seasonPoints: history.filter((event) => event.event <= gw).reduce((total, event) => total + net(event), 0),
		thisGw: history.filter((event) => event.event === gw).reduce((total, event) => total + net(event), 0),
	})).sort((a, b) => b.seasonPoints - a.seasonPoints);
}

function buildTableMessage(data, gw) {
	const rows = seasonRows(data, gw);
	return [`🏆 Overall standings through GW${gw}:`, ...rows.map((row, index) => {
		const gap = rows[0].seasonPoints - row.seasonPoints;
		return `${index + 1}. ${row.name}: ${row.seasonPoints} pts${gap ? ` (-${gap})` : ''}`;
	})].join('\n');
}

function buildFormMessage(data, gw) {
	const weeks = [...new Set(data.flatMap(([, history]) => history.map((event) => event.event)))]
		.filter((event) => event <= gw).sort((a, b) => b - a).slice(0, 5).sort((a, b) => a - b);
	if (weeks.length === 0) throw new Error('No gameweek history is available yet.');
	const rows = data.map(([name, history]) => ({
		name,
		points: history.filter((event) => weeks.includes(event.event)).reduce((total, event) => total + net(event), 0),
	})).sort((a, b) => b.points - a.points);
	return [`🔥 Form over GW${weeks[0]}–GW${weeks.at(-1)}:`, ...rows.map((row, index) => `${index + 1}. ${row.name}: ${row.points} pts`)].join('\n');
}

function buildGameweekMessage(data, gw) {
	const rows = data.map(([name, history]) => ({
		name,
		points: history.filter((event) => event.event === gw).reduce((total, event) => total + net(event), 0),
	})).sort((a, b) => b.points - a.points);
	return [`⚡ GW${gw} league table:`, ...rows.map((row, index) => `${index + 1}. ${row.name}: ${row.points} pts`)].join('\n');
}

function findManager(rows, query) {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return { error: 'Please include a manager name, e.g. /rival Alex or /team Alex.' };
	const matches = rows.filter(([name]) => name.toLowerCase().includes(normalized));
	if (matches.length === 0) return { error: `No manager found matching “${query.trim()}”.` };
	if (matches.length > 1) return { error: `More than one manager matches “${query.trim()}”. Please be more specific.` };
	return { manager: matches[0] };
}

function buildRivalMessage(data, gw, query) {
	const weeks = [...new Set(data.flatMap(([, rows]) => rows.map((event) => event.event)))].sort((a, b) => b - a).slice(0, 5);
	const compareNames = query.split(/\s+vs\s+/i);
	if (compareNames.length > 2) return 'Use /rival <manager> or /rival <manager 1> vs <manager 2>.';
	const results = compareNames.map((managerName) => findManager(data, managerName));
	const error = results.find((result) => result.error)?.error;
	if (error) return error;
	const metrics = results.map(({ manager }) => {
		const [name, history] = manager;
		return {
			name,
			recent: history.filter((event) => weeks.includes(event.event)).reduce((total, event) => total + net(event), 0),
			season: history.filter((event) => event.event <= gw).reduce((total, event) => total + net(event), 0),
		};
	});
	if (metrics.length === 2) {
		const [first, second] = metrics;
		return [`🆚 ${first.name} vs ${second.name} — GW${gw}`,
			`Season: ${first.name} ${first.season} pts, ${second.name} ${second.season} pts (${first.season - second.season >= 0 ? `${first.name} +${first.season - second.season}` : `${second.name} +${second.season - first.season}`})`,
			`Last ${weeks.length} GWs: ${first.name} ${first.recent} pts, ${second.name} ${second.recent} pts (${first.recent - second.recent >= 0 ? `${first.name} +${first.recent - second.recent}` : `${second.name} +${second.recent - first.recent}`})`].join('\n');
	}
	const [{ name, recent, season }] = metrics;
	const rankedSeason = seasonRows(data, gw);
	const rank = rankedSeason.findIndex((row) => row.name === name) + 1;
	const recentRows = data.map(([manager, rows]) => ({
		name: manager,
		points: rows.filter((event) => weeks.includes(event.event)).reduce((total, event) => total + net(event), 0),
	})).sort((a, b) => b.points - a.points);
	const recentRank = recentRows.findIndex((row) => row.name === name) + 1;
	return [`🆚 ${name} — GW${gw}`, `Season: ${season} pts (rank ${rank}/${data.length})`, `Last ${weeks.length} GWs: ${recent} pts (rank ${recentRank}/${data.length})`].join('\n');
}

function buildBanterMessage(data, gw) {
	const season = seasonRows(data, gw);
	const weekly = data.map(([name, history]) => ({
		name,
		points: history.filter((event) => event.event === gw).reduce((total, event) => total + net(event), 0),
	})).sort((a, b) => b.points - a.points);
	if (season.length < 2) return 'The league needs at least two managers before the banter can begin.';
	return `🎤 GW${gw} banter report:\n${weekly[0].name} takes this week’s bragging rights with ${weekly[0].points} pts.\n${season[0].name} is still top overall on ${season[0].seasonPoints} pts.\n${season.at(-1).name}, there’s plenty of season left to turn it around!`;
}

function formatKickoff(kickoffTime) {
	return kickoffTime ? `${kickoffTime.slice(0, 10)} ${kickoffTime.slice(11, 16)} UTC` : 'TBD';
}

async function fixturesText() {
	const [bootstrap, fixtures] = await Promise.all([fplGet('bootstrap-static/'), fplGet('fixtures/')]);
	const latestGw = Math.max(0, ...(bootstrap.events || []).filter((event) => event.finished).map((event) => event.id));
	const nextEvent = (bootstrap.events || []).find((event) => event.is_next)
		|| (bootstrap.events || []).find((event) => event.id > latestGw);
	if (!nextEvent) return 'No upcoming fixtures are currently available.';
	const teams = new Map((bootstrap.teams || []).map((team) => [team.id, team]));
	const upcomingWeeks = (bootstrap.events || []).filter((event) => event.id >= nextEvent.id).slice(0, 5).map((event) => event.id);
	const nextFixtures = fixtures.filter((fixture) => fixture.event === nextEvent.id)
		.sort((a, b) => (a.kickoff_time || '').localeCompare(b.kickoff_time || ''));
	if (nextFixtures.length === 0) return `No fixtures are listed for GW${nextEvent.id} yet.`;
	const lines = [`📅 GW${nextEvent.id} fixtures:`];
	for (const fixture of nextFixtures) {
		const home = teams.get(fixture.team_h);
		const away = teams.get(fixture.team_a);
		lines.push(`${home?.short_name || 'TBC'} v ${away?.short_name || 'TBC'} — ${formatKickoff(fixture.kickoff_time)} (difficulty ${fixture.team_h_difficulty ?? '?'}–${fixture.team_a_difficulty ?? '?'})`);
	}
	const difficulty = new Map();
	for (const fixture of fixtures.filter((item) => upcomingWeeks.includes(item.event))) {
		for (const [teamId, value] of [[fixture.team_h, fixture.team_h_difficulty], [fixture.team_a, fixture.team_a_difficulty]]) {
			if (!difficulty.has(teamId)) difficulty.set(teamId, []);
			difficulty.get(teamId).push(value);
		}
	}
	const hardest = [...difficulty].map(([id, values]) => ({
		name: teams.get(id)?.name || teams.get(id)?.short_name || `Team ${id}`,
		average: values.reduce((sum, value) => sum + value, 0) / values.length,
	})).sort((a, b) => b.average - a.average).slice(0, 3);
	if (hardest.length) lines.push('', `🧱 Toughest next ${upcomingWeeks.length}-GW run (avg difficulty):`, ...hardest.map((team) => `• ${team.name}: ${team.average.toFixed(1)}`));
	return lines.join('\n');
}

async function teamText(leagueId, query) {
	const standings = await fplGet(`leagues-classic/${leagueId}/standings/`);
	const members = standings?.standings?.results || [];
	const result = findManager(members.map((member) => [member.player_name, member.entry]), query);
	if (result.error) return result.error;
	const [name, entryId] = result.manager;
	const [bootstrap, history] = await Promise.all([
		fplGet('bootstrap-static/'),
		fplGet(`entry/${entryId}/history/`),
	]);
	const gw = (bootstrap.events || []).find((event) => event.is_current)?.id
		|| Math.max(0, ...(history.current || []).map((event) => event.event));
	if (!gw) return 'No gameweek is currently available for that manager.';
	const picksData = await fplGet(`entry/${entryId}/event/${gw}/picks/`);
	const elements = bootstrap.elements || [];
	const players = new Map(elements.map((player) => [player.id, player.web_name]));
	const positions = new Map(elements.map((player) => [player.id, player.element_type]));
	const picks = picksData.picks || [];
	if (!picks.length) return `No picks are available for ${name} in GW${gw} yet.`;
	const starters = picks.filter((pick) => pick.position <= 11);
	const formation = [2, 3, 4].map((type) => starters.filter((pick) => positions.get(pick.element) === type).length).join('-');
	const lines = [`🧢 ${name}’s GW${gw} team${formation ? ` (${formation})` : ''}:`];
	for (const pick of starters) {
		const player = players.get(pick.element) || `Player ${pick.element}`;
		lines.push(`${pick.is_captain ? '⭐ ' : ''}${player}${pick.is_captain ? ' (C)' : pick.is_vice_captain ? ' (VC)' : ''}`);
	}
	const bench = picks.filter((pick) => pick.position > 11).map((pick) => players.get(pick.element) || `Player ${pick.element}`);
	if (bench.length) lines.push('', `Bench: ${bench.join(', ')}`);
	return lines.join('\n');
}

async function commandText(command, args, leagueId, mode) {
	if (command === '/score') return scoreText(leagueId, mode);
	if (['/table', '/form', '/gw', '/rival', '/banter'].includes(command)) {
		const data = await getHistoryRows(leagueId);
		const gw = getCurrentGameweek(data);
		if (command === '/table') return buildTableMessage(data, gw);
		if (command === '/form') return buildFormMessage(data, gw);
		if (command === '/gw') return buildGameweekMessage(data, gw);
		if (command === '/rival') return buildRivalMessage(data, gw, args.join(' '));
		return buildBanterMessage(data, gw);
	}
	if (command === '/fixtures') return fixturesText();
	if (command === '/team') return teamText(leagueId, args.join(' '));
	return undefined;
}

async function handleTelegramUpdate(update, env) {
	const message = update.message;
	if (!message?.text || !message.chat?.id) return;
	const [rawCommand, ...args] = message.text.trim().split(/\s+/);
	const command = rawCommand.toLowerCase().split('@')[0];
	const chatId = String(message.chat.id);

	if (command === '/start' || command === '/help') {
		await telegramCall(env, 'sendMessage', {
			chat_id: chatId,
			text: 'FPL commands:\n/score - league score and prizes\n/table - overall standings\n/form - points over the last 5 gameweeks\n/gw - latest gameweek standings\n/rival <name> [vs <name>] - compare managers\n/banter - weekly bragging rights\n/fixtures - next fixtures and toughest runs\n/team <name> - show a manager’s picks',
		});
		return;
	}
	if (!['/score', '/table', '/form', '/gw', '/rival', '/banter', '/fixtures', '/team'].includes(command)) return;

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
		const text = await commandText(command, args, leagueId, mode);
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
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to register Telegram webhook: ${message}`);
				return new Response(`Could not register the Telegram webhook: ${message}`, { status: 502 });
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