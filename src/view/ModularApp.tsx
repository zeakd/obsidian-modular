// React 진입점 — ItemView 의 container 에 마운트되는 단일 App.

import { Canvas } from '../canvas/Canvas';
import type { VaultStore } from '../data/vault-store';

export function ModularApp({ store }: { store: VaultStore }) {
  return <Canvas store={store} />;
}
