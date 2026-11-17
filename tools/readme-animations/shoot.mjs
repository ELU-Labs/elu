#!/usr/bin/env node
// shoot.mjs: takes pictures of an SVG in a headless Chromium, shown the way a README shows it:
// as an <img>, served with the policy GitHub puts on raw SVG files (inline styles only).
//
//   node shoot.mjs <chromium> <file.svg> <out folder> [--at 1,4.5] [--bg '#0d1117'] [--reduced] [--scale 2] [--clip x,y,w,h] [--timeline]
//
//   --at        seconds after the page loaded at which to take a picture (one picture each)
//   --bg        the page colour behind the image (default white)
//   --reduced   ask for reduced motion, as a person's system setting does
//   --scale     pixels per CSS pixel (default 1)
//   --clip      take only this part of the page, for a close look (the image starts at 20,20)
//   --timeline  no pictures: step the loop in the browser and print which frame shows when
//
// No dependencies. Node 22. Never run it on a laptop that is doing other work.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const rest = [];
const opt = { at: [], bg: '#ffffff', reduced: false, scale: 1, clip: null, timeline: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--at') opt.at = args[++i].split(',').map(Number);
  else if (args[i] === '--bg') opt.bg = args[++i];
  else if (args[i] === '--scale') opt.scale = Number(args[++i]);
  else if (args[i] === '--clip') opt.clip = args[++i].split(',').map(Number);
  else if (args[i] === '--reduced') opt.reduced = true;
  else if (args[i] === '--timeline') opt.timeline = true;
  else rest.push(args[i]);
}
if (rest.length !== 3) {
  process.stderr.write("usage: node shoot.mjs <chromium> <file.svg> <out folder> [--at 1,4.5] [--bg '#0d1117'] [--reduced] [--scale 2] [--clip x,y,w,h] [--timeline]\n");
  process.exit(2);
}
const [chrome, svgFile, outDir] = [rest[0], resolve(rest[1]), resolve(rest[2])];
const name = basename(svgFile).replace(/\.svg$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let svgData;
try {
  svgData = readFileSync(svgFile);
} catch (e) {
  process.stderr.write(`shoot: cannot read ${svgFile}: ${e.message}\n`);
  process.exit(1);
}

// what GitHub sends with a raw SVG file
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/img.svg' || path === '/plain.svg') {
    const head = { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' };
    if (path === '/img.svg') head['Content-Security-Policy'] = POLICY;
    res.writeHead(200, head);
    res.end(svgData);
  } else if (path === '/page.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="margin:20px;background:${opt.bg}"><img src="/img.svg?${Date.now()}" alt="" style="max-width:100%;display:block"></body>`);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'shoot-'));
const flags = [
  '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-breakpad',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
];
if (opt.reduced) flags.push('--force-prefers-reduced-motion');
const child = spawn(chrome, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
// whatever happens, the browser and its scratch profile do not outlive this script
process.on('exit', () => {
  child.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
});
let exitCode = 0;
try {
  const wsUrl = await new Promise((res, rej) => {
    let err = '';
    const timer = setTimeout(() => rej(new Error('the browser did not start: ' + err.slice(0, 400))), 30000);
    child.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    child.on('exit', (c) => { clearTimeout(timer); rej(new Error(`the browser stopped (${c}): ${err.slice(0, 400)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no connection to the browser')); });
  let seq = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message));
      else p.res(m.result);
      return;
    }
    for (const w of [...waiters]) {
      if (w.method === m.method && w.sessionId === m.sessionId) { waiters.splice(waiters.indexOf(w), 1); w.res(m.params); }
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const once = (method, sessionId) => new Promise((res) => waiters.push({ method, sessionId, res }));

  const open = async (url) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 870, height: 900, deviceScaleFactor: opt.scale, mobile: false }, sessionId);
    if (opt.reduced) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    const loaded = once('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    return { targetId, sessionId, t0: Date.now() };
  };
  const evaluate = async (sessionId, expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  if (opt.timeline) {
    // the file as its own page, without the policy, so the browser lets us step its clock
    const { targetId, sessionId } = await open(`${origin}/plain.svg?${Date.now()}`);
    const out = JSON.parse(await evaluate(sessionId, `(() => {
      const frames = [...document.querySelectorAll('g.F')];
      const shown = () => frames.map((f) => getComputedStyle(f).visibility === 'visible' ? 1 : 0).join('');
      const anims = document.getAnimations();
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!anims.length) return JSON.stringify({ reduced, running: 0, frames: frames.length, steps: [[0, shown()]] });
      const T = anims[0].effect.getComputedTiming().duration;
      anims.forEach((a) => a.pause());
      const steps = [];
      for (let t = 5; t < T; t += 10) { anims.forEach((a) => { a.currentTime = t; }); steps.push([t, shown()]); }
      return JSON.stringify({ reduced, running: anims.length, frames: frames.length, T, steps });
    })()`));
    await send('Target.closeTarget', { targetId });
    const badSteps = out.steps.filter(([, s]) => s.split('1').length !== 2);
    process.stdout.write(`${name}: reduced motion ${out.reduced ? 'on' : 'off'}, ${out.frames} frames, ${out.running} running animations${out.T ? `, loop ${out.T / 1000} s` : ''}\n`);
    // the loop is stepped every 10 ms; a change lies between two steps
    let from = 0;
    let start = 0;
    for (let i = 1; i <= out.steps.length; i++) {
      if (i === out.steps.length || out.steps[i][1] !== out.steps[from][1]) {
        const end = i === out.steps.length ? (out.T ?? 0) : (out.steps[i - 1][0] + out.steps[i][0]) / 2;
        process.stdout.write(`  ${(start / 1000).toFixed(2)} s to ${(end / 1000).toFixed(2)} s: frame ${out.steps[from][1].indexOf('1') + 1} shows (${out.steps[from][1]})\n`);
        from = i;
        start = end;
      }
    }
    process.stdout.write(`  ${out.steps.length} moments stepped, ${badSteps.length} with more or fewer than one frame showing\n`);
    if (badSteps.length) exitCode = 1;
  } else {
    mkdirSync(outDir, { recursive: true });
    const times = opt.at.length ? opt.at : [null];
    for (const t of times) {
      const { targetId, sessionId, t0 } = await open(`${origin}/page.html`);
      const [w, h] = JSON.parse(await evaluate(sessionId, 'JSON.stringify([document.documentElement.scrollWidth, Math.ceil(document.querySelector("img").getBoundingClientRect().bottom + 20)])'));
      const clip = opt.clip ? { x: opt.clip[0], y: opt.clip[1], width: opt.clip[2], height: opt.clip[3], scale: 1 } : { x: 0, y: 0, width: w, height: h, scale: 1 };
      if (t !== null) await sleep(t * 1000 - (Date.now() - t0));
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, sessionId);
      const tag = (t === null ? '' : `-at-${t}s`) + (opt.bg.toLowerCase() === '#ffffff' ? '' : '-dark') + (opt.reduced ? '-reduced' : '') + (opt.clip ? `-clip-${opt.clip.join('-')}` : '');
      const file = join(outDir, `${name}${tag}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      process.stdout.write(`${file}\n`);
      await send('Target.closeTarget', { targetId });
    }
  }
  await send('Browser.close').catch(() => {});
} catch (e) {
  process.stderr.write(`shoot: ${e.message}\n`);
  exitCode = 1;
} finally {
  child.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
