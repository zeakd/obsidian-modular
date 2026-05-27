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
      // Plugin id/name are prepended automatically — bare id/name avoids
      // "Modular: Modular canvas" duplication in the UI.
      this.addCommand({
        id: 'open-canvas',
        name: 'Open canvas',
        callback: () => { void this.activateView(); },
      });

      await this.log.write('registering ribbon icon');
      this.addRibbonIcon('git-fork', 'Modular canvas', () => { void this.activateView(); });

      // Diagnostic: dump the debug log to DevTools console on demand.
      this.addCommand({
        id: 'show-debug-log',
        name: 'Show debug log',
        callback: () => { void this.showDebugLog(); },
      });

      await this.log.write('─── onload complete ───');
      new Notice('Modular loaded', 3000);
    } catch (err) {
      await this.log.error('onload failed', err);
      new Notice('Modular load failed — see _modular-debug.log', 10000);
      throw err;
    }
  }

  // Obsidian's Plugin.onunload is sync (void). Stay sync to satisfy
  // no-misused-promises; no async work needed for teardown anyway.
  onunload(): void {
    try {
      this.store?.stop();
    } catch (e) {
      console.error('[modular] onunload error:', e);
    }
    this.store = null;
  }

  private async showDebugLog(): Promise<void> {
    try {
      const text = await this.log.read();
      if (text == null) { new Notice('Debug log not found'); return; }
      // eslint-disable-next-line obsidianmd/rule-custom-message -- this command's whole purpose is to surface log text to devtools
      console.log('[modular] ─── debug log ───\n' + text);
      new Notice('Debug log printed to devtools console (⌘⌥i)');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Debug log read failed: ${msg}`);
    }
  }

  private async activateView(): Promise<void> {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(VIEW_TYPE_MODULAR);
    let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
    if (!leaf) {
      leaf = ws.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_MODULAR, active: true });
    }
    await ws.revealLeaf(leaf);
  }
}
