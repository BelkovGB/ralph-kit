/**
 * Линтер набора. В проект не копируется: он относится к разработке Ralph, а не к
 * его поведению у потребителя.
 *
 * Пакетов в репозитории нет намеренно — набор ставят и в проект на другом языке,
 * поэтому ни `package.json`, ни `node_modules` здесь не заводится. ESLint
 * запускается разово через `npx` и версией закреплён в CI: плавающая версия
 * приносила бы новые правила вместе с чужим выпуском.
 *
 * Запуск: npx --yes eslint@10.9.1 . — та же версия, что в CI.
 */

// Глобальные имена перечислены явно, потому что пакета `globals` в репозитории
// нет. Новое имя из стандартной библиотеки Node добавляют сюда же: без записи
// правило `no-undef` считает его опечаткой.
const nodeGlobals = {
  AbortController: 'readonly',
  Buffer: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  global: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
};

export default [
  {
    // `.local` — рабочие файлы этой копии, в CI их нет. Линтер обязан давать
    // один результат здесь и на сервере.
    ignores: ['.local/**'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Имя с подчёркиванием в начале — принятая в наборе пометка «значение
      // получено, но не нужно»: так помечают неиспользуемый параметр и снятое
      // из деструктуризации поле.
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          // Ключ снимают из объекта именно так: имя слева существует ради того,
          // чтобы не попасть в остаток справа.
          ignoreRestSiblings: true,
        },
      ],
      'no-undef': 'error',
      // Оба правила запрещают приём, который в наборе применяется намеренно и
      // ровно по одному разу: разбор скрипта страницы через `new Function` и
      // управляющий символ в регулярном выражении. Включены, чтобы снятие
      // запрета оставалось видимой пометкой, а не тихой привычкой.
      'no-new-func': 'error',
      'no-control-regex': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Правило считает гонкой любую запись в process.env после await. В наборе
      // такие записи делают тестовые фикстуры в одном потоке, и правило даёт
      // только шум.
      'require-atomic-updates': 'off',
    },
  },
];
