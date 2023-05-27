import immediate from 'immediate';

import WebSQLDatabase from './websql/WebSQLDatabase.js';

function customOpenDatabase(SQLiteDatabase, opts) {
  opts = opts || {};
  var sqliteOpts = opts.sqlite;
  var webSQLOverrides = opts.websql || {};
  var openDelay = webSQLOverrides.openDelay || immediate;

  function createDb(dbName, dbVersion) {
    var sqliteDatabase = new SQLiteDatabase(dbName, sqliteOpts);
    return new WebSQLDatabase(dbVersion, sqliteDatabase, webSQLOverrides);
  }

  function openDatabase(args) {

    if (args.length < 4) {
      throw new Error('Failed to execute \'openDatabase\': ' +
        '4 arguments required, but only ' + args.length + ' present');
    }

    var dbName = args[0];
    var dbVersion = args[1];
    // db description and size are ignored
    var callback = args[4];

    var db = createDb(dbName, dbVersion);

    if (typeof callback === 'function') {
      openDelay(function () {
        callback(db);
      });
    }

    return db;
  }

  return (...args) => openDatabase(args);
}

export default customOpenDatabase;
