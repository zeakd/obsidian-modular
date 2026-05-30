// Modular plugin entry. Lifecycle log goes to `_modular-debug.log` in the
// vault root so a remote AI can see where load broke without DevTools.

import { App, Plugin, Notice, SuggestModal, WorkspaceLeaf } from 'obsidian';
import { VaultDebugLog } from 'obsidian-plugin-kit/runtime';
import { ModularView, VIEW_TYPE_MODULAR } from './view/ModularView';
import { VaultStore } from './data/vault-store';
import type { Entity, EntityId } from './data/types';

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

      // PR-4: entity 검색 — vault-store snapshot 의 entities 를 quick switcher 스타일로.
      this.addCommand({
        id: 'find-entity',
        name: 'Find entity',
        callback: () => { void this.openFindEntity(); },
      });

      // PR-11: AI 본문 제안 (stub) — 현재 activeFile 이 modular _index.md 면
      // body 에 placeholder 텍스트 append. 실제 LLM 통합은 외부 plugin /
      // settings 로 inject 가능 (ai/suggest.setSuggester).
      this.addCommand({
        id: 'ai-suggest-body',
        name: 'AI: suggest body for current entity',
        checkCallback: (checking: boolean) => {
          const file = this.app.workspace.getActiveFile();
          const ok = !!file && file.path.endsWith('/_index.md');
          if (!ok) return false;
          if (checking) return true;
          void this.runAiSuggestBody();
          return true;
        },
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

  private async runAiSuggestBody(): Promise<void> {
    if (!this.store) return;
    const file = this.app.workspace.getActiveFile();
    if (!file || !file.path.endsWith('/_index.md')) return;
    const { getSuggester } = await import('./ai/suggest');
    const folderPath = file.path.slice(0, -'/_index.md'.length);
    const snap = this.store.getSnapshot();
    const entity = [...snap.entities.values()].find((e) => e.folderPath === folderPath);
    if (!entity) { new Notice('Modular: not a known entity'); return; }
    const siblings = [...snap.entities.values()].filter(
      (e) => e.parentId === entity.parentId && e.id !== entity.id,
    );
    const children = [...snap.entities.values()].filter((e) => e.parentId === entity.id);
    try {
      const suggested = await getSuggester().suggestBody({ entity, siblings, children });
      const body = await this.app.vault.read(file);
      const newBody = body.replace(/(\n+)?$/, '\n\n' + suggested + '\n');
      await this.app.vault.modify(file, newBody);
      new Notice('Modular: AI 본문 제안 추가됨');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Modular: AI suggest failed — ${msg}`);
    }
  }

  private async openFindEntity(): Promise<void> {
    if (!this.store) return;
    const entities = [...this.store.getSnapshot().entities.values()];
    new FindEntityModal(this.app, entities, async (id: EntityId) => {
      if (!this.store) return;
      // 1. activate Canvas (ensure view exists + focus)
      await this.activateView();
      // 2. open _index.md in side leaf (cheap; same as node click)
      await this.store.openInSideLeaf(id);
    }).open();
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

class FindEntityModal extends SuggestModal<Entity> {
  private entities: Entity[];
  private onPick: (id: EntityId) => void | Promise<void>;
  constructor(app: App, entities: Entity[], onPick: (id: EntityId) => void | Promise<void>) {
    super(app);
    this.entities = entities;
    this.onPick = onPick;
    this.setPlaceholder('Find modular entity…');
  }
  getSuggestions(query: string): Entity[] {
    const q = query.trim().toLowerCase();
    if (!q) {
      // No query → recently modified first.
      return [...this.entities].sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0));
    }
    const filtered = this.entities.filter((e) => e.name.toLowerCase().includes(q));
    // Module first, then alphabetical.
    return filtered.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'module' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  renderSuggestion(e: Entity, el: HTMLElement): void {
    el.createDiv({ text: e.name, cls: 'modular-suggest-name' });
    const sub = el.createDiv({ cls: 'modular-suggest-sub' });
    sub.setText(`${e.kind === 'module' ? '◇' : '·'} ${e.folderPath}`);
  }
  onChooseSuggestion(e: Entity): void {
    void this.onPick(e.id);
  }
}
