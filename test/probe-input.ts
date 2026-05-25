// 입력 중인 textarea 의 computed style 검사.

const PORT = Number(process.env.CDP_PORT ?? 9222);

async function fetchTargets(): Promise<any[]> {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
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
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((r) => ws.addEventListener('open', () => r()));
  await send(ws, 'Runtime.enable');

  const expr = `(() => {
    const ta = document.querySelector('.modular-canvas textarea');
    if (!ta) return { found: false };
    const focused = document.activeElement === ta;
    const cs = getComputedStyle(ta);
    const card = ta.closest('.mn, .cn');
    const cardCs = card ? getComputedStyle(card) : null;
    return {
      found: true,
      focused,
      className: ta.className,
      ta: {
        background: cs.background,
        backgroundColor: cs.backgroundColor,
        border: cs.border,
        borderRadius: cs.borderRadius,
        outline: cs.outline,
        boxShadow: cs.boxShadow,
        padding: cs.padding,
        margin: cs.margin,
        color: cs.color,
        font: cs.font,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        width: cs.width,
        height: cs.height,
      },
      cardClassName: card?.className,
      card: cardCs ? {
        border: cardCs.border,
        borderColor: cardCs.borderColor,
        boxShadow: cardCs.boxShadow,
        background: cardCs.backgroundColor,
      } : null,
    };
  })()`;

  const result = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(result.result?.value ?? result, null, 2));
  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
