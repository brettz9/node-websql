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

/**
 * V8 likes predictable objects.
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
 * The WebSQL `Database` object.
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
   *
   */
  #runTransaction () {
    const txn = new WebSQLTransaction(this, this._executeDelay);

    this._transactionDelay(() => {
      const currentTask = /** @type {TransactionTask} */ (this._currentTask);
      currentTask.txnCallback(txn);
      txn._checkDone();
    });
  }

  /**
   *
   */
  #runNextTransaction () {
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
    this.#runNextTransaction();
  }

  /**
   * Not a true `#private` method: `WebSQLTransaction` calls this on its
   * owning `WebSQLDatabase` once it's finished running its SQL queue.
   * @param {Error | null} err
   * @param {WebSQLTransaction} transaction
   */
  // eslint-disable-next-line unicorn/prefer-private-class-fields -- see above
  _onTransactionComplete (err, transaction) {
    /**
     * @param {Error | boolean | null} [er]
     */
    const done = (er) => {
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
        if (this._currentTask) {
          this._currentTask.errorCallback(/** @type {Error} */ (er));
        }
      } else if (this._currentTask) {
        this._currentTask.successCallback();
      }
      this._running = false;
      this._currentTask = null;
      this.#runNextTransaction();
    };
    /**
     * @param {Error | boolean} er
     * @param {() => void} [cb]
     */
    const rollback = (er, cb) => {
      this._db.exec(ROLLBACK, false, () => {
        done(er);
        if (cb) {
          cb();
        }
      });
    };
    /**
     * @param {() => void} [cb]
     */
    const commit = (cb) => {
      this._db.exec(COMMIT, false, () => {
        done();
        if (cb) {
          cb();
        }
      });
    };

    if (this._currentTask && this._currentTask.nonstandardTransCb) {
      const cont = this._currentTask.nonstandardTransCb.call(this, this._currentTask, err, done, rollback, commit);
      if (!cont) {
        return;
      }
    }
    if (this._currentTask && this._currentTask.readOnly) {
      done(err); // read-only doesn't require a transaction
    } else if (err) {
      rollback(err);
    } else {
      commit();
    }
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
