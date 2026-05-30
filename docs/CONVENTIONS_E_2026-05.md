# Conventions E — `_index.md` + folder + frontmatter `modular-id`

목표: rename invariance, 외부 편집 안전성, 본체 식별 명확화.
범위: modular plugin 데이터 모델 전면 재정의 + 1회성 자동 마이그레이션.
대상 버전: 0.3.0.

## 새 데이터 모델

### 디스크 레이아웃
```
modular/
  payments/                     ← entity 폴더 (이름은 표시용)
    _index.md                   ← 본체 (frontmatter에 source-of-truth)
    .position                   ← 위치 sidecar (모든 entity 동일 패턴)
    refund/                     ← 자식 entity (모든 자식은 폴더)
      _index.md
      .position
  billing/
    _index.md
    .position
    invoice/                    ← leaf component도 자기 폴더
      _index.md
      .position
```

**핵심 변경:**
- 본체 = `_index.md` (이름 고정). 외부 rename 깨질 일 없음.
- 모든 entity = 폴더. leaf ↔ expanded 구분 폐지 (자식 추가는 단순 폴더 생성).
- Position sidecar = 항상 `<folder>/.position` (단일 패턴).

### Frontmatter 스키마 (`_index.md`)
```yaml
---
modular-id: 01HXABC...DEFG          # ULID, 영속. 생성 후 변경 X.
modular-parent: 01HXAAA...0001      # parent id. 루트 module은 누락 또는 null.
modular-tags: [auth, payments]      # module만 사용 (기존 호환)
modular-tasks: [01HYAAA..., 01HYBBB...]  # 자기에서 → target id의 task (component)
---
<body content — 자유 markdown>
```

### Type 분류
- **module**: `modular-parent`가 없거나 null. 루트 entity.
- **component**: `modular-parent`가 존재. 다른 entity의 자식.

폴더 nesting과 `modular-parent`는 항상 일치해야 함 (마이그 단계에서 보장).
runtime에 둘이 어긋나면: parent id를 source of truth로 (path는 표현).

### Workspace snapshot (in-memory)
```ts
interface Entity {
  id: string;                          // ULID
  path: string;                        // 현재 _index.md 경로 (표현용)
  folderPath: string;                  // 폴더 경로
  name: string;                        // 폴더명 (사용자 표시)
  position: { x: number; y: number };
  // type-specific
  kind: 'module' | 'component';
  parentId: string | null;             // module은 null
  tags?: string[];                     // module
}

interface Task {
  fromId: string;
  toId: string;
}

interface Workspace {
  entities: Map<string, Entity>;       // id → Entity (현재 modules + components split 폐지)
  tasks: Task[];
}
```

레퍼런스가 전부 id 기반 — 사용자가 폴더를 어디로 옮기든 task edges / positions 유지.

## ID

ULID 형식 (26자, 시간 정렬). 생성: `Date.now().toString(36) + crypto.randomUUID().slice(0, 18)` 같은 단순 형식도 OK. ULID lib 도입 vs 자체 구현:
- 자체 구현 권장 (의존 추가 회피)
- 충돌 확률: timestamp + 18자 random = practical 0

## 마이그레이션

**없음.** v2 only — plugin은 `_index.md` 본체를 가진 폴더만 entity로 인식.

옛 v1 데이터 (`<folder>/<folder>.md`)가 vault에 남아 있어도 plugin은 그냥 일반 markdown으로 무시. 사용자가 손으로 정리하거나 새로 시작.

(self-use 단계라 자동 마이그 비용이 부담. 다른 사용자에게 배포 단계에서 필요하면 그때 작성.)

## 코드 영향 (예상 변경 LOC)

| 파일 | 작업 | LOC |
|---|---|---|
| `src/data/conventions.ts` | 전면 rewrite (path 패턴 → 폴더 + _index 식별) | ~150 |
| `src/data/types.ts` | Entity 통합, id 필드 | ~30 |
| `src/data/frontmatter.ts` | id/parent/tasks 처리 | ~50 |
| `src/data/vault-store.ts` | id 기반 cache, snapshot 재구성 | ~250 |
| `src/canvas/Canvas.tsx` | node.id = entity.id, edge ref도 id | ~80 |
| `src/diagram/*.tsx` | data 인터페이스 id 추가 | ~20 |
| `src/main.ts` | (변경 거의 없음) | ~5 |
| 테스트 신규/갱신 | store.test.ts 14개 모두 재작성 | ~250 |
| **합** | | **~830** |

## 단계별 PR 분할

너무 크니까 분리:

1. **PR-A:** spec doc + types + id 유틸 (이 문서 + Entity/Workspace 타입 정의)
2. **PR-B:** migration-v2 모듈 (단독 + 테스트)
3. **PR-C:** conventions + vault-store rewrite + 테스트
4. **PR-D:** Canvas/diagram id 마이그 + smoke
5. **PR-E:** main.ts 마이그 트리거 + 통합 테스트 + 0.3.0 release

각 PR은 머지 후에도 plugin이 동작해야 하니, 단계마다 호환 layer 또는 feature flag 고려.

대안: 단일 큰 PR (작업 사이즈 무시하고 한 번에). 사용자 결정 필요.

## 결정 필요

1. **PR 분할 vs 단일 PR**
   - 분할: 단계별 머지/검증 가능, 호환 layer 비용
   - 단일: 더 깔끔, 검증 어려움 + revert 비용
2. **버전**: 0.3.0 minor (현재 사용자=self만이라 minor OK) vs 1.0.0 major (스펙 변경 크니까)
3. **백업 폴더 위치**: `modular/.modular-backup-pre-v2/` vs `_modular-backup-v1/` (vault root) vs 사용자가 직접 backup
4. **ID 생성**: 자체 구현 ULID vs `ulid` npm dep 추가
