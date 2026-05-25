// vitest setup — alias `obsidian` to obsidian-sim's shape-only mock so
// source-level ESM imports (`import { Plugin } from 'obsidian'`) resolve
// at test time. vi.mock is hoisted to the top of the file by vitest's
// transformer, so the factory cannot reference any top-level variables —
// the import must happen INSIDE the factory function.

import { vi } from 'vitest';

vi.mock('obsidian', async () => {
  const mock = await import('obsidian-sim/mock');
  return mock;
});
