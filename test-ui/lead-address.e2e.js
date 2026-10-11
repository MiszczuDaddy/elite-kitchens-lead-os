'use strict';
// Run with: bash test-ui/run.sh lead-address.e2e.js (demo emulators and fake providers only).
const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const args of [
  ['--test', 'test/lead-address.test.js'],
  ['--test', '--test-name-pattern=^(address intake:|any form works:)', 'test/leads.test.js']
]) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(__dirname, '../functions'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
require('./appointments.e2e');
