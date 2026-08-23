import immediate from 'immediate';

import WebSQLDatabase from './websql/WebSQLDatabase.js';

/**
 * @template Opts
 * @param {import('./types.js').SqlDriverConstructor<Opts>} SQLiteDatabase
 * @param {{ sqlite?: Opts, websql?: import('./types.js').WebSQLOverrides }} [opts]
 */
function customOpenDatabase (SQLiteDatabase, opts) {
  opts ||= {};
  const sqliteOpts = opts.sqlite;
  const webSQLOverrides = opts.websql || {};
  const openDelay = webSQLOverrides.openDelay || immediate;

  /**
   * @param {string} dbName
   * @param {string} dbVersion
   */
  function createDb (dbName, dbVersion) {
    const sqliteDatabase = new SQLiteDatabase(dbName, sqliteOpts);
    return new WebSQLDatabase(dbVersion, sqliteDatabase, webSQLOverrides);
  }

  /**
   * @param {unknown[]} args
   * @throws {Error} If fewer than 4 arguments are given.
   */
  function openDatabase (args) {
    if (args.length < 4) {
      throw new Error('Failed to execute \'openDatabase\': ' +
        '4 arguments required, but only ' + args.length + ' present');
    }

    const dbName = /** @type {string} */ (args[0]);
    const dbVersion = /** @type {string} */ (args[1]);
    // db description and size are ignored
    const callback = /** @type {((db: WebSQLDatabase) => void) | undefined} */ (args[4]);

    const db = createDb(dbName, dbVersion);

    if (typeof callback === 'function') {
      const onOpen = callback;
      openDelay(function () {
        onOpen(db);
      });
    }

    return db;
  }

  return (/** @type {unknown[]} */ ...args) => openDatabase(args);
}

export default customOpenDatabase;
