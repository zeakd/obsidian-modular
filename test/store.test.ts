// L1 behavior test — VaultStore v3 (folder-agnostic).
//
// entity = frontmatter modular-id 가진 .md. 폴더 무관. 이름 = basename.
// 관계 = 네이티브 wikilink (modular-parent / modular-tasks), id 로 해석.
// 위치 = <dir>/.<basename>.position sidecar.

import { test, expect } from 'vitest';
import { installObsidianHook } from 'obsidian-sim/install';
import { makeApp } from 'obsidian-sim/sim';

installObsidianHook();
const { VaultStore } = await import('../src/data/vault-store');

function freshStore() {
  const app = makeApp() as any;
  const store = new VaultStore(app);
  return { app, store };
}

// Deterministic settle: drain VaultSim + MetadataSim queues + microtasks.
// Raw tick counting raced with v3's chained async rebuilds (adopt → frontmatter
// read → mc changed → body excerpt read → rebuild).
async function settle(app: any, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (app.vault?.flush) await app.vault.flush();
    if (app.metadataCache?.flush) await app.metadataCache.flush();
    await Promise.resolve();
    await Promise.resolve();
  }
}

function byName(store: any, name: string) {
  for (const e of store.getSnapshot().entities.values()) if (e.name === name) return e;
  return null;
}

test('start() on empty vault → empty snapshot', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  expect(store.getSnapshot().entities.size).toBe(0);
  expect(store.getSnapshot().tasks).toEqual([]);
});

test('createModule → modular/<name>.md, name=basename, id in frontmatter', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const id = await store.createModule('Payments', { x: 10, y: 20 });
  expect(typeof id).toBe('string');
  const f = app.vault.getAbstractFileByPath('modular/Payments.md');
  expect(f).toBeTruthy();
  const body = await app.vault.read(f);
  expect(body).toContain(`modular-id: ${id}`);
  await settle(app);
  const ent = byName(store, 'Payments');
  expect(ent.id).toBe(id);
  expect(ent.kind).toBe('module');
  expect(ent.parentId).toBeNull();
  expect(ent.position).toEqual({ x: 10, y: 20 });
});

test('createChildComponent → flat file + modular-parent wikilink resolved to id', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const pid = await store.createModule('Payments', { x: 0, y: 0 });
  await settle(app);
  const cid = await store.createChildComponent(pid, 'Refund', { x: 5, y: 5 });
  await settle(app);
  // flat: 폴더 중첩 아님
  const cf = app.vault.getAbstractFileByPath('modular/Refund.md');
  expect(cf).toBeTruthy();
  const body = await app.vault.read(cf);
  expect(body).toContain('modular-parent: "[[Payments]]"');
  const child = byName(store, 'Refund');
  expect(child.kind).toBe('component');
  expect(child.parentId).toBe(pid);
});

test('updateEntityPosition → <dir>/.<basename>.position sidecar', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const id = await store.createModule('P', { x: 1, y: 1 });
  await settle(app);
  await store.updateEntityPosition(id, { x: 42, y: 84 });
  await settle(app);
  const raw = await app.vault.adapter.read('modular/.P.position');
  expect(JSON.parse(raw)).toEqual({ x: 42, y: 84 });
  expect(store.getSnapshot().entities.get(id).position).toEqual({ x: 42, y: 84 });
});

test('renameEntity → file basename changes, id stable, name updates', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const id = await store.createModule('Old', { x: 0, y: 0 });
  await settle(app);
  const r = await store.renameEntity(id, 'New');
  expect(r).toBe(id);
  await settle(app);
  expect(app.vault.getAbstractFileByPath('modular/New.md')).toBeTruthy();
  expect(app.vault.getAbstractFileByPath('modular/Old.md')).toBeFalsy();
  expect(store.getSnapshot().entities.get(id).name).toBe('New');
});

test('moveEntity → modular-parent wikilink changes, file stays put', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  const b = await store.createModule('B', { x: 0, y: 0 });
  await settle(app);
  const c = await store.createChildComponent(a, 'C', { x: 0, y: 0 });
  await settle(app);
  expect(store.getSnapshot().entities.get(c).parentId).toBe(a);
  // move C under B
  await store.moveEntity(c, b);
  await settle(app);
  // file path unchanged (flat, no folder move)
  expect(app.vault.getAbstractFileByPath('modular/C.md')).toBeTruthy();
  const body = await app.vault.read(app.vault.getAbstractFileByPath('modular/C.md'));
  expect(body).toContain('modular-parent: "[[B]]"');
  expect(store.getSnapshot().entities.get(c).parentId).toBe(b);
});

test('moveEntity to null → becomes module', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  const c = await store.createChildComponent(a, 'C', { x: 0, y: 0 });
  await settle(app);
  await store.moveEntity(c, null);
  await settle(app);
  const ent = store.getSnapshot().entities.get(c);
  expect(ent.parentId).toBeNull();
  expect(ent.kind).toBe('module');
});

test('moveEntity under own descendant → throws', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  const c = await store.createChildComponent(a, 'C', { x: 0, y: 0 });
  await settle(app);
  await expect(store.moveEntity(a, c)).rejects.toThrow();
});

test('deleteEntity cascades descendants + removes sidecars', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  await store.createChildComponent(a, 'C1', { x: 0, y: 0 });
  await store.createChildComponent(a, 'C2', { x: 0, y: 0 });
  await settle(app);
  expect(store.getSnapshot().entities.size).toBe(3);
  await store.deleteEntity(a);
  await settle(app);
  expect(store.getSnapshot().entities.size).toBe(0);
  expect(app.vault.getAbstractFileByPath('modular/A.md')).toBeFalsy();
  expect(app.vault.getAbstractFileByPath('modular/C1.md')).toBeFalsy();
});

test('addComponentTask → wikilink in frontmatter, snapshot toId resolved', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  const c1 = await store.createChildComponent(a, 'C1', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(a, 'C2', { x: 0, y: 0 });
  await settle(app);
  await store.addComponentTask(c1, c2);
  await settle(app);
  const snap = store.getSnapshot();
  expect(snap.tasks).toContainEqual({ fromId: c1, toId: c2 });
  const body = await app.vault.read(app.vault.getAbstractFileByPath('modular/C1.md'));
  expect(body).toContain('[[C2]]');
});

test('removeComponentTask removes the edge', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  const c1 = await store.createChildComponent(a, 'C1', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(a, 'C2', { x: 0, y: 0 });
  await settle(app);
  await store.addComponentTask(c1, c2);
  await settle(app);
  await store.removeComponentTask(c1, c2);
  await settle(app);
  expect(store.getSnapshot().tasks).toEqual([]);
});

test('task to deleted target dropped from snapshot', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  const c1 = await store.createChildComponent(a, 'C1', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(a, 'C2', { x: 0, y: 0 });
  await settle(app);
  await store.addComponentTask(c1, c2);
  await settle(app);
  await store.deleteEntity(c2);
  await settle(app);
  expect(store.getSnapshot().tasks).toEqual([]);
});

test('adopt: vault note with modular-parent but no id gets an id + joins', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  const a = await store.createModule('A', { x: 0, y: 0 });
  await settle(app);
  // user hand-writes a note anywhere with a parent link, no modular-id
  await app.vault.create('notes/Hand.md', '---\nmodular-parent: "[[A]]"\n---\nhi');
  await settle(app);
  const ent = byName(store, 'Hand');
  expect(ent).toBeTruthy();
  expect(ent.parentId).toBe(a);
  // id was auto-assigned
  const body = await app.vault.read(app.vault.getAbstractFileByPath('notes/Hand.md'));
  expect(body).toMatch(/modular-id:\s*\S+/);
});

test('folder-agnostic: entity recognized outside modular/', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  await app.vault.create('anywhere/deep/Thing.md', '---\nmodular-id: 01TESTTESTTESTTESTTESTTEST\n---\n');
  await settle(app);
  const ent = byName(store, 'Thing');
  expect(ent).toBeTruthy();
  expect(ent.path).toBe('anywhere/deep/Thing.md');
});

test('plain note without modular-id is ignored', async () => {
  const { app, store } = freshStore();
  store.start();
  await settle(app);
  await app.vault.create('notes/random.md', '# just a note');
  await settle(app);
  expect(store.getSnapshot().entities.size).toBe(0);
});
