# websql-configurable

A fork of [websql](https://github.com/nolanlawson/node-websql) which
allows for additional configurability (with types incorporated from [@types/websql](https://www.npmjs.com/package/@types/websql)).

The [WebSQL Database API][websql], implemented for Node
using [better-sqlite3][]. In the browser, it falls back to `window.openDatabase`.

## Install

    npm install websql-configurable

## Usage

```js
import openDatabase from 'websql-configurable';
```

Create a SQLite3 database called `mydb.db`:

```js
const db = openDatabase('mydb.db', '1.0', 'description', 1);
```

Create an in-memory database:

```js
const db = openDatabase(':memory:', '1.0', 'description', 1);
```

## API

### openDatabase(name, version, description, size [, callback])

The `name` is the name of the database. It's passed verbatim to [better-sqlite3][].

The `version` is the database version (_currently ignored - see below_).

The `description` and `size` attributes are ignored, but they are required for
compatibility with the WebSQL API.

The `callback` just returns the same database object returned
synchronously (_migrations currently aren't supported - see below_).

For more information how to use the WebSQL API, see [the spec][websql] or
[various](http://www.html5rocks.com/en/tutorials/webdatabase/todo/) [tutorials](html5doctor.com/introducing-web-sql-databases/).

For more information on `better-sqlite3`, see [its documentation][better-sqlite3].

### In the browser

You can also use this module in the browser (via Browserify/Webpack/etc.),
in which case it will just use
`window.openDatabase`, meaning you are subject to [browser WebSQL support](http://caniuse.com/#feat=sql-storage).

### readTransaction() vs transaction()

Both `readTransaction()` (read-only) and `transaction()` (read-write) are supported.
`readTransaction()` has some small performance optimizations, so it's worthwhile to
use if you're not writing any data in a transaction.

### Synchronous execution

`better-sqlite3` runs every statement synchronously on the main thread. Each
batch of queries is executed in a tight loop and the `exec()` callback is then
deferred by a single macrotask (`setImmediate`), so callers still observe the
same asynchronous, one-callback-per-batch behavior as before. Two
`SQLiteDatabase` instances pointing at the same file are coordinated by an
in-process per-file reader/writer lock (any number of concurrent
`readTransaction()`s, exclusive access for `transaction()`).

## Goals

The [WebSQL Database API][websql] is a deprecated
standard, but in many cases it's useful to reuse legacy code
designed for browsers that support WebSQL. Also, it allows you to quickly
test WebSQL-based code in Node, which can be convenient.

The goal of this API is to exactly match the existing WebSQL API, as implemented
in browsers. If there's any difference between browsers (e.g. `rows[0]` is supported
in Chrome, whereas only `rows.item(0)` is supported in Safari), then the lowest-common
denominator version is exported by this library.

This library has a robust test suite, and has been known to pass the PouchDB
test suite as well.

## Non-Goals

This library is _not_ designed to:

- Invent new APIs, e.g. deleting databases, supporting `BLOB`s, encryption, etc.
- Support WebSQL in Firefox, IE, or other non-WebSQL browsers

In other words, the goal is not to carry the torch of WebSQL,
but rather to bridge the gap from existing WebSQL-based code to Node.js.

## Custom SQLite3 bindings

This library is designed to allow swappable SQLite3 implementations, beyond
just [node-sqlite3](https://github.com/mapbox/node-sqlite3). Examples:

* [node-websql itself](https://github.com/nolanlawson/node-websql/blob/7c6327c2bbcf48bb0ac26f8f689206b7227baf81/lib/sqlite/SQLiteDatabase.js)
* [Cordova SQLite Plugin 2](https://github.com/nolanlawson/cordova-plugin-sqlite-2/blob/6bc32a4e71a3eea28fbc98c4da7e87c56156d094/src/javascript/SQLiteDatabase.js)
* [React Native SQLite 2](https://github.com/noradaiko/react-native-sqlite-2)

To create your own custom implementation, use this API:

```js
import customOpenDatabase from 'websql-configurable/custom/index.js';

// The second argument is an optional options object
const openDatabase = customOpenDatabase(SQLiteDatabase, {
  sqlite: {
    busyTimeout: 1000, // The default in ms
    trace: cb, // Called with each statement's SQL text
    profile: cb, // Called with each statement's SQL text and its duration
    memoryQuota: 5000000 // Cap the database size (in bytes) via `max_page_count`
  },
  websql: {
    openDelay: cb, // Defaults to `immediate`
    transactionDelay: cb, // Defaults to `immediate`
    executeDelay: cb // Defaults to `immediate`
  }
});
```

This `SQLiteDatabase` implementation needs to be a constructor-style function
with a constructor signature like so:

```js
// takes two arguments: the database name and an optional options object
const db = new SQLiteDatabase('dbname', {busyTimeout: 1000, trace: cb, profile: cb, memoryQuota: 5000000});
```

The built-in implementation also exposes node-sqlite3's `configure(option, value)`
(for `'busyTimeout'`, `'trace'`, `'profile'`, and `'memoryQuota'`) and a
callback-style `close(cb)` for drop-in compatibility.

Then it implements a single function, `exec()`, like so:

```js
/**
 *
 * @param {Array<{sql: string, args: Array}>} queries
 * @param {boolean} readOnly
 * @param {(err: Error, results?: Array) => void} callback
 */
function exec (queries, readOnly, callback) {
  // queries: an array of SQL statements and queries, with a key "sql" and "args"
  // readOnly: whether or not these queries are in "read only" mode
  // callback: callback to be called with results (first arg is error, second arg is results)
}
```

Here is the full specification:

### SQLiteDatabase(name (String))

Construct a new `SQLiteDatbase` object, with the given string name.

### exec(queries (Array<SQLQuery>), readOnly (boolean), callback (function))

Execute the list of `SQLQuery`s. If we are in `readOnly` mode, then any
non-`SELECT` queries need to throw an error without executing. This function calls the Node-style
callback with an error as the first argument or the `Array<SQLResult>` as
the second argument.

### SQLQuery

A SQL query and bindings to execute. This can be a plain JavaScript object or a custom class,
as long as it has the following members:

#### sql (String)

The SQL query to execute.

#### args (Array<String>)

The arguments to bind the query.

E.g.:

```js
const args = {
  sql: 'INSERT INTO foo values (?, ?)',
  args: ['bar', 'baz']
};
```

### SQLResult

A result returned by a SQL query. This can be a plain JavaScript object or a custom class,
as long as it has the following members:

#### error

A JavaScript `Error` object, or `undefined` if the `SQLQuery` did not throw an error. If `error` is truthy, then it's assumed `insertId`, `rowsAffected`, and `rows` are falsy (they will be ignored anyway).

#### insertId (number)

An insertion ID representing the new row number, or `undefined` if nothing was inserted.

#### rowsAffected (number)

The number of rows affected by the query, or 0 if none.

#### rows (Array&lt;object&gt;)

The rows returned by a `SELECT` query, or empty if none.

Each object is a mapping of keys (columns) to values (value fetched).

E.g.:

```js
const rows = {
  insertId: undefined,
  rowsAffected: 0,
  rows: [
    {foo: 'bar'},
    {foo: 'baz'}
  ]
};
```

Or:

```js
const errorResult = {
  error: new Error('whoopsie')
};
```

For an example implementation (and the one used by this module)
see `lib/sqlite/SQLiteDatabase.js`.

## TODOs

The versioning and migration APIs
(i.e. [`changeVersion()`](https://www.w3.org/TR/webdatabase/#dom-database-changeversion))
are not supported. Pull requests welcome!

## Limitations

1. A database `name` is handed straight to SQLite, whose valid values are
filenames, `":memory:"` for an anonymous in-memory database, and an empty
string for an anonymous disk-based database. This does not honor the
[WebSQL spec](https://www.w3.org/TR/webdatabase/#dom-opendatabase)'s
indication that "All strings including the empty string are valid database
names" (and that they are case-sensitive), so consumers will need to do their
own mapping for strings in order to 1) avoid problems with invalid filenames or
filenames on case insensitive file systems, and to 2) avoid user databases being
given special treatment if the empty string or the string ":memory:" is used;
another special purpose form of string supported by SQLite that may call for
escaping are [`file::memory:...`](https://sqlite.org/inmemorydb.html)
[URLs](https://sqlite.org/uri.html#uri_format).

2. Each `executeSql()` call must contain a single statement. Unlike
`node-sqlite3`'s `exec()`, `better-sqlite3` does preserve literal NUL bytes in
string values and does not choke on [SQL comments](https://sqlite.org/lang_comment.html).

3. `better-sqlite3` builds SQLite with strict quoting (`SQLITE_DQS=0`): a
double-quoted token is always an identifier and a single-quoted token is always
a string literal. SQL written against `node-sqlite3`'s more lenient build - for
example `INSERT INTO t VALUES ("some text")` or a single-quoted table name -
must be rewritten as standard SQL (`'some text'` for the string, `"t"` for the
identifier).

## Testing

First:

    npm install

Main test suite:

    npm test

Linter:

    npm run lint

Test in debug mode (e.g. with the `node-inspector`):

    npm run test-debug

Run the test suite against actual WebSQL in a browser:

    npm run test-local

Run the actual-WebSQL test against PhantomJS:

    npm run test-phantom

[websql]: https://www.w3.org/TR/webdatabase/
[better-sqlite3]: https://github.com/WiseLibs/better-sqlite3
