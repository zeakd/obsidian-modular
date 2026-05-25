// Bun test preload — alias `obsidian` (and `electron`) to obsidian-sim's
// mock so source-level ESM imports (`import { Plugin } from 'obsidian'`) get
// the mock at `bun test` time. installObsidianHook covers CJS require() in
// built bundles only; ESM imports go through Bun's loader.

import { mock } from 'bun:test';
import * as obsidianMock from 'obsidian-sim/mock';

mock.module('obsidian', () => obsidianMock);
mock.module('electron', () => ({}));
