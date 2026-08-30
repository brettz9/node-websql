import ashNazg from 'eslint-config-ash-nazg';

export default [
  {
    ignores: [
      'coverage',
      'dist',
      // Vendored/Rollup-bundled PouchDB test harness -- not code this
      // project authors or maintains, and risky to autofix (stylistic
      // fixes here have broken real behavior, e.g. regex `.test()` -> `
      // .startsWith()` conversions that dropped implicit string coercion).
      'test/pouchdb-node.js',
      'test/pouchdb-browser.js',
      'test/pouchdb-websql.js'
    ]
  },
  ...ashNazg(['sauron', 'node']),
  {
    rules: {
      // Disable for now
      'promise/prefer-await-to-then': 0,
      'promise/no-callback-in-promise': 0,
      'promise/always-return': 0,
      'unicorn/prefer-then-catch': 0,
      'n/handle-callback-err': 0,
      '@stylistic/max-len': 0,
      'no-shadow': 0,
      'n/callback-return': 0,
      'jsdoc/require-returns': 0,
      camelcase: 0,

      // False positive: this doesn't recognize packages typed only via our
      // own `lib/ambient.d.ts` declarations (e.g. `tiny-queue`, which ships
      // no types of its own).
      'jsdoc/imports-as-dependencies': 0,

      // Library is heavy on callbacks
      'promise/prefer-await-to-callbacks': 0
    }
  },
  {
    files: ['test/test.js'],
    rules: {
      // Would be preferable to hoist the `await import(...)` calls to the
      // module's top level instead of this async `describe()` callback,
      // but Mocha loads its entry test file via a synchronous `require()`,
      // which throws `ERR_REQUIRE_ASYNC_MODULE` for any ES module with
      // top-level await -- tried it, confirmed it breaks the whole suite.
      'mocha/no-async-suite': 0,
      'sonarjs/synchronous-suite-callback': 0
    }
  },
  {
    files: ['test/test.utils.js'],
    rules: {
      // Reading local test/CI configuration (COUCH_HOST etc.), not
      // handling untrusted input.
      'n/no-process-env': 0,
      // Default local CouchDB dev URL, not a real endpoint.
      'sonarjs/no-clear-text-protocols': 0,
      // `readAsArrayBuffer`/`FileReader` here is the browser-only branch
      // of `readBlob` (the `!process.browser` branch above it handles
      // Node); switching its untested browser code to `Blob#arrayBuffer`
      // is out of scope for a lint pass.
      'unicorn/prefer-blob-reading-methods': 0
    }
  },
  {
    files: ['test/test.main.js'],
    rules: {
      // `Promise` here is the imported `bluebird` package (`import Promise
      // from 'bluebird'`), not the native global; `.longStackTraces()` is
      // a real bluebird API, not native-prototype extension.
      'no-use-extend-native/no-use-extend-native': 0,

      // Deliberately empty transaction/query callbacks here, testing that
      // the adapter tolerates callbacks that don't do anything.
      'no-empty-function': 0
    }
  },
  {
    files: ['test/test.mapreduce.js'],
    rules: {
      // These map/reduce functions are `.toString()`'d and re-evaluated
      // elsewhere as standalone function expressions (for persisted-view
      // tests). ES2015 method shorthand's `.toString()` output drops the
      // `function` keyword, which breaks that round-trip -- autofixing
      // this rule here has caused real test failures before.
      'object-shorthand': 0
    }
  },
  {
    files: ['test/test.attachments.js'],
    rules: {
      // `if (++done === N && changes === N)` -- reordering to put the
      // side-effect-free `changes === N` first (as the rule suggests)
      // would change behavior: `++done` would stop running on every call
      // once `changes !== N` short-circuits it.
      'unicorn/prefer-simple-condition-first': 0
    }
  },
  {
    files: ['test/test.bulk_docs.js', 'test/test.replication.js'],
    rules: {
      // `validate_doc_update` functions here intentionally throw plain
      // `{forbidden: reason}`/`{unauthorized: reason}` objects, matching
      // CouchDB's own ddoc validation error convention (that's what's
      // being tested) -- not a mistaken substitute for `Error`.
      'no-throw-literal': 0
    }
  },
  {
    // The hand-maintained test suite (adapted from upstream PouchDB's
    // legacy callback/promise-heavy tests). These rules would require
    // restructuring hundreds of individual test cases' control flow
    // (de-nesting promise chains, rewriting done()/callback patterns,
    // splitting skip/pending tests into separate suites) rather than
    // fixing an actual defect, and doing that mechanically is exactly
    // what caused real regressions earlier in this file's history.
    files: ['test/test*.js'],
    rules: {
      // Deeply nested `.then()`/`new Promise()`/callback chains are the
      // dominant style throughout this suite (hundreds of call sites).
      'promise/no-nesting': 0,
      'promise/avoid-new': 0,
      'promise/catch-or-return': 0,
      'promise/no-promise-in-callback': 0,
      'max-nested-callbacks': 0,
      'mocha/handle-done-callback': 0,

      // The suite has 51 deliberately-skipped tests (environment-specific:
      // browser-only or real-CouchDB-only features this adapter doesn't
      // implement), which is the intended, documented state, not oversight.
      'mocha/no-pending-tests': 0,
      'sonarjs/no-skipped-tests': 0,
      'sonarjs/explicit-test-skip': 0,
      'mocha/no-conditional-tests': 0,

      // SonarJS doesn't recognize this suite's assertion idioms (chai
      // `.should`, custom `testUtils` helpers, assertions inside promise
      // callbacks), producing many false positives.
      'sonarjs/assertions-in-tests': 0,
      'sonarjs/prefer-specific-assertions': 0,

      // Test-only utility functions taking exactly one parameter (e.g.
      // `keyFunc(doc)`, `ids(row)`) passed directly to `.map()`; there's
      // no `.map(parseInt)`-style footgun here since the extra
      // (index, array) arguments are simply unused.
      'unicorn/no-array-callback-reference': 0,

      // These test helpers sort plain data for assertions, not in a
      // security context.
      'unicorn/no-array-sort': 0,
      'unicorn/require-array-sort-compare': 0,
      'unicorn/prefer-simple-sort-comparator': 0,
      'unicorn/no-boolean-sort-comparator': 0,
      'sonarjs/pseudo-random': 0,

      // Not type-checked for now (see tsconfig.json's commented-out
      // `test/**/*.js`), so there's no payoff for fully typing every
      // `@param`.
      'jsdoc/require-param-type': 0,

      // Diagnostic output in test callbacks/error handlers is intentional
      // here, not debug leftovers.
      'no-console': 0,

      // `navigator` is only ever read behind a `typeof process ===
      // 'undefined' || process.browser` guard (Safari detection), so it's
      // never actually reached under Node.
      'n/no-unsupported-features/node-builtins': 0,

      // `new PouchDB(name, callback)` is PouchDB's own constructor+callback
      // API, used throughout for its callback side effect without needing
      // the instance itself.
      'no-new': 0
    }
  },
  {
    files: ['custom/index.js'],
    rules: {
      // Deliberate: this is the package's own public sub-path entry point
      // (`"./custom/index.js"` in package.json's `exports`), forwarding
      // to `lib/custom.js` -- not an accidental barrel file.
      'unicorn/no-barrel-files': 0
    }
  },
  {
    files: ['**/*.md/*.js'],
    languageOptions: {
      globals: {
        openDatabase: 'readonly',
        cb: 'readonly',
        SQLiteDatabase: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', {
        varsIgnorePattern: 'openDatabase|db|rows|args|exec|errorResult',
        argsIgnorePattern: 'callback|queries|readOnly'
      }]
    }
  }
];
