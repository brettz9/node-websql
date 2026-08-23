import sqlite3 from 'sqlite3';
import SQLiteResult from './SQLiteResult.js';

/**
 * @typedef {object} SQLiteDatabaseOptions
 * @property {number} [busyTimeout]
 * @property {(sql: string) => void} [trace]
 * @property {(sql: string, time: number) => void} [profile]
 */

var READ_ONLY_ERROR = new Error(
  'could not prepare statement (23 not authorized)');

/**
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 * @param {unknown[]} args
 * @param {(result: SQLiteResult) => void} cb
 */
function runSelect(db, sql, args, cb) {
  db.all(sql, args, function (err, /** @type {unknown[]} */ rows) {
    if (err) {
      return cb(new SQLiteResult(err));
    }
    var insertId = void 0;
    var rowsAffected = 0;
    var resultSet = new SQLiteResult(null, insertId, rowsAffected, rows);
    cb(resultSet);
  });
}

/**
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 * @param {unknown[]} args
 * @param {(result: SQLiteResult) => void} cb
 */
function runNonSelect(db, sql, args, cb) {
  db.run(sql, args, function (err) {
    if (err) {
      return cb(new SQLiteResult(err));
    }

    var executionResult = this;
    var insertId = executionResult.lastID;
    var rowsAffected = executionResult.changes;
    /** @type {unknown[]} */
    var rows = [];
    var resultSet = new SQLiteResult(null, insertId, rowsAffected, rows);
    cb(resultSet);
  });
}

class SQLiteDatabase {
  /**
   * @param {string} name
   * @param {SQLiteDatabaseOptions} [opts]
   */
  constructor(name, opts) {
    opts = opts || {};
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
  exec(queries, readOnly, callback) {

    var db = this._db;
    var len = queries.length;
    /** @type {SQLiteResult[]} */
    var results = new Array(len);

    var i = 0;

    function checkDone() {
      if (++i === len) {
        callback(null, results);
      } else {
        doNext();
      }
    }

    /**
     * @param {number} i
     */
    function onQueryComplete(i) {
      return function (/** @type {SQLiteResult} */ res) {
        results[i] = res;
        checkDone();
      };
    }

    function doNext() {
      var query = queries[i];
      var sql = query.sql;
      var args = query.args;

      // TODO: It seems like the node-sqlite3 API either allows:
      // 1) all(), which returns results but not rowsAffected or lastID
      // 2) run(), which doesn't return results, but returns rowsAffected and lastID
      // So we try to sniff whether it's a SELECT query or not.
      // This is inherently error-prone, although it will probably work in the 99%
      // case.
      var isSelect = /^\s*SELECT\b/i.test(sql);

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
