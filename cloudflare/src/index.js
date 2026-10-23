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
		return [member.player_name, history.current || [], member.entry];
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
	return data.map(([name, history, entryId]) => ({
		name,
		entryId,
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
		return buildRivalComparison(metrics[0], metrics[1], gw, weeks.length);
	}
	const [{ name, recent, season }] = metrics;
	const rankedSeason = seasonRows(data, gw);
	const target = results[0].manager;
	const entryId = target[2];
	const rank = rankedSeason.findIndex((row) => entryId !== undefined ? row.entryId === entryId : row.name === name) + 1;
	const recentRows = data.map(([manager, rows, managerEntryId]) => ({
		name: manager,
		entryId: managerEntryId,
		points: rows.filter((event) => weeks.includes(event.event)).reduce((total, event) => total + net(event), 0),
	})).sort((a, b) => b.points - a.points);
	const recentRank = recentRows.findIndex((row) => entryId !== undefined ? row.entryId === entryId : row.name === name) + 1;
	return [`🆚 ${name} — GW${gw}`, `Season: ${season} pts (rank ${rank}/${data.length})`, `Last ${weeks.length} GWs: ${recent} pts (rank ${recentRank}/${data.length})`].join('\n');
}

function buildRivalComparison(first, second, gw, weekCount) {
	const seasonLead = first.season - second.season;
	const recentLead = first.recent - second.recent;
	const seasonWinner = seasonLead >= 0 ? first.name : second.name;
	const recentWinner = recentLead >= 0 ? first.name : second.name;
	return [`🆚 ${first.name} vs ${second.name} — GW${gw}`,
		`Season: ${first.name} ${first.season} pts, ${second.name} ${second.season} pts (${seasonWinner} +${Math.abs(seasonLead)})`,
		`Last ${weekCount} GWs: ${first.name} ${first.recent} pts, ${second.name} ${second.recent} pts (${recentWinner} +${Math.abs(recentLead)})`].join('\n');
}

function buildRivalEntryComparison(data, gw, firstEntryId, secondEntryId) {
	const weeks = [...new Set(data.flatMap(([, history]) => history.map((event) => event.event)))]
		.sort((a, b) => b - a).slice(0, 5);
	const selected = [firstEntryId, secondEntryId].map((entryId) => data.find(([, , id]) => String(id) === String(entryId)));
	if (selected.some((row) => !row)) return 'A manager in that selection is no longer in this league. Please try /rival again.';
	const metrics = selected.map(([name, history]) => ({
		name,
		season: history.filter((event) => event.event <= gw).reduce((total, event) => total + net(event), 0),
		recent: history.filter((event) => weeks.includes(event.event)).reduce((total, event) => total + net(event), 0),
	}));
	return buildRivalComparison(metrics[0], metrics[1], gw, weeks.length);
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

function getNextGameweek(bootstrap) {
	const events = bootstrap.events || [];
	const latestFinished = Math.max(0, ...events.filter((event) => event.finished).map((event) => event.id));
	return events.find((event) => event.is_next)
		|| events.find((event) => event.is_current && !event.finished)
		|| events.find((event) => event.id > latestFinished);
}

function rankPlayerPicks(bootstrap, fixtures, gameweek, positions) {
	const teams = new Map((bootstrap.teams || []).map((team) => [team.id, team]));
	const fixtureByTeam = new Map();
	for (const fixture of fixtures.filter((item) => item.event === gameweek)) {
		const home = teams.get(fixture.team_h);
		const away = teams.get(fixture.team_a);
		if (home) fixtureByTeam.set(fixture.team_h, {
			opponent: away?.short_name || 'TBC',
			venue: 'H',
			difficulty: fixture.team_h_difficulty ?? 3,
		});
		if (away) fixtureByTeam.set(fixture.team_a, {
			opponent: home?.short_name || 'TBC',
			venue: 'A',
			difficulty: fixture.team_a_difficulty ?? 3,
		});
	}
	return (bootstrap.elements || []).filter((player) => positions.includes(player.element_type)
		&& player.now_cost > 0
		&& (!player.status || player.status === 'a')
		&& player.chance_of_playing_next_round !== 0)
		.map((player) => {
			const fixture = fixtureByTeam.get(player.team);
			const form = Number(player.form) || 0;
			const pointsPerGame = Number(player.points_per_game) || 0;
			const minutes = Number(player.minutes) || 0;
			const difficulty = fixture?.difficulty ?? 3;
			const score = form * 0.45 + pointsPerGame * 0.35 + (5 - difficulty) * 0.45 + Math.min(minutes / 1800, 1) * 0.75;
			return {
				name: player.web_name,
				position: player.element_type,
				team: teams.get(player.team)?.short_name || 'TBC',
				price: player.now_cost / 10,
				form,
				pointsPerGame,
				fixture: fixture ? `${fixture.venue} ${fixture.opponent} (FDR ${fixture.difficulty})` : 'fixture TBD',
				score,
			};
		}).sort((a, b) => b.score - a.score);
}

async function recommendationsText(captainOnly = false) {
	const [bootstrap, fixtures] = await Promise.all([fplGet('bootstrap-static/'), fplGet('fixtures/')]);
	const nextEvent = getNextGameweek(bootstrap);
	if (!nextEvent) return 'No upcoming gameweek is currently available for recommendations.';
	const positionNames = new Map([[1, 'GK'], [2, 'DEF'], [3, 'MID'], [4, 'FWD']]);
	const playerPositions = captainOnly ? [3, 4] : [1, 2, 3, 4];
	const ranked = rankPlayerPicks(bootstrap, fixtures, nextEvent.id, playerPositions);
	if (ranked.length === 0) return 'No available player recommendations were found for the next gameweek.';
	if (captainOnly) {
		const shortlist = ranked.slice(0, 3);
		const lines = [`© GW${nextEvent.id} captain shortlist (form, minutes & fixture-based):`];
		shortlist.forEach((player, index) => {
			const label = index === 0 ? '⭐ Suggested captain' : index === 1 ? 'Vice-captain option' : 'Alternative';
			lines.push(`${label}: ${player.name} (${player.team}, ${player.fixture}; form ${player.form})`);
		});
		lines.push('', 'These are stats-based suggestions, not predictions or guarantees.');
		return lines.join('\n');
	}
	const lines = [`💡 GW${nextEvent.id} suggested picks (stats-based):`];
	for (const [position, name] of positionNames) {
		const candidates = ranked.filter((player) => player.position === position).slice(0, 2);
		if (candidates.length) {
			lines.push('', `${name}:`, ...candidates.map((player) => `• ${player.name} (${player.team}, £${player.price.toFixed(1)}m, form ${player.form}; ${player.fixture})`));
		}
	}
	lines.push('', 'Uses recent form, points per game, minutes, availability and fixture difficulty; not a guarantee of points.');
	return lines.join('\n');
}

function formatTransferTime(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'time unavailable';
	return `${new Intl.DateTimeFormat('en-GB', {
		day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
	}).format(date).replace(',', '')} UTC`;
}

async function movesText(leagueId) {
	const [standings, bootstrap] = await Promise.all([
		fplGet(`leagues-classic/${leagueId}/standings/`),
		fplGet('bootstrap-static/'),
	]);
	const members = standings?.standings?.results || [];
	if (members.length === 0) return 'No managers were found in this league.';
	const playerNames = new Map((bootstrap.elements || []).map((player) => [player.id, player.web_name]));
	const managerActivity = await Promise.all(members.map(async (member) => {
		const [transfers, history] = await Promise.all([
			fplGet(`entry/${member.entry}/transfers/`),
			fplGet(`entry/${member.entry}/history/`),
		]);
		return { manager: member.player_name, transfers: transfers || [], history };
	}));
	const transfers = managerActivity.flatMap(({ manager, transfers: rows }) =>
		rows.map((transfer) => ({ ...transfer, manager })))
		.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 15);
	const specialMoves = managerActivity.flatMap(({ manager, history }) => [
		...(history.chips || []).map((chip) => ({ type: 'chip', manager, event: chip.event, name: chip.name })),
		...(history.current || []).filter((event) => event.event_transfers_cost > 0)
			.map((event) => ({ type: 'hit', manager, event: event.event, cost: event.event_transfers_cost })),
	]).sort((a, b) => b.event - a.event).slice(0, 10);
	if (transfers.length === 0 && specialMoves.length === 0) return 'No transfers, chips, or point hits have been recorded in this league yet.';
	const lines = [];
	if (transfers.length) lines.push(`🔄 Latest league transfers (${transfers.length} shown):`);
	for (const transfer of transfers) {
		const playerIn = playerNames.get(transfer.element_in) || `Player ${transfer.element_in}`;
		const playerOut = playerNames.get(transfer.element_out) || `Player ${transfer.element_out}`;
		lines.push(`GW${transfer.event} · ${transfer.manager}: ${playerOut} → ${playerIn} · ${formatTransferTime(transfer.time)}`);
	}
	if (specialMoves.length) {
		lines.push('', '⚡ Chips & hits (latest 10):');
		for (const move of specialMoves) {
			if (move.type === 'hit') {
				lines.push(`GW${move.event} · ${move.manager}: took a -${move.cost} point hit`);
			} else {
				const chipNames = {
					wildcard: 'Wildcard',
					freehit: 'Free Hit',
					bboost: 'Bench Boost',
					'3xc': 'Triple Captain',
					assistant_manager: 'Assistant Manager',
				};
				const chipName = chipNames[move.name] || move.name.replaceAll('_', ' ');
				lines.push(`GW${move.event} · ${move.manager}: used ${chipName}`);
			}
		}
	}
	return lines.join('\n');
}

async function teamText(leagueId, query, selectedEntryId) {
	const standings = await fplGet(`leagues-classic/${leagueId}/standings/`);
	const members = standings?.standings?.results || [];
	let member;
	if (selectedEntryId !== undefined) {
		member = members.find((item) => String(item.entry) === String(selectedEntryId));
		if (!member) return 'That manager is no longer in this league. Please run /team again.';
	} else {
		const result = findManager(members.map((item) => [item.player_name, item.entry]), query);
		if (result.error) return result.error;
		const [, entryId] = result.manager;
		member = members.find((item) => String(item.entry) === String(entryId));
	}
	const { player_name: name, entry: entryId } = member;
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

function managerKeyboard(members, action, firstEntryId) {
	const candidates = firstEntryId === undefined
		? members
		: members.filter((member) => String(member.entry) !== String(firstEntryId));
	const prefix = firstEntryId === undefined ? action : `${action}2:${firstEntryId}`;
	const buttons = candidates.map((member) => {
		const teamName = member.entry_name && member.entry_name !== member.player_name ? ` · ${member.entry_name}` : '';
		const text = `${member.player_name}${teamName}`;
		return {
			text: Array.from(text).slice(0, 64).join(''),
			callback_data: `${prefix}:${member.entry}`,
		};
	});
	const keyboard = [];
	for (let index = 0; index < buttons.length; index += 2) keyboard.push(buttons.slice(index, index + 2));
	return { inline_keyboard: keyboard };
}

async function sendManagerChoices(env, chatId, leagueId, action, firstEntryId) {
	const standings = await fplGet(`leagues-classic/${leagueId}/standings/`);
	const members = standings?.standings?.results || [];
	const candidates = firstEntryId === undefined
		? members
		: members.filter((member) => String(member.entry) !== String(firstEntryId));
	if (candidates.length === 0) {
		await telegramCall(env, 'sendMessage', { chat_id: chatId, text: 'No other managers are available to compare.' });
		return;
	}
	await telegramCall(env, 'sendMessage', {
		chat_id: chatId,
		text: firstEntryId === undefined
			? action === 'team' ? 'Choose a manager to view their team:' : 'Choose the first manager to compare:'
			: 'Choose the second manager to compare:',
		reply_markup: managerKeyboard(members, action, firstEntryId),
	});
}

function configuredLeague(chatId, env) {
	if (env.TG_CHAT_ID && chatId === String(env.TG_CHAT_ID) && env.FPL_LEAGUE_ID) {
		return { leagueId: env.FPL_LEAGUE_ID, mode: 'quarter' };
	}
	if (env.TG_CHAT_ID_2 && chatId === String(env.TG_CHAT_ID_2) && env.FPL_LEAGUE_ID_2) {
		return { leagueId: env.FPL_LEAGUE_ID_2, mode: 'four_week' };
	}
	return undefined;
}

async function handleCallbackQuery(callback, env) {
	const chatId = callback.message?.chat?.id;
	if (!chatId) return;
	await telegramCall(env, 'answerCallbackQuery', { callback_query_id: callback.id });
	const config = configuredLeague(String(chatId), env);
	if (!config) {
		await telegramCall(env, 'sendMessage', { chat_id: String(chatId), text: 'This chat is not configured for this bot.' });
		return;
	}
	const parts = (callback.data || '').split(':');
	try {
		if (parts[0] === 'team' && parts.length === 2 && /^\d+$/.test(parts[1])) {
			const text = await teamText(config.leagueId, '', parts[1]);
			await telegramCall(env, 'sendMessage', { chat_id: String(chatId), text });
		} else if (parts[0] === 'rival' && parts.length === 2 && /^\d+$/.test(parts[1])) {
			await sendManagerChoices(env, String(chatId), config.leagueId, 'rival', parts[1]);
		} else if (parts[0] === 'rival2' && parts.length === 3 && parts.slice(1).every((part) => /^\d+$/.test(part))) {
			const data = await getHistoryRows(config.leagueId);
			const gw = getCurrentGameweek(data);
			const text = buildRivalEntryComparison(data, gw, parts[1], parts[2]);
			await telegramCall(env, 'sendMessage', { chat_id: String(chatId), text });
		}
	} catch (error) {
		console.error('Failed to process manager selection:', error);
		await telegramCall(env, 'sendMessage', {
			chat_id: String(chatId),
			text: 'Sorry, I could not load that manager right now. Please try again shortly.',
		});
	}
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
	if (command === '/moves') return movesText(leagueId);
	if (command === '/recommend') return recommendationsText();
	if (command === '/captain') return recommendationsText(true);
	if (command === '/team' && args.length === 0) return undefined;
	if (command === '/team') return teamText(leagueId, args.join(' '));
	if (command === '/rival' && args.length === 0) return undefined;
	return undefined;
}

async function handleTelegramUpdate(update, env) {
	if (update.callback_query) {
		await handleCallbackQuery(update.callback_query, env);
		return;
	}
	const message = update.message;
	if (!message?.text || !message.chat?.id) return;
	const [rawCommand, ...args] = message.text.trim().split(/\s+/);
	const command = rawCommand.toLowerCase().split('@')[0];
	const chatId = String(message.chat.id);

	if (command === '/start' || command === '/help') {
		await telegramCall(env, 'sendMessage', {
			chat_id: chatId,
			text: 'FPL commands:\n/score - league score and prizes\n/table - overall standings\n/form - points over the last 5 gameweeks\n/gw - latest gameweek standings\n/rival - tap two managers to compare (or type names)\n/moves - latest transfers, chips and hits\n/banter - weekly bragging rights\n/fixtures - next fixtures and toughest runs\n/recommend - stats-based picks by position\n/captain - captain shortlist\n/team - tap a manager to view their picks (or type a name)',
		});
		return;
	}
	if (!['/score', '/table', '/form', '/gw', '/rival', '/moves', '/banter', '/fixtures', '/recommend', '/captain', '/team'].includes(command)) return;

	const config = configuredLeague(chatId, env);
	if (!config) {
		await telegramCall(env, 'sendMessage', {
			chat_id: chatId,
			text: 'This chat is not configured for this bot.',
		});
		return;
	}

	try {
		if (command === '/team' && args.length === 0) {
			await sendManagerChoices(env, chatId, config.leagueId, 'team');
			return;
		}
		if (command === '/rival' && args.length === 0) {
			await sendManagerChoices(env, chatId, config.leagueId, 'rival');
			return;
		}
		const text = await commandText(command, args, config.leagueId, config.mode);
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
					allowed_updates: ['message', 'callback_query'],
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