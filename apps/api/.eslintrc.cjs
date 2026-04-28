module.exports = {
  root: true,
  extends: [require.resolve('@crm/config-eslint')],
  rules: {
    /**
     * NestJS uses TypeScript class types as runtime DI tokens (via
     * `emitDecoratorMetadata`). ESLint's `consistent-type-imports` rule does
     * not understand decorator metadata and would incorrectly flag DI imports
     * as type-only. Disable it for the API workspace.
     */
    '@typescript-eslint/consistent-type-imports': 'off',
  },
};
