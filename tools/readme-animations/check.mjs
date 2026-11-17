#!/usr/bin/env node
// check.mjs: reads one animation written by render.mjs and checks it without drawing it.
//
//   node check.mjs <animation.svg> [<story folder>]
//
// It checks that the file holds only what a README image may hold, that exactly one frame
// shows at every moment of the loop, that the loop is as long as the story says, that with
// reduced motion only the still frame shows, and that no path or real e-mail is in the text.
// It does not check that the file is well-formed XML: use a real parser for that (USAGE.md).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [file, storyDir] = process.argv.slice(2);
if (!file) {
  process.stderr.write('usage: node check.mjs <animation.svg> [<story folder>]\n');
  process.exit(2);
}
const svg = readFileSync(file, 'utf8');
const story = storyDir ? JSON.parse(readFileSync(join(storyDir, 'story.json'), 'utf8')) : null;
let bad = 0;
const say = (ok, msg) => {
  if (!ok) bad++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${msg}\n`);
};
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// 1. only what a README image may hold
const banned = [
  ['script', /<script/i], ['foreignObject', /<foreignObject/i], ['SMIL', /<(animate|animateTransform|animateMotion|set)[\s>]/],
  ['outside image', /<image[\s>]/i], ['@import', /@import/i], ['@font-face', /@font-face/i],
  ['outside link', /href="(?!#)/], ['outside url()', /url\((?!#)/], ['event handler', /\son[a-z]+="/i],
];
for (const [what, re] of banned) say(!re.test(svg), `no ${what}`);
const title = /<title>([^<]*)<\/title>/.exec(svg);
say(!!title && title[1].trim().length > 0, `title: ${title ? unesc(title[1]) : 'missing'}`);
if (story) say(!!title && unesc(title[1]) === story.alt, 'the title is the story\'s alt text');
say(/<svg[^>]*\sviewBox="0 0 [\d.]+ [\d.]+"/.test(svg) && /<svg[^>]*\swidth="\d+"/.test(svg), 'the svg has a viewBox and a width');

// 2. the loop
const css = (/<style>([\s\S]*?)<\/style>/.exec(svg) ?? [, ''])[1];
const groups = [...svg.matchAll(/<g class="F F(\d+)( S)?">/g)].map((m) => ({ k: Number(m[1]), still: !!m[2] }));
const base = /\.F\{visibility:hidden;animation:([\d.]+)s step-end infinite\}\.S\{visibility:visible\}/.exec(css);
say(groups.length > 0, `${groups.length} frames`);
if (groups.length > 1) {
  say(!!base, 'frames are hidden unless the loop or the still rule shows them');
  const T = base ? Number(base[1]) : NaN;
  const frames = groups.map(({ k }) => {
    const named = new RegExp(`\\.F${k}\\{animation-name:k${k}\\}`).test(css);
    const body = new RegExp(`@keyframes k${k}\\{((?:[\\d.,%]+\\{visibility:(?:visible|hidden)\\})+)\\}`).exec(css);
    const keys = [];
    if (body) {
      for (const m of body[1].matchAll(/([\d.,%]+)\{visibility:(visible|hidden)\}/g)) {
        for (const p of m[1].split(',')) keys.push([Number(p.replace('%', '')), m[2] === 'visible']);
      }
    }
    keys.sort((a, b) => a[0] - b[0]);
    return { k, named, keys };
  });
  say(frames.every((f) => f.named && f.keys.length >= 2 && f.keys[0][0] === 0 && f.keys[f.keys.length - 1][0] === 100), 'every frame has its own keyframes from 0% to 100%');
  // step-end: a value holds from its keyframe until the next one
  const shows = (f, p) => {
    let v = false;
    for (const [at, vis] of f.keys) if (at <= p) v = vis;
    return v;
  };
  const edges = [...new Set(frames.flatMap((f) => f.keys.map((x) => x[0])))].sort((a, b) => a - b);
  const points = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1];
    points.push(a, a + 1e-7, (a + b) / 2, b - 1e-7);
  }
  for (let i = 0; i < 5000; i++) points.push((i / 5000) * 100);
  let wrong = 0;
  for (const p of points) if (frames.filter((f) => shows(f, p)).length !== 1) wrong++;
  say(wrong === 0, `exactly one frame shows at each of ${points.length} moments of the loop, the edges included`);
  // which frame shows in each stretch, and for how long
  const order = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const on = frames.filter((f) => shows(f, (edges[i] + edges[i + 1]) / 2)).map((f) => f.k);
    const secs = ((edges[i + 1] - edges[i]) / 100) * T;
    if (order.length && order[order.length - 1].k === on[0]) order[order.length - 1].secs += secs;
    else order.push({ k: on[0], secs });
  }
  say(order.map((o) => o.k).join(',') === groups.map((g) => g.k).join(','), `frames show in order: ${order.map((o) => `${o.k} for ${o.secs.toFixed(2)} s`).join(', ')}`);
  say(Math.abs(order.reduce((a, o) => a + o.secs, 0) - T) < 1e-6, `the loop is ${T} s long`);
  if (story) {
    const want = story.frames.map((f) => f.seconds);
    say(Math.abs(want.reduce((a, b) => a + b, 0) - T) < 0.005, `the loop length is the sum of the story's seconds (${want.reduce((a, b) => a + b, 0)})`);
    say(order.length === want.length && order.every((o, i) => Math.abs(o.secs - want[i]) < 0.005), 'each frame shows for its own seconds');
  }
  say(/@media \(prefers-reduced-motion:reduce\)\{\.F\{animation:none\}\}/.test(css), 'with reduced motion the loop is off');
  const stills = groups.filter((g) => g.still);
  say(stills.length === 1, `with reduced motion, or no animation, only frame ${stills.map((g) => g.k).join(',') || '?'} shows`);
  if (story) say(stills.length === 1 && stills[0].k === (story.still ?? 1), 'that frame is the story\'s still');
}
if (story) {
  const caps = [...svg.matchAll(/<text class="C"[^>]*>([^<]*)<\/text>/g)].map((m) => unesc(m[1]));
  say(caps.length === story.frames.length && caps.every((c, i) => c === story.frames[i].caption), 'each frame carries its caption');
}

// 3. nothing private in the text
const text = unesc(svg.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, '\n'));
const paths = text.match(/(?:\/tmp\/|\/home\/|\/Users\/|\/private\/|\/var\/folders\/|\/root\/)\S*/g) ?? [];
say(paths.length === 0, `no machine path in the text${paths.length ? ': ' + [...new Set(paths)].slice(0, 5).join(' ') : ''}`);
const mails = (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).filter((m) => !/(\.invalid|[@.]example\.(com|org|net)|\.example)$/i.test(m));
say(mails.length === 0, `every e-mail ends in .invalid or example.com${mails.length ? ': ' + [...new Set(mails)].slice(0, 5).join(' ') : ''}`);

process.stdout.write(`${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB · ${bad ? bad + ' FAILED' : 'all checks passed'}\n`);
process.exit(bad ? 1 : 0);
