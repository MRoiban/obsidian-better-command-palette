import typescript from 'rollup-plugin-typescript2';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import webWorkerLoader from 'rollup-plugin-web-worker-loader';
import { terser } from 'rollup-plugin-terser';
import copy from 'rollup-plugin-copy';
import eslint from '@rollup/plugin-eslint';
import scss from 'rollup-plugin-scss';

const isProduction = process.env.NODE_ENV === 'production';
const isLocal = process.env.DEST === 'local';
const includeTestFiles = process.env.TYPE === 'test';

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
            ],
        }),
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
            typescript: require('typescript'),
            tsconfigOverride: {
                compilerOptions: {
                    declaration: false,
                    declarationMap: false,
                    noUnusedLocals: false,
                    noUnusedParameters: false,
                }
            }
        }),
        isProduction && terser(),
    ],
};