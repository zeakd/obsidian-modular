// AI suggest — stub. modular 본문 / child 제안의 통합점.
//
// 실제 LLM 호출은 사용자 환경에 따라 다름 (Anthropic / OpenAI / local).
// 이 stub 은 인터페이스만 정의하고 default suggester 는 placeholder 텍스트.
// 사용자가 settings 또는 외부 plugin 으로 real suggester 를 inject 가능.

import type { Entity } from '../data/types';

export interface SuggestBodyArgs {
  entity: Entity;
  /** 형제 + 자식 entities (context for the LLM). */
  siblings: Entity[];
  children: Entity[];
}

export interface Suggester {
  suggestBody(args: SuggestBodyArgs): Promise<string>;
}

export const placeholderSuggester: Suggester = {
  async suggestBody({ entity }: SuggestBodyArgs): Promise<string> {
    return [
      `# ${entity.name}`,
      '',
      `(이 ${entity.kind === 'module' ? '모듈' : '컴포넌트'}의 목적을 한 문장으로 설명)`,
      '',
      '## 역할',
      '',
      '## 의존',
      '',
    ].join('\n');
  },
};

let currentSuggester: Suggester = placeholderSuggester;

export function setSuggester(s: Suggester): void {
  currentSuggester = s;
}

export function getSuggester(): Suggester {
  return currentSuggester;
}
