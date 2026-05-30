// BodyEditModal — markdown 본문 (frontmatter 제외) 빠른 편집.
// PR-10: side leaf 없이 노드 메뉴에서 바로 본문 편집. Canvas 컨텍스트
// 보존이 핵심. 풀 markdown editor 가 아니라 textarea 기반 — 짧은 메모,
// 한 문단 수정 등의 빠른 작업.

import { App, Modal, Notice, Setting, TFile } from 'obsidian';

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function bodyEditModal(app: App, file: TFile, entityName: string): Promise<void> {
  return new Promise((resolve) => {
    const modal = new BodyEditModalImpl(app, file, entityName, resolve);
    modal.open();
  });
}

class BodyEditModalImpl extends Modal {
  private file: TFile;
  private entityName: string;
  private resolve: () => void;
  private ta!: HTMLTextAreaElement;
  private originalBody = '';
  private frontmatter = '';

  constructor(app: App, file: TFile, entityName: string, resolve: () => void) {
    super(app);
    this.file = file;
    this.entityName = entityName;
    this.resolve = resolve;
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText(`Body — ${this.entityName}`);
    this.contentEl.empty();
    this.contentEl.addClass('modular-body-edit');

    const full = await this.app.vault.read(this.file);
    const fmMatch = full.match(FRONTMATTER_RE);
    this.frontmatter = fmMatch ? fmMatch[0] : '';
    this.originalBody = fmMatch ? full.slice(fmMatch[0].length) : full;

    this.ta = this.contentEl.createEl('textarea', { cls: 'modular-body-edit-ta' });
    this.ta.value = this.originalBody;
    this.ta.rows = 14;
    window.setTimeout(() => this.ta.focus(), 0);

    new Setting(this.contentEl)
      .addButton((btn) => btn
        .setButtonText('취소')
        .onClick(() => this.close()))
      .addButton((btn) => btn
        .setButtonText('저장 (⌘+Enter)')
        .setCta()
        .onClick(() => { void this.save(); }));

    this.scope.register(['Mod'], 'Enter', () => { void this.save(); return false; });
  }

  onClose(): void {
    this.resolve();
  }

  private async save(): Promise<void> {
    const next = this.ta.value;
    if (next === this.originalBody) {
      this.close();
      return;
    }
    try {
      const out = this.frontmatter + (next.startsWith('\n') ? next : '\n' + next);
      await this.app.vault.modify(this.file, out);
      new Notice('Modular: 본문 저장됨');
      this.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Modular: 본문 저장 실패 — ${msg}`);
    }
  }
}
