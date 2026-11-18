import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Requires a local Chromium-family browser; no browser package or persistent test server is installed.
const chrome = process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium');
const temp = await realpath(tmpdir());
const profile = await mkdtemp(join(temp, 'wp-inline-browser-'));
let resolve, reject;
const result = new Promise((ok, fail) => { resolve = ok; reject = fail; });
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/result') {
    let report = '';
    for await (const chunk of req) {
      report += chunk;
      if (report.length > 8192) { res.writeHead(413).end(); return; }
    }
    res.end('received');
    resolve(report);
    return;
  }
  const html = req.url === '/';
  if (req.method !== 'GET' || (!html && !/^\/dist\/[\w/-]+\.js$/.test(req.url))) {
    res.writeHead(404).end(); return;
  }
  try {
    const file = new URL(html ? './direct-image-inline.browser.html' : `..${req.url}`, import.meta.url);
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' }).end(content);
  } catch {
    res.writeHead(404).end();
  }
});
let browser, browserDone, timer;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  browser = spawn(chrome, ['--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  browser.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
  browserDone = new Promise(done => browser.once('close', code => {
    reject(new Error(`Browser exited before reporting the result (${code}).\n${diagnostic}`));
    done();
  }));
  browser.once('error', error => reject(new Error('Cannot launch Chromium; set CHROME to its executable.', { cause: error })));
  timer = setTimeout(() => reject(new Error(`Timed out waiting for the browser fixture.\n${diagnostic}`)), 15_000);
  assert.equal(await result, 'OK', 'real DOM inline-rendering regression');
  console.log('Chromium: shadow mount, raster decode, clone isolation and URL cleanup passed.');
} finally {
  clearTimeout(timer);
  if (browser?.pid && browser.exitCode === null) browser.kill();
  if (browserDone) await browserDone;
  server.closeAllConnections();
  await new Promise(done => server.close(done));
  // Only remove the precise, isolated profile directory created by this run.
  if (dirname(profile) === temp && await realpath(profile) === profile) await rm(profile, { recursive: true });
}
