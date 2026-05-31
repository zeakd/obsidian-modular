// VaultStore — v3 (folder-agnostic, 2026).
//
// entity = frontmatter `modular-id` 를 가진 아무 markdown 파일. 폴더 무관.
// 이름 = 파일 basename. 관계 = 네이티브 wikilink (modular-parent / modular-tasks).
// modular 고유 저장: modular-id (anchor) + <dir>/.<basename>.position (sidecar).
//
// 관계 해석: wikilink → obsidian metadataCache.getFirstLinkpathDest → 그 파일의
// modular-id. rename 시 obsidian 이 inbound wikilink 자동 갱신 → 관계 유지.

import { App, Menu, Platform, TAbstractFile, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';
import type { Entity, EntityId, Task, Workspace } from './types';
import {
  newComponentBody,
  newModuleBody,
  parseWikiLink,
  setOutgoingTaskLinks,
  writeModularFrontmatter,
} from './frontmatter';
import {
  entityPathFromSidecar,
  isEntityCandidate,
  isPositionSidecar,
  nameFromPath,
  newEntityPath,
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
  /** id → 현재 .md path. */
  private pathById = new Map<EntityId, string>();
  /** path → id. */
  private idByPath = new Map<string, EntityId>();
  /** id → body excerpt cache (frontmatter 제거 첫 ~400자). 비동기 채움. */
  private bodyExcerptById = new Map<EntityId, string>();
  /** PR-5: pin 된 entity ids. */
  private pinnedIds = new Set<EntityId>();
  private sideLeaf: WorkspaceLeaf | null = null;

  constructor(app: App) {
    this.app = app;
  }

  getApp(): App { return this.app; }

  start(): void {
    void this.loadAllPositions().then(() => {
      this.pendingRebuild = false;
      this.rebuild();
    });
    const vault = this.app.vault;
    const mc = this.app.metadataCache;

    const onCreate = (f: TAbstractFile) => {
      if (f instanceof TFile && isEntityCandidate(f.path)) {
        // 새로 만들어진 후보 .md — 우리 createModule 가 만든 거면 이미 id 있음.
        // vault/외부가 만든 거면 (modular-parent 등) id 부여. id 없고 modular
        // 메타도 없으면 entity 아님 → ensureId 가 판단.
        void this.maybeAdoptFile(f).then((adopted) => { if (adopted) this.requestRebuild(); });
      }
    };
    const onModify = (f: TAbstractFile) => {
      if (f instanceof TFile && isEntityCandidate(f.path)) {
        const id = this.idByPath.get(f.path);
        if (id) this.bodyExcerptById.delete(id); // body 변화 → excerpt 무효화
        this.requestRebuild();
      }
      if (isPositionSidecar(f.path)) {
        if (this.suppressNextSidecarModify.delete(f.path)) return;
        void this.loadSinglePositionByFile(f.path).then(() => this.requestRebuild());
      }
    };
    const onDelete = (f: TAbstractFile) => {
      if (f instanceof TFile && isEntityCandidate(f.path)) {
        const id = this.idByPath.get(f.path);
        if (id) {
          delete this.positions[id];
          this.bodyExcerptById.delete(id);
          this.idByPath.delete(f.path);
          this.pathById.delete(id);
        }
        this.requestRebuild();
      }
    };
    const onRename = (f: TAbstractFile, oldPath: string) => {
      if (f instanceof TFile && isEntityCandidate(f.path)) {
        const id = this.idByPath.get(oldPath);
        if (id) {
          this.idByPath.delete(oldPath);
          this.idByPath.set(f.path, id);
          this.pathById.set(id, f.path);
          // sidecar 도 따라 이동 (obsidian 은 .position 을 모름).
          void this.moveSidecar(oldPath, f.path);
        }
        this.requestRebuild();
      }
    };
    const onMcChange = (f: TFile) => {
      if (isEntityCandidate(f.path)) this.requestRebuild();
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

  // ── pin (PR-5) ───────────────────────────────────────────────────────────

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

  // ── auto-id (PR-8 / v3) ────────────────────────────────────────────────

  /**
   * 후보 .md 를 entity 로 채택. frontmatter 에 modular-id 있으면 그대로,
   * 없는데 modular-parent / modular-tasks 가 있으면 (= 사용자가 관계만
   * 적은 노트) id 자동 부여. 둘 다 없으면 entity 아님 → false.
   */
  private async maybeAdoptFile(f: TFile): Promise<boolean> {
    try {
      const body = await this.app.vault.read(f);
      const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) return false;
      const block = fm[1];
      if (/^[ \t]*modular-id:[ \t]*\S/m.test(block)) return true; // already entity
      // modular 관계 메타가 있으면 entity 의도로 보고 id 부여.
      const hasRel = /^[ \t]*modular-(parent|tasks):/m.test(block);
      if (!hasRel) return false;
      await writeModularFrontmatter(this.app, f, { 'modular-id': newId() });
      return true;
    } catch {
      return false;
    }
  }

  // ── positions ─────────────────────────────────────────────────────────

  private async loadAllPositions(): Promise<void> {
    try {
      // id ↔ path 맵을 먼저 (frontmatter modular-id 스캔).
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (!isEntityCandidate(f.path)) continue;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
        const idRaw: unknown = fm?.['modular-id'];
        if (typeof idRaw !== 'string' || !idRaw) continue;
        this.pathById.set(idRaw, f.path);
        this.idByPath.set(f.path, idRaw);
      }
      // 각 entity sidecar 로드.
      const adapter = this.app.vault.adapter;
      for (const [id, path] of this.pathById) {
        const side = positionSidecarPath(path);
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
    if (!isPositionSidecar(sidecarPath)) return;
    const entityPath = entityPathFromSidecar(sidecarPath);
    const id = this.idByPath.get(entityPath);
    if (!id) return;
    const pos = await readPositionFile(this.app.vault.adapter, sidecarPath);
    if (pos) this.positions[id] = pos;
  }

  private async writeSinglePosition(entityPath: string, pos: { x: number; y: number }): Promise<void> {
    const side = positionSidecarPath(entityPath);
    try {
      this.suppressNextSidecarModify.add(side);
      await this.app.vault.adapter.write(side, JSON.stringify(pos));
    } catch (e) {
      this.suppressNextSidecarModify.delete(side);
      console.error('[modular] writeSinglePosition failed:', e);
    }
  }

  private async moveSidecar(oldEntityPath: string, newEntityPath: string): Promise<void> {
    const oldSide = positionSidecarPath(oldEntityPath);
    const newSide = positionSidecarPath(newEntityPath);
    if (oldSide === newSide) return;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(oldSide)) {
        const body = await adapter.read(oldSide);
        await adapter.write(newSide, body);
        await adapter.remove(oldSide);
      }
    } catch (e) {
      console.error('[modular] moveSidecar failed:', e);
    }
  }

  // ── snapshot ──────────────────────────────────────────────────────────

  private rebuild(): void {
    const vault = this.app.vault;
    const mc = this.app.metadataCache;
    const entities = new Map<EntityId, Entity>();
    this.pathById.clear();
    this.idByPath.clear();

    // pass 1: 모든 entity 식별 (modular-id) + path↔id 맵.
    interface Raw { file: TFile; id: EntityId; fm: Record<string, unknown> | undefined; }
    const raws: Raw[] = [];
    for (const f of vault.getMarkdownFiles()) {
      if (!isEntityCandidate(f.path)) continue;
      const fm = mc.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
      const idRaw: unknown = fm?.['modular-id'];
      if (typeof idRaw !== 'string' || !idRaw) continue;
      this.pathById.set(idRaw, f.path);
      this.idByPath.set(f.path, idRaw);
      raws.push({ file: f, id: idRaw, fm });
    }

    // pass 2: 관계 wikilink 해석 + Entity 조립.
    const filesToReadBody: Array<{ id: EntityId; file: TFile }> = [];
    const tasksRaw: Array<{ fromId: EntityId; toId: EntityId }> = [];
    const seen = new Set<EntityId>();
    for (const { file, id, fm } of raws) {
      const parentId = this.resolveLinkToId(fm?.['modular-parent'], file.path);
      const ent: Entity = {
        id,
        path: file.path,
        name: nameFromPath(file.path),
        position: this.positions[id] ?? { x: 0, y: 0 },
        parentId,
        kind: parentId ? 'component' : 'module',
        tags: normalizeTags(fm?.['tags']),
        bodyExcerpt: this.bodyExcerptById.get(id),
        createdMs: file.stat.ctime,
        modifiedMs: file.stat.mtime,
      };
      entities.set(id, ent);
      seen.add(id);
      if (!this.bodyExcerptById.has(id)) filesToReadBody.push({ id, file });
      const tasks = fm?.['modular-tasks'];
      if (Array.isArray(tasks)) {
        for (const t of tasks) {
          const toId = this.resolveLinkToId(t, file.path);
          if (toId) tasksRaw.push({ fromId: id, toId });
        }
      }
    }

    // 캐시 정리 (삭제된 entity).
    for (const id of [...this.bodyExcerptById.keys()]) if (!seen.has(id)) this.bodyExcerptById.delete(id);

    // task dedup + 양 끝 존재 검증.
    const taskSeen = new Set<string>();
    const tasks: Task[] = [];
    for (const t of tasksRaw) {
      if (!entities.has(t.fromId) || !entities.has(t.toId)) continue;
      const key = `${t.fromId}|${t.toId}`;
      if (taskSeen.has(key)) continue;
      taskSeen.add(key);
      tasks.push(t);
    }

    this.snapshot = { entities, tasks };
    this.emit();

    // body excerpt 비동기 로드 후 한 번 더 rebuild.
    if (filesToReadBody.length > 0) {
      void Promise.all(filesToReadBody.map(async ({ id, file }) => {
        try { this.bodyExcerptById.set(id, stripFrontmatter(await vault.read(file)).slice(0, 400)); }
        catch { this.bodyExcerptById.set(id, ''); }
      })).then(() => this.rebuild());
    }
  }

  /** frontmatter wikilink 값 → 대상 entity id (해석 실패 시 null). */
  private resolveLinkToId(raw: unknown, sourcePath: string): EntityId | null {
    const linktext = parseWikiLink(raw);
    if (!linktext) return null;
    const dest = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (!dest) return null;
    return this.idByPath.get(dest.path) ?? null;
  }

  /** id → 그 entity 의 .md 를 가리키는 wikilink 텍스트 (`[[..]]`). */
  private linkForId(id: EntityId, sourcePath: string): string | null {
    const path = this.pathById.get(id);
    if (!path) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    return `[[${linktext}]]`;
  }

  // ── mutations ───────────────────────────────────────────────────────────

  async createModule(name: string, position: { x: number; y: number }): Promise<EntityId | null> {
    const path = newEntityPath(name);
    if (!path) return null;
    const id = newId();
    await this.ensureFolder(path);
    await this.app.vault.create(path, newModuleBody(id));
    this.positions[id] = position;
    this.pathById.set(id, path);
    this.idByPath.set(path, id);
    await this.writeSinglePosition(path, position);
    return id;
  }

  async createChildComponent(
    parentId: EntityId,
    name: string,
    position: { x: number; y: number },
  ): Promise<EntityId | null> {
    const path = newEntityPath(name);
    if (!path) return null;
    const parentLink = this.linkForId(parentId, path);
    if (!parentLink) return null;
    const id = newId();
    await this.ensureFolder(path);
    await this.app.vault.create(path, newComponentBody(id, parentLink));
    this.positions[id] = position;
    this.pathById.set(id, path);
    this.idByPath.set(path, id);
    await this.writeSinglePosition(path, position);
    return id;
  }

  async updateEntityPosition(id: EntityId, pos: { x: number; y: number }): Promise<void> {
    const path = this.pathById.get(id);
    if (!path) return;
    this.positions[id] = pos;
    await this.writeSinglePosition(path, pos);
    this.rebuild();
  }

  /** delete — 파일 + sidecar trash. 자식은 id 그래프 따라 cascade. */
  async deleteEntity(id: EntityId): Promise<void> {
    const toDelete = this.collectDescendants(id);
    toDelete.push(id);
    for (const eid of toDelete) {
      const path = this.pathById.get(eid);
      if (!path) continue;
      const f = this.app.vault.getAbstractFileByPath(path);
      // sidecar 먼저 정리.
      const side = positionSidecarPath(path);
      try {
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(side)) await adapter.remove(side);
      } catch { /* best-effort */ }
      delete this.positions[eid];
      this.bodyExcerptById.delete(eid);
      if (f instanceof TFile) await this.app.fileManager.trashFile(f);
    }
  }

  /** id 그래프에서 후손 ids 수집 (자기 제외). */
  private collectDescendants(rootId: EntityId): EntityId[] {
    const out: EntityId[] = [];
    const stack = [rootId];
    const entities = this.snapshot.entities;
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of entities.values()) {
        if (e.parentId === cur) { out.push(e.id); stack.push(e.id); }
      }
    }
    return out;
  }

  /** PR-6: 부모 변경 — frontmatter modular-parent wikilink 만 갱신 (파일 이동 X). */
  async moveEntity(id: EntityId, newParentId: EntityId | null): Promise<void> {
    const path = this.pathById.get(id);
    if (!path) return;
    if (newParentId !== null) {
      // 자기 후손으로의 이동 차단.
      if (this.collectDescendants(id).includes(newParentId) || newParentId === id) {
        throw new Error('cannot move an entity under its own descendant');
      }
    }
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const link = newParentId === null ? null : this.linkForId(newParentId, path);
    await writeModularFrontmatter(this.app, f, {
      'modular-parent': link === null ? undefined : link,
    });
  }

  /** rename — 파일 basename 변경 (= 이름). id 그대로, inbound wikilink 는 obsidian 자동 갱신. */
  async renameEntity(id: EntityId, newName: string): Promise<EntityId | null> {
    const path = this.pathById.get(id);
    if (!path) return null;
    const safe = sanitizeFileName(newName);
    if (!safe) return null;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const newPath = normalizePath(dir ? `${dir}/${safe}.md` : `${safe}.md`);
    if (newPath === path) return id;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return null;
    await this.app.fileManager.renameFile(f, newPath);
    // sidecar 이동은 rename 이벤트 핸들러가 처리.
    return id;
  }

  async updateModuleTags(id: EntityId, tags: string[]): Promise<void> {
    const path = this.pathById.get(id);
    if (!path) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    await writeModularFrontmatter(this.app, f, { ['tags' as never]: tags });
  }

  private currentOutgoingIds(fromId: EntityId): EntityId[] {
    return this.snapshot.tasks.filter((t) => t.fromId === fromId).map((t) => t.toId);
  }

  private linksForIds(ids: EntityId[], sourcePath: string): string[] {
    const out: string[] = [];
    for (const id of ids) {
      const link = this.linkForId(id, sourcePath);
      if (link) out.push(link);
    }
    return out;
  }

  async addComponentTask(fromId: EntityId, toId: EntityId): Promise<void> {
    if (fromId === toId) return;
    const path = this.pathById.get(fromId);
    if (!path) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const existing = this.currentOutgoingIds(fromId);
    if (existing.includes(toId)) return;
    await setOutgoingTaskLinks(this.app, f, this.linksForIds([...existing, toId], path));
  }

  async removeComponentTask(fromId: EntityId, toId: EntityId): Promise<void> {
    const path = this.pathById.get(fromId);
    if (!path) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const existing = this.currentOutgoingIds(fromId);
    const next = existing.filter((p) => p !== toId);
    if (next.length === existing.length) return;
    await setOutgoingTaskLinks(this.app, f, this.linksForIds(next, path));
  }

  // ── side-leaf navigation ──────────────────────────────────────────────

  async openInSideLeaf(id: EntityId): Promise<void> {
    const f = this.entityFile(id);
    if (!f) return;
    const ws = this.app.workspace;
    if (Platform.isMobile) {
      await ws.getLeaf('tab').openFile(f);
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
    const f = this.entityFile(id);
    if (!f) return;
    const leaf = Platform.isMobile
      ? this.app.workspace.getLeaf('tab')
      : this.app.workspace.getLeaf('split', 'vertical');
    await leaf.openFile(f);
  }

  /** PR-10: 본문 편집 modal 이 다룰 TFile. */
  entityFile(id: EntityId): TFile | null {
    const path = this.pathById.get(id);
    if (!path) return null;
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  // ── context menu ──────────────────────────────────────────────────────

  openContextMenu(
    id: EntityId,
    event: MouseEvent,
    callbacks: {
      onAddChild?: (parentId: EntityId) => void;
      onRename?: (id: EntityId) => void;
      onDelete?: (id: EntityId) => void;
      onEditBody?: (id: EntityId) => void;
    },
  ): void {
    const menu = new Menu();
    if (callbacks.onEditBody) {
      menu.addItem((item) => item.setTitle('본문 편집').setIcon('edit-3')
        .onClick(() => callbacks.onEditBody!(id)));
    }
    if (callbacks.onAddChild) {
      menu.addItem((item) => item.setTitle('자식 추가').setIcon('plus')
        .onClick(() => callbacks.onAddChild!(id)));
    }
    if (callbacks.onRename) {
      menu.addItem((item) => item.setTitle('이름 변경').setIcon('pencil')
        .onClick(() => callbacks.onRename!(id)));
    }
    menu.addItem((item) => item
      .setTitle(this.isPinned(id) ? '핀 해제' : '핀 고정').setIcon('pin')
      .onClick(() => this.togglePin(id)));
    menu.addSeparator();
    if (callbacks.onDelete) {
      menu.addItem((item) => item.setTitle('삭제 (자식 포함)').setIcon('trash')
        .onClick(() => callbacks.onDelete!(id)));
    }
    menu.showAtMouseEvent(event);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async ensureFolder(filePath: string): Promise<void> {
    const dir = filePath.slice(0, filePath.lastIndexOf('/'));
    if (!dir) return;
    if (!this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => { /* exists race */ });
    }
  }
}

async function readPositionFile(
  adapter: { read: (p: string) => Promise<string> },
  path: string,
): Promise<{ x: number; y: number } | null> {
  try {
    const parsed: unknown = JSON.parse(await adapter.read(path));
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

function stripFrontmatter(body: string): string {
  const m = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? body.slice(m[0].length) : body;
}

function normalizeTags(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return (raw as unknown[]).map(String);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return undefined;
}
