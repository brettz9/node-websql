import Queue from 'tiny-queue';
import immediate from 'immediate';
import noop from 'noop-fn';

import WebSQLTransaction from './WebSQLTransaction.js';

/**
 * @typedef {(
 *   currentTask: TransactionTask,
 *   err: Error | null,
 *   done: (er?: Error | boolean | null) => void,
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
    // Off by default: queued transactions -- read or write alike -- run
    // strictly one at a time, in the order requested, per the WebSQL spec
    // (see `#runNextTransaction`). When true, any number of read-only
    // tasks may instead run concurrently; a non-read-only task still
    // always runs with full exclusivity either way.
    this._concurrentReaders = Boolean(webSQLOverrides.concurrentReaders);
    /** @type {Set<TransactionTask>} */
    this._activeReaders = new Set();
    /** @type {TransactionTask | null} */
    this._activeWriter = null;
    this._transactionDelay = webSQLOverrides.transactionDelay || immediate;
    this._executeDelay = webSQLOverrides.executeDelay || immediate;
  }

  /**
   * @param {TransactionTask} task
   */
  #runTransaction (task) {
    const txn = new WebSQLTransaction(this, task, this._executeDelay);

    this._transactionDelay(() => {
      task.txnCallback(txn);
      txn._checkDone();
    });
  }

  /**
   * Starts as many queued tasks as the current lock state allows. With
   * `concurrentReaders` off (the default), a task only starts once
   * nothing else is active at all -- full mutual exclusion, matching the
   * WebSQL spec's strict one-at-a-time, in-request-order guarantee (see
   * this file's own test suite, "callback order 2"). With it on, any
   * leading run of read-only tasks can all start together instead
   * (concurrent reads are always fine); a non-read-only task still needs
   * exclusivity regardless, so nothing past it may start until it
   * finishes. Not starvation-proof in the `concurrentReaders` case -- a
   * steady stream of arriving readers could in principle keep a waiting
   * writer waiting indefinitely -- but that's an acceptable tradeoff over
   * the added complexity of tracking arrival order across reader/writer
   * kinds.
   */
  #runNextTransaction () {
    for (;;) {
      const [nextTask] = this._txnQueue.slice(0, 1);
      if (!nextTask) {
        return;
      }
      const readerMayShare = this._concurrentReaders && nextTask.readOnly;
      if (readerMayShare) {
        if (this._activeWriter) {
          return;
        }
      } else if (this._activeWriter || this._activeReaders.size) {
        return;
      }
      this._txnQueue.shift();
      if (nextTask.readOnly) {
        this._activeReaders.add(nextTask);
      } else {
        this._activeWriter = nextTask;
      }
      this.#runTransaction(nextTask);
    }
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
    const task = transaction._task;
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
        task.errorCallback(/** @type {Error} */ (er));
      } else {
        task.successCallback();
      }
      if (task.readOnly) {
        this._activeReaders.delete(task);
      } else if (this._activeWriter === task) {
        this._activeWriter = null;
      }
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

    if (task.nonstandardTransCb) {
      const cont = task.nonstandardTransCb.call(this, task, err, done, rollback, commit);
      if (!cont) {
        return;
      }
    }
    if (task.readOnly) {
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
   * @param {NonstandardTransCb} [nonstandardTransCb]
   */
  readTransaction (txnCallback, errorCallback, successCallback, nonstandardTransCb) {
    this.#createTransaction(true, txnCallback, errorCallback, successCallback, nonstandardTransCb);
  }
}

export default WebSQLDatabase;
export {TransactionTask};
