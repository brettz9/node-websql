import sqlite3 from 'sqlite3';
import SQLiteResult from './SQLiteResult.js';

/**
 * @typedef {object} SQLiteDatabaseOptions
 * @property {number} [busyTimeout]
 * @property {(sql: string) => void} [trace]
 * @property {(sql: string, time: number) => void} [profile]
 */

const READ_ONLY_ERROR = new Error(
  'could not prepare statement (23 not authorized)'
);

/**
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 * @param {unknown[]} args
 * @param {(result: SQLiteResult) => void} cb
 */
function runSelect (db, sql, args, cb) {
  db.all(sql, args, function (err, /** @type {unknown[]} */ rows) {
    if (err) {
      cb(new SQLiteResult(err));
      return;
    }
    const insertId = undefined;
    const rowsAffected = 0;
    const resultSet = new SQLiteResult(null, insertId, rowsAffected, rows);
    cb(resultSet);
  });
}

/**
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 * @param {unknown[]} args
 * @param {(result: SQLiteResult) => void} cb
 */
function runNonSelect (db, sql, args, cb) {
  // sqlite3's `run()` only exposes `lastID`/`changes` via the callback's
  // `this` (typed as `RunResult`), so there's no way to avoid using `this`
  // outside of a class here.
  /* eslint-disable unicorn/no-this-outside-of-class -- see above */
  db.run(sql, args, function (err) {
    if (err) {
      cb(new SQLiteResult(err));
      return;
    }

    const insertId = this.lastID;
    const rowsAffected = this.changes;
    /** @type {unknown[]} */
    const rows = [];
    const resultSet = new SQLiteResult(null, insertId, rowsAffected, rows);
    cb(resultSet);
  });
  /* eslint-enable unicorn/no-this-outside-of-class -- see above */
}

/**
 *
 */
class SQLiteDatabase {
  /**
   * @param {string} name
   * @param {SQLiteDatabaseOptions} [opts]
   */
  constructor (name, opts) {
    opts ||= {};
    this._db = new sqlite3.Database(name);
    if (opts.busyTimeout) {
      this._db.configure('busyTimeout', opts.busyTimeout); // Default is 1000
    }
    if (opts.trace) {
      this._db.configure('trace', opts.trace);
    }
    if (opts.profile) {
      this._db.configure('profile', opts.profile);
    }
  }

  /**
   * @param {import('../types.js').SqlQuery[]} queries
   * @param {boolean} readOnly
   * @param {(err: Error | null, results?: SQLiteResult[]) => void} callback
   */
  exec (queries, readOnly, callback) {
    const db = this._db;
    const len = queries.length;
    /** @type {SQLiteResult[]} */
    const results = Array.from({length: len});

    let i = 0;

    /**
     *
     */
    function checkDone () {
      if (++i === len) {
        callback(null, results);
      } else {
        doNext();
      }
    }

    /**
     * @param {number} i
     */
    function onQueryComplete (i) {
      return function (/** @type {SQLiteResult} */ res) {
        results[i] = res;
        checkDone();
      };
    }

    /**
     *
     */
    function doNext () {
      const query = queries[i];
      const {sql, args} = query;

      // TODO: It seems like the node-sqlite3 API either allows:
      // 1) all(), which returns results but not rowsAffected or lastID
      // 2) run(), which doesn't return results, but returns rowsAffected and lastID
      // So we try to sniff whether it's a SELECT query or not.
      // This is inherently error-prone, although it will probably work in the 99%
      // case.
      const isSelect = (/^\s*SELECT\b/iv).test(sql);

      if (readOnly && !isSelect) {
        onQueryComplete(i)(new SQLiteResult(READ_ONLY_ERROR));
      } else if (isSelect) {
        runSelect(db, sql, args, onQueryComplete(i));
      } else {
        runNonSelect(db, sql, args, onQueryComplete(i));
      }
    }

    doNext();
  }
}

export default SQLiteDatabase;
