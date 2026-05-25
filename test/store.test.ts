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

import { test, expect } from 'bun:test';
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

async function waitTicks(n = 5): Promise<void> {
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
