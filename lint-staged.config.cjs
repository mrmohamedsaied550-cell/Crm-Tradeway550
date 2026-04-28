/**
 * lint-staged — runs only on files staged for commit.
 *
 * Workspace ESLint configs live inside each app/package; we invoke ESLint with
 * --no-error-on-unmatched-pattern to tolerate hooks staging files outside a
 * lintable workspace (e.g. root configs).
 */
module.exports = {
  "*.{ts,tsx}": [
    "eslint --fix --max-warnings 0 --no-error-on-unmatched-pattern",
    "prettier --write",
  ],
  "*.{js,cjs,mjs,jsx}": ["prettier --write"],
  "*.{json,md,yml,yaml}": ["prettier --write"],
};
