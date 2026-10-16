// 同じ seed・視点・画質・ブラウザで旧版と新版を実描画する。README の数字は使用しない。
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve(process.argv[2] || 'artifacts/neighborhood/after');
await fs.mkdir(out, { recursive: true });
const checkpoint = async stage => { console.log(stage); await fs.writeFile(path.join(out, 'progress.json'), JSON.stringify({ stage, at: new Date().toISOString(), pid: process.pid })); };
await checkpoint('starting');
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } });
await server.listen();
await checkpoint('server-ready');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--mute-audio'] });
await checkpoint('chrome-ready');
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    let seed = 726146;
    Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  });
  await page.goto(server.resolvedUrls.local[0] + (process.argv[3] || ''));
  await checkpoint('menu-ready');
  await page.selectOption('#quality', 'low');
  await page.selectOption('#difficulty', 'normal');
  const started = Date.now();
  await page.click('#startBtn');
  await checkpoint('loading-assets');
  await page.waitForFunction(() => window.__game?.() && document.querySelector('#loading')?.classList.contains('hidden'), null, { timeout: 300000 });
  const startupMs = Date.now() - started;
  await checkpoint('game-ready');
  await page.evaluate(() => { const g = window.__game(); g.engine.stopRenderLoop(); g.paused = true; });
  const views = [
    { name: 'ground', pos: [0, 2.1, 6], target: [-22, 3, -35] },
    { name: 'aerial', pos: [260, 290, 285], target: [0, 1, 0] },
  ];
  if (process.argv[3]?.includes('pilot')) views[1] = { name: 'aerial', pos: [95,100,118], target: [-4,1,15] };
  const metrics = [];
  for (const view of views) {
    await checkpoint('render-' + view.name);
    metrics.push(await page.evaluate(async view => {
      const g = window.__game(), engine = g.engine, V = g.player.position.constructor;
      const ground = g.city.terrain?.heightAt(view.pos[0], view.pos[2]) || 0;
      g.camera.position.set(view.pos[0], view.pos[1] + (view.name === 'ground' ? ground : 0), view.pos[2]);
      g.camera.setTarget(new V(...view.target));
      g.assets.update(1, g.camera.position);
      for (let i = 0; i < 12; i++) g.scene.render();
      const ms = [], intervals = [], draws = [];
      let last = performance.now();
      for (let i = 0; i < 60; i++) {
        await new Promise(requestAnimationFrame);
        const now = performance.now(); intervals.push(now - last); last = now;
        engine.beginFrame();
        engine._drawCalls.fetchNewFrame();
        const start = performance.now();
        g.scene.render();
        ms.push(performance.now() - start);
        draws.push(engine._drawCalls.current);
        engine.endFrame();
      }
      ms.sort((a,b) => a-b); intervals.sort((a,b) => a-b); draws.sort((a,b) => a-b);
      const gl = engine._gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { view, samples: 60, renderMedianMs: ms[30], renderP95Ms: ms[57], frameMedianMs: intervals[30], frameP95Ms: intervals[57], drawCallsMedian: draws[30], activeMeshes: g.scene.getActiveMeshes().length, triangles: g.scene.getActiveIndices()/3, totalMeshes: g.scene.meshes.length, materials: g.scene.materials.length, buildings: g.city.buildings.length, placements: g.assets.placements.length, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    }, view));
    await page.screenshot({ path: path.join(out, view.name + '.png') });
  }
  const result = { seed: 726146, viewport: [1280,720], quality: 'low', startupMs, browser: browser.version(), metrics, errors };
  await fs.writeFile(path.join(out, 'metrics.json'), JSON.stringify(result, null, 2));
  await checkpoint('complete');
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); await server.close(); }
