// VaultStore — 폴더 nesting + .positions.json.
// type / parent 는 path 의 폴더 구조가 결정 (frontmatter 무관).

import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { Workspace, Module, Component, ComponentTask } from './types';
import {
  moduleFromEntity,
  componentFromEntity,
  newModuleFileBody,
  newComponentFileBody,
  writeModularFrontmatter,
  setOutgoingTasks,
} from './frontmatter';
import {
  MODULAR_FOLDER,
  POSITIONS_PATH,
  isModularPath,
  entityInfo,
  newModulePaths,
  newChildComponentPaths,
  promotedLeafPaths,
  sanitizeFileName,
  basenameFromPath,
} from './conventions';

type Listener = () => void;
type PositionsMap = Record<string, { x: number; y: number }>;

const EMPTY: Workspace = { modules: [], components: [], componentTasks: [] };

export class VaultStore {
  private app: App;
  private snapshot: Workspace = EMPTY;
  private listeners = new Set<Listener>();
  private detachFns: Array<() => void> = [];
  private positions: PositionsMap = {};
  private positionsLoaded = false;
  private posWriteChain: Promise<void> = Promise.resolve();

  constructor(app: App) {
    this.app = app;
  }

  start(): void {
    void this.loadPositions().then(() => this.rebuild());
    const vault = this.app.vault;
    const mc = this.app.metadataCache;
    const onCreate = (f: any) => { if (f instanceof TFile && isModularPath(f.path)) this.rebuild(); };
    const onModify = (f: any) => {
      if (f instanceof TFile && isModularPath(f.path)) this.rebuild();
      if (f && typeof f.path === 'string' && f.path === POSITIONS_PATH) {
        void this.loadPositions().then(() => this.rebuild());
      }
    };
    const onDelete = (f: any) => {
      const p = typeof f?.path === 'string' ? f.path : '';
      if (isModularPath(p)) {
        if (this.positions[p]) {
          delete this.positions[p];
          void this.writePositions();
        }
        this.rebuild();
      }
    };
    const onRename = (f: any, oldPath: any) => {
      // 폴더 rename 도 자식별 emit 됨 (Obsidian 동작). 우리는 path 만 보고 처리.
      const newPath = typeof f?.path === 'string' ? f.path : '';
      const newOk = newPath && isModularPath(newPath);
      const oldOk = typeof oldPath === 'string' && isModularPath(oldPath);
      if (oldOk && typeof oldPath === 'string' && this.positions[oldPath]) {
        const pos = this.positions[oldPath];
        delete this.positions[oldPath];
        if (newOk) this.positions[newPath] = pos;
        void this.writePositions();
      }
      if (newOk || oldOk) this.rebuild();
    };
    const onMcChange = (f: any) => { if (f instanceof TFile && isModularPath(f.path)) this.rebuild(); };
    const r1 = vault.on('create', onCreate);
    const r2 = vault.on('modify', onModify);
    const r3 = vault.on('delete', onDelete);
    const r4 = vault.on('rename', onRename);
    const r5 = mc.on('changed', onMcChange);
    this.detachFns.push(
      () => vault.offref(r1),
      () => vault.offref(r2),
      () => vault.offref(r3),
      () => vault.offref(r4),
      () => mc.offref(r5),
    );
  }

  stop(): void {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.listeners.clear();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = (): Workspace => this.snapshot;
  private emit(): void { for (const fn of this.listeners) fn(); }

  // ── positions ────────────────────────────────────────────

  private async loadPositions(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(POSITIONS_PATH)) {
        const raw = await adapter.read(POSITIONS_PATH);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const out: PositionsMap = {};
          for (const [k, v] of Object.entries(parsed)) {
            const obj = v as any;
            if (obj && typeof obj.x === 'number' && typeof obj.y === 'number') {
              out[k] = { x: obj.x, y: obj.y };
            }
          }
          this.positions = out;
        }
      }
    } catch (e) {
      console.error('[modular] loadPositions failed:', e);
    } finally {
      this.positionsLoaded = true;
    }
  }

  private writePositions(): Promise<void> {
    this.posWriteChain = this.posWriteChain.catch(() => {}).then(async () => {
      try {
        await this.ensureModularFolder();
        const adapter = this.app.vault.adapter;
        const keys = Object.keys(this.positions).sort();
        const obj: PositionsMap = {};
        for (const k of keys) obj[k] = this.positions[k];
        await adapter.write(POSITIONS_PATH, JSON.stringify(obj, null, 2));
      } catch (e) {
        console.error('[modular] writePositions failed:', e);
      }
    });
    return this.posWriteChain;
  }

  // ── rebuild — path 기반 분류 ─────────────────────────────

  private rebuild(): void {
    const vault = this.app.vault;
    const mc = this.app.metadataCache;

    const modules: Module[] = [];
    const components: Component[] = [];
    const componentTasks: ComponentTask[] = [];
    type RawTask = { fromPath: string; toPath: string };
    const rawTasks: RawTask[] = [];
    const allEntityPaths = new Set<string>();

    for (const f of vault.getMarkdownFiles()) {
      const info = entityInfo(f.path);
      if (!info) continue;
      allEntityPaths.add(f.path);
      const fm = mc.getFileCache(f)?.frontmatter;
      const pos = this.positions[f.path];
      if (info.kind === 'module') {
        modules.push(moduleFromEntity(f.path, fm, pos));
      } else {
        components.push(componentFromEntity(f.path, info.parentEntityPath!, fm, pos));
        const ts = fm?.['modular-tasks'];
        if (Array.isArray(ts)) {
          for (const dest of ts) {
            if (typeof dest === 'string' && dest) rawTasks.push({ fromPath: f.path, toPath: dest });
          }
        }
      }
    }

    const seen = new Set<string>();
    for (const t of rawTasks) {
      if (!allEntityPaths.has(t.fromPath) || !allEntityPaths.has(t.toPath)) continue;
      if (t.fromPath === t.toPath) continue;
      const id = `task:${t.fromPath}→${t.toPath}`;
      if (seen.has(id)) continue;
      seen.add(id);
      componentTasks.push({ id, fromPath: t.fromPath, toPath: t.toPath });
    }

    // stale positions 정리
    let positionsChanged = false;
    for (const k of Object.keys(this.positions)) {
      if (!allEntityPaths.has(k)) {
        delete this.positions[k];
        positionsChanged = true;
      }
    }
    if (positionsChanged && this.positionsLoaded) void this.writePositions();

    this.snapshot = { modules, components, componentTasks };
    this.emit();
  }

  // ── mutation ─────────────────────────────────────────────

  async ensureModularFolder(): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(MODULAR_FOLDER);
    if (!f) await this.app.vault.createFolder(MODULAR_FOLDER);
    else if (!(f instanceof TFolder)) {
      throw new Error(`'${MODULAR_FOLDER}' exists and is not a folder`);
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) await this.app.vault.createFolder(path);
    else if (!(f instanceof TFolder)) {
      throw new Error(`'${path}' exists and is not a folder`);
    }
  }

  async createModule(name: string, position: { x: number; y: number }): Promise<string> {
    const paths = newModulePaths(name);
    if (!paths) throw new Error('invalid name');
    await this.ensureModularFolder();
    await this.ensureFolder(paths.folder);
    await this.app.vault.create(normalizePath(paths.md), newModuleFileBody());
    this.positions[paths.md] = position;
    await this.writePositions();
    return paths.md;
  }

  /** parent 에 자식 component 추가. parent 가 leaf 면 자동으로 expanded 로 promote. */
  async createChildComponent(
    parentPath: string,
    name: string,
    position: { x: number; y: number },
  ): Promise<string> {
    const parentInfo = entityInfo(parentPath);
    if (!parentInfo) throw new Error(`not a modular entity: ${parentPath}`);

    let parentFolder: string;
    if (parentInfo.expanded) {
      parentFolder = parentInfo.folderPath;
    } else {
      // leaf → promote
      parentFolder = await this.promoteLeaf(parentPath);
    }

    const paths = newChildComponentPaths(parentFolder, name);
    if (!paths) throw new Error('invalid name');
    await this.ensureFolder(paths.folder);
    await this.app.vault.create(normalizePath(paths.md), newComponentFileBody());
    this.positions[paths.md] = position;
    await this.writePositions();
    return paths.md;
  }

  /** leaf 를 expanded 로 promote — md 를 X/X.md 로 이동. 반환: 새 폴더 path. */
  private async promoteLeaf(leafPath: string): Promise<string> {
    const promoted = promotedLeafPaths(leafPath);
    if (!promoted) throw new Error(`cannot promote: ${leafPath}`);
    await this.ensureFolder(promoted.folder);
    const f = this.app.vault.getAbstractFileByPath(leafPath);
    if (f instanceof TFile) {
      await this.app.fileManager.renameFile(f, normalizePath(promoted.md));
      if (this.positions[leafPath]) {
        this.positions[promoted.md] = this.positions[leafPath];
        delete this.positions[leafPath];
        await this.writePositions();
      }
    }
    return promoted.folder;
  }

  async updateEntityPosition(path: string, pos: { x: number; y: number }): Promise<void> {
    this.positions[path] = pos;
    await this.writePositions();
    this.rebuild();
  }

  async updateModuleTags(path: string, tags: string[]): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    await writeModularFrontmatter(this.app, f, { 'modular-tags': tags });
  }

  /** delete — expanded 면 폴더 통째 (자식들 다 사라짐), leaf 면 md 만. */
  async deleteEntity(path: string): Promise<void> {
    const info = entityInfo(path);
    if (!info) return;
    if (info.expanded) {
      const folder = this.app.vault.getAbstractFileByPath(info.folderPath);
      if (folder instanceof TFolder) {
        // 안의 모든 positions 정리
        const prefix = `${info.folderPath}/`;
        for (const k of Object.keys(this.positions)) {
          if (k === path || k.startsWith(prefix)) delete this.positions[k];
        }
        await this.writePositions();
        await this.app.vault.delete(folder, true);
        return;
      }
    }
    // leaf 또는 폴더 없는 경우
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    delete this.positions[path];
    await this.writePositions();
    await this.app.vault.delete(f);
  }

  /** entity 의 본체 md 와 (expanded 면) 폴더를 같이 rename. */
  async renameEntity(oldPath: string, newName: string): Promise<string | null> {
    const safe = sanitizeFileName(newName);
    if (!safe) return null;
    const info = entityInfo(oldPath);
    if (!info) return null;
    const oldBase = basenameFromPath(oldPath);
    if (oldBase === safe) return oldPath;

    if (info.expanded) {
      // 폴더 먼저 rename — 자식들 path 자동 갱신 (rename 이벤트가 자식별 emit)
      const folder = this.app.vault.getAbstractFileByPath(info.folderPath);
      if (folder instanceof TFolder) {
        const parentDir = info.folderPath.split('/').slice(0, -1).join('/');
        const newFolderPath = parentDir ? `${parentDir}/${safe}` : safe;
        await this.app.fileManager.renameFile(folder, normalizePath(newFolderPath));
        // 폴더 rename 후 동명 md 도 함께 — Obsidian 이 폴더 안 자식까지 path 갱신했으니
        // 본체 md 의 새 path = newFolderPath/oldBase.md
        const movedMdPath = `${newFolderPath}/${oldBase}.md`;
        const movedMd = this.app.vault.getAbstractFileByPath(movedMdPath);
        if (movedMd instanceof TFile) {
          await this.app.fileManager.renameFile(movedMd, normalizePath(`${newFolderPath}/${safe}.md`));
        }
        return `${newFolderPath}/${safe}.md`;
      }
    }

    // leaf
    const f = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(f instanceof TFile)) return null;
    const parentDir = oldPath.split('/').slice(0, -1).join('/');
    const newPath = normalizePath(`${parentDir}/${safe}.md`);
    await this.app.fileManager.renameFile(f, newPath);
    return newPath;
  }

  async addComponentTask(fromPath: string, toPath: string): Promise<void> {
    if (fromPath === toPath) return;
    const f = this.app.vault.getAbstractFileByPath(fromPath);
    if (!(f instanceof TFile)) return;
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const existing = Array.isArray(fm?.['modular-tasks'])
      ? (fm!['modular-tasks'] as string[]).filter((s) => typeof s === 'string')
      : [];
    if (existing.includes(toPath)) return;
    await setOutgoingTasks(this.app, f, [...existing, toPath]);
  }

  async removeComponentTask(fromPath: string, toPath: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(fromPath);
    if (!(f instanceof TFile)) return;
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const existing = Array.isArray(fm?.['modular-tasks'])
      ? (fm!['modular-tasks'] as string[]).filter((s) => typeof s === 'string')
      : [];
    const next = existing.filter((p) => p !== toPath);
    if (next.length === existing.length) return;
    await setOutgoingTasks(this.app, f, next);
  }

  async openInSplitLeaf(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf('split');
    await leaf.openFile(f);
  }
}
