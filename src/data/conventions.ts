// 파일 컨벤션 — 재귀 nesting.
// 모든 entity = 폴더 + 동명 md (expanded). 단 사용자가 만든 단독 md (leaf) 도 인식.
//
// 규약:
//   modular/X/X.md          → expanded module
//   modular/X/Y.md  (Y!=X)  → leaf component (parent = modular/X/X.md)
//   modular/X/Y/Y.md        → expanded component (parent = modular/X/X.md)
//   modular/X/Y/Z/Z.md      → expanded component (parent = modular/X/Y/Y.md)
//   modular/X/Y/Z.md (Z!=Y) → leaf component (parent = modular/X/Y/Y.md)
//   modular/A.md            → 무시 (modular 직속 단독 md)
//   modular/.../.ai/...     → 무시 (AI 영역)

export const MODULAR_FOLDER = 'modular';
/** 옛 단일 파일. 첫 부팅 시 entity 별 dotfile 로 분배 후 삭제. */
export const LEGACY_POSITIONS_PATH = 'modular/.positions.json';
export const AI_FOLDER = '.ai';

export function isModularPath(path: string): boolean {
  if (!path.startsWith(`${MODULAR_FOLDER}/`)) return false;
  if (!path.endsWith('.md')) return false;
  if (path.includes(`/${AI_FOLDER}/`)) return false;
  return true;
}

export function basenameFromPath(path: string): string {
  const last = path.split('/').pop() ?? path;
  return last.replace(/\.md$/i, '');
}

export function sanitizeFileName(raw: string): string | null {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/** entity 의 본체 md 인지 + 부모/expanded 여부 추론. */
export interface EntityInfo {
  kind: 'module' | 'component';
  /** parent entity 의 본체 md path. module 이면 null. */
  parentEntityPath: string | null;
  /** 폴더가 있어 자식을 가질 수 있는지. (true = expanded, false = leaf) */
  expanded: boolean;
  /** entity 의 폴더 path. expanded 면 그 폴더, leaf 면 부모 폴더. */
  folderPath: string;
}

export function entityInfo(path: string): EntityInfo | null {
  if (!isModularPath(path)) return null;
  const inside = path.slice(`${MODULAR_FOLDER}/`.length, -3); // X/X 또는 X/Y/Z
  const parts = inside.split('/');
  if (parts.length < 2) return null;

  const last = parts[parts.length - 1];
  const parentSeg = parts[parts.length - 2];
  const isExpanded = last === parentSeg;

  if (isExpanded) {
    // modular/.../X/X.md
    if (parts.length === 2) {
      // modular/X/X.md → module
      return {
        kind: 'module',
        parentEntityPath: null,
        expanded: true,
        folderPath: `${MODULAR_FOLDER}/${parts[0]}`,
      };
    }
    // modular/<...>/X/X.md → component
    const parentFolderName = parts[parts.length - 3];
    const parentFolderPath = `${MODULAR_FOLDER}/${parts.slice(0, -2).join('/')}`;
    return {
      kind: 'component',
      parentEntityPath: `${parentFolderPath}/${parentFolderName}.md`,
      expanded: true,
      folderPath: `${MODULAR_FOLDER}/${parts.slice(0, -1).join('/')}`,
    };
  }

  // leaf: modular/<...>/M/C.md where C != M
  const parentFolderName = parts[parts.length - 2];
  const parentFolderPath = `${MODULAR_FOLDER}/${parts.slice(0, -1).join('/')}`;
  return {
    kind: 'component',
    parentEntityPath: `${parentFolderPath}/${parentFolderName}.md`,
    expanded: false,
    folderPath: parentFolderPath,
  };
}

/** 새 module 의 path 와 폴더 path 생성. */
export function newModulePaths(name: string): { folder: string; md: string } | null {
  const safe = sanitizeFileName(name);
  if (!safe) return null;
  const folder = `${MODULAR_FOLDER}/${safe}`;
  return { folder, md: `${folder}/${safe}.md` };
}

/** parent expanded 폴더 안에 새 자식 component 의 path 생성. expanded 형태로. */
export function newChildComponentPaths(parentFolderPath: string, name: string): { folder: string; md: string } | null {
  const safe = sanitizeFileName(name);
  if (!safe) return null;
  const folder = `${parentFolderPath}/${safe}`;
  return { folder, md: `${folder}/${safe}.md` };
}

/** entity 의 좌표 sidecar dotfile 경로.
 *  - expanded entity 는 폴더 안의 `.position` (folder-scoped dotfile)
 *  - leaf entity 는 sibling 의 `.<basename>.position`
 *  둘 다 dotfile 이라 Obsidian explorer 의 기본 표시에서 hidden. */
export function positionSidecarPath(info: EntityInfo, entityPath: string): string {
  if (info.expanded) {
    return `${info.folderPath}/.position`;
  }
  const slashIdx = entityPath.lastIndexOf('/');
  const dir = entityPath.slice(0, slashIdx);
  const base = entityPath.slice(slashIdx + 1).replace(/\.md$/, '');
  return `${dir}/.${base}.position`;
}

/** leaf entity 가 expanded 로 promote 될 때의 새 path. */
export function promotedLeafPaths(leafPath: string): { folder: string; md: string } | null {
  const info = entityInfo(leafPath);
  if (!info || info.expanded) return null;
  const base = basenameFromPath(leafPath);
  const parentDir = leafPath.slice(0, -(`${base}.md`.length + 0)); // includes trailing slash? compute differently
  // leafPath = parentDir/X.md → parentDir = leafPath without "X.md"
  const slashIdx = leafPath.lastIndexOf('/');
  const parentDirClean = leafPath.slice(0, slashIdx);
  const folder = `${parentDirClean}/${base}`;
  const md = `${folder}/${base}.md`;
  return { folder, md };
}
