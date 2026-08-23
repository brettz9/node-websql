import immediate from 'immediate';

import WebSQLDatabase from './websql/WebSQLDatabase.js';

/**
 * @template Opts
 * @param {import('./types.js').SqlDriverConstructor<Opts>} SQLiteDatabase
 * @param {{ sqlite?: Opts, websql?: import('./types.js').WebSQLOverrides }} [opts]
 */
function customOpenDatabase(SQLiteDatabase, opts) {
  opts = opts || {};
  var sqliteOpts = opts.sqlite;
  var webSQLOverrides = opts.websql || {};
  var openDelay = webSQLOverrides.openDelay || immediate;

  /**
   * @param {string} dbName
   * @param {string} dbVersion
   */
  function createDb(dbName, dbVersion) {
    var sqliteDatabase = new SQLiteDatabase(dbName, sqliteOpts);
    return new WebSQLDatabase(dbVersion, sqliteDatabase, webSQLOverrides);
  }

  /**
   * @param {unknown[]} args
   */
  function openDatabase(args) {

    if (args.length < 4) {
      throw new Error('Failed to execute \'openDatabase\': ' +
        '4 arguments required, but only ' + args.length + ' present');
    }

    var dbName = /** @type {string} */ (args[0]);
    var dbVersion = /** @type {string} */ (args[1]);
    // db description and size are ignored
    var callback = /** @type {((db: WebSQLDatabase) => void) | undefined} */ (args[4]);

    var db = createDb(dbName, dbVersion);

    if (typeof callback === 'function') {
      var onOpen = callback;
      openDelay(function () {
        onOpen(db);
      });
    }

    return db;
  }

  return (/** @type {unknown[]} */ ...args) => openDatabase(args);
}

export default customOpenDatabase;
