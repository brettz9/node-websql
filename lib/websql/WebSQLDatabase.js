'use strict';

var Queue = require('tiny-queue');
var immediate = require('immediate');
var noop = require('noop-fn');

var WebSQLTransaction = require('./WebSQLTransaction');

var ROLLBACK = [
  {sql: 'ROLLBACK;', args: []}
];

var COMMIT = [
  {sql: 'END;', args: []}
];

// v8 likes predictable objects
function TransactionTask(readOnly, txnCallback, errorCallback, successCallback, nonstandardTransCb) {
  this.readOnly = readOnly;
  this.txnCallback = txnCallback;
  this.errorCallback = errorCallback;
  this.successCallback = successCallback;
  this.nonstandardTransCb = nonstandardTransCb;
}

function WebSQLDatabase(dbVersion, db, webSQLOverrides) {
  this.version = dbVersion;
  this._db = db;
  this._txnQueue = new Queue();
  this._running = false;
  this._currentTask = null;
  this._readonlyTaskSiblings = [];
  this._transactionDelay = webSQLOverrides.transactionDelay || immediate;
  this._executeDelay = webSQLOverrides.executeDelay;
}

WebSQLDatabase.prototype._onTransactionComplete = function(err) {
  var self = this;

  function done(er) {
    if (er) {
      self._currentTask && self._currentTask.errorCallback(er);
      self._readonlyTaskSiblings.forEach(function (tc) {
          tc.errorCallback(er);
      });
    } else {
      self._currentTask && self._currentTask.successCallback();
      self._readonlyTaskSiblings.forEach(function (tc) {
          tc.successCallback();
      });
    }
    self._running = false;
    self._currentTask = null;
    self._readonlyTaskSiblings = [];
    self._runNextTransaction();
  }
  function rollback (er, cb) {
    self._db.exec(ROLLBACK, false, function () {
      done(er);
      if (cb) {
        cb();
      }
    });
  }
  function commit (cb) {
    self._db.exec(COMMIT, false, function () {
      done();
      if (cb) {
        cb();
      }
    });
  }

  if (self._currentTask && self._currentTask.nonstandardTransCb) {
    // No need to run the nonstandard callbacks on the read-only siblings if this is read-only
    var cont = self._currentTask.nonstandardTransCb.call(this, self._currentTask, err, done, rollback, commit);
    if (!cont) {
        return;
    }
  }
  if (err) {
    rollback(err);
  } else {
    commit();
  }
};

WebSQLDatabase.prototype._runTransaction = function () {
  var self = this;
  var txn = self._currentTxn = new WebSQLTransaction(self, this._executeDelay);

  this._transactionDelay(function () {
    delete self._currentTxn;
    self._currentTask.txnCallback(txn);
    self._readonlyTaskSiblings.forEach(function (tc) {
        tc.txnCallback(txn);
    });
    txn._checkDone();
  });
};

WebSQLDatabase.prototype._runNextTransaction = function(runningTransTask) {
  if (this._running) {
    // We don't risk write-starvation here, as we only add to the last task
    if (this._currentTask &&
        this._currentTask.readOnly &&
        runningTransTask.readOnly &&
        !this._currentTxn._complete
    ) {
      // Treat this read-only task as part of the last old read-only transaction if still running
      this._readonlyTaskSiblings.push(runningTransTask);
      return;
    }
    this._txnQueue.push(runningTransTask);
    return;
  }
  if (runningTransTask) {
    this._txnQueue.push(runningTransTask);
  }
  var task = this._txnQueue.shift();

  if (!task) {
    return;
  }

  this._currentTask = task;
  this._running = true;
  this._runTransaction();
};

WebSQLDatabase.prototype._createTransaction = function(
    readOnly, txnCallback, errorCallback, successCallback, nonstandardTransCb) {
  errorCallback = errorCallback || noop;
  successCallback = successCallback || noop;

  if (typeof txnCallback !== 'function') {
    throw new Error('The callback provided as parameter 1 is not a function.');
  }

  this._runNextTransaction(new TransactionTask(readOnly, txnCallback, errorCallback, successCallback, nonstandardTransCb));
};

WebSQLDatabase.prototype.transaction = function (txnCallback, errorCallback, successCallback, nonstandardTransCb) {
  this._createTransaction(false, txnCallback, errorCallback, successCallback, nonstandardTransCb);
};

WebSQLDatabase.prototype.readTransaction = function (txnCallback, errorCallback, successCallback) {
  this._createTransaction(true, txnCallback, errorCallback, successCallback);
};

module.exports = WebSQLDatabase;
