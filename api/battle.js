// Topo Wars two player battles. One address, several operations picked by "op".
// The server keeps the real copy of every battle and replays each turn with the same rules the game uses.
const crypto = require('crypto');
const Engine = require('../lib/engine.js');
const db = require('../lib/store.js');

const KEEP_SECONDS = 60 * 60 * 24 * 45;
const MAX_STATE = 3 * 1024 * 1024;
const MAX_ACTIONS = 500;
const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const key = id => 'tw:battle:' + id;
const pushKey = (id, side) => 'tw:push:' + id + ':' + side;
const GAME_URL = 'https://topo-wars.vercel.app';

// Turn notifications. The keys come from setup-push.js and live in the Vercel project settings.
const PUSH_PUB = process.env.VAPID_PUBLIC_KEY || '';
const PUSH_PRIV = process.env.VAPID_PRIVATE_KEY || '';
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
let webpush = null;
function pusher() {
  if (!PUSH_PUB || !PUSH_PRIV) return null;
  if (!webpush) {
    webpush = require('web-push');
    webpush.setVapidDetails(GAME_URL, PUSH_PUB, PUSH_PRIV);
  }
  return webpush;
}
function goodSub(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return false;
  if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
  let host;
  try { const u = new URL(sub.endpoint); if (u.protocol !== 'https:') return false; host = u.hostname; } catch (e) { return false; }
  return process.env.PUSH_ANY_HOST === '1' || PUSH_HOSTS.some(h => host === h || host.endsWith('.' + h));
}
async function notify(id, side, body) {
  const wp = pusher();
  if (!wp) return false;
  try {
    const raw = await db.cmd('GET', pushKey(id, side));
    if (!raw) return false;
    const payload = JSON.stringify({ title: 'Topo Wars', body, id, url: '/#join=' + id });
    await wp.sendNotification(JSON.parse(raw), payload, { TTL: 60 * 60 * 24 * 7, urgency: 'high', timeout: 6000 });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await db.cmd('DEL', pushKey(id, side)).catch(() => {});
    return false;
  }
}
const newId = () => Array.from(crypto.randomBytes(6), b => ID_CHARS[b % ID_CHARS.length]).join('');
const newToken = () => crypto.randomBytes(16).toString('hex');

function reply(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    return req.body;
  }
  if (req.method !== 'POST') return {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function load(id) {
  if (typeof id !== 'string' || !/^[A-Z0-9]{4,12}$/.test(id)) return null;
  const raw = await db.cmd('GET', key(id));
  return raw ? JSON.parse(raw) : null;
}
async function save(id, rec) {
  rec.at = Date.now();
  await db.cmd('SET', key(id), JSON.stringify(rec), 'EX', KEEP_SECONDS);
}
function sideOf(rec, token) {
  if (typeof token !== 'string' || !token) return 0;
  if (token === rec.t[1]) return 1;
  if (token === rec.t[2]) return 2;
  return 0;
}

// A fresh battle straight from Engine.create: nobody has moved and nobody has extra supply.
function checkNew(G) {
  if (!G) return 'The battle data could not be read';
  if (![32, 64, 128].includes(G.size)) return 'Unknown grid size';
  if (G.over || G.round !== 1 || G.turn !== 1) return 'The battle must be brand new';
  if (G.units.length || G.air.length) return 'The battle must start with no pieces placed';
  if (G.score[1] || G.score[2] || G.supply[2] !== 0 || G.supply[1] > Engine.INCOME + 1) return 'The starting supply or score is wrong';
  const N = G.size * G.size;
  for (const k of ['elev', 'tier', 'terr', 'owner']) if (!G[k] || G[k].length !== N) return 'The map data is incomplete';
  return null;
}

const ops = {
  async health() {
    if (!db.configured()) return [200, { ok: true, redis: false, why: 'No Redis address is set' }];
    try {
      const pong = await db.cmd('PING');
      return [200, { ok: true, redis: pong === 'PONG', push: !!(PUSH_PUB && PUSH_PRIV) }];
    } catch (e) {
      return [200, { ok: true, redis: false, why: e.message }];
    }
  },

  async create(b) {
    if (typeof b.state !== 'string' || b.state.length > MAX_STATE) return [400, { error: 'The battle is missing or too large' }];
    const G = Engine.deserialize(b.state);
    const bad = checkNew(G);
    if (bad) return [400, { error: bad }];
    G.diff = 'friend';
    G.log = G.log.slice(-5);
    let id = null;
    for (let k = 0; k < 5 && !id; k++) {
      const tryId = newId();
      const ok = await db.cmd('SET', key(tryId), '{}', 'NX', 'EX', 60);
      if (ok === 'OK') id = tryId;
    }
    if (!id) return [500, { error: 'Could not pick a battle code, try again' }];
    const rec = { rev: 1, t: { 1: newToken(), 2: null }, s: Engine.serialize(G), place: String(b.place || '').slice(0, 80) };
    await save(id, rec);
    return [200, { id, token: rec.t[1], side: 1, rev: rec.rev }];
  },

  async join(b) {
    const rec = await load(b.id);
    if (!rec || !rec.t) return [404, { error: 'That battle was not found. It may have expired.' }];
    let side = sideOf(rec, b.token);
    if (!side) {
      if (rec.t[2]) return [403, { error: 'This battle already has two players.' }];
      rec.t[2] = newToken();
      side = 2;
      await save(b.id, rec);
      await notify(b.id, 1, 'Your friend joined the battle.');
    }
    return [200, { id: b.id, token: rec.t[side], side, rev: rec.rev, state: rec.s, joined: !!rec.t[2], place: rec.place || '' }];
  },

  async state(b) {
    const rec = await load(b.id);
    if (!rec || !rec.t) return [404, { error: 'That battle was not found. It may have expired.' }];
    if (!sideOf(rec, b.token)) return [403, { error: 'You are not a player in this battle.' }];
    const out = { rev: rec.rev, joined: !!rec.t[2] };
    if (Number(b.rev) !== rec.rev) out.state = rec.s;
    return [200, out];
  },

  async vapid() {
    return [200, { key: PUSH_PUB || null }];
  },

  async subscribe(b) {
    const rec = await load(b.id);
    if (!rec || !rec.t) return [404, { error: 'That battle was not found. It may have expired.' }];
    const side = sideOf(rec, b.token);
    if (!side) return [403, { error: 'You are not a player in this battle.' }];
    if (!goodSub(b.sub)) return [400, { error: 'That notification address was not accepted.' }];
    const sub = { endpoint: b.sub.endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth } };
    await db.cmd('SET', pushKey(b.id, side), JSON.stringify(sub), 'EX', KEEP_SECONDS);
    return [200, { ok: true, push: !!pusher() }];
  },

  async unsubscribe(b) {
    const rec = await load(b.id);
    if (!rec || !rec.t) return [404, { error: 'That battle was not found. It may have expired.' }];
    const side = sideOf(rec, b.token);
    if (!side) return [403, { error: 'You are not a player in this battle.' }];
    await db.cmd('DEL', pushKey(b.id, side));
    return [200, { ok: true }];
  },

  async turn(b) {
    const lock = 'tw:lock:' + b.id;
    const rec = await load(b.id);
    if (!rec || !rec.t) return [404, { error: 'That battle was not found. It may have expired.' }];
    const side = sideOf(rec, b.token);
    if (!side) return [403, { error: 'You are not a player in this battle.' }];
    if (Number(b.rev) !== rec.rev) return [409, { error: 'The battle changed since you loaded it.', rev: rec.rev, state: rec.s }];
    const acts = Array.isArray(b.actions) ? b.actions : [];
    if (acts.length > MAX_ACTIONS) return [400, { error: 'Too many moves in one turn' }];
    if ((await db.cmd('SET', lock, '1', 'NX', 'EX', 15)) !== 'OK') return [409, { error: 'That turn is already being saved.', rev: rec.rev, state: rec.s }];
    try {
      const G = Engine.deserialize(rec.s);
      if (G.over) return [409, { error: 'The battle is already over.', rev: rec.rev, state: rec.s }];
      if (G.turn !== side) return [409, { error: 'It is not your turn.', rev: rec.rev, state: rec.s }];
      for (let k = 0; k < acts.length; k++) {
        if (!Engine.apply(G, side, acts[k])) return [409, { error: 'Move ' + (k + 1) + ' of your turn was not allowed, so the turn was not saved.', rev: rec.rev, state: rec.s }];
        if (G.over) break;
      }
      Engine.passTurn(G, side);
      rec.s = Engine.serialize(G);
      rec.rev += 1;
      await save(b.id, rec);
      const other = side === 1 ? 2 : 1;
      const w = G.over && G.over.winner;
      await notify(b.id, other, !G.over ? 'Your friend finished their turn. Your move in round ' + G.round + '.'
        : w === other ? 'You won the battle. Open Topo Wars to see how it ended.'
        : w === side ? 'Your friend won the battle. Open Topo Wars to see how it ended.'
        : 'The battle ended in a draw.');
      return [200, { rev: rec.rev, state: rec.s, joined: !!rec.t[2] }];
    } finally {
      await db.cmd('DEL', lock);
    }
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  try {
    const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const b = { ...q, ...(await readBody(req)) };
    const op = ops[b.op || 'health'];
    if (!op) return reply(res, 400, { error: 'Unknown operation' });
    if (b.op && b.op !== 'health' && b.op !== 'vapid' && !db.configured()) return reply(res, 503, { error: 'The server has no database yet.' });
    const [code, obj] = await op(b);
    return reply(res, code, obj);
  } catch (e) {
    return reply(res, 500, { error: 'Server error: ' + e.message });
  }
};
