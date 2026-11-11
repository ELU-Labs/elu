'use strict';
// Loaded by elu.cjs once the Node is new enough to read this line.
import('../lib/install.mjs').then(function (install) { return install.start(); }).catch(function (error) {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exit(1);
});
