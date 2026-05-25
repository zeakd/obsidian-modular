// Obsidian 의 DevTools console 을 외부에서 캡쳐.
// 사용: 먼저 Obsidian 을 `--remote-debugging-port=9222` 로 띄우고, 이 스크립트 실행.
//
//   open -a Obsidian --args --remote-debugging-port=9222
//   bun run test/devtools-attach.ts
//
// 결과: Obsidian 의 모든 console.log / console.error / 예외 가 stdout 으로.
// Ctrl+C 종료. 또는 --duration <sec> 로 자동 종료.

interface Target { id: string; type: string; title: string; url: string; webSocketDebuggerUrl: string; }
interface CdpMessage { id?: number; method?: string; params?: any; result?: any; error?: any; }

const PORT = Number(process.env.CDP_PORT ?? 9222);
const DURATION_S = (() => {
  const i = process.argv.indexOf('--duration');
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return 30;
})();

function nowStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

async function fetchTargets(): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`/json/list HTTP ${res.status}`);
  return (await res.json()) as Target[];
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function pickRendererTarget(): Promise<Target> {
  // Obsidian 의 메인 renderer 는 보통 type === 'page'. background helper 들은 제외.
  return waitFor(async () => {
    const targets = await fetchTargets();
    // renderer page 중 첫 번째 (보통 메인 창)
    const main = targets.find((t) => t.type === 'page');
    return main ?? null;
  }, 8000, 'Obsidian renderer target');
}

let nextId = 1;
function send(ws: WebSocket, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const onMsg = (ev: MessageEvent) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as CdpMessage;
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

function formatArg(arg: any): string {
  if (!arg) return '';
  if (arg.type === 'string') return String(arg.value);
  if (arg.type === 'number') return String(arg.value);
  if (arg.type === 'boolean') return String(arg.value);
  if (arg.type === 'undefined') return 'undefined';
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.description) return arg.description;
  if (arg.preview) {
    const props = (arg.preview.properties ?? []).map((p: any) => `${p.name}: ${p.value}`).join(', ');
    return `${arg.preview.description ?? arg.className} { ${props} }`;
  }
  return arg.className ?? '[obj]';
}

async function main(): Promise<void> {
  console.log(`[devtools] connecting to CDP on 127.0.0.1:${PORT} …`);
  const target = await pickRendererTarget();
  console.log(`[devtools] target: ${target.title || target.url}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${String(e)}`)));
  });

  // 이벤트 listener — console 호출과 exception
  ws.addEventListener('message', (ev) => {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch { return; }
    if (!msg.method) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const { type, args, stackTrace } = msg.params;
      const text = (args ?? []).map(formatArg).join(' ');
      if (text.startsWith('[modular]') || text.toLowerCase().includes('plugin') || type === 'error' || type === 'warning') {
        console.log(`${nowStamp()} [${type.padEnd(5)}] ${text}`);
        if (stackTrace && type === 'error') {
          for (const f of stackTrace.callFrames.slice(0, 4)) {
            console.log(`             at ${f.functionName || '(anon)'} (${f.url}:${f.lineNumber})`);
          }
        }
      }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      console.log(`${nowStamp()} [EXC ] ${ex.text} ${ex.exception?.description ?? ''}`);
      if (ex.stackTrace) {
        for (const f of ex.stackTrace.callFrames.slice(0, 6)) {
          console.log(`             at ${f.functionName || '(anon)'} (${f.url}:${f.lineNumber})`);
        }
      }
    }
  });

  await send(ws, 'Runtime.enable');
  console.log(`[devtools] attached. listening ${DURATION_S}s …`);

  // 이미 발생한 console history (가능한 만큼)
  // Runtime.enable 이 historic message 도 보내므로 별도 호출 불필요.

  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  console.log(`[devtools] done.`);
  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[devtools] error:', err);
  process.exit(1);
});
