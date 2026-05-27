// First L1 behavior test for modular — exercises VaultStore against
// obsidian-sim's VaultSim + MetadataSim. No Obsidian launch required.
//
// Coverage so far:
//   - createModule writes the expected folder + md file with the convention
//     `modular/<name>/<name>.md` and a default frontmatter body.
//   - The store's snapshot reflects the new module once vault events have
//     flushed.
//   - createChildComponent inside an expanded module creates the
//     `modular/<m>/<c>/<c>.md` nested path and lands as a component in the
//     snapshot with parentPath pointing at the module.

import { test, expect } from 'vitest';
import { installObsidianHook } from 'obsidian-sim/install';
import { makeApp } from 'obsidian-sim/sim';

// Route any `require('obsidian')` deeper in the dependency graph (the bundled
// modular code does this) to obsidian-sim's mock.
installObsidianHook();

// Lazy import so the require hook above is in place before module-eval.
const { VaultStore } = await import('../src/data/vault-store');

function freshStore() {
  const app = makeApp() as any;
  const store = new VaultStore(app);
  return { app, store };
}

// Bumped from 5 → 12 after the sim adopted an AsyncQueue (kit PR A):
// mutations chain through a Promise tail and even adapter-level loops in
// modular's loadAllPositions need more microtask hops to settle.
async function waitTicks(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

test('start() on an empty vault produces an empty snapshot', async () => {
  const { store } = freshStore();
  store.start();
  await waitTicks();
  const snap = store.getSnapshot();
  expect(snap.modules).toEqual([]);
  expect(snap.components).toEqual([]);
});

test('createModule writes modular/<name>/<name>.md and snapshot reflects it', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();

  const path = await store.createModule('payments', { x: 100, y: 200 });
  expect(path).toBe('modular/payments/payments.md');

  // Module file exists with the new-module frontmatter body.
  const file = app.vault.getAbstractFileByPath('modular/payments/payments.md');
  expect(file).toBeTruthy();
  const body = await app.vault.read(file);
  expect(body).toContain('modular-tags: []');

  await waitTicks();
  const snap = store.getSnapshot();
  expect(snap.modules).toHaveLength(1);
  expect(snap.modules[0].path).toBe(path);
  expect(snap.modules[0].name).toBe('payments');
  expect(snap.modules[0].position).toEqual({ x: 100, y: 200 });
  expect(snap.components).toEqual([]);
});

test('createChildComponent inside an expanded module appears as component', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();

  const modPath = await store.createModule('billing', { x: 0, y: 0 });
  await waitTicks();
  const compPath = await store.createChildComponent(modPath, 'invoice', { x: 50, y: 60 });
  expect(compPath).toBe('modular/billing/invoice/invoice.md');

  // Folder + md both exist.
  expect(app.vault.getAbstractFileByPath('modular/billing/invoice')).toBeTruthy();
  expect(app.vault.getAbstractFileByPath('modular/billing/invoice/invoice.md')).toBeTruthy();

  await waitTicks();
  const snap = store.getSnapshot();
  expect(snap.modules.map((m: any) => m.name)).toEqual(['billing']);
  expect(snap.components).toHaveLength(1);
  expect(snap.components[0].path).toBe(compPath);
  expect(snap.components[0].name).toBe('invoice');
  expect(snap.components[0].parentPath).toBe(modPath);
  expect(snap.components[0].position).toEqual({ x: 50, y: 60 });
});

test('deleteEntity on a leaf removes it from snapshot', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modPath = await store.createModule('temp', { x: 0, y: 0 });
  await waitTicks();
  expect(store.getSnapshot().modules).toHaveLength(1);
  await store.deleteEntity(modPath);
  await waitTicks();
  expect(store.getSnapshot().modules).toEqual([]);
});

test('deleteEntity on expanded module removes folder + children', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modPath = await store.createModule('payments', { x: 0, y: 0 });
  await waitTicks();
  await store.createChildComponent(modPath, 'refund', { x: 10, y: 10 });
  await store.createChildComponent(modPath, 'paywall', { x: 20, y: 20 });
  await waitTicks();
  expect(store.getSnapshot().modules).toHaveLength(1);
  expect(store.getSnapshot().components).toHaveLength(2);

  await store.deleteEntity(modPath);
  await waitTicks();
  expect(store.getSnapshot().modules).toEqual([]);
  expect(store.getSnapshot().components).toEqual([]);
  // folder + child files all gone
  expect(app.vault.getAbstractFileByPath('modular/payments')).toBeFalsy();
  expect(app.vault.getAbstractFileByPath('modular/payments/refund/refund.md')).toBeFalsy();
});

test('renameEntity on expanded module renames folder + md + child paths', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const oldModPath = await store.createModule('billing', { x: 0, y: 0 });
  await waitTicks();
  await store.createChildComponent(oldModPath, 'invoice', { x: 10, y: 10 });
  await waitTicks();

  const newModPath = await store.renameEntity(oldModPath, 'payments');
  expect(newModPath).toBe('modular/payments/payments.md');
  await waitTicks();

  // 새 path 들 모두 존재
  expect(app.vault.getAbstractFileByPath('modular/payments/payments.md')).toBeTruthy();
  expect(app.vault.getAbstractFileByPath('modular/payments/invoice/invoice.md')).toBeTruthy();
  // 옛 path 모두 사라짐
  expect(app.vault.getAbstractFileByPath('modular/billing/billing.md')).toBeFalsy();
  expect(app.vault.getAbstractFileByPath('modular/billing/invoice/invoice.md')).toBeFalsy();

  // snapshot 의 자식도 새 parent path
  const snap = store.getSnapshot();
  expect(snap.modules.map((m: any) => m.path)).toEqual(['modular/payments/payments.md']);
  expect(snap.components[0].parentPath).toBe('modular/payments/payments.md');
});

test('createChildComponent promotes a leaf parent to expanded', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();

  // module 만들고, 그 안에 component 를 *leaf* 형태로 손으로 추가하면 promote 트리거.
  // 단순 시뮬레이션 — createChildComponent 가 항상 expanded 로 만들지만,
  // promote 시나리오는 'leaf 가 이미 존재하는 vault' 에서 자식 추가 시.
  const modPath = await store.createModule('app', { x: 0, y: 0 });
  await waitTicks();
  // 직접 leaf 파일 박기 (사용자가 explorer 에서 만든 것 모사)
  await app.vault.create('modular/app/widget.md', '---\nmodular-tasks: []\n---\n\n');
  await waitTicks();

  // 이 시점에서 widget 은 leaf component. 자식 추가 시 promote.
  const leafPath = 'modular/app/widget.md';
  const subPath = await store.createChildComponent(leafPath, 'detail', { x: 0, y: 0 });
  expect(subPath).toBe('modular/app/widget/detail/detail.md');
  await waitTicks();

  // 옛 leaf 가 이동됐는지
  expect(app.vault.getAbstractFileByPath('modular/app/widget.md')).toBeFalsy();
  expect(app.vault.getAbstractFileByPath('modular/app/widget/widget.md')).toBeTruthy();
  expect(app.vault.getAbstractFileByPath('modular/app/widget/detail/detail.md')).toBeTruthy();

  // snapshot 의 부모 관계
  const snap = store.getSnapshot();
  const widget = snap.components.find((c: any) => c.name === 'widget');
  const detail = snap.components.find((c: any) => c.name === 'detail');
  expect(widget?.parentPath).toBe('modular/app/app.md');
  expect(detail?.parentPath).toBe('modular/app/widget/widget.md');
});

test('addComponentTask records outgoing task in frontmatter and snapshot', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const mod = await store.createModule('m', { x: 0, y: 0 });
  await waitTicks();
  const c1 = await store.createChildComponent(mod, 'a', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(mod, 'b', { x: 0, y: 0 });
  await waitTicks();

  await store.addComponentTask(c1, c2);
  await waitTicks();

  // snapshot 에 task 등장
  const snap = store.getSnapshot();
  expect(snap.componentTasks).toHaveLength(1);
  expect(snap.componentTasks[0].fromPath).toBe(c1);
  expect(snap.componentTasks[0].toPath).toBe(c2);

  // frontmatter 에 outgoing 기록
  const f = app.vault.getAbstractFileByPath(c1);
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  expect(fm?.['modular-tasks']).toEqual([c2]);
});

test('removeComponentTask deletes the outgoing entry', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const mod = await store.createModule('m', { x: 0, y: 0 });
  await waitTicks();
  const c1 = await store.createChildComponent(mod, 'a', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(mod, 'b', { x: 0, y: 0 });
  await waitTicks();
  await store.addComponentTask(c1, c2);
  await waitTicks();

  await store.removeComponentTask(c1, c2);
  await waitTicks();

  const snap = store.getSnapshot();
  expect(snap.componentTasks).toEqual([]);
  const f = app.vault.getAbstractFileByPath(c1);
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  expect(fm?.['modular-tasks']).toEqual([]);
});

test('updateEntityPosition writes entity .position sidecar', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const mod = await store.createModule('p', { x: 100, y: 100 });
  await waitTicks();

  await store.updateEntityPosition(mod, { x: 555, y: 666 });
  await waitTicks();

  const snap = store.getSnapshot();
  expect(snap.modules[0].position).toEqual({ x: 555, y: 666 });

  // expanded module 의 sidecar 는 그 폴더 안 .position
  const raw = await app.vault.adapter.read('modular/p/.position');
  const pos = JSON.parse(raw);
  expect(pos).toEqual({ x: 555, y: 666 });

  // 옛 단일 파일 안 생김
  expect(await app.vault.adapter.exists('modular/.positions.json')).toBe(false);
});

test('createChildComponent writes child .position in child folder', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const mod = await store.createModule('app', { x: 0, y: 0 });
  await waitTicks();
  const comp = await store.createChildComponent(mod, 'widget', { x: 50, y: 60 });
  await waitTicks();

  // child 가 expanded 라 sidecar 는 그 자식 폴더 안 .position
  expect(comp).toBe('modular/app/widget/widget.md');
  const raw = await app.vault.adapter.read('modular/app/widget/.position');
  expect(JSON.parse(raw)).toEqual({ x: 50, y: 60 });
});

test('migrates legacy .positions.json to per-entity sidecars on first start', async () => {
  const { app, store } = freshStore();
  // 옛 데이터를 vault 에 미리 박아둠 — file index 인식되도록 vault.create 사용
  await app.vault.createFolder('modular');
  await app.vault.createFolder('modular/legacy');
  await app.vault.create('modular/legacy/legacy.md', '---\nmodular-tags: []\n---\n\n');
  await app.vault.adapter.write(
    'modular/.positions.json',
    JSON.stringify({ 'modular/legacy/legacy.md': { x: 42, y: 84 } }),
  );

  store.start();
  await waitTicks();

  // 마이그레이션 후: 단일 파일 사라지고 sidecar 생김
  expect(await app.vault.adapter.exists('modular/.positions.json')).toBe(false);
  const raw = await app.vault.adapter.read('modular/legacy/.position');
  expect(JSON.parse(raw)).toEqual({ x: 42, y: 84 });

  // snapshot 의 position 도 마이그레이션 값 반영
  const snap = store.getSnapshot();
  const legacy = snap.modules.find((m: any) => m.name === 'legacy');
  expect(legacy?.position).toEqual({ x: 42, y: 84 });
});
