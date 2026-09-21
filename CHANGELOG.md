# Changelog for `node-websql`

## 4.1.0

- fix: relocated index.d.ts to lib/websql-spec-ambient.d.ts, alongside its
sibling ambient .d.ts files, and pointed package.json's stale top-level
"types" field at the real generated dist/lib/index.d.ts (it was pointing
at a file excluded from the published package).
- test: make test.js's before/after cleanup hooks actually run
- test: Two previously-swallowed problems in the legacy PouchDB
adapter suite: missing inherits/through2 dependencies (not hoisted by
pnpm since they were only transitive), and scope-eval's return-inside-
eval trick throwing "Illegal return statement" under current V8, breaking
every filter/map/reduce function evaluated by pouchdb-node.js and
pouchdb-browser.js. Replaced scope-eval with plain `new Function(...)` in
both files and dropped the now-unused dependency.
- test: Slow suite is now gated behind RUN_LEGACY_TESTS instead of running by default.

## 4.0.0

- **BREAKING:** swap the SQL engine from `sqlite3` to
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3); the
  `sqlite3` `optionalDependency` is removed and `better-sqlite3` is now a
  regular dependency.
- **BREAKING:** `better-sqlite3` builds SQLite with strict quoting
  (`SQLITE_DQS=0`), so a double-quoted token is always an identifier and a
  single-quoted token is always a string literal. SQL that leaned on
  `node-sqlite3`'s lenient build (e.g. `INSERT ... VALUES ("text")`, or a
  single-quoted table name) must be corrected to standard SQL.
- feat: statements now execute synchronously; the `exec()` callback is deferred
  by a single `setImmediate` per batch.
- feat: literal NUL bytes in string values are preserved (previously truncated
  by `node-sqlite3`), and SQL comments no longer cause runtime errors.
- feat: coordinate multiple `SQLiteDatabase` instances on the same file with an
  in-process per-file reader/writer lock (concurrent `readTransaction()`s,
  exclusive `transaction()`).
- feat: `SQLiteDatabase` gains a `memoryQuota` option (byte cap enforced via
  `max_page_count`), plus node-sqlite3-compatible `configure()` and `close()`.

## 3.1.0

- feat: add opt-in, non-standard concurrentReaders mode for parallel readTransaction()s

## 3.0.6

- fix: let `readTransaction()` defer finalization via `nonstandardTransCb`

## 3.0.5

fix: expose `./lib/websql/WebSQLTransaction.js` and `./lib/websql/WebSQLResultSet.js`

## 3.0.4

fix: stop `WebSQLTransaction` from permanently locking itself out of further
`executeSql()` calls once its SQL queue is merely found empty; only mark it
complete once the (optional, nonstandard) 4th `transaction()`/`readTransaction()`
callback has actually committed, rolled back, or confirmed there is no more
work coming, so a caller that defers that decision can still submit more SQL
afterward and have it run

## 3.0.3

fix: update type files

## 3.0.2

fix: update type files
fix: expose `./lib/websql/WebSQLDatabase.js`

## 3.0.1

fix: update type files

## 3.0.0

feat: switch to ESM

## 2.0.1

fix: missing `dist` folder

## 2.0.0

feat: export types

## 1.0.1

- fix: add missing types

## 1.0.0

Beginning of `websql` fork
