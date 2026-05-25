// Modular plugin entry. Lifecycle log goes to `_modular-debug.log` in the
// vault root so a remote AI can see where load broke without DevTools.

import { Plugin, Notice, WorkspaceLeaf } from 'obsidian';
import { VaultDebugLog } from 'obsidian-plugin-kit/runtime';
import { ModularView, VIEW_TYPE_MODULAR } from './view/ModularView';
import { VaultStore } from './data/vault-store';

export default class ModularPlugin extends Plugin {
  private store: VaultStore | null = null;
  private log!: VaultDebugLog;

  async onload(): Promise<void> {
    this.log = new VaultDebugLog(this);
    await this.log.write('─── onload start ───');
    try {
      await this.log.write('creating VaultStore');
      this.store = new VaultStore(this.app);

      await this.log.write('starting VaultStore');
      this.store.start();

      await this.log.write('registering view');
      this.registerView(
        VIEW_TYPE_MODULAR,
        (leaf: WorkspaceLeaf) => new ModularView(leaf, this.store!),
      );

      await this.log.write('registering command');
      this.addCommand({
        id: 'open-modular-canvas',
        name: 'Open Modular canvas',
        callback: () => this.activateView(),
      });

      await this.log.write('registering ribbon icon');
      this.addRibbonIcon('git-fork', 'Modular canvas', () => this.activateView());

      // Diagnostic: dump the debug log to DevTools console on demand.
      this.addCommand({
        id: 'modular-show-debug-log',
        name: 'Modular: show debug log',
        callback: async () => {
          try {
            const text = await this.log.read();
            if (text == null) { new Notice('debug log not found'); return; }
            console.log('[modular] ─── debug log ───\n' + text);
            new Notice('debug log printed to DevTools console (⌘⌥I)');
          } catch (e) {
            new Notice(`debug log read failed: ${e}`);
          }
        },
      });

      await this.log.write('─── onload complete ───');
      new Notice('Modular loaded ✓', 3000);
    } catch (err) {
      await this.log.error('onload failed', err);
      new Notice('Modular load failed — see _modular-debug.log', 10000);
      throw err;
    }
  }

  async onunload(): Promise<void> {
    try {
      this.store?.stop();
    } catch (e) {
      console.error('[modular] onunload error:', e);
    }
    this.store = null;
  }

  private async activateView(): Promise<void> {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(VIEW_TYPE_MODULAR);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
    if (!leaf) {
      leaf = ws.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_MODULAR, active: true });
    }
    ws.revealLeaf(leaf);
  }
}
