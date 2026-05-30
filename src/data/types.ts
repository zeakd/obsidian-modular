// 데이터 모델 — v2 (conventions E, 2026-05).
//
// Source of truth: frontmatter `modular-id` (ULID). path 는 표현일 뿐.
// 모든 entity 는 자기 폴더 + `_index.md` 본체. leaf ↔ expanded 구분 없음.

export type EntityId = string;
export type EntityPath = string;

export interface Entity {
  /** 영속적 식별자. frontmatter `modular-id`. rename / move 에 불변. */
  id: EntityId;
  /** _index.md 의 현재 vault path (표현용). */
  path: EntityPath;
  /** entity 의 폴더 경로 (path = folderPath/_index.md). */
  folderPath: EntityPath;
  /** 폴더 이름 (사용자에게 표시되는 이름). */
  name: string;
  position: { x: number; y: number };
  /** module = 부모 없음, component = 부모 id. */
  parentId: EntityId | null;
  kind: 'module' | 'component';
  /** module 만 사용 (v1 호환). */
  tags?: string[];
  /**
   * markdown body 의 첫 부분 (frontmatter 제거 후 ~400자). 노드에 표시할
   * 미리보기. 빈 entity 면 빈 문자열. async 로 채워지고 못 읽었으면 undefined.
   */
  bodyExcerpt?: string;
  /** _index.md ctime (ms since epoch). entity가 처음 만들어진 시점. */
  createdMs?: number;
  /** _index.md mtime (ms since epoch). 마지막 본문/frontmatter 변경. */
  modifiedMs?: number;
}

export interface Task {
  fromId: EntityId;
  toId: EntityId;
}

export interface Workspace {
  /** id → entity. UI/rendering 은 모두 id 로 reference. */
  entities: Map<EntityId, Entity>;
  tasks: Task[];
}

/** frontmatter 에 남는 의미 있는 메타. */
export interface ModularFrontmatter {
  'modular-id'?: string;
  'modular-parent'?: string | null;
  'modular-tags'?: string[];
  'modular-tasks'?: string[];
}

// ── compat shims for UI code that still expects flat module/component lists ──
// Phased migration helper — Canvas can switch over without a single-commit
// rewrite of every consumer.

export function selectModules(ws: Workspace): Entity[] {
  return [...ws.entities.values()].filter((e) => e.kind === 'module');
}

export function selectComponents(ws: Workspace): Entity[] {
  return [...ws.entities.values()].filter((e) => e.kind === 'component');
}
