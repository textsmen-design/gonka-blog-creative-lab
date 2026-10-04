// tools/scene/cdp.mjs — минимальный CDP-драйвер для локальных проверок (Node ≥ 22, глобальный WebSocket).
// Запускает отдельный headless Chrome с временным профилем; ничего не трогает в обычном профиле.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch({ width = 1440, height = 900, mobile = false, port = 9400 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gonka-cdp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.some((t) => t.type === 'page')) break; } catch { /* ждём запуск */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  const connect = async (url) => {
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map(); const events = []; const dialogs = [];
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
      else {
        events.push(d);
        // диалоги confirm/alert/prompt автоматически подтверждаются: иначе страница блокируется и тест зависает
        if (d.method === 'Page.javascriptDialogOpening') { dialogs.push(d.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: '' } })); }
      }
    });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    return { ws, send, events, dialogs };
  };
  const page = await connect(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await connect(ver.webSocketDebuggerUrl);
  const { send, events } = page;
  for (const d of ['Page', 'Runtime', 'Log', 'Network']) await send(`${d}.enable`);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  // Внешние ресурсы страницы (шрифты, tailwind CDN) блокируем: тесты не должны зависеть от внешней сети
  await send('Network.setBlockedURLs', { urls: ['*://cdn.tailwindcss.com/*', '*://fonts.googleapis.com/*', '*://fonts.gstatic.com/*'] });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    send, events, wait, browserSend: browser.send, dialogs: page.dialogs,
    goto: async (url, settle = 2500) => { await send('Page.navigate', { url }); await wait(settle); },
    waitFor: async (expression, timeout = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await (async () => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value)(); if (v) return true; await wait(150); } return false; },
    eval: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value,
    beforeLoad: (source) => send('Page.addScriptToEvaluateOnNewDocument', { source }),
    move: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
    shot: async (file, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); },
    jsErrors: () => events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description || '')),
    requests: () => events.filter((e) => e.method === 'Network.requestWillBeSent').map((e) => e.params.request.url),
    close: () => { try { page.ws.close(); browser.ws.close(); } catch { /* уже закрыто */ } chrome.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* профиль во временной папке */ } }, 800); },
  };
}
