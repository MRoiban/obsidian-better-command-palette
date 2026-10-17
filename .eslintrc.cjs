module.exports = {
    root: true,
    env: {
        browser: true,
        es2021: true,
        node: true,
    },
    parser: '@typescript-eslint/parser',
    parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
    },
    plugins: ['@typescript-eslint', 'import'],
    extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
    ],
    ignorePatterns: [
        'dist/',
        'node_modules/',
        'test-vault/',
    ],
    rules: {
        '@typescript-eslint/ban-ts-comment': 'off',
        '@typescript-eslint/no-empty-function': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-inferrable-types': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unused-vars': ['warn', {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
        }],
        'class-methods-use-this': 'off',
        'import/extensions': 'off',
        'max-classes-per-file': 'off',
        'no-console': 'off',
        'no-param-reassign': 'off',
        'no-useless-escape': 'off',
        'prefer-const': 'off',
    },
};
