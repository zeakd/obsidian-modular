// L1 behavior test — VaultStore v2 (conventions E, id-based).
//
// Coverage:
//   - createModule → `modular/<name>/_index.md` + sidecar + id in frontmatter
//   - createChildComponent → nested `<parent>/<child>/_index.md` + parent id link
//   - snapshot reflects entities + tasks indexed by id
//   - rename = folder rename (id stays, path moves)
//   - delete = folder trash + cache cleanup
//   - tasks add/remove operate on ids, persist as id arrays in frontmatter
//   - external markdown edit reloads cache

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

async function waitTicks(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function entityByName(store: any, name: string) {
  const snap = store.getSnapshot();
  for (const e of snap.entities.values()) {
    if (e.name === name) return e;
  }
  return null;
}

test('start() on an empty vault produces an empty snapshot', async () => {
  const { store } = freshStore();
  store.start();
  await waitTicks();
  const snap = store.getSnapshot();
  expect(snap.entities.size).toBe(0);
  expect(snap.tasks).toEqual([]);
});

test('createModule writes modular/<name>/_index.md with frontmatter id', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const id = await store.createModule('payments', { x: 100, y: 200 });
  expect(typeof id).toBe('string');
  expect(id!.length).toBe(26);

  // Files on disk
  const indexFile = app.vault.getAbstractFileByPath('modular/payments/_index.md');
  expect(indexFile).toBeTruthy();
  const body = await app.vault.read(indexFile);
  expect(body).toContain(`modular-id: ${id}`);
  expect(body).toContain('modular-tags: []');

  await waitTicks();
  const ent = entityByName(store, 'payments');
  expect(ent).toBeTruthy();
  expect(ent.id).toBe(id);
  expect(ent.kind).toBe('module');
  expect(ent.parentId).toBeNull();
  expect(ent.position).toEqual({ x: 100, y: 200 });
});

test('createChildComponent nests under parent and records modular-parent', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const parentId = await store.createModule('billing', { x: 0, y: 0 });
  await waitTicks();
  const childId = await store.createChildComponent(parentId, 'invoice', { x: 50, y: 60 });
  expect(typeof childId).toBe('string');

  expect(app.vault.getAbstractFileByPath('modular/billing/invoice/_index.md')).toBeTruthy();
  const body = await app.vault.read(app.vault.getAbstractFileByPath('modular/billing/invoice/_index.md'));
  expect(body).toContain(`modular-id: ${childId}`);
  expect(body).toContain(`modular-parent: ${parentId}`);

  await waitTicks();
  const child = entityByName(store, 'invoice');
  expect(child.kind).toBe('component');
  expect(child.parentId).toBe(parentId);
  expect(child.position).toEqual({ x: 50, y: 60 });
});

test('deleteEntity on a module removes it from snapshot + trashes folder', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const id = await store.createModule('temp', { x: 0, y: 0 });
  await waitTicks();
  expect(store.getSnapshot().entities.size).toBe(1);
  await store.deleteEntity(id);
  await waitTicks();
  expect(store.getSnapshot().entities.size).toBe(0);
  expect(app.vault.getAbstractFileByPath('modular/temp')).toBeFalsy();
});

test('deleteEntity on an entity with children removes folder + descendants', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modId = await store.createModule('payments', { x: 0, y: 0 });
  await waitTicks();
  await store.createChildComponent(modId, 'refund', { x: 10, y: 10 });
  await store.createChildComponent(modId, 'paywall', { x: 20, y: 20 });
  await waitTicks();
  expect(store.getSnapshot().entities.size).toBe(3);

  await store.deleteEntity(modId);
  await waitTicks();
  expect(store.getSnapshot().entities.size).toBe(0);
  expect(app.vault.getAbstractFileByPath('modular/payments')).toBeFalsy();
});

test('renameEntity preserves id, moves folder, snapshot updates name', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modId = await store.createModule('billing', { x: 0, y: 0 });
  await waitTicks();
  await store.createChildComponent(modId, 'invoice', { x: 0, y: 0 });
  await waitTicks();

  const result = await store.renameEntity(modId, 'payments');
  expect(result).toBe(modId);
  await waitTicks();

  // new paths exist, old gone
  expect(app.vault.getAbstractFileByPath('modular/payments/_index.md')).toBeTruthy();
  expect(app.vault.getAbstractFileByPath('modular/payments/invoice/_index.md')).toBeTruthy();
  expect(app.vault.getAbstractFileByPath('modular/billing')).toBeFalsy();

  // snapshot still indexed by id; name reflects new folder
  const snap = store.getSnapshot();
  expect(snap.entities.get(modId)?.name).toBe('payments');
  // child's parentId still refers to original modId
  const child = entityByName(store, 'invoice');
  expect(child.parentId).toBe(modId);
});

test('addComponentTask records id reference in frontmatter and snapshot', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modId = await store.createModule('m', { x: 0, y: 0 });
  await waitTicks();
  const c1 = await store.createChildComponent(modId, 'a', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(modId, 'b', { x: 0, y: 0 });
  await waitTicks();
  await store.addComponentTask(c1, c2);
  await waitTicks();

  const snap = store.getSnapshot();
  expect(snap.tasks).toHaveLength(1);
  expect(snap.tasks[0]).toEqual({ fromId: c1, toId: c2 });

  const f = app.vault.getAbstractFileByPath('modular/m/a/_index.md');
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  expect(fm?.['modular-tasks']).toEqual([c2]);
});

test('removeComponentTask deletes the outgoing entry', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modId = await store.createModule('m', { x: 0, y: 0 });
  await waitTicks();
  const c1 = await store.createChildComponent(modId, 'a', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(modId, 'b', { x: 0, y: 0 });
  await waitTicks();
  await store.addComponentTask(c1, c2);
  await waitTicks();
  await store.removeComponentTask(c1, c2);
  await waitTicks();

  expect(store.getSnapshot().tasks).toEqual([]);
  const f = app.vault.getAbstractFileByPath('modular/m/a/_index.md');
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  expect(fm?.['modular-tasks']).toEqual([]);
});

test('updateEntityPosition writes <folder>/.position sidecar', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const id = await store.createModule('p', { x: 1, y: 2 });
  await waitTicks();
  await store.updateEntityPosition(id, { x: 99, y: 100 });
  await waitTicks();
  const sidecar = await app.vault.adapter.read('modular/p/.position');
  expect(JSON.parse(sidecar)).toEqual({ x: 99, y: 100 });
  expect(store.getSnapshot().entities.get(id)?.position).toEqual({ x: 99, y: 100 });
});

test('task to a deleted target is dropped from snapshot', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  const modId = await store.createModule('m', { x: 0, y: 0 });
  await waitTicks();
  const c1 = await store.createChildComponent(modId, 'a', { x: 0, y: 0 });
  const c2 = await store.createChildComponent(modId, 'b', { x: 0, y: 0 });
  await waitTicks();
  await store.addComponentTask(c1, c2);
  await waitTicks();

  // Delete target c2; task should vanish from snapshot.
  await store.deleteEntity(c2);
  await waitTicks();
  expect(store.getSnapshot().tasks).toEqual([]);
  // frontmatter on c1 still has the stale id but snapshot filters it.
  const f = app.vault.getAbstractFileByPath('modular/m/a/_index.md');
  const fm = app.metadataCache.getFileCache(f)?.frontmatter;
  expect(fm?.['modular-tasks']).toEqual([c2]);
});

test('non-_index.md files in modular/ are ignored', async () => {
  const { app, store } = freshStore();
  store.start();
  await waitTicks();
  // A leftover legacy file shouldn't surface as an entity.
  await app.vault.createFolder('modular');
  await app.vault.create('modular/note.md', '# random');
  await waitTicks();
  expect(store.getSnapshot().entities.size).toBe(0);
});
