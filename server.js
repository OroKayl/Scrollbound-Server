'use strict';
/* Scrollbound — shared-world backend (v0.17: real clan system + friends list)
 *
 * What it does:
 *   - Login with a display name + shared INVITE_CODE -> issues a token.
 *   - Stores each player's personal idle save server-side (skills/gear/gold).
 *   - Holds ONE shared world: which guild owns each POI (AI clans + player clans),
 *     siege declarations, and a server-run siege that resolves everyone together.
 *   - Players can create/join clans; clans collectively own POIs (combined member power).
 *   - Exposes per-player skill levels so friends can see each other's progress.
 *   - Serves the game client from /public so friends just visit the URL.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '4mb' }));

const PORT = process.env.PORT || 3000;
const INVITE_CODE = process.env.INVITE_CODE || 'SCROLLBOUND';
const SIEGE_MINUTES = Number(process.env.SIEGE_MINUTES || 60);
const SIEGE_PERIOD_MS = SIEGE_MINUTES * 60 * 1000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// --- world seed (must match the client's POI + clan ids) ---
const POIS = ['oakreach','tinford','mistlake','greenrow','emberforge','blackpine','gravemount','drownreach','thornwild','cinderpeak','shadefen','glimmerdeep'];
const AI_CLANS = {
  ironpeak:  { n: 'Iron Peak',    factor: 1.05 },
  thornwall: { n: 'Thornwall',    factor: 1.15 },
  tideborn:  { n: 'The Tideborn', factor: 0.90 },
  goldcrest: { n: 'Goldcrest',    factor: 0.80 },
  ashveil:   { n: 'Ashveil',      factor: 1.00 },
};
const AI_START_POWER = 10;
const INIT_OWNERS = { tinford:'ironpeak', greenrow:'goldcrest', blackpine:'thornwall', gravemount:'ironpeak', drownreach:'tideborn', cinderpeak:'ashveil', glimmerdeep:'goldcrest' };

// --- persistence ---
// db.clans: { 'c_hex': { id, name, tag, ownerId, members:[playerId,...], inviteCode, created } }
// db.players[id]: { id, name, guild, power, clanId, skills:{skill:level,...}, save, created, lastSeen }
let db = {
  players: {},
  tokens: {},
  clans: {},
  world: { territories: {}, sieges: {}, nextSiege: 0, season: 1, leaderboard: [], ai: {} }
};

function seedWorld() {
  POIS.forEach(p => { if (!(p in db.world.territories)) db.world.territories[p] = INIT_OWNERS[p] || null; });
  if (!db.world.nextSiege) db.world.nextSiege = Date.now() + SIEGE_PERIOD_MS;
  db.world.ai = db.world.ai || {};
  for (const id of Object.keys(AI_CLANS)) if (!(id in db.world.ai)) db.world.ai[id] = AI_START_POWER;
  db.clans = db.clans || {};
}
function load() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* fresh start */ }
  seedWorld();
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save failed', e); }
  }, 200);
}
load();

// --- power helpers ---
function guildPower(id) {
  if (AI_CLANS[id]) return Math.round(db.world.ai[id] || AI_START_POWER);
  // Player clan: sum of all member powers (more members = genuinely stronger)
  if (db.clans[id]) {
    return db.clans[id].members.reduce((s, pid) => {
      const p = db.players[pid];
      return s + ((p && p.power) || AI_START_POWER);
    }, 0);
  }
  // Solo player
  const p = db.players[id];
  return (p && p.power) || AI_START_POWER;
}
function avgPlayerPower() {
  const now = Date.now();
  const ps = Object.values(db.players).filter(p => now - (p.lastSeen || 0) < 7 * 86400000);
  if (!ps.length) return AI_START_POWER;
  return ps.reduce((s, p) => s + (p.power || AI_START_POWER), 0) / ps.length;
}
function growAI() {
  const target = avgPlayerPower();
  for (const id of Object.keys(AI_CLANS)) {
    const cur = db.world.ai[id] || AI_START_POWER;
    const goal = Math.max(AI_START_POWER, target * AI_CLANS[id].factor);
    db.world.ai[id] = cur + (goal - cur) * 0.2;
  }
}

// --- owner info (handles AI clans, player clans, solo players) ---
function ownerInfo(id) {
  if (!id) return null;
  if (AI_CLANS[id]) return { type: 'ai', id, name: AI_CLANS[id].n };
  if (db.clans[id]) return { type: 'clan', id, name: db.clans[id].name, tag: db.clans[id].tag };
  const p = db.players[id];
  return { type: 'player', id, name: (p && p.guild) || '?' };
}

// --- public world snapshot ---
function publicWorld() {
  const territories = {};
  for (const p of POIS) territories[p] = ownerInfo(db.world.territories[p]);

  const sieges = {};
  for (const p of Object.keys(db.world.sieges)) {
    sieges[p] = db.world.sieges[p]
      .map(id => {
        const info = ownerInfo(id);
        return { id, name: info ? info.name : '?', power: guildPower(id) };
      })
      .sort((a, b) => b.power - a.power);
  }

  const now = Date.now();
  const players = Object.values(db.players).map(p => ({
    id: p.id,
    name: p.name,
    guild: p.guild,
    power: p.power,
    clanId: p.clanId || null,
    clanName: (p.clanId && db.clans[p.clanId]) ? db.clans[p.clanId].name : null,
    clanTag: (p.clanId && db.clans[p.clanId]) ? db.clans[p.clanId].tag : null,
    skills: p.skills || {},
    online: now - (p.lastSeen || 0) < 120000,
  }));

  // Full clan list (invite codes exposed — this is a private friends server)
  const clans = {};
  for (const [id, c] of Object.entries(db.clans)) {
    clans[id] = { id, name: c.name, tag: c.tag, ownerId: c.ownerId, members: c.members, inviteCode: c.inviteCode };
  }

  return {
    territories, sieges,
    nextSiege: db.world.nextSiege,
    season: db.world.season,
    leaderboard: db.world.leaderboard,
    players, clans,
  };
}

// --- auth helper ---
function authed(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '') || (req.body && req.body.token);
  return t && db.tokens[t] ? db.tokens[t] : null;
}

// --- helper: which ID does this player's siege go under? (clanId if in clan, else playerId) ---
function declId(playerId) {
  const p = db.players[playerId];
  return (p && p.clanId) ? p.clanId : playerId;
}

// --- API ---
app.post('/api/login', (req, res) => {
  const { name, code } = req.body || {};
  if (code !== INVITE_CODE) return res.status(403).json({ error: 'Wrong invite code.' });
  if (!name || !/^[\w \-]{1,20}$/.test(name)) return res.status(400).json({ error: 'Name must be 1–20 letters/numbers.' });
  let id = Object.keys(db.players).find(k => db.players[k].name.toLowerCase() === name.toLowerCase());
  if (!id) {
    id = 'p_' + crypto.randomBytes(4).toString('hex');
    db.players[id] = { id, name, guild: name, power: 10, clanId: null, skills: {}, save: null, created: Date.now() };
  }
  const token = crypto.randomBytes(16).toString('hex');
  db.tokens[token] = id;
  db.players[id].lastSeen = Date.now();
  save();
  const p = db.players[id];
  const clan = p.clanId ? db.clans[p.clanId] : null;
  res.json({
    token,
    playerId: id,
    name: p.name,
    clanId: p.clanId || null,
    clanName: clan ? clan.name : null,
    clanTag: clan ? clan.tag : null,
    isOwner: clan ? clan.ownerId === id : false,
    save: p.save,
    world: publicWorld(),
  });
});

app.get('/api/state', (req, res) => {
  const id = authed(req);
  if (id) db.players[id].lastSeen = Date.now();
  const p = id ? db.players[id] : null;
  const clan = (p && p.clanId) ? db.clans[p.clanId] : null;
  res.json({
    world: publicWorld(),
    save: p ? p.save : null,
    you: id || null,
    clanId: p ? (p.clanId || null) : null,
    clanName: clan ? clan.name : null,
    clanTag: clan ? clan.tag : null,
    isOwner: clan ? clan.ownerId === id : false,
  });
});

app.post('/api/save', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const { save: blob, power, guild, skills } = req.body || {};
  if (blob !== undefined) db.players[id].save = blob;
  if (typeof power === 'number') db.players[id].power = Math.max(1, Math.round(power));
  if (guild && /^[\w \-]{1,24}$/.test(guild)) db.players[id].guild = guild;
  if (skills && typeof skills === 'object') db.players[id].skills = skills; // { woodcutting:45, mining:32, ... }
  db.players[id].lastSeen = Date.now();
  save();
  res.json({ ok: true });
});

// --- siege ---
app.post('/api/siege/declare', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const { poiId } = req.body || {};
  if (!POIS.includes(poiId)) return res.status(400).json({ error: 'Unknown POI.' });
  const did = declId(id);
  if (db.world.territories[poiId] === did) return res.status(400).json({ error: 'Your clan already holds it.' });
  // One declared target per declarer (clan or solo player) per window
  for (const p of Object.keys(db.world.sieges)) db.world.sieges[p] = db.world.sieges[p].filter(x => x !== did);
  db.world.sieges[poiId] = db.world.sieges[poiId] || [];
  db.world.sieges[poiId].push(did);
  save();
  res.json({ ok: true, world: publicWorld() });
});

app.post('/api/siege/cancel', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const did = declId(id);
  for (const p of Object.keys(db.world.sieges)) db.world.sieges[p] = db.world.sieges[p].filter(x => x !== did);
  save();
  res.json({ ok: true, world: publicWorld() });
});

// --- clan endpoints ---
app.post('/api/clan/create', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  if (db.players[id].clanId) return res.status(400).json({ error: 'Leave your current clan first.' });
  const { name, tag } = req.body || {};
  if (!name || !/^[\w \-]{2,24}$/.test(name)) return res.status(400).json({ error: 'Clan name must be 2–24 characters.' });
  if (!tag || !/^[A-Za-z0-9]{2,5}$/.test(tag)) return res.status(400).json({ error: 'Tag must be 2–5 letters/numbers.' });
  const cleanTag = tag.toUpperCase();
  for (const c of Object.values(db.clans)) {
    if (c.name.toLowerCase() === name.toLowerCase()) return res.status(400).json({ error: 'Clan name already taken.' });
    if (c.tag === cleanTag) return res.status(400).json({ error: 'Clan tag already taken.' });
  }
  const clanId = 'c_' + crypto.randomBytes(4).toString('hex');
  const inviteCode = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char code
  db.clans[clanId] = { id: clanId, name, tag: cleanTag, ownerId: id, members: [id], inviteCode, created: Date.now() };
  db.players[id].clanId = clanId;
  db.players[id].guild = name;
  save();
  console.log(`[clan] ${db.players[id].name} created "${name}" [${cleanTag}] code=${inviteCode}`);
  res.json({ ok: true, clanId, clanName: name, clanTag: cleanTag, inviteCode, world: publicWorld() });
});

app.post('/api/clan/join', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  if (db.players[id].clanId) return res.status(400).json({ error: 'Leave your current clan first.' });
  const { inviteCode } = req.body || {};
  const clan = Object.values(db.clans).find(c => c.inviteCode === (inviteCode || '').toUpperCase());
  if (!clan) return res.status(404).json({ error: 'Invalid invite code.' });
  clan.members.push(id);
  db.players[id].clanId = clan.id;
  db.players[id].guild = clan.name;
  save();
  console.log(`[clan] ${db.players[id].name} joined "${clan.name}"`);
  res.json({ ok: true, clanId: clan.id, clanName: clan.name, clanTag: clan.tag, isOwner: false, world: publicWorld() });
});

app.post('/api/clan/leave', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const clanId = db.players[id].clanId;
  if (!clanId || !db.clans[clanId]) return res.status(400).json({ error: 'Not in a clan.' });
  const clan = db.clans[clanId];
  if (clan.ownerId === id) {
    // Owner disbands: remove all members and release POIs
    clan.members.forEach(pid => {
      if (db.players[pid]) { db.players[pid].clanId = null; db.players[pid].guild = db.players[pid].name; }
    });
    for (const p of POIS) { if (db.world.territories[p] === clanId) db.world.territories[p] = null; }
    delete db.clans[clanId];
    console.log(`[clan] "${clan.name}" disbanded by owner`);
  } else {
    clan.members = clan.members.filter(m => m !== id);
    db.players[id].clanId = null;
    db.players[id].guild = db.players[id].name;
    console.log(`[clan] ${db.players[id].name} left "${clan.name}"`);
  }
  save();
  // Return explicit clanId:null so client immediately clears clan state
  res.json({ ok: true, clanId: null, clanName: null, clanTag: null, isOwner: false, world: publicWorld() });
});

app.post('/api/clan/kick', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const clanId = db.players[id].clanId;
  if (!clanId || !db.clans[clanId]) return res.status(400).json({ error: 'Not in a clan.' });
  const clan = db.clans[clanId];
  if (clan.ownerId !== id) return res.status(403).json({ error: 'Only the clan owner can kick members.' });
  const { targetId } = req.body || {};
  if (!targetId || targetId === id) return res.status(400).json({ error: 'Invalid target.' });
  if (!clan.members.includes(targetId)) return res.status(400).json({ error: 'Not a clan member.' });
  clan.members = clan.members.filter(m => m !== targetId);
  if (db.players[targetId]) { db.players[targetId].clanId = null; db.players[targetId].guild = db.players[targetId].name; }
  save();
  console.log(`[clan] ${db.players[id].name} kicked ${db.players[targetId] ? db.players[targetId].name : targetId} from "${clan.name}"`);
  // Return kicker's clan info so client stays in sync
  res.json({ ok: true, clanId, clanName: clan.name, clanTag: clan.tag, isOwner: true, world: publicWorld() });
});

app.get('/api/clan/info', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const clanId = req.query.clanId || (db.players[id] && db.players[id].clanId);
  if (!clanId || !db.clans[clanId]) return res.status(404).json({ error: 'Clan not found.' });
  const clan = db.clans[clanId];
  const now = Date.now();
  const members = clan.members.map(pid => {
    const p = db.players[pid];
    return {
      id: pid,
      name: p ? p.name : '?',
      power: p ? (p.power || 0) : 0,
      skills: p ? (p.skills || {}) : {},
      online: p ? (now - (p.lastSeen || 0) < 120000) : false,
      isOwner: pid === clan.ownerId,
    };
  });
  res.json({ clan: { id: clan.id, name: clan.name, tag: clan.tag, ownerId: clan.ownerId, inviteCode: clan.inviteCode, created: clan.created }, members });
});

// --- server-authoritative siege resolution ---
function resolveSieges() {
  const w = db.world;
  growAI();
  for (const aid of Object.keys(AI_CLANS)) {
    if (Math.random() < 0.5) continue;
    const cands = POIS.filter(p => w.territories[p] !== aid);
    if (!cands.length) continue;
    const t = cands[Math.floor(Math.random() * cands.length)];
    w.sieges[t] = w.sieges[t] || [];
    if (!w.sieges[t].includes(aid)) w.sieges[t].push(aid);
  }
  for (const poi of Object.keys(w.sieges)) {
    const attackers = w.sieges[poi].slice().sort((a, b) => guildPower(b) - guildPower(a));
    if (!attackers.length) continue;
    const top = attackers[0];
    if (top === w.territories[poi]) continue;
    const atk = guildPower(top);
    const def = (w.territories[poi] ? guildPower(w.territories[poi]) : 0) + 20; // +20 walls baseline
    const roll = () => 0.7 + Math.random() * 0.6;
    if (atk * roll() > def * roll()) w.territories[poi] = top;
  }
  w.sieges = {};
  w.nextSiege = Date.now() + SIEGE_PERIOD_MS;
  save();
  console.log('[siege] resolved; next window', new Date(w.nextSiege).toISOString());
}
setInterval(() => { if (Date.now() >= db.world.nextSiege) resolveSieges(); }, 15000);

// --- serve the game client ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send('<h1>Scrollbound server is running.</h1><p>Drop the game client at <code>public/index.html</code>.</p>');
});

app.listen(PORT, () => console.log(`Scrollbound server on :${PORT} (invite "${INVITE_CODE}", siege every ${SIEGE_MINUTES}m)`));
