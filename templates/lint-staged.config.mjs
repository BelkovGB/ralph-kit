// Formatter run over staged files by templates/pre-commit.
// Replace the pattern and the command with your project's own.
export default {
  '*.{cjs,css,js,json,jsx,md,mjs,ts,tsx,yaml,yml}': 'prettier --write',
};
