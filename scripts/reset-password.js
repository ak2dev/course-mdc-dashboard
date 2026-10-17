'use strict';

// Removes the faculty password set in the Control Center, so sign-in falls back
// to TEACHER_PASSWORD (or the built-in default if that is unset).
// Uses MongoDB when MONGODB_URI is set (environment or .env.local), otherwise
// data/credentials.json. When using the JSON file, stop the local server first.
//   npm run reset-password

const path = require('path');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
} catch { /* optional */ }

const { getStore } = require('../lib/store');

(async () => {
  const store = getStore();
  const removed = await store.deleteCredential('faculty');
  const target = store.kind === 'mongodb' ? 'MongoDB' : 'data/credentials.json';
  console.log(removed
    ? `Removed the custom faculty password from ${target}. Sign in with TEACHER_PASSWORD (or the default), then set a new one in Control Center → Security.`
    : `No custom faculty password was set in ${target}; nothing changed.`);
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
