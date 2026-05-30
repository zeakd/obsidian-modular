// frontmatter ↔ entity 변환. v2 (conventions E).
// id / parent / tasks 가 모두 frontmatter source-of-truth.

import type { App, FrontMatterCache, TFile } from 'obsidian';
import type { Entity, EntityId, ModularFrontmatter } from './types';
import {
  folderPathFromIndex,
  kindFromFolderPath,
  nameFromFolderPath,
} from './conventions';

/** _index.md frontmatter → Entity (position 은 별도 sidecar 에서). */
export function entityFromIndex(
  indexPath: string,
  fm: FrontMatterCache | undefined,
  posFallback?: { x: number; y: number },
): Entity | null {
  const folderPath = folderPathFromIndex(indexPath);
  const id: unknown = fm?.['modular-id'];
  if (typeof id !== 'string' || id.length === 0) return null;

  const kind = kindFromFolderPath(folderPath);
  const parentRaw: unknown = fm?.['modular-parent'];
  const parentId = typeof parentRaw === 'string' && parentRaw.length > 0 ? parentRaw : null;
  // module 은 parent 없어야 — 어긋나면 kind 우선 (frontmatter 오염 방어).
  const finalParent = kind === 'module' ? null : parentId;

  const tagsRaw: unknown = fm?.['modular-tags'];
  const tags = Array.isArray(tagsRaw) ? (tagsRaw as unknown[]).map(String) : undefined;

  return {
    id,
    path: indexPath,
    folderPath,
    name: nameFromFolderPath(folderPath),
    position: posFallback ?? { x: 0, y: 0 },
    parentId: finalParent,
    kind,
    tags: kind === 'module' ? (tags ?? []) : undefined,
  };
}

/** 새 module 의 _index.md body. */
export function newModuleIndexBody(id: EntityId): string {
  return [
    '---',
    `modular-id: ${id}`,
    'modular-tags: []',
    '---',
    '',
    '',
  ].join('\n');
}

/** 새 component 의 _index.md body. */
export function newComponentIndexBody(id: EntityId, parentId: EntityId): string {
  return [
    '---',
    `modular-id: ${id}`,
    `modular-parent: ${parentId}`,
    'modular-tasks: []',
    '---',
    '',
    '',
  ].join('\n');
}

/** entity 의 frontmatter 패치 (in-place via app.fileManager.processFrontMatter). */
export async function writeModularFrontmatter(
  app: App,
  file: TFile,
  patch: Partial<ModularFrontmatter>,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete fm[k];
      else fm[k] = v;
    }
  });
}

/**
 * PR-9: tasks 를 wiki link 형식으로 frontmatter 에 저장.
 *   modular-tasks:
 *     - "[[modular/payments/_index|payments]]"
 * Obsidian graph view / backlinks 가 자동으로 인식. 단 rename 시 obsidian 이
 * link path 갱신해줌. id 기반 ref 도 함께 유지 — store 가 rebuild 시 둘 다
 * 인식 (legacy id 배열 그대로도 backward compatible).
 */
export async function setOutgoingTasks(
  app: App,
  file: TFile,
  refs: Array<{ id: EntityId; folderPath: string; name: string }>,
): Promise<void> {
  const links = refs.map((r) => `[[${r.folderPath}/_index|${r.name}]]`);
  await writeModularFrontmatter(app, file, { 'modular-tasks': links });
}

/**
 * frontmatter modular-tasks 항목 한 개를 entity ref 후보로 파싱.
 * - 순수 id (ULID 26 chars 형식) → { kind: 'id', value }
 * - `[[<path>/_index]]` 또는 `[[<path>/_index|alias]]` → { kind: 'link', path }
 * - 그 외 → null
 */
export function parseTaskRef(raw: unknown): { kind: 'id'; value: string } | { kind: 'link'; path: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const linkMatch = trimmed.match(/^\[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/);
  if (linkMatch) {
    let p = linkMatch[1];
    // wiki link 는 .md 확장자 생략 관용. 우리 entity 본체는 _index → 그대로.
    if (p.endsWith('.md')) p = p.slice(0, -3);
    return { kind: 'link', path: p };
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(trimmed)) return { kind: 'id', value: trimmed };
  return null;
}
