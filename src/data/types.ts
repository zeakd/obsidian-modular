// 데이터 모델 — v3 (folder-agnostic, 2026).
//
// entity = frontmatter `modular-id` 를 가진 markdown 파일. 폴더 무관.
// 이름 = 파일 basename. 관계 = 네이티브 wikilink (vault-store 가 id 로 해석).

export type EntityId = string;
export type EntityPath = string;

export interface Entity {
  /** 영속적 식별자. frontmatter `modular-id`. rename / move 에 불변. */
  id: EntityId;
  /** entity 의 .md 파일 path (표현/현재 위치). */
  path: EntityPath;
  /** 파일 basename (확장자 제외) = 표시 이름. */
  name: string;
  position: { x: number; y: number };
  /** module = 부모 없음, component = 부모 id. */
  parentId: EntityId | null;
  kind: 'module' | 'component';
  /** 네이티브 tags frontmatter. */
  tags?: string[];
  /** markdown body 의 첫 ~400자 (frontmatter 제외). 노드 미리보기. */
  bodyExcerpt?: string;
  /** 파일 ctime (ms). */
  createdMs?: number;
  /** 파일 mtime (ms). */
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

/** frontmatter 에 남는 modular 고유 메타. (tags 는 네이티브라 여기 없음) */
export interface ModularFrontmatter {
  'modular-id'?: string;
  'modular-parent'?: string | null;
  'modular-tasks'?: string[];
}
