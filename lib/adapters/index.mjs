import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as agy from './agy.mjs';
import * as grok from './grok.mjs';
import { refuse } from '../util.mjs';
import { VENDORS } from '../vendors.mjs';

// The adapter registry: one module per entry in VENDORS.
export const ADAPTERS = Object.freeze({ claude, codex, agy, grok });
export function adapterFor(vendor) {
  if (!VENDORS.includes(vendor) || !ADAPTERS[vendor]) refuse(`Choose a supported vendor: ${String(vendor).slice(0, 40)}.`);
  return ADAPTERS[vendor];
}
