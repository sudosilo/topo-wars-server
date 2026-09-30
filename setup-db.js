// Creates an Upstash Redis database with your Upstash email and API key, then hands its address to this Vercel project.
// Run it from the topo-wars-server folder with: node setup-db.js
const readline = require('readline');
const { execSync } = require('child_process');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const lines = [], waiters = [];
rl.on('line', l => { if (waiters.length) waiters.shift()(l.trim()); else lines.push(l.trim()); });
rl.on('close', () => { while (waiters.length) waiters.shift()(''); });
const ask = q => { process.stdout.write(q); return lines.length ? Promise.resolve(lines.shift()) : new Promise(r => waiters.push(r)); };

function setEnv(name, value) {
  try { execSync('vercel env rm ' + name + ' production -y', { stdio: 'ignore' }); } catch (e) { /* it did not exist yet */ }
  execSync('vercel env add ' + name + ' production', { input: value + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
}

(async () => {
  const name = await ask('Name for the new database: ');
  const email = await ask('Upstash login email: ');
  const key = await ask('Upstash API key: ');
  rl.close();
  if (!name || !email || !key) { console.log('All three answers are needed. Nothing was created.'); process.exit(1); }
  const auth = 'Basic ' + Buffer.from(email + ':' + key).toString('base64');
  const api = 'https://api.upstash.com/v2/redis/database';

  let r = await fetch(api, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ database_name: name, platform: 'aws', primary_region: 'us-east-1', tls: true })
  });
  let db = await r.json().catch(() => ({}));
  if (!r.ok || !db.database_id) {
    console.log('Upstash did not create the database. It said: ' + JSON.stringify(db));
    process.exit(1);
  }
  // Some accounts only return the passwords when the database is read back.
  if (!db.password && !db.rest_token) {
    r = await fetch(api + '/' + db.database_id, { headers: { Authorization: auth } });
    db = { ...db, ...(await r.json().catch(() => ({}))) };
  }
  const host = String(db.endpoint || '').includes('.') ? db.endpoint : db.endpoint + '.upstash.io';
  if (db.rest_token) {
    setEnv('UPSTASH_REDIS_REST_URL', 'https://' + host);
    setEnv('UPSTASH_REDIS_REST_TOKEN', db.rest_token);
  } else if (db.password) {
    setEnv('REDIS_URL', 'rediss://default:' + db.password + '@' + host + ':' + (db.port || 6379));
  } else {
    console.log('The database was made but Upstash did not share its password. Database id: ' + db.database_id);
    process.exit(1);
  }
  console.log('Database ' + name + ' is ready and connected to this project.');
})().catch(e => { console.log('Setup stopped: ' + e.message); process.exit(1); });
