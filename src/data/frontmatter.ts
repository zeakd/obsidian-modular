// frontmatter ↔ entity 변환. type/parent 는 conventions.entityInfo() 가 결정.

import type { App, FrontMatterCache, TFile } from 'obsidian';
import type { Module, Component, ModularFrontmatter } from './types';
import { basenameFromPath } from './conventions';

export function moduleFromEntity(
  path: string,
  fm: FrontMatterCache | undefined,
  posFallback?: { x: number; y: number },
): Module {
  const tagsRaw: unknown = fm?.['modular-tags'];
  const tags = Array.isArray(tagsRaw) ? (tagsRaw as unknown[]).map(String) : [];
  return {
    path,
    name: basenameFromPath(path),
    position: posFallback ?? { x: 0, y: 0 },
    tags,
  };
}

export function componentFromEntity(
  path: string,
  parentPath: string,
  _fm: FrontMatterCache | undefined,
  posFallback?: { x: number; y: number },
): Component {
  return {
    path,
    name: basenameFromPath(path),
    parentPath,
    position: posFallback ?? { x: 0, y: 0 },
  };
}

export function newModuleFileBody(): string {
  return [
    '---',
    'modular-tags: []',
    '---',
    '',
    '',
  ].join('\n');
}

export function newComponentFileBody(): string {
  return [
    '---',
    'modular-tasks: []',
    '---',
    '',
    '',
  ].join('\n');
}

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
  toPaths: string[],
): Promise<void> {
  await writeModularFrontmatter(app, file, { 'modular-tasks': toPaths });
}
