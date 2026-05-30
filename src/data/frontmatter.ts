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

export async function setOutgoingTasks(
  app: App,
  file: TFile,
  toIds: EntityId[],
): Promise<void> {
  await writeModularFrontmatter(app, file, { 'modular-tasks': toIds });
}
