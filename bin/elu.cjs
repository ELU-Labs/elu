#!/usr/bin/env node
// The first file every start runs. It is written for any Node to read, so an old Node gets
// one sentence here and not a syntax error. What only a current Node can read is in start.cjs.
'use strict';
var MINIMUM = 22;
if (!(parseInt(process.versions.node, 10) >= MINIMUM)) {
  process.stderr.write('ELU needs Node ' + MINIMUM + ' or newer; this is Node ' + process.versions.node + '.\n');
  process.exit(1);
}
require('./start.cjs');
