# Changelog for `node-websql`

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
