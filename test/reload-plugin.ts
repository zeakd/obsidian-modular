// Obsidian 의 plugin 을 외부에서 disable/enable — CDP Runtime.evaluate.
// 사용: bun run test/reload-plugin.ts [plugin-id]   (기본 'modular')

const PORT = Number(process.env.CDP_PORT ?? 9222);
const PLUGIN_ID = process.argv[2] ?? 'modular';

async function fetchTargets(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return await res.json();
}

let nextId = 1;
function send(ws: WebSocket, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const onMsg = (ev: MessageEvent) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main(): Promise<void> {
  const targets = await fetchTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no Obsidian renderer page found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });

  await send(ws, 'Runtime.enable');

  const expr = `
    (async () => {
      const app = window.app;
      if (!app?.plugins) return { ok: false, reason: 'no app.plugins' };
      try { await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)}); } catch (e) {}
      await new Promise((r) => setTimeout(r, 250));
      try {
        await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
      } catch (e) {
        return { ok: false, reason: 'enablePlugin threw', error: String(e && e.stack || e) };
      }
      const loaded = !!app.plugins.plugins?.[${JSON.stringify(PLUGIN_ID)}];
      const enabled = !!app.plugins.enabledPlugins?.has?.(${JSON.stringify(PLUGIN_ID)});
      return { ok: loaded, loaded, enabled };
    })()
  `;
  const result = await send(ws, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('reload result:', JSON.stringify(result.result?.value ?? result, null, 2));
  ws.close();
}

main().catch((err) => {
  console.error('error:', err);
  process.exit(1);
});
