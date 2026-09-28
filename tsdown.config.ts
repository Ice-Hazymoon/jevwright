import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        bin: 'bin/jevwright.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    fixedExtension: true,
    dts: true,
    sourcemap: false,
    clean: true,
});
