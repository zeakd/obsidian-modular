// ItemView — 메인 워크스페이스 영역에 띄우는 다이어그램 view.
// containerEl 안에 React root 를 마운트.

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { ModularApp } from './ModularApp';
import type { VaultStore } from '../data/vault-store';

export const VIEW_TYPE_MODULAR = 'modular-canvas';

export class ModularView extends ItemView {
  private root: Root | null = null;
  private store: VaultStore;

  constructor(leaf: WorkspaceLeaf, store: VaultStore) {
    super(leaf);
    this.store = store;
  }

  getViewType(): string { return VIEW_TYPE_MODULAR; }
  getDisplayText(): string { return 'Modular'; }
  getIcon(): string { return 'git-fork'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('modular-view-container');
    const mount = container.createDiv({ cls: 'modular-view-mount' });
    this.root = createRoot(mount);
    this.root.render(createElement(ModularApp, { store: this.store }));
  }

  async onClose(): Promise<void> {
    this.root?.unmount();
    this.root = null;
  }
}
