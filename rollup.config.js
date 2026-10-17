import fs from 'fs';
import path from 'path';
import typescript from 'rollup-plugin-typescript2';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import webWorkerLoader from 'rollup-plugin-web-worker-loader';
import { terser } from 'rollup-plugin-terser';
import copy from 'rollup-plugin-copy';
import scss from 'rollup-plugin-scss';
import replace from '@rollup/plugin-replace';
import alias from '@rollup/plugin-alias';

const isProduction = process.env.NODE_ENV === 'production';
const isLocal = process.env.DEST === 'local';
const includeTestFiles = process.env.TYPE === 'test';

/**
 * onnxruntime-web WASM binary for the local embedding worker. Its JS glue is bundled
 * (inlined in the worker via `onnxruntime-web/webgpu`), and this binary is copied next
 * to main.js so nothing is loaded from a CDN. Must match the glue's flavour (asyncify).
 */
const ORT_WASM_ASSET = 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm';
if (!includeTestFiles && !fs.existsSync(ORT_WASM_ASSET)) {
    throw new Error(`Missing ${ORT_WASM_ASSET}. Run "bun install".`);
}

/**
 * Workers are built by rollup-plugin-web-worker-loader as IIFE bundles, where rollup's
 * default `import.meta.url` shim reads `document` (absent in workers). Point it at the
 * worker's own location instead.
 */
const workerImportMeta = () => ({
    name: 'worker-import-meta',
    resolveImportMeta(property, { format }) {
        if (format === 'iife' && property === 'url') {
            return 'self.location.href';
        }
        return null;
    },
});

let outputLocation = './test-vault/.obsidian/plugins/obsidian-better-command-palette';

if (isProduction) {
    outputLocation = './dist';
}

if (isLocal) {
    outputLocation = '.';
}

export default {
    input: includeTestFiles ? 'test/e2e/test.ts' : 'src/main.ts',
    output: {
        file: `${outputLocation}/main.js`,
        sourcemap: isProduction ? null : 'inline',
        format: 'cjs',
        exports: 'default',
    },
    external: ['obsidian'],
    plugins: [
        alias({
            entries: [
                { find: /^src\/(.*)/, replacement: path.resolve(__dirname, 'src/$1') }
            ]
        }),
        replace({
            'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
            preventAssignment: true,
        }),
        nodeResolve({
            browser: true,
            extensions: ['.ts', '.js', '.d.ts'],
        }),
        commonjs(),
        scss({
            output: `${outputLocation}/styles.css`,
        }),
        // eslint(),
        copy({
            targets: [
                ...(!isLocal
                    ? [{ src: 'manifest.json', dest: outputLocation }]
                    : []),
                ...(!includeTestFiles
                    ? [{ src: ORT_WASM_ASSET, dest: outputLocation }]
                    : []),
            ],
            copyOnce: true,
        }),
        workerImportMeta(),
        webWorkerLoader({
            targetPlatform: 'browser',
            preserveSource: !isProduction,
            sourcemap: !isProduction,
            inline: true,
            forceInline: true,
            extensions: ['.ts'],
        }),
        typescript({
            check: false,
            tsconfigOverride: {
                compilerOptions: {
                    declaration: false,
                    declarationMap: false,
                    noUnusedLocals: false,
                    noUnusedParameters: false,
                },
            },
        }),
        isProduction && terser(),
    ],
};
