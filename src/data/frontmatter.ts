// frontmatter 헬퍼 — v3 (folder-agnostic).
// 관계는 네이티브 wikilink. id 부여 + body 템플릿 + frontmatter 쓰기.
// 링크 → 파일 해석(resolution)은 obsidian metadataCache 가 필요하므로
// vault-store 에서 처리; 여기선 raw wikilink 텍스트 파싱만.

import type { App, TFile } from 'obsidian';
import type { EntityId, ModularFrontmatter } from './types';

/**
 * frontmatter 값 한 개에서 wikilink 대상 텍스트 추출.
 *   "[[Payments]]"          → "Payments"
 *   "[[notes/Payments|별칭]]" → "notes/Payments"
 *   그 외(순수 텍스트 등)    → null
 */
export function parseWikiLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^\[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/);
  if (!m) return null;
  let p = m[1].trim();
  if (p.endsWith('.md')) p = p.slice(0, -3);
  return p || null;
}

export function newModuleBody(id: EntityId): string {
  return ['---', `modular-id: ${id}`, '---', '', ''].join('\n');
}

export function newComponentBody(id: EntityId, parentLink: string): string {
  return [
    '---',
    `modular-id: ${id}`,
    `modular-parent: "${parentLink}"`,
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

/** modular-tasks 를 wikilink 문자열 배열로 기록. */
export async function setOutgoingTaskLinks(
  app: App,
  file: TFile,
  links: string[],
): Promise<void> {
  await writeModularFrontmatter(app, file, { 'modular-tasks': links });
}
