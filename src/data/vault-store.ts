// VaultStore — 폴더 nesting + .positions.json.
// type / parent 는 path 의 폴더 구조가 결정 (frontmatter 무관).

import { App, Menu, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';
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
  LEGACY_POSITIONS_PATH,
  isModularPath,
  entityInfo,
  newModulePaths,
  newChildComponentPaths,
  promotedLeafPaths,
  positionSidecarPath,
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
  // entity path → position. source 는 entity 별 .position dotfile.
  // 캐시 in-memory; drag stop 마다 *그 entity 의 sidecar 만* write.
  private positions: PositionsMap = {};
  private positionsLoaded = false;
  // 우측 split leaf 재사용 — 클릭마다 같은 leaf 의 파일이 바뀌도록.
  // detach 됐는지는 매번 getLeavesOfType 으로 검증.
  private sideLeaf: WorkspaceLeaf | null = null;

  constructor(app: App) {
    this.app = app;
  }

  start(): void {
    void this.loadAllPositions().then(() => this.rebuild());
    const vault = this.app.vault;
    const mc = this.app.metadataCache;
    const onCreate = (f: any) => { if (f instanceof TFile && isModularPath(f.path)) this.rebuild(); };
    const onModify = (f: any) => {
      if (f instanceof TFile && isModularPath(f.path)) this.rebuild();
      // 외부에서 .position 파일이 직접 수정되면 그 entity 만 reload.
      if (f && typeof f.path === 'string' && /\.position$/.test(f.path) && f.path.startsWith(`${MODULAR_FOLDER}/`)) {
        void this.loadSinglePositionByFile(f.path).then(() => this.rebuild());
      }
    };
    const onDelete = (f: any) => {
      const p = typeof f?.path === 'string' ? f.path : '';
      if (isModularPath(p)) {
        if (this.positions[p]) {
          delete this.positions[p];
          // entity 의 .md 가 사라지면 sidecar 도 같이 정리.
          void this.deleteSidecarForEntity(p);
        }
        this.rebuild();
      }
    };
    const onRename = (f: any, oldPath: any) => {
      // 폴더 rename 도 자식별 emit 됨. path 만 보고 처리.
      const newPath = typeof f?.path === 'string' ? f.path : '';
      const newOk = newPath && isModularPath(newPath);
      const oldOk = typeof oldPath === 'string' && isModularPath(oldPath);
      if (oldOk && typeof oldPath === 'string' && this.positions[oldPath]) {
        const pos = this.positions[oldPath];
        delete this.positions[oldPath];
        if (newOk) this.positions[newPath] = pos;
        // 새 path 의 sidecar 에 한 번 write — 폴더 rename 이면 .position 도 같이 따라왔지만
        // leaf rename 인 경우 sibling 의 .<basename>.position 도 같이 옮겨야 한다.
        if (newOk) void this.writeSinglePosition(newPath, pos);
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
  //
  // 각 entity 의 좌표는 *그 entity 의 sidecar dotfile* 에 저장.
  // 다른 entity 의 drag 가 같은 파일을 건드리지 않으므로 sync conflict 빈도가
  // 단일 .positions.json 보다 훨씬 낮다.

  /** 첫 부팅 시 호출. 모든 entity 의 sidecar 를 읽어 메모리 캐시 구성.
   *  옛 .positions.json 이 있으면 한 번 분배 후 삭제 (마이그레이션). */
  private async loadAllPositions(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      // 1. 마이그레이션: 옛 단일 파일 → 각 entity 의 sidecar 로 분배.
      if (await adapter.exists(LEGACY_POSITIONS_PATH)) {
        try {
          const raw = await adapter.read(LEGACY_POSITIONS_PATH);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const [path, v] of Object.entries(parsed)) {
              const obj = v as any;
              if (obj && typeof obj.x === 'number' && typeof obj.y === 'number') {
                this.positions[path] = { x: obj.x, y: obj.y };
                // 본체 md 가 존재할 때만 sidecar write — orphan 만들지 않음.
                if (await adapter.exists(path)) {
                  await this.writeSinglePosition(path, { x: obj.x, y: obj.y });
                }
              }
            }
          }
          await adapter.remove(LEGACY_POSITIONS_PATH);
          console.log('[modular] migrated .positions.json → per-entity .position sidecars');
        } catch (e) {
          console.error('[modular] migration failed:', e);
        }
      }
      // 2. 정상 로드: 모든 modular 영역의 md 를 walk 해서 각자 sidecar read.
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (!isModularPath(f.path)) continue;
        await this.loadSinglePositionByEntity(f.path);
      }
    } catch (e) {
      console.error('[modular] loadAllPositions failed:', e);
    } finally {
      this.positionsLoaded = true;
    }
  }

  /** entity path 의 sidecar 한 개만 read → 캐시 갱신. */
  private async loadSinglePositionByEntity(entityPath: string): Promise<void> {
    const info = entityInfo(entityPath);
    if (!info) return;
    const side = positionSidecarPath(info, entityPath);
    await this.loadSinglePositionByFile(side, entityPath);
  }

  /** sidecar 파일 경로로 직접 read. entityPath 는 옵션 — 모르면 sidecar 에서 역추론 어렵지만
   *  외부 modify 이벤트의 경우 sidecar 가 path → 그 entity path 를 우리가 알아야 update.
   *  단순화: sidecar 의 위치만 보고 entity path 추정. */
  private async loadSinglePositionByFile(sidecarPath: string, entityPathHint?: string): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(sidecarPath))) return;
      const raw = await adapter.read(sidecarPath);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const x = Number(parsed.x);
      const y = Number(parsed.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const entityPath = entityPathHint ?? this.entityPathFromSidecar(sidecarPath);
      if (!entityPath) return;
      this.positions[entityPath] = { x, y };
    } catch (e) {
      console.error('[modular] loadSinglePosition failed:', e);
    }
  }

  /** sidecar 경로 → 그 entity 의 md path 역추론.
   *  - `<folder>/.position`        → `<folder>/<basename(folder)>.md` (expanded)
   *  - `<dir>/.<base>.position`    → `<dir>/<base>.md` (leaf) */
  private entityPathFromSidecar(sidecarPath: string): string | null {
    if (!sidecarPath.endsWith('.position')) return null;
    const slashIdx = sidecarPath.lastIndexOf('/');
    if (slashIdx < 0) return null;
    const dir = sidecarPath.slice(0, slashIdx);
    const file = sidecarPath.slice(slashIdx + 1);
    if (file === '.position') {
      // expanded: <dir>/<basename(dir)>.md
      const dirSlash = dir.lastIndexOf('/');
      const folderName = dir.slice(dirSlash + 1);
      return `${dir}/${folderName}.md`;
    }
    // leaf: .<base>.position
    if (file.startsWith('.') && file.endsWith('.position')) {
      const base = file.slice(1, -('.position'.length));
      return `${dir}/${base}.md`;
    }
    return null;
  }

  /** 한 entity 의 sidecar 만 write — drag stop 마다 호출. */
  private async writeSinglePosition(entityPath: string, pos: { x: number; y: number }): Promise<void> {
    const info = entityInfo(entityPath);
    if (!info) return;
    const side = positionSidecarPath(info, entityPath);
    try {
      // expanded 면 폴더가 이미 있음. leaf 면 sibling 폴더 (= parent 폴더) 이미 있음.
      await this.app.vault.adapter.write(side, JSON.stringify(pos));
    } catch (e) {
      console.error('[modular] writeSinglePosition failed:', e);
    }
  }

  /** entity 삭제 시 sidecar 도 같이 삭제 — expanded 는 폴더 통째 삭제로 자동 따라옴,
   *  leaf 는 sibling 이라 명시 삭제 필요. */
  private async deleteSidecarForEntity(entityPath: string): Promise<void> {
    const info = entityInfo(entityPath);
    if (!info) {
      // info 가 nil 인 경우 (이미 entity 가 사라진 후 호출 등) — leaf sidecar 만 추정 시도.
      const slashIdx = entityPath.lastIndexOf('/');
      if (slashIdx < 0) return;
      const dir = entityPath.slice(0, slashIdx);
      const base = entityPath.slice(slashIdx + 1).replace(/\.md$/, '');
      const guess = `${dir}/.${base}.position`;
      try {
        const adapter = this.app.vault.adapter;
        if (await adapter.exists(guess)) await adapter.remove(guess);
      } catch {}
      return;
    }
    if (info.expanded) return; // 폴더 통째 삭제로 자동
    const side = positionSidecarPath(info, entityPath);
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(side)) await adapter.remove(side);
    } catch (e) {
      console.error('[modular] deleteSidecar failed:', e);
    }
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

    // stale positions 정리 — entity 가 사라진 경우 캐시만 정리.
    // sidecar 파일은 entity delete 이벤트에서 deleteSidecarForEntity 가 처리.
    for (const k of Object.keys(this.positions)) {
      if (!allEntityPaths.has(k)) delete this.positions[k];
    }

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
    await this.writeSinglePosition(paths.md, position);
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
    await this.writeSinglePosition(paths.md, position);
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
        const pos = this.positions[leafPath];
        this.positions[promoted.md] = pos;
        delete this.positions[leafPath];
        // 옛 leaf sidecar 삭제 + 새 expanded sidecar 작성
        try {
          const oldSidecar = `${leafPath.slice(0, leafPath.lastIndexOf('/'))}/.${basenameFromPath(leafPath)}.position`;
          const adapter = this.app.vault.adapter;
          if (await adapter.exists(oldSidecar)) await adapter.remove(oldSidecar);
        } catch {}
        await this.writeSinglePosition(promoted.md, pos);
      }
    }
    return promoted.folder;
  }

  async updateEntityPosition(path: string, pos: { x: number; y: number }): Promise<void> {
    this.positions[path] = pos;
    await this.writeSinglePosition(path, pos);
    this.rebuild();
  }

  async updateModuleTags(path: string, tags: string[]): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    await writeModularFrontmatter(this.app, f, { 'modular-tags': tags });
  }

  /** delete — expanded 면 폴더 통째 (자식들 다 사라짐), leaf 면 md + sibling sidecar. */
  async deleteEntity(path: string): Promise<void> {
    const info = entityInfo(path);
    if (!info) return;
    if (info.expanded) {
      const folder = this.app.vault.getAbstractFileByPath(info.folderPath);
      if (folder instanceof TFolder) {
        // 안의 모든 positions 캐시 정리 — sidecar 파일들은 폴더 통째 삭제로 자동 따라옴.
        const prefix = `${info.folderPath}/`;
        for (const k of Object.keys(this.positions)) {
          if (k === path || k.startsWith(prefix)) delete this.positions[k];
        }
        await this.app.vault.delete(folder, true);
        return;
      }
    }
    // leaf — sibling sidecar 도 명시 삭제 (rename 이벤트가 사이드카 안 따라가게).
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    delete this.positions[path];
    await this.deleteSidecarForEntity(path);
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

    // leaf — md rename + sidecar (.<base>.position) 도 같이 rename
    const f = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(f instanceof TFile)) return null;
    const parentDir = oldPath.split('/').slice(0, -1).join('/');
    const newPath = normalizePath(`${parentDir}/${safe}.md`);
    await this.app.fileManager.renameFile(f, newPath);
    // sibling sidecar rename
    try {
      const oldSidecar = `${parentDir}/.${oldBase}.position`;
      const newSidecar = `${parentDir}/.${safe}.position`;
      const sf = this.app.vault.getAbstractFileByPath(oldSidecar);
      if (sf instanceof TFile) {
        await this.app.fileManager.renameFile(sf, normalizePath(newSidecar));
      }
    } catch {}
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

  /** 마지막에 쓴 sideLeaf 가 살아 있으면 파일만 교체. 죽었으면 새 split.
   *  - pinned: 외부 (explorer, link click, quick switcher) navigation 이 이 leaf 를 target 으로 잡지 않음.
   *    modular sideLeaf 가 vault 전체의 file open 잡이가 되는 부작용 방지.
   *  - active: false: focus 가 sideLeaf 로 안 옮김. canvas 가 active 유지되어
   *    Tab/Delete/Esc 같은 단축이 그대로 작동. */
  async openInSideLeaf(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const ws = this.app.workspace;
    let leaf = this.sideLeaf;
    const alive = leaf
      ? ws.getLeavesOfType('markdown').includes(leaf)
        || ws.getLeavesOfType('empty').includes(leaf)
      : false;
    if (!leaf || !alive) {
      leaf = ws.getLeaf('split', 'vertical');
      leaf.setPinned(true);
      this.sideLeaf = leaf;
    }
    await leaf.openFile(f, { active: false });
  }

  /** ⌘+Enter — 항상 새 split. side leaf 재사용 안 함. */
  async openInNewSplit(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf('split', 'vertical');
    await leaf.openFile(f);
  }

  /** 우클릭 메뉴. callback 으로 plugin 측 동작 받음. */
  showNodeMenu(
    event: MouseEvent,
    path: string,
    callbacks: {
      onRename?: (path: string) => void;
      onAddChild?: (path: string) => void;
      onDelete?: (path: string) => void;
    },
  ): void {
    const info = entityInfo(path);
    if (!info) return;
    const menu = new Menu();

    menu.addItem((item) => item
      .setTitle('파일 열기 (side)')
      .setIcon('file-text')
      .onClick(() => { void this.openInSideLeaf(path); }));

    menu.addItem((item) => item
      .setTitle('새 split 에서 열기')
      .setIcon('panel-right')
      .onClick(() => { void this.openInNewSplit(path); }));

    menu.addSeparator();

    if (callbacks.onAddChild) {
      menu.addItem((item) => item
        .setTitle('자식 컴포넌트 추가')
        .setIcon('plus')
        .onClick(() => callbacks.onAddChild!(path)));
    }
    if (callbacks.onRename) {
      menu.addItem((item) => item
        .setTitle('이름 변경')
        .setIcon('pencil')
        .onClick(() => callbacks.onRename!(path)));
    }

    menu.addSeparator();

    if (callbacks.onDelete) {
      menu.addItem((item) => item
        .setTitle(info.expanded ? '삭제 (폴더 통째)' : '삭제')
        .setIcon('trash')
        .onClick(() => callbacks.onDelete!(path)));
    }

    menu.showAtMouseEvent(event);
  }
}
