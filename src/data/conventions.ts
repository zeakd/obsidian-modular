// 파일 컨벤션 — v2 (conventions E, 2026-05).
//
// 모든 entity = 폴더 + `_index.md` (본체). leaf ↔ expanded 구분 폐지.
// 본체 식별은 path 패턴이 아니라 frontmatter 의 `modular-id` (id.ts).
//
// 폴더 nesting 은 hierarchy 표시 + 사용자 직관을 위한 보조 표현일 뿐.
// 실제 parent-child 관계는 frontmatter `modular-parent` 가 source of truth.
// (마이그 단계에서 폴더 nesting 과 parent id 가 일치하도록 보장.)
//
// 규약:
//   modular/X/_index.md           → entity (X 라는 이름의 entity 본체)
//   modular/X/Y/_index.md         → entity (X 폴더 안에 nested 된 자식 entity)
//   modular/X/Y/.position         → 위치 sidecar
//   modular/A.md, modular/A/B.md  → 무시 (entity 아님)
//   modular/.../.ai/...           → 무시 (AI 영역)
//   modular/.migration-v2         → 마이그 완료 마커
//   modular/.../.position         → entity 위치 sidecar (모든 entity 단일 패턴)

export const MODULAR_FOLDER = 'modular';
export const AI_FOLDER = '.ai';
export const INDEX_FILE = '_index.md';
export const POSITION_FILE = '.position';
export const MIGRATION_MARKER = 'modular/.migration-v2';

/** 본체 _index.md 인지 (modular 영역 + AI 제외). */
export function isEntityIndexPath(path: string): boolean {
  if (!path.startsWith(`${MODULAR_FOLDER}/`)) return false;
  if (path.includes(`/${AI_FOLDER}/`)) return false;
  return path.endsWith(`/${INDEX_FILE}`);
}

/** 좌표 sidecar 인지. */
export function isPositionSidecarPath(path: string): boolean {
  if (!path.startsWith(`${MODULAR_FOLDER}/`)) return false;
  if (path.includes(`/${AI_FOLDER}/`)) return false;
  return path.endsWith(`/${POSITION_FILE}`);
}

/** entity index path → 그 entity 의 폴더 path. */
export function folderPathFromIndex(indexPath: string): string {
  return indexPath.slice(0, -`/${INDEX_FILE}`.length);
}

/** folder path → 그 안의 _index.md path. */
export function indexPathFromFolder(folderPath: string): string {
  return `${folderPath}/${INDEX_FILE}`;
}

/** folder path → 그 안의 .position path. */
export function positionSidecarPath(folderPath: string): string {
  return `${folderPath}/${POSITION_FILE}`;
}

/** position sidecar path → 그 entity 의 폴더 path. */
export function folderPathFromSidecar(sidecarPath: string): string {
  return sidecarPath.slice(0, -`/${POSITION_FILE}`.length);
}

/** 폴더 path → 표시 이름 (마지막 segment). */
export function nameFromFolderPath(folderPath: string): string {
  const i = folderPath.lastIndexOf('/');
  return i < 0 ? folderPath : folderPath.slice(i + 1);
}

/** 폴더 path → 부모 폴더 path. modular/X 는 modular (root 위라 entity 없음). */
export function parentFolderPath(folderPath: string): string {
  const i = folderPath.lastIndexOf('/');
  return i < 0 ? '' : folderPath.slice(0, i);
}

/** 부모 폴더 path 가 modular 루트면 그 entity 는 module. 아니면 component. */
export function kindFromFolderPath(folderPath: string): 'module' | 'component' {
  return parentFolderPath(folderPath) === MODULAR_FOLDER ? 'module' : 'component';
}

export function sanitizeFileName(raw: string): string | null {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/** 새 module 의 폴더 + index path. */
export function newModulePaths(name: string): { folder: string; index: string } | null {
  const safe = sanitizeFileName(name);
  if (!safe) return null;
  const folder = `${MODULAR_FOLDER}/${safe}`;
  return { folder, index: indexPathFromFolder(folder) };
}

/** 자식 entity 의 폴더 + index path (parent folder 안에). */
export function newChildEntityPaths(parentFolderPath: string, name: string): { folder: string; index: string } | null {
  const safe = sanitizeFileName(name);
  if (!safe) return null;
  const folder = `${parentFolderPath}/${safe}`;
  return { folder, index: indexPathFromFolder(folder) };
}
