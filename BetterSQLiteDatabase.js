'use strict';

var Database = require('better-sqlite3');
var SQLiteResult = require('./lib/sqlite/SQLiteResult');

var READ_ONLY_ERROR = new Error(
  'could not prepare statement (23 not authorized)');

function SQLiteDatabase(name, opts) {
  // We add our own `timeout` default to continue using node-sqlite's
  //  1000ms default instead of using `better-sqlite3`'s 5000ms default
  opts = opts || {};
  opts = Object.assign({
      memory: name === ':memory:', // `better-sqlite3` requires this
      timeout: opts.busyTimeout || 1000
  }, opts); // Can use `timeout` too
  // `trace` and `profile` options of node-sqlite3 are not supported
  // `better-sqlite3` does not support the empty string like
  //    node-sqlite3 (an anonymous disk-based database): https://github.com/JoshuaWise/better-sqlite3/issues/208
  this._db = new Database(name, opts);
}

function runSelect(db, sql, args, cb) {
  var rows;
  try {
    var stmt = db.prepare(sql);
    rows = stmt.all(...args);
  } catch (err) {
    return cb(new SQLiteResult(err));
  }
  var insertId = void 0;
  var rowsAffected = 0;
  var resultSet = new SQLiteResult(null, insertId, rowsAffected, rows);
  cb(resultSet);
}

function runNonSelect(db, sql, args, cb) {
  var executionResult;
  try {
    var stmt = db.prepare(sql);
    executionResult = stmt.run(...args);
  } catch (err) {
    return cb(new SQLiteResult(err));
  }
  /* jshint validthis:true */
  var insertId = executionResult.lastInsertRowid;
  var rowsAffected = executionResult.changes;
  var rows = [];
  var resultSet = new SQLiteResult(null, insertId, rowsAffected, rows);
  cb(resultSet);
}

SQLiteDatabase.prototype.exec = function exec(queries, readOnly, callback) {

  var db = this._db;
  var len = queries.length;
  var results = new Array(len);

  var i = 0;

  function checkDone() {
    if (++i === len) {
      callback(null, results);
    } else {
      doNext();
    }
  }

  function onQueryComplete(i) {
    return function (res) {
      results[i] = res;
      checkDone();
    };
  }

  function doNext() {
    var query = queries[i];
    var sql = query.sql;
    // BetterSQLite doesn't convert booleans to the integers it needs
    var args = query.args.map((v) => typeof v === 'boolean' ? Number(v) : v);

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
};

module.exports = SQLiteDatabase;
