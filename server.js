'use strict';
/* Scrollbound — shared-world backend (Phase A, friends beta)
 *
 * What it does:
 *   - Login with a display name + shared INVITE_CODE -> issues a token.
 *   - Stores each player's personal idle save server-side (skills/gear/gold).
 *   - Holds ONE shared world: which guild owns each POI (AI clans + real players),
 *     siege declarations, and a server-run siege that resolves everyone together.
 *   - Serves the game client from /public so friends just visit the URL.
 *
 * Data is a JSON file (DATA_FILE). For a casual beta that's fine; for durability
 * across redeploys, point DATA_FILE at a mounted volume (see README).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '4mb' }));

const PORT = process.env.PORT || 3000;
const INVITE_CODE = process.env.INVITE_CODE || 'SCROLLBOUND';
const SIEGE_MINUTES = Number(process.env.SIEGE_MINUTES || 60); // beta default: hourly windows
const SIEGE_PERIOD_MS = SIEGE_MINUTES * 60 * 1000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// --- world seed (must match the client's POI + clan ids) ---
const POIS = ['oakreach','tinford','mistlake','greenrow','emberforge','blackpine','gravemount','drownreach','thornwild','cinderpeak','shadefen','glimmerdeep'];
const AI_CLANS = {
  ironpeak:  { n: 'Iron Peak',   power: 45 },
  thornwall: { n: 'Thornwall',   power: 55 },
  tideborn:  { n: 'The Tideborn',power: 35 },
  goldcrest: { n: 'Goldcrest',   power: 30 },
  ashveil:   { n: 'Ashveil',     power: 40 },
};
const INIT_OWNERS = { tinford:'ironpeak', greenrow:'goldcrest', blackpine:'thornwall', gravemount:'ironpeak', drownreach:'tideborn', cinderpeak:'ashveil', glimmerdeep:'goldcrest' };

// --- persistence ---
let db = { players:{}, tokens:{}, world:{ territories:{}, sieges:{}, nextSiege:0, season:1, leaderboard:[] } };
function seedWorld() {
  POIS.forEach(p => { if (!(p in db.world.territories)) db.world.territories[p] = INIT_OWNERS[p] || null; });
  if (!db.world.nextSiege) db.world.nextSiege = Date.now() + SIEGE_PERIOD_MS;
}
function load() { try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* fresh */ } seedWorld(); }
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save failed', e); } }, 200); }
load();

// --- helpers ---
function guildPower(id) {
  if (AI_CLANS[id]) return AI_CLANS[id].power;
  const p = db.players[id];
  return (p && p.power) || 10;
}
function ownerInfo(id) {
  if (!id) return null;
  if (AI_CLANS[id]) return { type:'ai', id, name: AI_CLANS[id].n };
  return { type:'player', id, name: (db.players[id] && db.players[id].guild) || '?' };
}
function publicWorld() {
  const territories = {};
  for (const p of POIS) territories[p] = ownerInfo(db.world.territories[p]);
  const sieges = {};
  for (const p of Object.keys(db.world.sieges)) {
    sieges[p] = db.world.sieges[p].map(id => ({ id, name: AI_CLANS[id] ? AI_CLANS[id].n : (db.players[id] && db.players[id].guild) || '?', power: guildPower(id) }))
      .sort((a, b) => b.power - a.power);
  }
  const now = Date.now();
  return {
    territories, sieges,
    nextSiege: db.world.nextSiege,
    season: db.world.season,
    leaderboard: db.world.leaderboard,
    players: Object.values(db.players).map(p => ({ name:p.name, guild:p.guild, power:p.power, online: now - (p.lastSeen||0) < 120000 })),
  };
}
function authed(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '') || (req.body && req.body.token);
  return t && db.tokens[t] ? db.tokens[t] : null;
}

// --- API ---
app.post('/api/login', (req, res) => {
  const { name, code } = req.body || {};
  if (code !== INVITE_CODE) return res.status(403).json({ error: 'Wrong invite code.' });
  if (!name || !/^[\w \-]{1,20}$/.test(name)) return res.status(400).json({ error: 'Name must be 1–20 letters/numbers.' });
  let id = Object.keys(db.players).find(k => db.players[k].name.toLowerCase() === name.toLowerCase());
  if (!id) { id = 'p_' + crypto.randomBytes(4).toString('hex'); db.players[id] = { id, name, guild: name, power: 10, save: null, created: Date.now() }; }
  const token = crypto.randomBytes(16).toString('hex');
  db.tokens[token] = id;
  db.players[id].lastSeen = Date.now();
  save();
  res.json({ token, playerId: id, name: db.players[id].name, save: db.players[id].save, world: publicWorld() });
});

app.get('/api/state', (req, res) => {
  const id = authed(req);
  if (id) db.players[id].lastSeen = Date.now();
  res.json({ world: publicWorld(), save: id ? db.players[id].save : null, you: id });
});

app.post('/api/save', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const { save: blob, power, guild } = req.body || {};
  if (blob !== undefined) db.players[id].save = blob;
  if (typeof power === 'number') db.players[id].power = Math.max(1, Math.round(power));
  if (guild && /^[\w \-]{1,24}$/.test(guild)) db.players[id].guild = guild;
  db.players[id].lastSeen = Date.now();
  save();
  res.json({ ok: true });
});

app.post('/api/siege/declare', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  const { poiId } = req.body || {};
  if (!POIS.includes(poiId)) return res.status(400).json({ error: 'Unknown POI.' });
  if (db.world.territories[poiId] === id) return res.status(400).json({ error: 'You already hold it.' });
  // one declared target per player per window
  for (const p of Object.keys(db.world.sieges)) db.world.sieges[p] = db.world.sieges[p].filter(x => x !== id);
  db.world.sieges[poiId] = db.world.sieges[poiId] || [];
  db.world.sieges[poiId].push(id);
  save();
  res.json({ ok: true, world: publicWorld() });
});

app.post('/api/siege/cancel', (req, res) => {
  const id = authed(req);
  if (!id) return res.status(401).json({ error: 'Not logged in.' });
  for (const p of Object.keys(db.world.sieges)) db.world.sieges[p] = db.world.sieges[p].filter(x => x !== id);
  save();
  res.json({ ok: true, world: publicWorld() });
});

// --- server-authoritative siege resolution (everyone resolves together) ---
function resolveSieges() {
  const w = db.world;
  // AI clans muster: each may declare on a random POI it doesn't already hold
  for (const aid of Object.keys(AI_CLANS)) {
    if (Math.random() < 0.5) continue;
    const cands = POIS.filter(p => w.territories[p] !== aid);
    if (!cands.length) continue;
    const t = cands[Math.floor(Math.random() * cands.length)];
    w.sieges[t] = w.sieges[t] || [];
    if (!w.sieges[t].includes(aid)) w.sieges[t].push(aid);
  }
  // resolve each contested POI: highest-power attacker fights the defender
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

// --- serve the game client (put the built client at public/index.html) ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.type('html').send('<h1>Scrollbound server is running.</h1><p>Drop the game client at <code>public/index.html</code>.</p>');
});

app.listen(PORT, () => console.log(`Scrollbound server on :${PORT} (invite "${INVITE_CODE}", siege every ${SIEGE_MINUTES}m)`));
