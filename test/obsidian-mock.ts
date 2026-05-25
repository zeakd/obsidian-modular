// Obsidian API 의 최소 mock — smoke test 환경 (외부 node/bun) 에서
// dist/main.js 를 require 했을 때 'obsidian' import 를 가로채기 위함.
//
// 실제 동작이 아니라 *type/shape* 만 맞춤. plugin 의 top-level evaluation +
// onload 단계에서 throw 가 없는지만 검증.

class Events {
  on(_name: string, _fn: any): any { return { _ref: true }; }
  off(_name: string, _fn: any): void {}
  offref(_ref: any): void {}
  trigger(_name: string, ..._args: any[]): void {}
}

export class Plugin extends Events {
  app: any;
  manifest: any;
  constructor(app: any, manifest: any) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  addCommand(_o: any): any { return _o; }
  addRibbonIcon(_icon: string, _title: string, _cb: any): any { return { addEventListener: () => {} }; }
  registerView(_type: string, _factory: any): void {}
  registerEvent(_ref: any): void {}
  registerDomEvent(_el: any, _type: string, _cb: any): void {}
  addSettingTab(_tab: any): void {}
  loadData(): Promise<any> { return Promise.resolve({}); }
  saveData(_data: any): Promise<void> { return Promise.resolve(); }
}

export class ItemView {
  containerEl: any;
  leaf: any;
  constructor(leaf: any) {
    this.leaf = leaf;
    this.containerEl = makeMockEl();
  }
  getViewType(): string { return ''; }
  getDisplayText(): string { return ''; }
  getIcon(): string { return ''; }
}

export class Notice {
  constructor(_msg: string, _ms?: number) {}
  setMessage(_m: string): this { return this; }
  hide(): void {}
}

export class TFile { path: string = ''; basename: string = ''; extension: string = ''; parent: any = null; vault: any = null; stat: any = {}; }
export class TFolder { path: string = ''; name: string = ''; parent: any = null; vault: any = null; children: any[] = []; }
export class TAbstractFile { path: string = ''; name: string = ''; parent: any = null; vault: any = null; }
export class WorkspaceLeaf {
  view: any = null;
  openFile(_f: any): Promise<void> { return Promise.resolve(); }
  setViewState(_s: any): Promise<void> { return Promise.resolve(); }
  getViewState(): any { return {}; }
}
export class Modal { app: any; constructor(app: any) { this.app = app; } open(): void {} close(): void {} }
export class Setting { containerEl: any; constructor(_el: any) { this.containerEl = _el; } setName(_: string): this { return this; } setDesc(_: string): this { return this; } addText(_cb: any): this { return this; } addToggle(_cb: any): this { return this; } addButton(_cb: any): this { return this; } }
export class PluginSettingTab { app: any; plugin: any; containerEl: any; constructor(app: any, plugin: any) { this.app = app; this.plugin = plugin; this.containerEl = makeMockEl(); } display(): void {} hide(): void {} }

export const Platform = { isDesktopApp: true, isMobile: false, isMacOS: true };
export const Menu = class { constructor() {} addItem(_cb: any): this { return this; } showAtMouseEvent(_e: any): void {} };
export const moment: any = (..._args: any[]) => ({ format: (_: string) => '', toDate: () => new Date() });
export function normalizePath(p: string): string { return p.replace(/^\/+/, '').replace(/\\/g, '/'); }
export function debounce<T extends (...args: any[]) => any>(fn: T, _ms: number, _resetTimer?: boolean): T { return fn; }

function makeMockEl(): any {
  const el: any = {
    children: [],
    style: {},
    createDiv: () => makeMockEl(),
    createEl: () => makeMockEl(),
    empty: () => {},
    addClass: () => el,
    removeClass: () => el,
    setAttribute: () => {},
    getAttribute: () => '',
    appendChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return el;
}

// 가짜 App — Plugin 생성자에 들어감.
export function makeMockApp(): any {
  const adapterFs = new Map<string, string>();
  const fileMap = new Map<string, any>();
  const handlers = new Map<string, Set<any>>();
  const mc = {
    on(name: string, fn: any) {
      let s = handlers.get(`mc:${name}`); if (!s) { s = new Set(); handlers.set(`mc:${name}`, s); }
      s.add(fn); return { _ref: name };
    },
    off(_n: string, _f: any) {},
    offref(_ref: any) {},
    getFileCache(_f: any): any { return {}; },
    resolvedLinks: {},
    unresolvedLinks: {},
  };
  const vault = {
    on(name: string, fn: any) {
      let s = handlers.get(`v:${name}`); if (!s) { s = new Set(); handlers.set(`v:${name}`, s); }
      s.add(fn); return { _ref: name };
    },
    off(_n: string, _f: any) {},
    offref(_ref: any) {},
    getMarkdownFiles(): any[] { return [...fileMap.values()]; },
    getAbstractFileByPath(p: string): any { return fileMap.get(p) ?? null; },
    create(p: string, body: string): Promise<any> { const f = new TFile(); (f as any).path = p; fileMap.set(p, f); adapterFs.set(p, body); return Promise.resolve(f); },
    modify(f: any, body: string): Promise<void> { adapterFs.set(f.path, body); return Promise.resolve(); },
    delete(f: any): Promise<void> { fileMap.delete(f.path); adapterFs.delete(f.path); return Promise.resolve(); },
    createFolder(_p: string): Promise<void> { return Promise.resolve(); },
    adapter: {
      exists(p: string): Promise<boolean> { return Promise.resolve(adapterFs.has(p)); },
      read(p: string): Promise<string> { return Promise.resolve(adapterFs.get(p) ?? ''); },
      write(p: string, content: string): Promise<void> { adapterFs.set(p, content); return Promise.resolve(); },
      remove(p: string): Promise<void> { adapterFs.delete(p); return Promise.resolve(); },
    },
  };
  const workspace = {
    onLayoutReady(fn: any) { setTimeout(fn, 0); },
    getLeaf(_split?: any) { return new WorkspaceLeaf(); },
    getLeavesOfType(_t: string) { return [] as any[]; },
    revealLeaf(_l: any) {},
    openLinkText(_p: string, _f: string) { return Promise.resolve(); },
    on(_n: string, _fn: any) { return { _ref: true }; },
    off(_n: string, _fn: any) {},
  };
  const fileManager = {
    processFrontMatter(_f: any, fn: any) { const fm = {}; fn(fm); return Promise.resolve(); },
    renameFile(f: any, newPath: string) { adapterFs.set(newPath, adapterFs.get(f.path) ?? ''); adapterFs.delete(f.path); fileMap.delete(f.path); f.path = newPath; fileMap.set(newPath, f); return Promise.resolve(); },
  };
  return { vault, metadataCache: mc, workspace, fileManager };
}
