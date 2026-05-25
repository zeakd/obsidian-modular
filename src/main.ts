// Modular plugin entry — load 단계별로 vault/_modular-debug.log 에 기록.
// 어디서 깨지는지 사용자가 vault 파일만 보고도 파악 가능.

import { Plugin, Notice, WorkspaceLeaf } from 'obsidian';
import { ModularView, VIEW_TYPE_MODULAR } from './view/ModularView';
import { VaultStore } from './data/vault-store';

const DEBUG_LOG_PATH = '_modular-debug.log';
const MAX_LOG_BYTES = 64 * 1024;

async function debugLog(plugin: Plugin, msg: string): Promise<void> {
  // 콘솔에도 같이 — DevTools 보는 경우 즉시 보임.
  console.log('[modular]', msg);
  try {
    const adapter = plugin.app.vault.adapter;
    const exists = await adapter.exists(DEBUG_LOG_PATH);
    let prev = '';
    if (exists) {
      prev = await adapter.read(DEBUG_LOG_PATH);
      if (prev.length > MAX_LOG_BYTES) {
        // 절반 자르기 — 무한 누적 방지.
        prev = prev.slice(prev.length - MAX_LOG_BYTES / 2);
      }
    }
    await adapter.write(DEBUG_LOG_PATH, `${prev}[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    console.error('[modular] debug log write failed:', e);
  }
}

export default class ModularPlugin extends Plugin {
  private store: VaultStore | null = null;

  async onload(): Promise<void> {
    await debugLog(this, '─── onload start ───');
    try {
      await debugLog(this, 'creating VaultStore');
      this.store = new VaultStore(this.app);

      await debugLog(this, 'starting VaultStore');
      this.store.start();

      await debugLog(this, 'registering view');
      this.registerView(
        VIEW_TYPE_MODULAR,
        (leaf: WorkspaceLeaf) => new ModularView(leaf, this.store!),
      );

      await debugLog(this, 'registering command');
      this.addCommand({
        id: 'open-modular-canvas',
        name: 'Open Modular canvas',
        callback: () => this.activateView(),
      });

      await debugLog(this, 'registering ribbon icon');
      this.addRibbonIcon('git-fork', 'Modular canvas', () => this.activateView());

      // 진단 명령 — vault 의 디버그 로그를 모달이 아닌 콘솔로 한 번 출력.
      this.addCommand({
        id: 'modular-show-debug-log',
        name: 'Modular: show debug log',
        callback: async () => {
          try {
            const adapter = this.app.vault.adapter;
            const exists = await adapter.exists(DEBUG_LOG_PATH);
            if (!exists) { new Notice('debug log not found'); return; }
            const text = await adapter.read(DEBUG_LOG_PATH);
            console.log('[modular] ─── debug log ───\n' + text);
            new Notice('debug log printed to DevTools console (⌘⌥I)');
          } catch (e) {
            new Notice(`debug log read failed: ${e}`);
          }
        },
      });

      await debugLog(this, '─── onload complete ───');
      new Notice('Modular loaded ✓', 3000);
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      console.error('[modular] onload failed:', err);
      await debugLog(this, `✗ onload failed: ${msg}`);
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
