// Talks to Redis. Uses the Upstash REST address when one is set, otherwise a normal redis:// or rediss:// address.
const net = require('net');
const tls = require('tls');

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || '';

function configured() {
  return !!((REST_URL && REST_TOKEN) || REDIS_URL);
}

// Redis wire format: every command is an array of strings.
function encode(args) {
  let out = '*' + args.length + '\r\n';
  for (const a of args) {
    const s = String(a);
    out += '$' + Buffer.byteLength(s) + '\r\n' + s + '\r\n';
  }
  return out;
}

// Reads one reply starting at pos. Returns null when more bytes are still on the way.
function parse(buf, pos) {
  if (pos >= buf.length) return null;
  const nl = buf.indexOf('\r\n', pos);
  if (nl < 0) return null;
  const type = String.fromCharCode(buf[pos]);
  const line = buf.toString('utf8', pos + 1, nl);
  const next = nl + 2;
  if (type === '+') return { v: line, end: next };
  if (type === '-') return { err: line, end: next };
  if (type === ':') return { v: Number(line), end: next };
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return { v: null, end: next };
    if (buf.length < next + len + 2) return null;
    return { v: buf.toString('utf8', next, next + len), end: next + len + 2 };
  }
  if (type === '*') {
    const n = Number(line);
    if (n < 0) return { v: null, end: next };
    const arr = [];
    let p = next;
    for (let k = 0; k < n; k++) {
      const r = parse(buf, p);
      if (!r) return null;
      arr.push(r.err ? new Error(r.err) : r.v);
      p = r.end;
    }
    return { v: arr, end: p };
  }
  return { err: 'Unreadable reply from Redis', end: buf.length };
}

function connect() {
  return new Promise((resolve, reject) => {
    const url = new URL(REDIS_URL);
    const secure = url.protocol === 'rediss:';
    const opts = { host: url.hostname, port: Number(url.port) || 6379 };
    const sock = secure ? tls.connect({ ...opts, servername: url.hostname }) : net.connect(opts);
    const waiting = [];
    let buf = Buffer.alloc(0);
    let ready = false;
    const handle = { dead: false };
    sock.on('close', () => { handle.dead = true; while (waiting.length) waiting.shift().no(new Error('Redis connection closed')); });
    sock.setTimeout(9000, () => sock.destroy(new Error('Redis timed out')));
    sock.on('data', d => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      let r;
      while (waiting.length && (r = parse(buf, 0))) {
        buf = buf.subarray(r.end);
        const w = waiting.shift();
        if (r.err) w.no(new Error(r.err)); else w.ok(r.v);
      }
    });
    sock.on('error', e => {
      while (waiting.length) waiting.shift().no(e);
      if (!ready) reject(e);
    });
    const send = args => new Promise((ok, no) => {
      waiting.push({ ok, no });
      sock.write(encode(args));
    });
    sock.once(secure ? 'secureConnect' : 'connect', async () => {
      try {
        const pass = decodeURIComponent(url.password || '');
        const user = decodeURIComponent(url.username || '');
        if (pass) await send(user ? ['AUTH', user, pass] : ['AUTH', pass]);
        ready = true;
        Object.assign(handle, { send, close: () => sock.end() });
        resolve(handle);
      } catch (e) {
        sock.destroy();
        reject(e);
      }
    });
  });
}

let conn = null;
async function cmd(...args) {
  if (REST_URL && REST_TOKEN) {
    const r = await fetch(REST_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REST_TOKEN },
      body: JSON.stringify(args.map(String))
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  }
  if (!REDIS_URL) throw new Error('No Redis address is set on the server');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!conn || conn.dead) conn = await connect();
      return await conn.send(args);
    } catch (e) {
      if (conn) { try { conn.close(); } catch (x) { /* already closed */ } }
      conn = null;
      if (attempt === 1 || /WRONGPASS|NOAUTH|ERR/.test(e.message)) throw e;
    }
  }
}

module.exports = { cmd, configured, encode, parse };
