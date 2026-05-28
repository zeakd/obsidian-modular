// modular build config — read by `opk build` / `opk dev`.
//
// @xyflow/react (formerly `reactflow`) ships its own CSS that source-level
// imports don't reach (it's loaded by the runtime as a side effect of
// importing the components). The dep CSS needs to land in plugin styles.css
// so node/edge/handle styling works inside Obsidian.

import { defineConfig } from 'obsidian-plugin-kit/build';

export default defineConfig({
  styles: {
    prepend: ['node_modules/@xyflow/react/dist/style.css'],
  },
});
