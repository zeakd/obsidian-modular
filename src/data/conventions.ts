// 파일 컨벤션 — v3 (folder-agnostic, 2026).
//
// entity = frontmatter `modular-id` 를 가진 *아무* markdown 파일.
// 폴더 위치/구조 완전 무관. 이름 = 파일 basename.
//
// 관계는 frontmatter 의 네이티브 wikilink 로:
//   modular-parent: "[[Payments]]"      → 부모 (없으면 module, 있으면 component)
//   modular-tasks: ["[[Paywall]]", ...]  → task 의존 edge
//   tags: [...]                          → 네이티브 태그 (modular 전용 아님)
//
// modular 고유 저장은 두 가지뿐:
//   - modular-id (frontmatter): 안정 anchor — 동명 노트 구분 + sync 견고성
//   - <dir>/.<basename>.position (sidecar): 캔버스 좌표 (git/sync 깨끗하게 분리)
//
// 새 entity 는 기본적으로 modular/ 루트에 평평하게 생성하되, 기존 entity 는
// vault 어디 있든 인식.

export const MODULAR_FOLDER = 'modular';   // 새 entity 기본 생성 위치
export const AI_FOLDER = '.ai';            // 무시 영역
export const POSITION_SUFFIX = '.position';

/** markdown 파일이고 AI 영역이 아닌가 (entity 후보). 실제 entity 여부는
 *  frontmatter modular-id 유무로 vault-store 가 판정. */
export function isEntityCandidate(path: string): boolean {
  if (!path.endsWith('.md')) return false;
  if (path.includes(`/${AI_FOLDER}/`) || path.startsWith(`${AI_FOLDER}/`)) return false;
  return true;
}

/** 파일 path → 표시 이름 (basename, 확장자 제외). */
export function nameFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

/** 파일 path → 좌표 sidecar path (`<dir>/.<basename>.position`). */
export function positionSidecarPath(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const dir = slash < 0 ? '' : filePath.slice(0, slash);
  const base = (slash < 0 ? filePath : filePath.slice(slash + 1)).replace(/\.md$/i, '');
  return dir ? `${dir}/.${base}${POSITION_SUFFIX}` : `.${base}${POSITION_SUFFIX}`;
}

/** 좌표 sidecar path 인가. */
export function isPositionSidecar(path: string): boolean {
  if (path.includes(`/${AI_FOLDER}/`)) return false;
  const base = path.split('/').pop() ?? path;
  return base.startsWith('.') && base.endsWith(POSITION_SUFFIX);
}

/** sidecar path → 그 entity 의 .md path 역추론. */
export function entityPathFromSidecar(sidecarPath: string): string {
  const slash = sidecarPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : sidecarPath.slice(0, slash);
  const base = (slash < 0 ? sidecarPath : sidecarPath.slice(slash + 1))
    .replace(/^\./, '')
    .replace(new RegExp(`${POSITION_SUFFIX}$`), '');
  return dir ? `${dir}/${base}.md` : `${base}.md`;
}

export function sanitizeFileName(raw: string): string | null {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

/** 새 entity 의 .md path (기본 modular/ 루트, 평평). */
export function newEntityPath(name: string): string | null {
  const safe = sanitizeFileName(name);
  if (!safe) return null;
  return `${MODULAR_FOLDER}/${safe}.md`;
}
