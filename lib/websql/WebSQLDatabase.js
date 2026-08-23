import Queue from 'tiny-queue';
import immediate from 'immediate';
import noop from 'noop-fn';

import WebSQLTransaction from './WebSQLTransaction.js';

/**
 * @typedef {(
 *   currentTask: TransactionTask,
 *   err: Error | null,
 *   done: () => void,
 *   rollback: (err: Error | boolean, cb: () => void) => void,
 *   commit: (cb: () => void) => void
 * ) => boolean} NonstandardTransCb
 */

const ROLLBACK = [
  {sql: 'ROLLBACK;', args: []}
];

const COMMIT = [
  {sql: 'END;', args: []}
];

// v8 likes predictable objects
/**
 *
 */
class TransactionTask {
  /**
   * @param {boolean} readOnly
   * @param {(trans: WebSQLTransaction) => void} txnCallback
   * @param {(err: Error) => void} errorCallback
   * @param {() => void} successCallback
   * @param {NonstandardTransCb} [nonstandardTransCb]
   */
  constructor (readOnly, txnCallback, errorCallback, successCallback, nonstandardTransCb) {
    this.readOnly = readOnly;
    this.txnCallback = txnCallback;
    this.errorCallback = errorCallback;
    this.successCallback = successCallback;
    this.nonstandardTransCb = nonstandardTransCb;
  }
}

/**
 *
 */
class WebSQLDatabase {
  /**
   * @param {string} dbVersion
   * @param {import('../types.js').SqlDriver} db
   * @param {import('../types.js').WebSQLOverrides} webSQLOverrides
   */
  constructor (dbVersion, db, webSQLOverrides) {
    this.version = dbVersion;
    this._db = db;
    /** @type {import('tiny-queue').default<TransactionTask>} */
    this._txnQueue = new Queue();
    this._running = false;
    /** @type {TransactionTask | null} */
    this._currentTask = null;
    this._transactionDelay = webSQLOverrides.transactionDelay || immediate;
    this._executeDelay = webSQLOverrides.executeDelay || immediate;
  }

  /**
   * @param {Error | null} err
   * @param {WebSQLTransaction} transaction
   */
  // Not a true `#private` method: `WebSQLTransaction` calls this on its
  // owning `WebSQLDatabase` once it's finished running its SQL queue.
  _onTransactionComplete (err, transaction) {
    const self = this;

    /**
     * @param {Error | boolean | null} [er]
     */
    function done (er) {
      if (transaction) {
        // Only now -- once the transaction has genuinely committed, rolled
        // back, or been confirmed read-only-complete -- is it truly done.
        // Marking this any earlier (e.g. as soon as its SQL queue merely
        // looked empty) would permanently stop it from accepting further
        // `executeSql()` calls even when `nonstandardTransCb` (below) chose
        // to defer the commit/rollback decision instead of finalizing here.
        transaction._complete = true;
      }
      if (er) {
        self._currentTask && self._currentTask.errorCallback(/** @type {Error} */ (er));
      } else {
        self._currentTask && self._currentTask.successCallback();
      }
      self._running = false;
      self._currentTask = null;
      self._runNextTransaction();
    }
    /**
     * @param {Error | boolean} er
     * @param {() => void} [cb]
     */
    function rollback (er, cb) {
      self._db.exec(ROLLBACK, false, function () {
        done(er);
        if (cb) {
          cb();
        }
      });
    }
    /**
     * @param {() => void} [cb]
     */
    function commit (cb) {
      self._db.exec(COMMIT, false, function () {
        done();
        if (cb) {
          cb();
        }
      });
    }

    if (self._currentTask && self._currentTask.nonstandardTransCb) {
      const cont = self._currentTask.nonstandardTransCb.call(this, self._currentTask, err, done, rollback, commit);
      if (!cont) {
        return;
      }
    }
    if (self._currentTask && self._currentTask.readOnly) {
      done(err); // read-only doesn't require a transaction
    } else if (err) {
      rollback(err);
    } else {
      commit();
    }
  }

  /**
   *
   */
  #runTransaction () {
    const self = this;
    const txn = new WebSQLTransaction(self, this._executeDelay);

    this._transactionDelay(function () {
      const currentTask = /** @type {TransactionTask} */ (self._currentTask);
      currentTask.txnCallback(txn);
      txn._checkDone();
    });
  }

  /**
   *
   */
  _runNextTransaction () {
    if (this._running) {
      return;
    }
    const task = this._txnQueue.shift();

    if (!task) {
      return;
    }

    this._currentTask = task;
    this._running = true;
    this.#runTransaction();
  }

  /**
   * @param {boolean} readOnly
   * @param {(trans: WebSQLTransaction) => void} txnCallback
   * @param {(err: Error) => void} [errorCallback]
   * @param {() => void} [successCallback]
   * @param {NonstandardTransCb} [nonstandardTransCb]
   */
  #createTransaction (
    readOnly, txnCallback, errorCallback, successCallback, nonstandardTransCb
  ) {
    errorCallback ||= noop;
    successCallback ||= noop;

    if (typeof txnCallback !== 'function') {
      throw new TypeError('The callback provided as parameter 1 is not a function.');
    }

    this._txnQueue.push(new TransactionTask(readOnly, txnCallback, errorCallback, successCallback, nonstandardTransCb));
    this._runNextTransaction();
  }

  /**
   * @param {(trans: WebSQLTransaction) => void} txnCallback
   * @param {(err: Error) => void} [errorCallback]
   * @param {() => void} [successCallback]
   * @param {NonstandardTransCb} [nonstandardTransCb]
   */
  transaction (txnCallback, errorCallback, successCallback, nonstandardTransCb) {
    this.#createTransaction(false, txnCallback, errorCallback, successCallback, nonstandardTransCb);
  }

  /**
   * @param {(trans: WebSQLTransaction) => void} txnCallback
   * @param {(err: Error) => void} [errorCallback]
   * @param {() => void} [successCallback]
   */
  readTransaction (txnCallback, errorCallback, successCallback) {
    this.#createTransaction(true, txnCallback, errorCallback, successCallback);
  }
}

export default WebSQLDatabase;
export {TransactionTask};
