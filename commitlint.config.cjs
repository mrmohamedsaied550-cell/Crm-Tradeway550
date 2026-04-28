/**
 * Conventional Commits — enforced via .husky/commit-msg.
 *
 * Allowed types: feat, fix, chore, docs, refactor, test, perf, build, ci, style, revert.
 * Subject case is relaxed (body may contain Arabic), but headers must be <= 100 chars.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "header-max-length": [2, "always", 100],
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "chore",
        "docs",
        "refactor",
        "test",
        "perf",
        "build",
        "ci",
        "style",
        "revert",
      ],
    ],
  },
};
