// 데이터 모델 — *파일 경로 = id*. type/parent 는 path 의 폴더 구조가 결정.

export type EntityPath = string;

export interface Module {
  path: EntityPath;
  name: string;
  position: { x: number; y: number };
  tags: string[];
}

export interface Component {
  path: EntityPath;
  name: string;
  /** 부모 entity (module 또는 다른 component) 의 path */
  parentPath: EntityPath;
  position: { x: number; y: number };
}

export interface ComponentTask {
  id: string;
  fromPath: EntityPath;
  toPath: EntityPath;
  label?: string;
}

export interface Workspace {
  modules: Module[];
  components: Component[];
  componentTasks: ComponentTask[];
}

/** frontmatter 에 남는 의미 있는 메타. */
export interface ModularFrontmatter {
  'modular-tags'?: string[];
  'modular-tasks'?: string[];
}
