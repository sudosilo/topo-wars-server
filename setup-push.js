// Makes the key pair that signs turn notifications and stores it in this Vercel project.
// Run it once from the topo-wars-server folder with: node setup-push.js
const crypto = require('crypto');
const { execSync } = require('child_process');

function setEnv(name, value) {
  try { execSync('vercel env rm ' + name + ' production -y', { stdio: 'ignore' }); } catch (e) { /* it did not exist yet */ }
  execSync('vercel env add ' + name + ' production', { input: value + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const b64u = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);

setEnv('VAPID_PUBLIC_KEY', b64u(raw));
setEnv('VAPID_PRIVATE_KEY', priv.d);
console.log('Notification keys are stored in this project.');
