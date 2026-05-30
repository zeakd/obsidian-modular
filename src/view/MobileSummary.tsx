// Mobile summary — read-only tree list (PR-12).
// 모바일은 데스크탑의 viewer 역할에 최적화. reactflow drag/zoom 정밀도 약하고
// 화면 좁아서 graph 시각화가 빈약함. 대신 hierarchy + recent activity 를 빠르게
// 훑을 수 있게.

import { useMemo, useSyncExternalStore } from 'react';
import type { Entity, EntityId, Workspace } from '../data/types';
import type { VaultStore } from '../data/vault-store';

export function MobileSummary({ store }: { store: VaultStore }) {
  const w = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { roots, childrenOf } = useMemo(() => buildTree(w), [w]);
  return (
    <div className="modular-mobile-summary">
      <div className="modular-mobile-header">
        <span className="modular-mobile-title">Modular</span>
        <span className="modular-mobile-stats">
          {w.entities.size} entit{w.entities.size === 1 ? 'y' : 'ies'} · {w.tasks.length} task{w.tasks.length === 1 ? '' : 's'}
        </span>
      </div>
      {roots.length === 0 ? (
        <div className="modular-mobile-empty">
          빈 vault. 데스크탑에서 entity 를 만들어 보세요.
        </div>
      ) : (
        <ul className="modular-mobile-tree">
          {roots.map((m) => (
            <EntityRow key={m.id} entity={m} childrenOf={childrenOf} depth={0} store={store} />
          ))}
        </ul>
      )}
    </div>
  );
}

function buildTree(w: Workspace): {
  roots: Entity[];
  childrenOf: Map<EntityId, Entity[]>;
} {
  const all = [...w.entities.values()];
  const childrenOf = new Map<EntityId, Entity[]>();
  for (const e of all) {
    if (!e.parentId) continue;
    const list = childrenOf.get(e.parentId) ?? [];
    list.push(e);
    childrenOf.set(e.parentId, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  const roots = all
    .filter((e) => e.kind === 'module')
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roots, childrenOf };
}

function EntityRow({
  entity, childrenOf, depth, store,
}: {
  entity: Entity;
  childrenOf: Map<EntityId, Entity[]>;
  depth: number;
  store: VaultStore;
}) {
  const kids = childrenOf.get(entity.id) ?? [];
  return (
    <li className="modular-mobile-row">
      <button
        type="button"
        className="modular-mobile-row-btn"
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onClick={() => { void store.openInSideLeaf(entity.id); }}
      >
        <span className="modular-mobile-kind">{entity.kind === 'module' ? '◇' : '·'}</span>
        <span className="modular-mobile-name">{entity.name}</span>
        {entity.bodyExcerpt && entity.bodyExcerpt.trim().length > 0 && (
          <span className="modular-mobile-excerpt">{entity.bodyExcerpt.slice(0, 60)}</span>
        )}
      </button>
      {kids.length > 0 && (
        <ul className="modular-mobile-children">
          {kids.map((c) => (
            <EntityRow key={c.id} entity={c} childrenOf={childrenOf} depth={depth + 1} store={store} />
          ))}
        </ul>
      )}
    </li>
  );
}
