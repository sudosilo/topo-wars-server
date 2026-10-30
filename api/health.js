// Health check. Returns 200 with a small JSON body and reports whether Redis answers a ping.
const db = require('../lib/store.js');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  let redis = 'not configured';
  if (db.configured()) {
    try {
      redis = (await db.cmd('PING')) === 'PONG' ? 'ok' : 'unexpected reply';
    } catch (e) {
      redis = 'error';
    }
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, service: 'topo-wars-server', redis }));
};
