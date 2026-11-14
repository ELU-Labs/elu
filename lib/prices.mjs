// What each model costs at its maker's API list price, in US dollars per million tokens:
// input (neither read from nor written to the cache), cached input (read from the cache),
// cache write, and output; and, for a model its maker bills higher once a request's prompt is
// long, that long-context price (long: from, the prompt in tokens it starts at, its input,
// cached and written tokens all counted; it is then the price of every token of the request).
// ELU prices a run with it only where the vendor reported tokens and no cost: Codex,
// Antigravity, and Grok Build signed in with a subscription. A cost the vendor reported
// (Claude Code's, Grok Build's on an API key) is used as it is. A model that is not here has
// no known price: its runs add nothing to a total and show a dash, never 0 and never a near
// model's price. This is the one place ELU keeps prices.
//
// Checked 2026-11-14, each on its maker's own page:
//   OpenAI     https://developers.openai.com/api/docs/pricing
//              Standard tier: short context up to 272K input tokens, long context over it.
//              Codex 0.167.0 gives gpt-6.1-terra a 500K context, and the others 272K, so a
//              gpt-6.1-terra request can be long. Cache write: the 30-minute one, the default
//              lifetime; Codex sets none (prompt_cache_ttl is unset) and ELU passes no service
//              tier, so a run is Standard. The page lists no long price for gpt-5.4-mini and
//              older: one price at any size.
//   Google     https://aistudio.google.com/docs/pricing
//              Standard paid tier: prompts up to 200k tokens, and over it (3.1 Pro only; the
//              others list one price at any size). Gemini lists no cache write price:
//              written tokens are input. Antigravity names a model with its effort
//              (gemini-3.1-pro-high), which priceOf leaves out; 3.1 Pro is gemini-3.1-pro-preview
//              there, and gemini-3.1-pro-preview-customtools, under the same heading and price.
//              Gemini 3.5 Flash (only its Lite is listed) has no price.
//   xAI        https://docs.x.ai/docs/models
//              Prompts under 200k tokens, and of 200k or more. No cache write price: written
//              tokens are input.
//              grok-4.6-fast is not listed, and has no price.
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//              For a Claude model another vendor runs (Antigravity offers some). Cache write:
//              the 5-minute one, the default lifetime. Haiku 5.5, priced by prompt size, is left out.
// A run is priced in each band only where its vendor says how big each request's prompt was
// (Codex, by its record of the thread); otherwise all of it is at the short rate.
export const PRICES_CHECKED = '2026-11-14';

const p = (input, cached, output, write) => Object.freeze({ input, cached, output, ...(write === undefined ? {} : { write }) });
// A price with its long-context one, from a request whose prompt is from tokens.
const band = from => (short, long) => Object.freeze({ ...short, long: Object.freeze({ from, ...long }) });
const OPENAI = band(272_001), GEMINI = band(200_001), XAI = band(200_000);
const CLAUDE_4 = p(5, 0.5, 25, 6.25), SONNET_4 = p(3, 0.3, 15, 3.75);
// A price that changes on a day: the entries in order, each until the day the next one starts (UTC).
const until = (day, before, after) => Object.freeze([Object.freeze({ ...before, until: day }), after]);
const FLASH = until('2027-01-01', p(0.75, 0.075, 3.75), p(1.5, 0.15, 7.5));
const GEMINI_4 = until('2026-12-01', p(2, 0.1, 10), p(4, 0.2, 20));

export const PRICES = Object.freeze({
  // OpenAI: the models Codex 0.167.0 lists (codex debug models --bundled), then the others of the page.
  'gpt-6-astra': OPENAI(p(10, 1, 50, 12.5), p(20, 2, 75, 25)),
  'gpt-6.1-sol': OPENAI(p(2, 0.1, 10, 2.5), p(4, 0.2, 15, 5)),
  'gpt-6.1-terra': OPENAI(p(1, 0.05, 5, 1.25), p(2, 0.1, 7.5, 2.5)),
  'gpt-6-sol': OPENAI(p(2, 0.2, 10, 2.5), p(4, 0.4, 15, 5)),
  'gpt-6-luna': OPENAI(p(0.1, 0.01, 0.5, 0.125), p(0.2, 0.02, 0.75, 0.25)),
  'gpt-5.6-sol': OPENAI(p(4, 0.4, 20, 5), p(8, 0.8, 30, 10)),
  'gpt-5.6-terra': OPENAI(p(2, 0.2, 12, 2.5), p(4, 0.4, 18, 5)),
  'gpt-5.6-luna': OPENAI(p(0.2, 0.02, 1.2, 0.25), p(0.4, 0.04, 1.8, 0.5)),
  'gpt-5.5': OPENAI(p(5, 0.5, 30), p(10, 1, 45)),
  'gpt-5.4': OPENAI(p(2.5, 0.25, 15), p(5, 0.5, 22.5)),
  'gpt-5.4-mini': p(0.75, 0.075, 4.5),
  'gpt-5.4-nano': p(0.2, 0.02, 1.25),
  'gpt-5.3-codex': p(1.75, 0.175, 14),
  'gpt-5.2': p(1.75, 0.175, 14),
  'gpt-5.1': p(1.25, 0.125, 10),
  'gpt-5': p(1.25, 0.125, 10),
  'gpt-5-mini': p(0.25, 0.025, 2),
  'gpt-5-nano': p(0.05, 0.005, 0.4),
  // Google: Gemini, which Antigravity runs.
  'gemini-3.1-pro': GEMINI(p(2, 0.2, 12), p(4, 0.4, 18)),
  'gemini-3.8-flash': FLASH,
  'gemini-3.6-flash': FLASH,
  'gemini-3.5-flash-lite': p(0.3, 0.03, 2.5),
  'gemini-3.1-flash-lite': p(0.25, 0.025, 1.5),
  'gemini-3-flash': p(0.5, 0.05, 3),
  'gemini-3.1-pro-preview-customtools': GEMINI(p(2, 0.2, 12), p(4, 0.4, 18)),
  'gemini-4-carbon': GEMINI_4,
  'gemini-4-argon': GEMINI_4,
  'gemini-4-hydrogen': p(1.5, 0.075, 7.5),
  // xAI: Grok, which Grok Build runs.
  'grok-4.7': XAI(p(2, 0.5, 6), p(4, 1, 12)),
  'grok-4.6': XAI(p(2, 0.5, 6), p(4, 1, 12)),
  'grok-4.5': XAI(p(2, 0.3, 6), p(4, 0.6, 12)),
  'grok-4.3': XAI(p(1.25, 0.2, 2.5), p(2.5, 0.4, 5)),
  'grok-4.20-0309-reasoning': XAI(p(1.25, 0.2, 2.5), p(2.5, 0.4, 5)),
  'grok-4.20-0309-non-reasoning': XAI(p(1.25, 0.2, 2.5), p(2.5, 0.4, 5)),
  'grok-4.20-multi-agent-0309': XAI(p(1.25, 0.2, 2.5), p(2.5, 0.4, 5)),
  'grok-build-0.1': XAI(p(1, 0.2, 2), p(2, 0.4, 4)),
  // Anthropic: Claude.
  'claude-fable-5-2': p(8, 0.2, 40, 10),
  'claude-fable-5-1': p(10, 0.25, 50, 12.5),
  'claude-fable-5': p(10, 1, 50, 12.5),
  'claude-opus-5-5': p(4, 0.2, 20, 5),
  'claude-opus-5': CLAUDE_4,
  'claude-opus-4-8': CLAUDE_4,
  'claude-opus-4-7': CLAUDE_4,
  'claude-opus-4-6': CLAUDE_4,
  'claude-opus-4-5': CLAUDE_4,
  'claude-sonnet-5-5': p(2, 0.1, 10, 2.5),
  'claude-sonnet-5': p(2, 0.2, 10, 2.5),
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-haiku-4-5': p(1, 0.1, 5, 1.25),
});

const EFFORT = /(?:-(?:minimal|low|medium|high|xhigh|max|thinking))+$/, AND_PREVIEW = /(?:-(?:minimal|low|medium|high|xhigh|max|thinking|preview))+$/;
// The names a model id may stand for in the table, most exact first: as given; without a
// provider's prefix (xai/, models/, anthropic.), a dated snapshot or a context window; without
// the efforts a vendor puts in its name (gemini-3-flash-high); without those and -preview,
// in either order. Never without any other word: gemini-3.5-flash is not gemini-3.5-flash-lite.
function keys(model) {
  if (typeof model !== 'string' || !model.trim() || model.length > 100) return [];
  // A display name, Gemini 3.1 Pro (High), reads as its id.
  const id = model.trim().toLowerCase().replace(/[()]/g, '').replace(/\s+/g, '-');
  const bare = id.slice(id.lastIndexOf('/') + 1).replace(/^(?:anthropic|google|openai|xai)\./, '').replace(/\[[^\]]*\]$/, '').replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$|@[\w.-]*$/, '');
  const plain = bare.replace(EFFORT, '');
  return [...new Set([id, bare, plain, bare.replace(AND_PREVIEW, '')])];
}
// A model's whole entry on a day (at: a time, now when not given), or null.
function entryOf(model, at = Date.now()) {
  const id = keys(model).find(key => Object.hasOwn(PRICES, key));
  if (!id) return null;
  const entry = PRICES[id];
  if (!Array.isArray(entry)) return entry;
  const day = new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 10);
  const { until: _, ...price } = entry.find(item => !item.until || day < item.until) ?? entry.at(-1);
  return price;
}
// A model's price on a day (at: a time, now when not given), or null when it has none here.
export function priceOf(model, at = Date.now()) {
  const entry = entryOf(model, at);
  if (!entry) return null;
  const { long: _, ...price } = entry;
  return price;
}
// A model's long-context price on a day: { from, input, cached, output, write? }, or null when
// its maker bills it the same at any size (or it has no price here).
export const longPriceOf = (model, at = Date.now()) => entryOf(model, at)?.long ?? null;
const dollarsOf = (used, price) => (used.input * price.input + used.cacheRead * price.cached + used.cacheWrite * (price.write ?? price.input) + used.output * price.output) / 1e6;
// What tokens cost at a model's list price, in dollars, or null when the model has no price
// here or there are no tokens. tokens: { input, output, cacheRead, cacheWrite }, input being
// neither read from nor written to the cache. long: the part of them its requests whose prompt
// reached the model's long-context size used, at that price (lib/codex-rollout.mjs); the rest
// is at the short one, as all of it is for a model with none. models: { id: tokens } for a run
// of several models, each at its own price; null when any of them has none.
export function listCost(model, tokens, { models = null, at = Date.now(), long = null } = {}) {
  const several = models && typeof models === 'object' && Object.keys(models).length, parts = several ? Object.entries(models) : [[model, tokens]];
  let dollars = 0;
  for (const [id, used] of parts) {
    const entry = entryOf(id, at);
    if (!entry || !used) return null;
    const over = !several && long && entry.long ? long : null;
    const short = over ? Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, Math.max(0, used[key] - over[key])])) : used;
    dollars += dollarsOf(short, entry) + (over ? dollarsOf(over, entry.long) : 0);
  }
  return dollars;
}
