// VaultStore — v2 (conventions E, 2026-05).
//
// 모든 entity = 폴더 + `_index.md` (본체). id (frontmatter `modular-id`) 가
// source of truth. cache / snapshot / tasks 모두 id 기반.
// path 는 표현. rename / move 에 invariant.

import { App, Menu, Platform, TAbstractFile, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';
import type { Entity, EntityId, Task, Workspace } from './types';
import {
  entityFromIndex,
  newComponentIndexBody,
  newModuleIndexBody,
  setOutgoingTasks,
} from './frontmatter';
import {
  AI_FOLDER,
  INDEX_FILE,
  MODULAR_FOLDER,
  folderPathFromIndex,
  folderPathFromSidecar,
  indexPathFromFolder,
  isEntityIndexPath,
  isPositionSidecarPath,
  nameFromFolderPath,
  newChildEntityPaths,
  newModulePaths,
  parentFolderPath,
  positionSidecarPath,
  sanitizeFileName,
} from './conventions';
import { newId } from './id';

type Listener = () => void;
type PositionsMap = Record<EntityId, { x: number; y: number }>;

const EMPTY: Workspace = Object.freeze({
  entities: new Map<EntityId, Entity>(),
  tasks: Object.freeze<Task[]>([]) as unknown as Task[],
});

export class VaultStore {
  private app: App;
  private snapshot: Workspace = EMPTY;
  private listeners = new Set<Listener>();
  private detachFns: Array<() => void> = [];
  private positions: PositionsMap = {};
  private positionsLoaded = false;
  private pendingRebuild = false;
  private suppressNextSidecarModify = new Set<string>();
  /** id → folderPath cache built on each rebuild. Used by event handlers to
   *  resolve folder lookups without walking the vault each time. */
  private folderPathById = new Map<EntityId, string>();
  /** folder path → id. inverse of folderPathById. */
  private idByFolderPath = new Map<string, EntityId>();
  /** id → cached body excerpt (frontmatter 제거된 첫 ~400자). 비동기로 채움. */
  private bodyExcerptById = new Map<EntityId, string>();
  /** PR-5: 사용자가 pin 한 entity ids — Canvas 우측 inspector panel 에 표시. */
  private pinnedIds = new Set<EntityId>();
  private sideLeaf: WorkspaceLeaf | null = null;

  constructor(app: App) {
    this.app = app;
  }

  /** UI 레이어가 obsidian App API (Modal, Notice 등) 를 호출할 때 노출. */
  getApp(): App { return this.app; }

  start(): void {
    void this.loadAllPositions().then(() => {
      if (this.pendingRebuild) this.pendingRebuild = false;
      this.rebuild();
    });
    const vault = this.app.vault;
    const mc = this.app.metadataCache;

    const onCreate = (f: TAbstractFile) => {
      if (f instanceof TFile && isEntityIndexPath(f.path)) {
        // PR-8: vault explorer / 외부 editor 가 만든 _index.md 면 id 가 없을 수
        // 있음. 자동으로 부여 (frontmatter patch) — 사용자가 ULID 외울 필요 X.
        void this.ensureIdOnIndex(f).then(() => this.requestRebuild());
      }
    };
    const onModify = (f: TAbstractFile) => {
      if (f instanceof TFile && isEntityIndexPath(f.path)) {
        // body 변화 시 캐시 invalidate — rebuild 가 새로 읽음.
        const folderPath = folderPathFromIndex(f.path);
        const id = this.idByFolderPath.get(folderPath);
        if (id) this.bodyExcerptById.delete(id);
        this.requestRebuild();
      }
      if (isPositionSidecarPath(f.path)) {
        if (this.suppressNextSidecarModify.delete(f.path)) return;
        void this.loadSinglePositionByFile(f.path).then(() => this.requestRebuild());
      }
    };
    const onDelete = (f: TAbstractFile) => {
      // Folder delete → drop everything beneath in our caches.
      if (isEntityIndexPath(f.path)) {
        const folder = folderPathFromIndex(f.path);
        const id = this.idByFolderPath.get(folder);
        if (id) {
          delete this.positions[id];
          this.idByFolderPath.delete(folder);
          this.folderPathById.delete(id);
        }
        this.requestRebuild();
      } else if (f instanceof TFolder && f.path.startsWith(`${MODULAR_FOLDER}/`)) {
        // Folder gone → its _index.md (and any nested entity folders) implicitly deleted.
        for (const [folder, id] of [...this.idByFolderPath]) {
          if (folder === f.path || folder.startsWith(f.path + '/')) {
            delete this.positions[id];
            this.idByFolderPath.delete(folder);
            this.folderPathById.delete(id);
          }
        }
        this.requestRebuild();
      }
    };
    const onRename = (f: TAbstractFile, oldPath: string) => {
      // Folder rename → rewrite path-keyed caches. Position is keyed by id
      // (not path) so positions cache is unaffected. Sidecars under the
      // renamed folder follow naturally.
      const oldIsIndex = isEntityIndexPath(oldPath);
      const newIsIndex = f instanceof TFile && isEntityIndexPath(f.path);
      if (oldIsIndex || newIsIndex) {
        this.requestRebuild();
        return;
      }
      // Folder-level rename (no extension). Update folderPath caches.
      if (f instanceof TFolder && oldPath.startsWith(`${MODULAR_FOLDER}/`)) {
        const newPath = f.path;
        for (const [folder, id] of [...this.idByFolderPath]) {
          if (folder === oldPath || folder.startsWith(oldPath + '/')) {
            const moved = newPath + folder.slice(oldPath.length);
            this.idByFolderPath.delete(folder);
            this.idByFolderPath.set(moved, id);
            this.folderPathById.set(id, moved);
          }
        }
        this.requestRebuild();
      }
    };
    const onMcChange = (f: TFile) => {
      if (isEntityIndexPath(f.path)) this.requestRebuild();
    };

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

  // ── auto-id (PR-8) ─────────────────────────────────────────────────────

  /**
   * vault 측에서 _index.md 가 새로 생기면 frontmatter `modular-id` 가 빠져
   * 있을 수 있음. 자동으로 ULID 부여 + parent id 추정 (폴더 nesting).
   */
  private async ensureIdOnIndex(f: TFile): Promise<void> {
    try {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const existingRaw: unknown = fm?.['modular-id'];
      const existing = typeof existingRaw === 'string' ? existingRaw : null;
      if (existing && existing.length > 0) return;
      const folderPath = folderPathFromIndex(f.path);
      const kind = (folderPath.split('/').length === 2) ? 'module' : 'component';
      const newEntityId = newId();
      await this.app.fileManager.processFrontMatter(f, (front: Record<string, unknown>) => {
        front['modular-id'] = newEntityId;
        if (kind === 'component' && !front['modular-parent']) {
          // 부모 폴더에 _index.md 가 있으면 그 id 를 parent 로.
          const parentFolder = folderPath.slice(0, folderPath.lastIndexOf('/'));
          const parentIndexFile = this.app.vault.getAbstractFileByPath(
            `${parentFolder}/${INDEX_FILE}`,
          );
          if (parentIndexFile instanceof TFile) {
            const parentFm = this.app.metadataCache.getFileCache(parentIndexFile)?.frontmatter;
            const parentIdMaybe: unknown = parentFm?.['modular-id'];
            if (typeof parentIdMaybe === 'string' && parentIdMaybe.length > 0) {
              front['modular-parent'] = parentIdMaybe;
            }
          }
        }
      });
    } catch (e) {
      console.error('[modular] ensureIdOnIndex failed:', e);
    }
  }

  // ── pin (PR-5) ─────────────────────────────────────────────────────────

  togglePin(id: EntityId): void {
    if (this.pinnedIds.has(id)) this.pinnedIds.delete(id);
    else this.pinnedIds.add(id);
    this.emit();
  }
  isPinned(id: EntityId): boolean { return this.pinnedIds.has(id); }
  getPinnedIds(): EntityId[] { return [...this.pinnedIds]; }

  private requestRebuild(): void {
    if (!this.positionsLoaded) { this.pendingRebuild = true; return; }
    this.rebuild();
  }

  // ── positions (sidecar at <folder>/.position) ──────────────────────────

  private async loadAllPositions(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      // walk modular/ for any .position sidecar; the entity's id comes from
      // its sibling _index.md (read separately when we know the path).
      const stack = [MODULAR_FOLDER];
      while (stack.length) {
        const dir = stack.pop()!;
        if (!(await adapter.exists(dir))) continue;
        const { files, folders } = await adapter.list(dir);
        for (const file of files) {
          if (file.endsWith(`/${INDEX_FILE}`) || file.endsWith(`/.position`)) {
            // handled below
          }
        }
        for (const sub of folders) {
          if (sub.endsWith(`/${AI_FOLDER}`) || sub.includes(`/${AI_FOLDER}/`)) continue;
          stack.push(sub);
        }
      }
      // Build id ↔ folderPath map first by scanning all _index.md.
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (!isEntityIndexPath(f.path)) continue;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        const id = typeof fm?.['modular-id'] === 'string' ? fm['modular-id'] : null;
        if (!id) continue;
        const folderPath = folderPathFromIndex(f.path);
        this.folderPathById.set(id, folderPath);
        this.idByFolderPath.set(folderPath, id);
      }
      // Then load each entity's sidecar by id.
      for (const [id, folderPath] of this.folderPathById) {
        const side = positionSidecarPath(folderPath);
        if (!(await adapter.exists(side))) continue;
        const pos = await readPositionFile(adapter, side);
        if (pos) this.positions[id] = pos;
      }
    } catch (e) {
      console.error('[modular] loadAllPositions failed:', e);
    } finally {
      this.positionsLoaded = true;
    }
  }

  private async loadSinglePositionByFile(sidecarPath: string): Promise<void> {
    if (!isPositionSidecarPath(sidecarPath)) return;
    const folderPath = folderPathFromSidecar(sidecarPath);
    const id = this.idByFolderPath.get(folderPath);
    if (!id) return;
    const pos = await readPositionFile(this.app.vault.adapter, sidecarPath);
    if (pos) this.positions[id] = pos;
  }

  private async writeSinglePosition(folderPath: string, pos: { x: number; y: number }): Promise<void> {
    const side = positionSidecarPath(folderPath);
    try {
      this.suppressNextSidecarModify.add(side);
      await this.app.vault.adapter.write(side, JSON.stringify(pos));
    } catch (e) {
      this.suppressNextSidecarModify.delete(side);
      console.error('[modular] writeSinglePosition failed:', e);
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────

  private rebuild(): void {
    const vault = this.app.vault;
    const mc = this.app.metadataCache;
    const entities = new Map<EntityId, Entity>();
    const tasksRaw: Array<{ fromId: EntityId; toId: EntityId }> = [];
    // Rebuild path↔id caches inline.
    this.folderPathById.clear();
    this.idByFolderPath.clear();

    const seenIds = new Set<EntityId>();
    const filesToReadBodyFor: Array<{ id: EntityId; file: TFile }> = [];
    for (const f of vault.getMarkdownFiles()) {
      if (!isEntityIndexPath(f.path)) continue;
      const fm = mc.getFileCache(f)?.frontmatter;
      const id = typeof fm?.['modular-id'] === 'string' ? fm['modular-id'] : null;
      if (!id) continue;
      const folderPath = folderPathFromIndex(f.path);
      const pos = this.positions[id] ?? { x: 0, y: 0 };
      const ent = entityFromIndex(f.path, fm, pos);
      if (!ent) continue;
      ent.bodyExcerpt = this.bodyExcerptById.get(id);
      ent.createdMs = f.stat.ctime;
      ent.modifiedMs = f.stat.mtime;
      entities.set(id, ent);
      this.folderPathById.set(id, folderPath);
      this.idByFolderPath.set(folderPath, id);
      seenIds.add(id);
      if (!this.bodyExcerptById.has(id)) filesToReadBodyFor.push({ id, file: f });
      const tasks: unknown = fm?.['modular-tasks'];
      if (Array.isArray(tasks)) {
        for (const t of tasks) {
          if (typeof t === 'string' && t.length > 0) tasksRaw.push({ fromId: id, toId: t });
        }
      }
    }
    // Drop excerpts for deleted entities.
    for (const id of [...this.bodyExcerptById.keys()]) {
      if (!seenIds.has(id)) this.bodyExcerptById.delete(id);
    }
    // Read body excerpts asynchronously for any entities we haven't yet,
    // then re-emit so nodes can show preview. First rebuild ships with
    // no excerpts; second one (after reads settle) carries them.
    if (filesToReadBodyFor.length > 0) {
      void Promise.all(filesToReadBodyFor.map(async ({ id, file }) => {
        try {
          const body = await vault.read(file);
          this.bodyExcerptById.set(id, stripFrontmatter(body).slice(0, 400));
        } catch {
          this.bodyExcerptById.set(id, '');
        }
      })).then(() => this.rebuild());
    }

    // Filter tasks: both endpoints must exist + dedup.
    const seen = new Set<string>();
    const tasks: Task[] = [];
    for (const t of tasksRaw) {
      if (!entities.has(t.fromId) || !entities.has(t.toId)) continue;
      const key = `${t.fromId}|${t.toId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push(t);
    }

    this.snapshot = { entities, tasks };
    this.emit();
  }

  // ── mutations ───────────────────────────────────────────────────────────

  async createModule(name: string, position: { x: number; y: number }): Promise<EntityId | null> {
    const paths = newModulePaths(name);
    if (!paths) return null;
    const id = newId();
    await this.app.vault.createFolder(paths.folder);
    await this.app.vault.create(paths.index, newModuleIndexBody(id));
    this.positions[id] = position;
    await this.writeSinglePosition(paths.folder, position);
    return id;
  }

  async createChildComponent(
    parentId: EntityId,
    name: string,
    position: { x: number; y: number },
  ): Promise<EntityId | null> {
    const parentFolder = this.folderPathById.get(parentId);
    if (!parentFolder) return null;
    const paths = newChildEntityPaths(parentFolder, name);
    if (!paths) return null;
    const id = newId();
    await this.app.vault.createFolder(paths.folder);
    await this.app.vault.create(paths.index, newComponentIndexBody(id, parentId));
    this.positions[id] = position;
    await this.writeSinglePosition(paths.folder, position);
    return id;
  }

  async updateEntityPosition(id: EntityId, pos: { x: number; y: number }): Promise<void> {
    const folderPath = this.folderPathById.get(id);
    if (!folderPath) return;
    this.positions[id] = pos;
    await this.writeSinglePosition(folderPath, pos);
    this.rebuild();
  }

  async deleteEntity(id: EntityId): Promise<void> {
    const folderPath = this.folderPathById.get(id);
    if (!folderPath) return;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (folder instanceof TFolder) {
      delete this.positions[id];
      // Also drop any nested descendants from caches (folder.delete cascades on disk).
      const prefix = folderPath + '/';
      for (const [fp, eid] of [...this.idByFolderPath]) {
        if (fp === folderPath || fp.startsWith(prefix)) {
          delete this.positions[eid];
          this.idByFolderPath.delete(fp);
          this.folderPathById.delete(eid);
        }
      }
      await this.app.fileManager.trashFile(folder);
    }
  }

  async renameEntity(id: EntityId, newName: string): Promise<EntityId | null> {
    const folderPath = this.folderPathById.get(id);
    if (!folderPath) return null;
    const safe = sanitizeFileName(newName);
    if (!safe) return null;
    const parent = parentFolderPath(folderPath);
    const newFolderPath = parent ? `${parent}/${safe}` : safe;
    if (newFolderPath === folderPath) return id;
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return null;
    await this.app.fileManager.renameFile(folder, normalizePath(newFolderPath));
    // Caches update via the rename event listener; id stays the same.
    return id;
  }

  async updateModuleTags(id: EntityId, tags: string[]): Promise<void> {
    const folderPath = this.folderPathById.get(id);
    if (!folderPath) return;
    const f = this.app.vault.getAbstractFileByPath(indexPathFromFolder(folderPath));
    if (!(f instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
      fm['modular-tags'] = tags;
    });
  }

  async addComponentTask(fromId: EntityId, toId: EntityId): Promise<void> {
    if (fromId === toId) return;
    const folderPath = this.folderPathById.get(fromId);
    if (!folderPath) return;
    const f = this.app.vault.getAbstractFileByPath(indexPathFromFolder(folderPath));
    if (!(f instanceof TFile)) return;
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const tasks: unknown = fm?.['modular-tasks'];
    const existing = Array.isArray(tasks)
      ? (tasks as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    if (existing.includes(toId)) return;
    await setOutgoingTasks(this.app, f, [...existing, toId]);
  }

  async removeComponentTask(fromId: EntityId, toId: EntityId): Promise<void> {
    const folderPath = this.folderPathById.get(fromId);
    if (!folderPath) return;
    const f = this.app.vault.getAbstractFileByPath(indexPathFromFolder(folderPath));
    if (!(f instanceof TFile)) return;
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
    const tasks: unknown = fm?.['modular-tasks'];
    const existing = Array.isArray(tasks)
      ? (tasks as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const next = existing.filter((p) => p !== toId);
    if (next.length === existing.length) return;
    await setOutgoingTasks(this.app, f, next);
  }

  // ── side-leaf navigation ────────────────────────────────────────────────

  async openInSideLeaf(id: EntityId): Promise<void> {
    const folderPath = this.folderPathById.get(id);
    if (!folderPath) return;
    const f = this.app.vault.getAbstractFileByPath(indexPathFromFolder(folderPath));
    if (!(f instanceof TFile)) return;
    const ws = this.app.workspace;
    if (Platform.isMobile) {
      const tab = ws.getLeaf('tab');
      await tab.openFile(f);
      return;
    }
    const leaf = this.sideLeaf;
    const alive = leaf ? isLeafAttached(ws, leaf) : false;
    let target = leaf;
    if (!target || !alive) {
      target = ws.getLeaf('split', 'vertical');
      target.setPinned(true);
      this.sideLeaf = target;
    }
    await target.openFile(f, { active: false });
  }

  async openInNewSplit(id: EntityId): Promise<void> {
    const folderPath = this.folderPathById.get(id);
    if (!folderPath) return;
    const f = this.app.vault.getAbstractFileByPath(indexPathFromFolder(folderPath));
    if (!(f instanceof TFile)) return;
    const leaf = Platform.isMobile
      ? this.app.workspace.getLeaf('tab')
      : this.app.workspace.getLeaf('split', 'vertical');
    await leaf.openFile(f);
  }

  // ── context menu ────────────────────────────────────────────────────────

  openContextMenu(
    id: EntityId,
    event: MouseEvent,
    callbacks: {
      onAddChild?: (parentId: EntityId) => void;
      onRename?: (id: EntityId) => void;
      onDelete?: (id: EntityId) => void;
    },
  ): void {
    void nameFromFolderPath; // imported for re-export consumers; no-op here.
    const menu = new Menu();

    if (callbacks.onAddChild) {
      menu.addItem((item) => item
        .setTitle('자식 추가')
        .setIcon('plus')
        .onClick(() => callbacks.onAddChild!(id)));
    }
    if (callbacks.onRename) {
      menu.addItem((item) => item
        .setTitle('이름 변경')
        .setIcon('pencil')
        .onClick(() => callbacks.onRename!(id)));
    }

    menu.addItem((item) => item
      .setTitle(this.isPinned(id) ? '핀 해제' : '핀 고정')
      .setIcon('pin')
      .onClick(() => this.togglePin(id)));

    menu.addSeparator();

    if (callbacks.onDelete) {
      menu.addItem((item) => item
        .setTitle('삭제 (폴더 통째)')
        .setIcon('trash')
        .onClick(() => callbacks.onDelete!(id)));
    }

    menu.showAtMouseEvent(event);
  }
}

async function readPositionFile(
  adapter: { read: (p: string) => Promise<string> },
  path: string,
): Promise<{ x: number; y: number } | null> {
  try {
    const raw = await adapter.read(path);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const x = Number((parsed as { x?: unknown }).x);
    const y = Number((parsed as { y?: unknown }).y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  } catch {
    return null;
  }
}

function isLeafAttached(
  ws: { iterateAllLeaves: (cb: (l: WorkspaceLeaf) => void) => void },
  leaf: WorkspaceLeaf,
): boolean {
  let found = false;
  ws.iterateAllLeaves((l) => { if (l === leaf) found = true; });
  return found;
}

/** Drop YAML frontmatter block (`---…---`) from body. */
function stripFrontmatter(body: string): string {
  const m = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? body.slice(m[0].length) : body;
}
