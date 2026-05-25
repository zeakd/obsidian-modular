import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { resolve as resolvePath, dirname } from 'path';

// obsidian's published package is types-only (main: ""). vitest needs to
// resolve the entry before vi.mock can swap it, so we redirect resolution
// at the alias layer to obsidian-sim's mock.
const here = dirname(fileURLToPath(import.meta.url));
const obsidianAlias = resolvePath(here, 'node_modules/obsidian-sim/dist/src/mock.js');

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: [
      { find: /^obsidian$/, replacement: obsidianAlias },
    ],
  },
});
