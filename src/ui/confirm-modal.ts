// Obsidian-native confirm — promise-based wrapper around Modal.
// Native confirm() works but breaks theming + mobile UX. This Modal renders
// in the obsidian-themed overlay, accepts Enter (confirm) / Escape (cancel),
// and returns a Promise<boolean> for ergonomic call-sites.

import { App, Modal, Setting } from 'obsidian';

export interface ConfirmModalOptions {
  title: string;
  message: string;
  /** Default 'OK'. */
  confirmLabel?: string;
  /** Default '취소'. */
  cancelLabel?: string;
  /** Style confirm button as destructive (red). Default false. */
  destructive?: boolean;
}

export function confirmModal(app: App, opts: ConfirmModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new ConfirmModalImpl(app, opts, resolve);
    modal.open();
  });
}

class ConfirmModalImpl extends Modal {
  private opts: ConfirmModalOptions;
  private resolve: (v: boolean) => void;
  private resolved = false;

  constructor(app: App, opts: ConfirmModalOptions, resolve: (v: boolean) => void) {
    super(app);
    this.opts = opts;
    this.resolve = resolve;
  }

  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.empty();
    this.contentEl.createDiv({ text: this.opts.message, cls: 'modular-confirm-msg' });

    new Setting(this.contentEl)
      .addButton((btn) => {
        btn
          .setButtonText(this.opts.cancelLabel ?? '취소')
          .onClick(() => { this.finish(false); });
      })
      .addButton((btn) => {
        btn
          .setButtonText(this.opts.confirmLabel ?? 'OK')
          .setCta()
          .onClick(() => { this.finish(true); });
        if (this.opts.destructive) btn.setWarning();
        // Focus the destructive/confirm button so Enter commits.
        window.setTimeout(() => btn.buttonEl.focus(), 0);
      });

    // Enter = confirm, Escape = cancel (Modal handles Escape natively).
    this.scope.register([], 'Enter', () => { this.finish(true); return false; });
  }

  onClose(): void {
    // Escape / outside click → unresolved promise → treat as cancel.
    if (!this.resolved) this.finish(false);
  }

  private finish(value: boolean): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(value);
    this.close();
  }
}
