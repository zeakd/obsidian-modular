// modular view 의 DOM/이벤트 상태 점검.
//   bun run test/probe-view.ts          전체 상태 dump
//   bun run test/probe-view.ts --click   첫 노드에 mousedown/mouseup 시뮬레이션

const PORT = Number(process.env.CDP_PORT ?? 9222);
const DO_CLICK = process.argv.includes('--click');
const DO_DRAG = process.argv.includes('--drag');

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
    const out = {};
    const cv = document.querySelector('.modular-canvas');
    if (!cv) return { found: false };
    const rf = cv.querySelector('.react-flow');
    const viewport = cv.querySelector('.react-flow__viewport');
    const pane = cv.querySelector('.react-flow__pane');
    const nodes = [...cv.querySelectorAll('.react-flow__node')];
    out.viewportTransform = viewport ? getComputedStyle(viewport).transform : null;
    out.paneComputed = pane ? (() => {
      const cs = getComputedStyle(pane);
      const r = pane.getBoundingClientRect();
      return { pointerEvents: cs.pointerEvents, w: Math.round(r.width), h: Math.round(r.height) };
    })() : null;
    out.nodes = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return {
        id: n.getAttribute('data-id'),
        cls: n.className,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        pointerEvents: cs.pointerEvents,
        opacity: cs.opacity,
        visibility: cs.visibility,
        transform: cs.transform,
      };
    });
    // 첫 노드 위에 있는 가장 윗 element (hit test)
    if (nodes.length > 0) {
      const r = nodes[0].getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.firstNodeHit = top ? {
        tag: top.tagName.toLowerCase(),
        cls: String(top.className).split(' ').slice(0, 4).join('.'),
        sameAsNode: top === nodes[0] || nodes[0].contains(top),
      } : null;
    }
    return out;
  })()`;

  const result = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('── state ──');
  console.log(JSON.stringify(result.result?.value ?? result, null, 2));

  if (DO_CLICK) {
    console.log('\n── simulating click on first node ──');
    const clickExpr = `(() => {
      const node = document.querySelector('.modular-canvas .react-flow__node');
      if (!node) return { ok: false, reason: 'no node' };
      const r = node.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const ev = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      node.dispatchEvent(ev('pointerdown'));
      node.dispatchEvent(ev('mousedown'));
      node.dispatchEvent(ev('mouseup'));
      node.dispatchEvent(ev('click'));
      return { ok: true, dispatched: ['pointerdown', 'mousedown', 'mouseup', 'click'], x, y };
    })()`;
    const cr = await send(ws, 'Runtime.evaluate', { expression: clickExpr, returnByValue: true });
    console.log(JSON.stringify(cr.result?.value ?? cr, null, 2));
    // 클릭 후 상태 다시 — selected 적용됐는지
    const after = await send(ws, 'Runtime.evaluate', {
      expression: `document.querySelectorAll('.modular-canvas .react-flow__node.selected').length`,
      returnByValue: true,
    });
    console.log('selected count after click:', after.result?.value);
  }

  if (DO_DRAG) {
    console.log('\n── simulating drag on first node (+80px) ──');
    const dragExpr = `(() => {
      const node = document.querySelector('.modular-canvas .react-flow__node');
      if (!node) return { ok: false };
      const r = node.getBoundingClientRect();
      const sx = r.left + r.width / 2;
      const sy = r.top + r.height / 2;
      const ev = (type, x, y) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
      node.dispatchEvent(ev('mousedown', sx, sy));
      window.dispatchEvent(ev('mousemove', sx + 80, sy + 30));
      window.dispatchEvent(ev('mouseup', sx + 80, sy + 30));
      const r2 = node.getBoundingClientRect();
      return { startX: sx, startY: sy, newX: Math.round(r2.left), newY: Math.round(r2.top) };
    })()`;
    const dr = await send(ws, 'Runtime.evaluate', { expression: dragExpr, returnByValue: true });
    console.log(JSON.stringify(dr.result?.value ?? dr, null, 2));
  }

  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
