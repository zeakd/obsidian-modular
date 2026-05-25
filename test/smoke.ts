// Plugin smoke test — Obsidian 없이 dist/main.js 를 require 하여 load 단계 검증.
//
// 다음을 차례로 검사:
//   1. obsidian/electron 의존성 mock
//   2. happy-dom 으로 window/document/HTMLElement 제공 (react-dom 같은 의존성 위)
//   3. dist/main.js require — top-level evaluation 통과?
//   4. default export 가 함수(Plugin class)인가?
//   5. mock app 으로 instance 생성 + onload() 호출 → throw 없이 진행?
//   6. onunload() 도 호출 → cleanup 검증
//
// 실패 시 마지막으로 통과한 단계와 throw 의 message + stack 을 표시.

import { Window } from 'happy-dom';
import { Module } from 'module';
import { resolve as resolvePath, dirname } from 'path';
import { fileURLToPath } from 'url';

// ── 1. DOM mock — react-dom / reactflow 같은 의존성의 top-level evaluation 보호 ──

const win = new Window();
const g: any = globalThis;
g.window = win;
g.document = win.document;
g.HTMLElement = win.HTMLElement;
g.HTMLDivElement = win.HTMLDivElement;
g.Element = win.Element;
g.Node = win.Node;
g.navigator = win.navigator;
g.location = win.location;
g.requestAnimationFrame = (cb: any) => setTimeout(cb, 16);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
g.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };

// ── 2. obsidian / electron require 가로채기 ──

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSIDIAN_MOCK_PATH = resolvePath(HERE, 'obsidian-mock.ts');

const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function patched(
  request: string,
  parent: any,
  ...rest: any[]
) {
  if (request === 'obsidian') return OBSIDIAN_MOCK_PATH;
  if (request === 'electron') return OBSIDIAN_MOCK_PATH; // 같은 mock 사용 (사용 없음)
  return origResolve.call(this, request, parent, ...rest);
};

// ── 3 ~ 6. 단계별 검사 ──

type Step = { name: string; ok: boolean; detail?: string; durationMs: number };
const steps: Step[] = [];

async function track<T>(name: string, fn: () => Promise<T> | T): Promise<T | null> {
  const t0 = performance.now();
  try {
    const v = await fn();
    steps.push({ name, ok: true, durationMs: Math.round(performance.now() - t0) });
    return v;
  } catch (err) {
    const e = err as Error;
    const detail = `${e.message}\n${e.stack ?? ''}`;
    steps.push({ name, ok: false, detail, durationMs: Math.round(performance.now() - t0) });
    return null;
  }
}

async function main(): Promise<void> {
  const DIST_PATH = resolvePath(HERE, '..', 'dist', 'main.js');

  // 단계 1: bundle require
  const mod = await track('require dist/main.js', () => {
    // Bun 은 .js 를 require 로 잘 받음. cache 우회를 위해 매번 fresh.
    delete (require.cache as any)?.[DIST_PATH];
    return require(DIST_PATH);
  });
  if (!mod) return reportAndExit(1);

  // 단계 2: default export
  const PluginClass = await track('default export is class', () => {
    const d = (mod as any).default ?? mod;
    if (typeof d !== 'function') throw new Error(`default export is ${typeof d}, expected function`);
    return d;
  });
  if (!PluginClass) return reportAndExit(1);

  // 단계 3: instance 생성
  const { makeMockApp } = await import(OBSIDIAN_MOCK_PATH);
  const app = makeMockApp();
  const manifest = { id: 'modular', name: 'Modular', version: '0.0.0', minAppVersion: '1.5.0', author: 'test', description: '' };
  const instance: any = await track('new Plugin(app, manifest)', () => new (PluginClass as any)(app, manifest));
  if (!instance) return reportAndExit(1);

  // 단계 4: onload
  await track('await onload()', async () => {
    if (typeof instance.onload !== 'function') throw new Error('onload is not a function');
    await instance.onload();
  });

  // 단계 5: onunload
  await track('await onunload()', async () => {
    if (typeof instance.onunload !== 'function') return;
    await instance.onunload();
  });

  return reportAndExit(steps.every((s) => s.ok) ? 0 : 1);
}

function reportAndExit(code: number): void {
  const STATUS = { ok: '✓', fail: '✗' };
  console.log('');
  console.log('  modular plugin — smoke test');
  console.log('  ' + '─'.repeat(48));
  for (const s of steps) {
    const icon = s.ok ? STATUS.ok : STATUS.fail;
    console.log(`  ${icon} ${s.name.padEnd(36)} (${s.durationMs}ms)`);
    if (!s.ok && s.detail) {
      const lines = s.detail.split('\n');
      for (const ln of lines) console.log(`      ${ln}`);
    }
  }
  console.log('');
  console.log(code === 0 ? '  PASS' : '  FAIL');
  console.log('');
  process.exit(code);
}

main().catch((err) => {
  console.error('smoke harness crashed:', err);
  process.exit(2);
});
