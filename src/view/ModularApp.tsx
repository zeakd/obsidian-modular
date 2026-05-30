// React 진입점 — ItemView 의 container 에 마운트되는 단일 App.
// PR-12: 모바일에서는 read-only summary 로 분기.

import { Platform } from 'obsidian';
import { Canvas } from '../canvas/Canvas';
import { MobileSummary } from './MobileSummary';
import type { VaultStore } from '../data/vault-store';

export function ModularApp({ store }: { store: VaultStore }) {
  if (Platform.isMobile) return <MobileSummary store={store} />;
  return <Canvas store={store} />;
}
