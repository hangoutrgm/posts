// ============================================================
// Arena — Bracket & Match Engine (PURE)
// No Firebase, no DOM: every export is a pure function over plain
// objects so it can be reasoned about (and tested) in isolation.
//
// Formats : Single Elimination · Double Elimination (WB + LB + GF)
//           Round Robin
// Series  : BO1 / BO3 / BO5  -> winsNeeded() threshold
// Advance : decideMatch() writes the winner into the next slot and
//           auto-resolves byes / drops losers into the losers bracket.
//
// Match shape (stored under /arena/matches/{tid}/{matchId}):
//   { id, stage:'wb'|'lb'|'gf'|'rr', round, index,
//     slotA, slotB, scoreA, scoreB, winner, status,
//     winTo:{id,slot}|null, loseTo:{id,slot}|null,
//     scheduledAt, roomRevealAt, roomId, roomPass }
// ============================================================

export const FORMAT = { SINGLE: 'single', DOUBLE: 'double', RR: 'rr' };
export const SERIES = { BO1: 1, BO3: 3, BO5: 5 };

/** Series label -> games the winner must take (BO3 -> 2). */
export function winsNeeded(series) {
  const n = SERIES[series] || 1;
  return Math.ceil((n + 1) / 2);
}

function pow2AtLeast(n) {
  let s = 1;
  while (s < Math.max(n, 1)) s *= 2;
  return s;
}

function roundCount(size) { return Math.log2(size); }

/** Standard seeding order (1v16, 8v9, 4v13, ...) as 1-based seeds. */
function seedOrder(size) {
  let arr = [1];
  while (arr.length < size) {
    const n = arr.length * 2;
    const next = [];
    for (const s of arr) { next.push(s); next.push(n + 1 - s); }
    arr = next;
  }
  return arr;
}

function match(id, stage, round, index, slotA, slotB) {
  return {
    id, stage, round, index,
    slotA: slotA ?? null, slotB: slotB ?? null,
    scoreA: 0, scoreB: 0, winner: null, status: 'pending',
    winTo: null, loseTo: null,
    scheduledAt: 0, roomRevealAt: 0, roomId: '', roomPass: ''
  };
}

/** Write a team into a match slot. */
function place(m, slot, teamId) {
  if (!m) return;
  if (slot === 'B') m.slotB = teamId; else m.slotA = teamId;
}

/** Propagate a decided match: winner -> winTo, loser -> loseTo. */
function advance(m, winnerId, matches) {
  if (m.winTo && winnerId) place(matches[m.winTo.id], m.winTo.slot, winnerId);
  if (m.loseTo) {
    const loser = m.slotA === winnerId ? m.slotB : m.slotA;
    if (loser) place(matches[m.loseTo.id], m.loseTo.slot, loser);
  }
}

/** Assign times by round depth; the room reveals when the match is due. */
function scheduleMatches(matches, startTime, roundGapMs, matchGapMs) {
  for (const m of Object.values(matches)) {
    m.scheduledAt = startTime + m.round * roundGapMs + m.index * matchGapMs;
    m.roomRevealAt = m.scheduledAt;
  }
}

// ------------------------------------------------------------
// Round Robin: every pair plays once.
// ------------------------------------------------------------
function buildRoundRobin(teams) {
  const matches = {};
  let n = 0;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const id = `rr${n}`;
      matches[id] = match(id, 'rr', 0, n, teams[i], teams[j]);
      n++;
    }
  }
  return matches;
}

/** Standings: 2 pts/win, 1/draw, sorted by pts, wins, game diff. */
export function roundRobinStandings(matches) {
  const table = {};
  const put = (id) => (table[id] = table[id] || { id, w: 0, l: 0, d: 0, gf: 0, ga: 0, pts: 0 });
  for (const m of Object.values(matches || {})) {
    if (!m.slotA || !m.slotB || m.status !== 'done') continue;
    const a = put(m.slotA), b = put(m.slotB);
    a.gf += m.scoreA; a.ga += m.scoreB;
    b.gf += m.scoreB; b.ga += m.scoreA;
    if (m.winner === m.slotA) { a.w++; b.l++; a.pts += 2; }
    else if (m.winner === m.slotB) { b.w++; a.l++; b.pts += 2; }
    else { a.d++; b.d++; a.pts++; b.pts++; }
  }
  return Object.values(table).sort((x, y) =>
    y.pts - x.pts || y.w - x.w || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
}

// ------------------------------------------------------------
// Single / Double elimination
// ------------------------------------------------------------
function buildSingleElim(teams, stage, size) {
  const matches = {};
  const rounds = roundCount(size);
  const order = seedOrder(size);
  const slots = order.map((s) => teams[s - 1] ?? null);

  for (let r = 0; r < rounds; r++) {
    const perRound = size / Math.pow(2, r + 1);
    for (let i = 0; i < perRound; i++) {
      const id = `${stage}R${r + 1}M${i}`;
      matches[id] = match(id, stage, r, i,
        r === 0 ? slots[i * 2] : null,
        r === 0 ? slots[i * 2 + 1] : null);
    }
  }
  for (let r = 0; r < rounds - 1; r++) {
    const perRound = size / Math.pow(2, r + 1);
    for (let i = 0; i < perRound; i++) {
      matches[`${stage}R${r + 1}M${i}`].winTo =
        { id: `${stage}R${r + 2}M${Math.floor(i / 2)}`, slot: i % 2 === 0 ? 'A' : 'B' };
    }
  }
  return matches;
}

/**
 * Losers-bracket match objects for power-of-two `size`. LB alternates minor
 * rounds (LB teams only) and major rounds (fresh WB dropouts join at slot B).
 * Round indices continue after the WB rounds so rendering stays ordered.
 */
function buildLosersBracket(size, wbRounds) {
  const lbRounds = Math.max(0, 2 * (roundCount(size) - 1));
  const matches = {};
  const counts = [];
  for (let j = 1; j <= lbRounds; j++) {
    if (j === 1) counts.push(size / 4);
    else if (j % 2 === 0) counts.push(counts[j - 2]);  // major = prior minor count
    else counts.push(counts[j - 2] / 2);               // minor = half
  }
  for (let j = 1; j <= lbRounds; j++) {
    for (let i = 0; i < counts[j - 1]; i++) {
      const id = `lbR${j}M${i}`;
      matches[id] = match(id, 'lb', wbRounds - 1 + j, i, null, null);
    }
  }
  return { matches, counts, lbRounds };
}

/** Auto-win every one-sided match (bye) and push it forward until stable. */
export function resolveByes(matches, need) {
  let changed = true, guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (const m of Object.values(matches)) {
      if (m.winner || m.status === 'done') continue;
      const hasA = !!m.slotA, hasB = !!m.slotB;
      if (hasA === hasB) continue;
      m.winner = hasA ? m.slotA : m.slotB;
      m.status = 'done';
      m.scoreA = hasA ? need : 0;
      m.scoreB = hasB ? need : 0;
      advance(m, m.winner, matches);
      changed = true;
    }
  }
  return matches;
}

/**
 * Build the bracket for a tournament.
 * @param {object} o { format, teams:[id], startTime, roundGapMs, matchGapMs }
 * @returns {{matches:object, rounds:number}}
 */
export function generateBracket(o) {
  const format = o.format || FORMAT.SINGLE;
  const teams = (o.teams || []).filter(Boolean);
  const startTime = o.startTime || Date.now();
  const roundGapMs = o.roundGapMs ?? 30 * 60 * 1000;
  const matchGapMs = o.matchGapMs ?? 5 * 60 * 1000;

  if (format === FORMAT.RR) {
    const matches = buildRoundRobin(teams);
    scheduleMatches(matches, startTime, roundGapMs, matchGapMs);
    return { matches, rounds: 1 };
  }

  const size = pow2AtLeast(Math.max(teams.length, 2));
  const wbRounds = roundCount(size);
  const matches = buildSingleElim(teams, 'wb', size);

  if (format === FORMAT.SINGLE) {
    scheduleMatches(matches, startTime, roundGapMs, matchGapMs);
    return { matches, rounds: wbRounds };
  }

  // ---- Double elimination ----
  const lb = buildLosersBracket(size, wbRounds);
  Object.assign(matches, lb.matches);

  // WB round 1 losers -> LB round 1 (two feed each LB1 match).
  for (let i = 0; i < size / 2; i++) {
    matches[`wbR1M${i}`].loseTo =
      { id: `lbR1M${Math.floor(i / 2)}`, slot: i % 2 === 0 ? 'A' : 'B' };
  }
  // WB round r>=2 losers -> LB major round 2(r-1), slot B (fresh dropout).
  for (let r = 2; r <= wbRounds; r++) {
    const lbRound = 2 * (r - 1);
    const perWB = size / Math.pow(2, r);
    for (let i = 0; i < perWB; i++) {
      matches[`wbR${r}M${i}`].loseTo = { id: `lbR${lbRound}M${i}`, slot: 'B' };
    }
  }
  // Wire LB winners forward:
  //   even (major) j: LB(j-1) match i -> LBj match i, slot A
  //   odd  (minor) j: LB(j-1) match i -> LBj match floor(i/2), slot A/B
  for (let j = 2; j <= lb.lbRounds; j++) {
    const prevCnt = lb.counts[j - 2];
    for (let i = 0; i < prevCnt; i++) {
      const from = matches[`lbR${j - 1}M${i}`];
      if (j % 2 === 0) from.winTo = { id: `lbR${j}M${i}`, slot: 'A' };
      else from.winTo = { id: `lbR${j}M${Math.floor(i / 2)}`, slot: i % 2 === 0 ? 'A' : 'B' };
    }
  }
  // Grand final: WB champion (A) vs LB champion (B).
  const gf = match('gfR1M0', 'gf', wbRounds + lb.lbRounds, 0, null, null);
  matches[gf.id] = gf;
  const wbFinal = matches[`wbR${wbRounds}M0`];
  wbFinal.winTo = { id: gf.id, slot: 'A' };
  if (lb.lbRounds > 0) matches[`lbR${lb.lbRounds}M0`].winTo = { id: gf.id, slot: 'B' };
  else wbFinal.loseTo = { id: gf.id, slot: 'B' }; // size==2: GF is a rematch

  scheduleMatches(matches, startTime, roundGapMs, matchGapMs);
  return { matches, rounds: wbRounds + lb.lbRounds + 1 };
}

/**
 * Record a result and auto-advance the winner. PURE: returns a NEW matches
 * object (deep clone), never mutates the input.
 * @throws Error when the score isn't a legal result for the series.
 */
export function decideMatch(currentMatches, matchId, scoreA, scoreB, series) {
  const need = winsNeeded(series);
  const matches = JSON.parse(JSON.stringify(currentMatches || {}));
  const m = matches[matchId];
  if (!m) throw new Error('Match not found.');
  if (m.status === 'done') throw new Error('This match already has a result.');

  const a = Number(scoreA), b = Number(scoreB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    throw new Error('Scores must be whole numbers.');
  }
  const legal = (a === need && b < need) || (b === need && a < need);
  if (!legal) {
    throw new Error(`Best of ${SERIES[series] || 1} — the winner must take ${need} game(s) (e.g. ${need}-0, ${need}-1).`);
  }

  m.scoreA = a;
  m.scoreB = b;
  m.winner = a > b ? m.slotA : m.slotB;
  m.status = 'done';
  advance(m, m.winner, matches);
  return resolveByes(matches, need);
}

/** True when every match in the bracket has a decided winner. */
export function isComplete(matches) {
  const list = Object.values(matches || {});
  return list.length > 0 && list.every((m) => m.status === 'done' && m.winner);
}

/** Champion: GF winner (double elim), last WB winner (single), or RR leader. */
export function championOf(matches, format) {
  if (!matches) return null;
  if (format === FORMAT.RR) {
    const s = roundRobinStandings(matches);
    return s.length ? s[0].id : null;
  }
  if (matches.gfR1M0) return matches.gfR1M0.winner || null;
  const wb = Object.values(matches).filter((m) => m.stage === 'wb');
  const last = wb.sort((x, y) => y.round - x.round)[0];
  return last ? last.winner : null;
}

/** Group matches for rendering into stage -> round -> sorted match list. */
export function bracketRounds(matches) {
  const out = { wb: {}, lb: {}, gf: {}, rr: {} };
  for (const m of Object.values(matches || {})) {
    const stage = out[m.stage] ? m.stage : 'wb';
    const key = m.stage === 'rr' ? 0 : m.round;
    (out[stage][key] = out[stage][key] || []).push(m);
  }
  for (const stage of Object.keys(out)) {
    for (const r of Object.keys(out[stage])) {
      out[stage][r].sort((x, y) => x.index - y.index);
    }
  }
  return out;
}
