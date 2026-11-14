// What each model costs at its maker's API list price, in US dollars per million tokens:
// input (neither read from nor written to the cache), cached input (read from the cache),
// cache write, and output. ELU prices a run with it only where the vendor reported tokens and
// no cost: Codex, Antigravity, and Grok Build signed in with a subscription. A cost the vendor
// reported (Claude Code's, Grok Build's on an API key) is used as it is. A model that is not
// here has no known price: its runs add nothing to a total and show a dash, never 0 and never
// a near model's price. This is the one place ELU keeps prices.
//
// Checked 2026-11-14, each on its maker's own page:
//   OpenAI     https://developers.openai.com/api/docs/pricing
//              Standard tier, short context (up to 272K input, the context Codex 0.167.0 gives
//              these models). Cache write: the 30-minute one, the default lifetime; Codex sets
//              none (prompt_cache_ttl is unset) and ELU passes no service tier, so a run is Standard.
//   Google     https://aistudio.google.com/docs/pricing
//              Standard paid tier, prompts up to 200k tokens. Gemini lists no cache write price:
//              written tokens are input. Antigravity names a model with its effort
//              (gemini-3.1-pro-high), which priceOf leaves out; 3.1 Pro is gemini-3.1-pro-preview
//              there, and gemini-3.1-pro-preview-customtools, under the same heading and price.
//              Gemini 3.5 Flash (only its Lite is listed) has no price.
//   xAI        https://docs.x.ai/docs/models
//              Prompts under 200k tokens. No cache write price: written tokens are input.
//              grok-4.6-fast is not listed, and has no price.
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//              For a Claude model another vendor runs (Antigravity offers some). Cache write:
//              the 5-minute one, the default lifetime. Haiku 5.5, priced by prompt size, is left out.
// A run's tokens are its total over every request, so a request over a model's short-context
// size, which its maker bills higher, is priced at the short rate.
export const PRICES_CHECKED = '2026-11-14';

const p = (input, cached, output, write) => Object.freeze({ input, cached, output, ...(write === undefined ? {} : { write }) });
const CLAUDE_4 = p(5, 0.5, 25, 6.25), SONNET_4 = p(3, 0.3, 15, 3.75);
// A price that changes on a day: the entries in order, each until the day the next one starts (UTC).
const until = (day, before, after) => Object.freeze([Object.freeze({ ...before, until: day }), after]);
const FLASH = until('2027-01-01', p(0.75, 0.075, 3.75), p(1.5, 0.15, 7.5));
const GEMINI_4 = until('2026-12-01', p(2, 0.1, 10), p(4, 0.2, 20));

export const PRICES = Object.freeze({
  // OpenAI: the models Codex 0.167.0 lists (codex debug models --bundled), then the others of the page.
  'gpt-6-astra': p(10, 1, 50, 12.5),
  'gpt-6.1-sol': p(2, 0.1, 10, 2.5),
  'gpt-6.1-terra': p(1, 0.05, 5, 1.25),
  'gpt-6-sol': p(2, 0.2, 10, 2.5),
  'gpt-6-luna': p(0.1, 0.01, 0.5, 0.125),
  'gpt-5.6-sol': p(4, 0.4, 20, 5),
  'gpt-5.6-terra': p(2, 0.2, 12, 2.5),
  'gpt-5.6-luna': p(0.2, 0.02, 1.2, 0.25),
  'gpt-5.5': p(5, 0.5, 30),
  'gpt-5.4': p(2.5, 0.25, 15),
  'gpt-5.4-mini': p(0.75, 0.075, 4.5),
  'gpt-5.4-nano': p(0.2, 0.02, 1.25),
  'gpt-5.3-codex': p(1.75, 0.175, 14),
  'gpt-5.2': p(1.75, 0.175, 14),
  'gpt-5.1': p(1.25, 0.125, 10),
  'gpt-5': p(1.25, 0.125, 10),
  'gpt-5-mini': p(0.25, 0.025, 2),
  'gpt-5-nano': p(0.05, 0.005, 0.4),
  // Google: Gemini, which Antigravity runs.
  'gemini-3.1-pro': p(2, 0.2, 12),
  'gemini-3.8-flash': FLASH,
  'gemini-3.6-flash': FLASH,
  'gemini-3.5-flash-lite': p(0.3, 0.03, 2.5),
  'gemini-3.1-flash-lite': p(0.25, 0.025, 1.5),
  'gemini-3-flash': p(0.5, 0.05, 3),
  'gemini-3.1-pro-preview-customtools': p(2, 0.2, 12),
  'gemini-4-carbon': GEMINI_4,
  'gemini-4-argon': GEMINI_4,
  'gemini-4-hydrogen': p(1.5, 0.075, 7.5),
  // xAI: Grok, which Grok Build runs.
  'grok-4.7': p(2, 0.5, 6),
  'grok-4.6': p(2, 0.5, 6),
  'grok-4.5': p(2, 0.3, 6),
  'grok-4.3': p(1.25, 0.2, 2.5),
  'grok-4.20-0309-reasoning': p(1.25, 0.2, 2.5),
  'grok-4.20-0309-non-reasoning': p(1.25, 0.2, 2.5),
  'grok-4.20-multi-agent-0309': p(1.25, 0.2, 2.5),
  'grok-build-0.1': p(1, 0.2, 2),
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
// A model's price on a day (at: a time, now when not given), or null when it has none here.
export function priceOf(model, at = Date.now()) {
  const id = keys(model).find(key => Object.hasOwn(PRICES, key));
  if (!id) return null;
  const entry = PRICES[id];
  if (!Array.isArray(entry)) return entry;
  const day = new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 10);
  const { until: _, ...price } = entry.find(item => !item.until || day < item.until) ?? entry.at(-1);
  return price;
}
// What tokens cost at a model's list price, in dollars, or null when the model has no price
// here or there are no tokens. tokens: { input, output, cacheRead, cacheWrite }, input being
// neither read from nor written to the cache. models: { id: tokens } for a run of several
// models, each at its own price; null when any of them has none.
export function listCost(model, tokens, { models = null, at = Date.now() } = {}) {
  const parts = models && typeof models === 'object' && Object.keys(models).length ? Object.entries(models) : [[model, tokens]];
  let dollars = 0;
  for (const [id, used] of parts) {
    const price = priceOf(id, at);
    if (!price || !used) return null;
    dollars += (used.input * price.input + used.cacheRead * price.cached + used.cacheWrite * (price.write ?? price.input) + used.output * price.output) / 1e6;
  }
  return dollars;
}
