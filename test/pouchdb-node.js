

/**
 *
 * @param ex
 */
function _interopDefault (ex) {
  return (ex && (typeof ex === 'object') && 'default' in ex) ? ex.default : ex;
}

import jsExtend from 'js-extend';
const jsExtend__default = _interopDefault(jsExtend);
import debug from 'debug';
import inherits from 'inherits';
import lie from 'lie';
import pouchdbCollections from 'pouchdb-collections';
import getArguments from 'argsarray';
import events from 'node:events';
import scopedEval from 'scope-eval';
import pouchCollate from 'pouchdb-collate';
const pouchCollate__default = _interopDefault(pouchCollate);
import crypto from 'node:crypto';
import levelup from 'levelup';
import sublevel from 'sublevel-pouchdb';
import through2 from 'through2';
import vuvuzela from 'vuvuzela';
import fs from 'node:fs';
import path from 'node:path';
import LevelWriteStream from 'level-write-stream';
import Deque from 'double-ended-queue';

/* c8 ignore next */
const PouchPromise = typeof Promise === 'function' ? Promise : lie;

// like underscore/lodash _.pick()
/**
 *
 * @param obj
 * @param arr
 */
function pick (obj, arr) {
  const res = {};
  for (const prop of arr) {
    if (prop in obj) {
      res[prop] = obj[prop];
    }
  }
  return res;
}

/**
 *
 * @param object
 */
function isBinaryObject (object) {
  return object instanceof Buffer;
}

/**
 *
 * @param object
 */
function cloneBinaryObject (object) {
  const copy = Buffer.alloc(object.length);
  object.copy(copy);
  return copy;
}

/**
 *
 * @param object
 */
function clone (object) {
  if (!object || typeof object !== 'object') {
    return object;
  }
  let newObject;
  let i;

  let len;

  if (Array.isArray(object)) {
    newObject = [];
    for (i = 0, len = object.length; i < len; i++) {
      newObject[i] = clone(object[i]);
    }
    return newObject;
  }

  // special case: to avoid inconsistencies between IndexedDB
  // and other backends, we automatically stringify Dates
  if (object instanceof Date) {
    return object.toISOString();
  }

  if (isBinaryObject(object)) {
    return cloneBinaryObject(object);
  }

  newObject = {};
  for (i in object) {
    if (!Object.prototype.hasOwnProperty.call(object, i)) {
      continue;
    }

    const value = clone(object[i]);
    if (typeof value !== 'undefined') {
      newObject[i] = value;
    }
  }
  return newObject;
}

/**
 *
 * @param fun
 */
function once (fun) {
  let called = false;
  return getArguments(function (args) {
    /* istanbul ignore if */
    if (called) {
      // this is a smoke test and should never actually happen
      throw new Error('once called more than once');
    }
    called = true;
    fun.apply(this, args);
  });
}

/**
 *
 * @param func
 */
function toPromise (func) {
  // create the function we will be returning
  return getArguments(function (args) {
    // Clone arguments
    args = clone(args);
    const self = this;
    const tempCB =
      (typeof args.at(-1) === 'function') ? args.pop() : false;
    // if the last argument is a function, assume its a callback
    let usedCB;
    if (tempCB) {
      // if it was a callback, create a new callback which calls it,
      // but do so async so we don't trap any errors
      usedCB = function (err, resp) {
        queueMicrotask(function () {
          tempCB(err, resp);
        });
      };
    }
    const promise = new PouchPromise(function (fulfill, reject) {
      try {
        const callback = once(function (err, mesg) {
          if (err) {
            reject(err);
          } else {
            fulfill(mesg);
          }
        });
        // create a callback for this invocation
        // apply the function in the orig context
        args.push(callback);
        const resp = func.apply(self, args);
        if (resp && typeof resp.then === 'function') {
          fulfill(resp);
        }
      } catch (e) {
        reject(e);
      }
    });
    // if there is a callback, call it back
    if (usedCB) {
      promise.then(function (result) {
        usedCB(null, result);
      }, usedCB);
    }
    return promise;
  });
}

const log = debug('pouchdb:api');

/**
 *
 * @param name
 * @param callback
 */
function adapterFun (name, callback) {
  /**
   *
   * @param self
   * @param name
   * @param args
   */
  function logApiCall (self, name, args) {
    /* istanbul ignore if */
    if (!log.enabled) {
      return;
    }

    const logArgs = [self._db_name, name];
    for (let i = 0; i < args.length - 1; i++) {
      logArgs.push(args[i]);
    }
    log.apply(null, logArgs);

    // override the callback itself to log the response
    const origCallback = args.at(-1);
    args[args.length - 1] = function (err, res) {
      let responseArgs = [self._db_name, name];
      responseArgs = responseArgs.concat(
        err ? ['error', err] : ['success', res]
      );
      log.apply(null, responseArgs);
      origCallback(err, res);
    };
  }

  return toPromise(getArguments(function (args) {
    if (this._closed) {
      return PouchPromise.reject(new Error('database is closed'));
    }
    if (this._destroyed) {
      return PouchPromise.reject(new Error('database is destroyed'));
    }
    const self = this;
    logApiCall(self, name, args);
    if (!this.taskqueue.isReady) {
      return new PouchPromise(function (fulfill, reject) {
        self.taskqueue.addTask(function (failed) {
          if (failed) {
            reject(failed);
          } else {
            fulfill(self[name].apply(self, args));
          }
        });
      });
    }
    return callback.apply(this, args);
  }));
}

// this is essentially the "update sugar" function from daleharvey/pouchdb#1388
// the diffFun tells us what delta to apply to the doc.  it either returns
// the doc, or false if it doesn't need to do an update after all
/**
 *
 * @param db
 * @param docId
 * @param diffFun
 */
function upsert (db, docId, diffFun) {
  return new PouchPromise(function (fulfill, reject) {
    db.get(docId, function (err, doc) {
      if (err) {
        /* c8 ignore next */
        if (err.status !== 404) {
          return reject(err);
        }
        doc = {};
      }

      // the user might change the _rev, so save it for posterity
      const docRev = doc._rev;
      const newDoc = diffFun(doc);

      if (!newDoc) {
        // if the diffFun returns falsy, we short-circuit as
        // an optimization
        return fulfill({updated: false, rev: docRev});
      }

      // users aren't allowed to modify these values,
      // so reset them here
      newDoc._id = docId;
      newDoc._rev = docRev;
      fulfill(tryAndPut(db, newDoc, diffFun));
    });
  });
}

/**
 *
 * @param db
 * @param doc
 * @param diffFun
 */
function tryAndPut (db, doc, diffFun) {
  return db.put(doc).then(function (res) {
    return {
      updated: true,
      rev: res.rev
    };
  }, function (err) {
    /* c8 ignore next */
    if (err.status !== 409) {
      throw err;
    }
    return upsert(db, doc._id, diffFun);
  });
}

// We fetch all leafs of the revision tree, and sort them based on tree length
// and whether they were deleted, undeleted documents with the longest revision
// tree (most edits) win
// The final sort algorithm is slightly documented in a sidebar here:
// https://guide.couchdb.org/draft/conflicts.html
/**
 *
 * @param metadata
 */
function winningRev (metadata) {
  let winningId;
  let winningPos;
  let winningDeleted;
  const toVisit = [...metadata.rev_tree];
  let node;
  while ((node = toVisit.pop())) {
    const tree = node.ids;
    const branches = tree[2];
    const {pos} = node;
    if (branches.length) { // non-leaf
      for (const branch of branches) {
        toVisit.push({pos: pos + 1, ids: branch});
      }
      continue;
    }
    const deleted = Boolean(tree[1].deleted);
    const id = tree[0];
    // sort by deleted, then pos, then id
    if (!winningId || (winningDeleted !== deleted
      ? winningDeleted
      : winningPos !== pos ? winningPos < pos : winningId < id)) {
      winningId = id;
      winningPos = pos;
      winningDeleted = deleted;
    }
  }

  return winningPos + '-' + winningId;
}

/**
 *
 * @param node
 */
function getTrees (node) {
  return node.ids;
}

// check if a specific revision of a doc has been deleted
//  - metadata: the metadata object from the doc store
//  - rev: (optional) the revision to check. defaults to winning revision
/**
 *
 * @param metadata
 * @param rev
 */
function isDeleted (metadata, rev) {
  if (!rev) {
    rev = winningRev(metadata);
  }
  const id = rev.slice(Math.max(0, rev.indexOf('-') + 1));
  let toVisit = metadata.rev_tree.map(getTrees);

  let tree;
  while ((tree = toVisit.pop())) {
    if (tree[0] === id) {
      return Boolean(tree[1].deleted);
    }
    toVisit = toVisit.concat(tree[2]);
  }
}

/**
 *
 * @param input
 */
function evalFilter (input) {
  return scopedEval('return ' + input + ';', {});
}

/**
 *
 * @param input
 */
function evalView (input) {
  return new Function('doc', [
    'var emitted = false;',
    'var emit = function (a, b) {',
    '  emitted = true;',
    '};',
    'var view = ' + input + ';',
    'view(doc);',
    'if (emitted) {',
    '  return true;',
    '}'
  ].join('\n'));
}

/**
 *
 * @param s
 */
function parseDesignDocFunctionName (s) {
  if (!s) {
    return null;
  }
  const parts = s.split('/');
  if (parts.length === 2) {
    return parts;
  }
  if (parts.length === 1) {
    return [s, s];
  }
  return null;
}

/**
 *
 * @param s
 */
function normalizeDesignDocFunctionName (s) {
  const normalized = parseDesignDocFunctionName(s);
  return normalized ? normalized.join('/') : null;
}

// Pretty much all below can be combined into a higher order function to
// traverse revisions
// The return value from the callback will be passed as context to all
// children of that node
/**
 *
 * @param revs
 * @param callback
 */
function traverseRevTree (revs, callback) {
  const toVisit = [...revs];

  let node;
  while ((node = toVisit.pop())) {
    const {pos} = node;
    const tree = node.ids;
    const branches = tree[2];
    const newCtx =
      callback(branches.length === 0, pos, tree[0], node.ctx, tree[1]);
    for (const branch of branches) {
      toVisit.push({pos: pos + 1, ids: branch, ctx: newCtx});
    }
  }
}

/**
 *
 * @param a
 * @param b
 */
function sortByPos (a, b) {
  return a.pos - b.pos;
}

/**
 *
 * @param revs
 */
function collectLeaves (revs) {
  const leaves = [];
  traverseRevTree(revs, function (isLeaf, pos, id, acc, opts) {
    if (isLeaf) {
      leaves.push({rev: pos + '-' + id, pos, opts});
    }
  });
  leaves.sort(sortByPos).reverse();
  for (const leaf of leaves) {
    delete leaf.pos;
  }
  return leaves;
}

// returns revs of all conflicts that is leaves such that
// 1. are not deleted and
// 2. are different than winning revision
/**
 *
 * @param metadata
 */
function collectConflicts (metadata) {
  const win = winningRev(metadata);
  const leaves = collectLeaves(metadata.rev_tree);
  const conflicts = [];
  for (const leaf of leaves) {
    if (leaf.rev !== win && !leaf.opts.deleted) {
      conflicts.push(leaf.rev);
    }
  }
  return conflicts;
}

inherits(PouchError, Error);

/**
 *
 * @param opts
 */
function PouchError (opts) {
  Error.call(this, opts.reason);
  this.status = opts.status;
  this.name = opts.error;
  this.message = opts.reason;
  this.error = true;
}

PouchError.prototype.toString = function () {
  return JSON.stringify({
    status: this.status,
    name: this.name,
    message: this.message,
    reason: this.reason
  });
};

const UNAUTHORIZED = new PouchError({
  status: 401,
  error: 'unauthorized',
  reason: 'Name or password is incorrect.'
});

const MISSING_BULK_DOCS = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: "Missing JSON list of 'docs'"
});

const MISSING_DOC = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'missing'
});

const REV_CONFLICT = new PouchError({
  status: 409,
  error: 'conflict',
  reason: 'Document update conflict'
});

const INVALID_ID = new PouchError({
  status: 400,
  error: 'invalid_id',
  reason: '_id field must contain a string'
});

const MISSING_ID = new PouchError({
  status: 412,
  error: 'missing_id',
  reason: '_id is required for puts'
});

const RESERVED_ID = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Only reserved document ids may start with underscore.'
});

const NOT_OPEN = new PouchError({
  status: 412,
  error: 'precondition_failed',
  reason: 'Database not open'
});

const UNKNOWN_ERROR = new PouchError({
  status: 500,
  error: 'unknown_error',
  reason: 'Database encountered an unknown error'
});

const BAD_ARG = new PouchError({
  status: 500,
  error: 'badarg',
  reason: 'Some query argument is invalid'
});

const INVALID_REQUEST = new PouchError({
  status: 400,
  error: 'invalid_request',
  reason: 'Request was invalid'
});

const QUERY_PARSE_ERROR = new PouchError({
  status: 400,
  error: 'query_parse_error',
  reason: 'Some query parameter is invalid'
});

const DOC_VALIDATION = new PouchError({
  status: 500,
  error: 'doc_validation',
  reason: 'Bad special document member'
});

const BAD_REQUEST = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Something wrong with the request'
});

const NOT_AN_OBJECT = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Document must be a JSON object'
});

const DB_MISSING = new PouchError({
  status: 404,
  error: 'not_found',
  reason: 'Database not found'
});

const IDB_ERROR = new PouchError({
  status: 500,
  error: 'indexed_db_went_bad',
  reason: 'unknown'
});

const WSQ_ERROR = new PouchError({
  status: 500,
  error: 'web_sql_went_bad',
  reason: 'unknown'
});

const LDB_ERROR = new PouchError({
  status: 500,
  error: 'levelDB_went_went_bad',
  reason: 'unknown'
});

const FORBIDDEN = new PouchError({
  status: 403,
  error: 'forbidden',
  reason: 'Forbidden by design doc validate_doc_update function'
});

const INVALID_REV = new PouchError({
  status: 400,
  error: 'bad_request',
  reason: 'Invalid rev format'
});

const FILE_EXISTS = new PouchError({
  status: 412,
  error: 'file_exists',
  reason: 'The database could not be created, the file already exists.'
});

const MISSING_STUB = new PouchError({
  status: 412,
  error: 'missing_stub'
});

const INVALID_URL = new PouchError({
  status: 413,
  error: 'invalid_url',
  reason: 'Provided URL is invalid'
});

const allErrors = {
  UNAUTHORIZED,
  MISSING_BULK_DOCS,
  MISSING_DOC,
  REV_CONFLICT,
  INVALID_ID,
  MISSING_ID,
  RESERVED_ID,
  NOT_OPEN,
  UNKNOWN_ERROR,
  BAD_ARG,
  INVALID_REQUEST,
  QUERY_PARSE_ERROR,
  DOC_VALIDATION,
  BAD_REQUEST,
  NOT_AN_OBJECT,
  DB_MISSING,
  WSQ_ERROR,
  LDB_ERROR,
  FORBIDDEN,
  INVALID_REV,
  FILE_EXISTS,
  MISSING_STUB,
  IDB_ERROR,
  INVALID_URL
};

/**
 *
 * @param error
 * @param reason
 * @param name
 */
function createError (error, reason, name) {
  /**
   *
   * @param reason
   */
  function CustomPouchError (reason) {
    // inherit error properties from our parent error manually
    // so as to allow proper JSON parsing.
    for (const p in error) {
      if (typeof error[p] !== 'function') {
        this[p] = error[p];
      }
    }
    if (name !== undefined) {
      this.name = name;
    }
    if (reason !== undefined) {
      this.reason = reason;
    }
  }
  CustomPouchError.prototype = PouchError.prototype;
  return new CustomPouchError(reason);
}

// Find one of the errors defined above based on the value
// of the specified property.
// If reason is provided prefer the error matching that reason.
// This is for differentiating between errors with the same name and status,
// eg, bad_request.
const getErrorTypeByProp = function (prop, value, reason) {
  const keys = Object.keys(allErrors).filter(function (key) {
    const error = allErrors[key];
    return typeof error !== 'function' && error[prop] === value;
  });
  const key = reason && keys.find(function (key) {
    const error = allErrors[key];
    return error.message === reason;
  }) || keys[0];
  return (key) ? allErrors[key] : null;
};

/**
 *
 * @param res
 */
function generateErrorFromResponse (res) {
  let error, errName, errType, errMsg, errReason;

  errName = (res.error === true && typeof res.name === 'string')
    ? res.name
    : res.error;
  errReason = res.reason;
  errType = getErrorTypeByProp('name', errName, errReason);

  if (res.missing ||
    errReason === 'missing' ||
    errReason === 'deleted' ||
    errName === 'not_found') {
    errType = MISSING_DOC;
  } else if (errName === 'doc_validation') {
    // doc validation needs special treatment since
    // res.reason depends on the validation error.
    // see utils.js
    errType = DOC_VALIDATION;
    errMsg = errReason;
  } else if (errName === 'bad_request' && errType.message !== errReason) {
    // if bad_request error already found based on reason don't override.
    errType = BAD_REQUEST;
  }

  // fallback to error by status or unknown error.
  if (!errType) {
    errType = getErrorTypeByProp('status', res.status, errReason) ||
      UNKNOWN_ERROR;
  }

  error = createError(errType, errReason, errName);

  // Keep custom message.
  if (errMsg) {
    error.message = errMsg;
  }

  // Keep helpful response data in our error messages.
  if (res.id) {
    error.id = res.id;
  }
  if (res.status) {
    error.status = res.status;
  }
  if (res.missing) {
    error.missing = res.missing;
  }

  return error;
}

inherits(Changes, events.EventEmitter);

/**
 *
 * @param db
 * @param opts
 * @param callback
 */
function Changes (db, opts, callback) {
  events.EventEmitter.call(this);
  const self = this;
  this.db = db;
  opts = opts ? clone(opts) : {};
  const complete = opts.complete = once(function (err, resp) {
    if (err) {
      self.emit('error', err);
    } else {
      self.emit('complete', resp);
    }
    self.removeAllListeners();
    db.removeListener('destroyed', onDestroy);
  });
  if (callback) {
    self.on('complete', function (resp) {
      callback(null, resp);
    });
    self.on('error', callback);
  }
  /**
   *
   */
  function onDestroy () {
    self.cancel();
  }
  db.once('destroyed', onDestroy);

  opts.onChange = function (change) {
    /* istanbul ignore if */
    if (opts.isCancelled) {
      return;
    }
    self.emit('change', change);
    if (self.startSeq && self.startSeq <= change.seq) {
      self.startSeq = false;
    }
  };

  const promise = new PouchPromise(function (fulfill, reject) {
    opts.complete = function (err, res) {
      if (err) {
        reject(err);
      } else {
        fulfill(res);
      }
    };
  });
  self.once('cancel', function () {
    db.removeListener('destroyed', onDestroy);
    opts.complete(null, {status: 'cancelled'});
  });
  this.then = promise.then.bind(promise);
  this.catch = promise.catch.bind(promise);
  this.then(function (result) {
    complete(null, result);
  }, complete);


  if (!db.taskqueue.isReady) {
    db.taskqueue.addTask(function () {
      if (self.isCancelled) {
        self.emit('cancel');
      } else {
        self.doChanges(opts);
      }
    });
  } else {
    self.doChanges(opts);
  }
}
Changes.prototype.cancel = function () {
  this.isCancelled = true;
  if (this.db.taskqueue.isReady) {
    this.emit('cancel');
  }
};
/**
 *
 * @param doc
 * @param metadata
 * @param opts
 */
function processChange (doc, metadata, opts) {
  let changeList = [{rev: doc._rev}];
  if (opts.style === 'all_docs') {
    changeList = collectLeaves(metadata.rev_tree).
      map(function (x) {
        return {rev: x.rev};
      });
  }
  const change = {
    id: metadata.id,
    changes: changeList,
    doc
  };

  if (isDeleted(metadata, doc._rev)) {
    change.deleted = true;
  }
  if (opts.conflicts) {
    change.doc._conflicts = collectConflicts(metadata);
    if (!change.doc._conflicts.length) {
      delete change.doc._conflicts;
    }
  }
  return change;
}

Changes.prototype.doChanges = function (opts) {
  const self = this;
  const callback = opts.complete;

  opts = clone(opts);
  if ('live' in opts && !('continuous' in opts)) {
    opts.continuous = opts.live;
  }
  opts.processChange = processChange;

  if (opts.since === 'latest') {
    opts.since = 'now';
  }
  if (!opts.since) {
    opts.since = 0;
  }
  if (opts.since === 'now') {
    this.db.info().then(function (info) {
      /* istanbul ignore if */
      if (self.isCancelled) {
        callback(null, {status: 'cancelled'});
        return;
      }
      opts.since = info.update_seq;
      self.doChanges(opts);
    }, callback);
    return;
  }

  if (opts.continuous && opts.since !== 'now') {
    this.db.info().then(function (info) {
      self.startSeq = info.update_seq;
      /* c8 ignore next */
    }, function (err) {
      if (err.id === 'idbNull') {
        // db closed before this returned thats ok
        return;
      }
      throw err;
    });
  }

  if (opts.filter && typeof opts.filter === 'string') {
    if (opts.filter === '_view') {
      opts.view = normalizeDesignDocFunctionName(opts.view);
    } else {
      opts.filter = normalizeDesignDocFunctionName(opts.filter);
    }

    if (this.db.type() !== 'http' && !opts.doc_ids) {
      return this.filterChanges(opts);
    }
  }

  if (!('descending' in opts)) {
    opts.descending = false;
  }

  // 0 and 1 should return 1 document
  opts.limit = opts.limit === 0 ? 1 : opts.limit;
  opts.complete = callback;
  const newPromise = this.db._changes(opts);
  if (newPromise && typeof newPromise.cancel === 'function') {
    const {cancel} = self;
    self.cancel = getArguments(function (args) {
      newPromise.cancel();
      cancel.apply(this, args);
    });
  }
};

Changes.prototype.filterChanges = function (opts) {
  const self = this;
  const callback = opts.complete;
  if (opts.filter === '_view') {
    if (!opts.view || typeof opts.view !== 'string') {
      const err = createError(BAD_REQUEST,
        '`view` filter parameter not found or invalid.');
      return callback(err);
    }
    // fetch a view from a design doc, make it behave like a filter
    const viewName = parseDesignDocFunctionName(opts.view);
    this.db.getView(viewName[0], viewName[1], function (err, view) {
      /* istanbul ignore if */
      if (self.isCancelled) {
        return callback(null, {status: 'cancelled'});
      }
      /* c8 ignore next */
      if (err) {
        return callback(generateErrorFromResponse(err));
      }
      if (!view.map) {
        return callback(createError(MISSING_DOC));
      }
      opts.filter = evalView(view.map);
      self.doChanges(opts);
    });
  } else {
    // fetch a filter from a design doc
    const filterName = parseDesignDocFunctionName(opts.filter);
    if (!filterName) {
      return self.doChanges(opts);
    }
    this.db.getFilter(filterName[0], filterName[1], function (err, filterFun) {
      /* istanbul ignore if */
      if (self.isCancelled) {
        return callback(null, {status: 'cancelled'});
      }
      /* c8 ignore next */
      if (err) {
        return callback(generateErrorFromResponse(err));
      }
      opts.filter = evalFilter(filterFun);
      self.doChanges(opts);
    });
  }
};

// shim for P/CouchDB adapters that don't directly implement _bulk_get
/**
 *
 * @param db
 * @param opts
 * @param callback
 */
function bulkGet (db, opts, callback) {
  const requests = Array.isArray(opts) ? opts : opts.docs;

  // consolidate into one request per doc if possible
  const requestsById = {};
  requests.forEach(function (request) {
    if (request.id in requestsById) {
      requestsById[request.id].push(request);
    } else {
      requestsById[request.id] = [request];
    }
  });

  const numDocs = Object.keys(requestsById).length;
  let numDone = 0;
  const perDocResults = new Array(numDocs);

  /**
   *
   */
  function collapseResults () {
    const results = [];
    perDocResults.forEach(function (res) {
      res.docs.forEach(function (info) {
        results.push({
          id: res.id,
          docs: [info]
        });
      });
    });
    callback(null, {results});
  }

  /**
   *
   */
  function checkDone () {
    if (++numDone === numDocs) {
      collapseResults();
    }
  }

  /**
   *
   * @param i
   * @param id
   * @param docs
   */
  function gotResult (i, id, docs) {
    perDocResults[i] = {id, docs};
    checkDone();
  }

  Object.keys(requestsById).forEach(function (docId, i) {
    const docRequests = requestsById[docId];

    // just use the first request as the "template"
    // TODO: The _bulk_get API allows for more subtle use cases than this,
    // but for now it is unlikely that there will be a mix of different
    // "atts_since" or "attachments" in the same request, since it's just
    // replicate.js that is using this for the moment.
    // Also, atts_since is aspirational, since we don't support it yet.
    const docOpts = pick(docRequests[0], ['atts_since', 'attachments']);
    docOpts.open_revs = docRequests.map(function (request) {
      // rev is optional, open_revs disallowed
      return request.rev;
    });

    // remove falsey / undefined revisions
    docOpts.open_revs = docOpts.open_revs.filter(Boolean);

    let formatResult = function (result) {
      return result;
    };

    if (docOpts.open_revs.length === 0) {
      delete docOpts.open_revs;

      // when fetching only the "winning" leaf,
      // transform the result so it looks like an open_revs
      // request
      formatResult = function (result) {
        return [{
          ok: result
        }];
      };
    }

    // globally-supplied options
    ['revs', 'attachments', 'binary', 'ajax'].forEach(function (param) {
      if (param in opts) {
        docOpts[param] = opts[param];
      }
    });
    db.get(docId, docOpts, function (err, res) {
      gotResult(i, docId, err ? [{error: err}] : formatResult(res));
    });
  });
}

/**
 *
 * @param id
 */
function isLocalId (id) {
  return (/^_local/).test(id);
}

// build up a list of all the paths to the leafs in this revision tree
/**
 *
 * @param revs
 */
function rootToLeaf (revs) {
  const paths = [];
  const toVisit = [...revs];
  let node;
  while ((node = toVisit.pop())) {
    const {pos} = node;
    const tree = node.ids;
    const id = tree[0];
    const opts = tree[1];
    const branches = tree[2];
    const isLeaf = branches.length === 0;

    const history = node.history ? [...node.history] : [];
    history.push({id, opts});
    if (isLeaf) {
      paths.push({pos: (pos + 1 - history.length), ids: history});
    }
    for (const branch of branches) {
      toVisit.push({pos: pos + 1, ids: branch, history});
    }
  }
  return paths.reverse();
}

// BEGIN Math.uuid.js

/* !
 Math.uuid.js (v1.4)
 https://www.broofa.com
 mailto:robert@broofa.com

 Copyright (c) 2010 Robert Kieffer
 Dual licensed under the MIT and GPL licenses.
 */

/*
 * Generate a random uuid.
 *
 * USAGE: Math.uuid(length, radix)
 *   length - the desired number of characters
 *   radix  - the number of allowable values for each character.
 *
 * EXAMPLES:
 *   // No arguments  - returns RFC4122, version 4 ID
 *   >>> Math.uuid()
 *   "92329D39-6F5C-4520-ABFC-AAB64544E172"
 *
 *   // One argument - returns ID of the specified length
 *   >>> Math.uuid(15)     // 15 character ID (default base=62)
 *   "VcydxgltxrVZSTV"
 *
 *   // Two arguments - returns ID of the specified length, and radix.
 *   // (Radix must be <= 62)
 *   >>> Math.uuid(8, 2)  // 8 character ID (base=2)
 *   "01001010"
 *   >>> Math.uuid(8, 10) // 8 character ID (base=10)
 *   "47473046"
 *   >>> Math.uuid(8, 16) // 8 character ID (base=16)
 *   "098F4D35"
 */
const chars = (
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz'
).split('');
/**
 *
 * @param radix
 */
function getValue (radix) {
  return 0 | Math.random() * radix;
}
/**
 *
 * @param len
 * @param radix
 */
function uuid (len, radix) {
  radix ||= chars.length;
  let out = '';
  let i = -1;

  if (len) {
    // Compact form
    while (++i < len) {
      out += chars[getValue(radix)];
    }
    return out;
  }
  // rfc4122, version 4 form
  // Fill in random data.  At i==19 set the high bits of clock sequence as
  // per rfc4122, sec. 4.1.5
  while (++i < 36) {
    switch (i) {
    case 8:
    case 13:
    case 18:
    case 23:
      out += '-';
      break;
    case 19:
      out += chars[(getValue(16) & 0x3) | 0x8];
      break;
    default:
      out += chars[getValue(16)];
    }
  }

  return out;
}

/**
 *
 * @param array
 */
function toObject (array) {
  return array.reduce(function (obj, item) {
    obj[item] = true;
    return obj;
  }, {});
}
// List of top level reserved words for doc
const reservedWords = toObject([
  '_id',
  '_rev',
  '_attachments',
  '_deleted',
  '_revisions',
  '_revs_info',
  '_conflicts',
  '_deleted_conflicts',
  '_local_seq',
  '_rev_tree',
  // replication documents
  '_replication_id',
  '_replication_state',
  '_replication_state_time',
  '_replication_state_reason',
  '_replication_stats',
  // Specific to Couchbase Sync Gateway
  '_removed'
]);

// List of reserved words that should end up the document
const dataWords = toObject([
  '_attachments',
  // replication documents
  '_replication_id',
  '_replication_state',
  '_replication_state_time',
  '_replication_state_reason',
  '_replication_stats'
]);

// Determine id an ID is valid
//   - invalid IDs begin with an underescore that does not begin '_design' or
//     '_local'
//   - any other string value is a valid id
// Returns the specific error object for each case
/**
 *
 * @param id
 */
function invalidIdError (id) {
  let err;
  if (!id) {
    err = createError(MISSING_ID);
  } else if (typeof id !== 'string') {
    err = createError(INVALID_ID);
  } else if ((id).startsWith('_') && !(/^_(design|local)/).test(id)) {
    err = createError(RESERVED_ID);
  }
  if (err) {
    throw err;
  }
}

/**
 *
 * @param rev
 */
function parseRevisionInfo (rev) {
  if (!(/^\d+\-./).test(rev)) {
    return createError(INVALID_REV);
  }
  const idx = rev.indexOf('-');
  const left = rev.slice(0, Math.max(0, idx));
  const right = rev.slice(Math.max(0, idx + 1));
  return {
    prefix: parseInt(left, 10),
    id: right
  };
}

/**
 *
 * @param revisions
 * @param opts
 */
function makeRevTreeFromRevisions (revisions, opts) {
  const pos = revisions.start - revisions.ids.length + 1;

  const revisionIds = revisions.ids;
  let ids = [revisionIds[0], opts, []];

  for (let i = 1, len = revisionIds.length; i < len; i++) {
    ids = [revisionIds[i], {status: 'missing'}, [ids]];
  }

  return [{
    pos,
    ids
  }];
}

// Preprocess documents, parse their revisions, assign an id and a
// revision for new writes that are missing them, etc
/**
 *
 * @param doc
 * @param newEdits
 */
function parseDoc (doc, newEdits) {
  let nRevNum;
  let newRevId;
  let revInfo;
  const opts = {status: 'available'};
  if (doc._deleted) {
    opts.deleted = true;
  }

  if (newEdits) {
    if (!doc._id) {
      doc._id = uuid();
    }
    newRevId = uuid(32, 16).toLowerCase();
    if (doc._rev) {
      revInfo = parseRevisionInfo(doc._rev);
      if (revInfo.error) {
        return revInfo;
      }
      doc._rev_tree = [{
        pos: revInfo.prefix,
        ids: [revInfo.id, {status: 'missing'}, [[newRevId, opts, []]]]
      }];
      nRevNum = revInfo.prefix + 1;
    } else {
      doc._rev_tree = [{
        pos: 1,
        ids: [newRevId, opts, []]
      }];
      nRevNum = 1;
    }
  } else {
    if (doc._revisions) {
      doc._rev_tree = makeRevTreeFromRevisions(doc._revisions, opts);
      nRevNum = doc._revisions.start;
      newRevId = doc._revisions.ids[0];
    }
    if (!doc._rev_tree) {
      revInfo = parseRevisionInfo(doc._rev);
      if (revInfo.error) {
        return revInfo;
      }
      nRevNum = revInfo.prefix;
      newRevId = revInfo.id;
      doc._rev_tree = [{
        pos: nRevNum,
        ids: [newRevId, opts, []]
      }];
    }
  }

  invalidIdError(doc._id);

  doc._rev = nRevNum + '-' + newRevId;

  const result = {metadata: {}, data: {}};
  for (const key in doc) {
    /* istanbul ignore else */
    if (!Object.prototype.hasOwnProperty.call(doc, key)) {
      continue;
    }

    const specialKey = key[0] === '_';
    if (specialKey && !reservedWords[key]) {
      const error = createError(DOC_VALIDATION, key);
      error.message = DOC_VALIDATION.message + ': ' + key;
      throw error;
    }
    if (specialKey && !dataWords[key]) {
      result.metadata[key.slice(1)] = doc[key];
    } else {
      result.data[key] = doc[key];
    }
  }
  return result;
}

/* * A generic pouch adapter */

/**
 *
 * @param left
 * @param right
 */
function compare (left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// returns first element of arr satisfying callback predicate
/**
 *
 * @param arr
 * @param callback
 */
function arrayFirst (arr, callback) {
  for (const [i, element] of arr.entries()) {
    if (callback(element, i) === true) {
      return element;
    }
  }
}

// Wrapper for functions that call the bulkdocs api with a single doc,
// if the first result is an error, return an error
/**
 *
 * @param callback
 */
function yankError (callback) {
  return function (err, results) {
    if (err || (results[0] && results[0].error)) {
      callback(err || results[0]);
    } else {
      callback(null, results.length ? results[0] : results);
    }
  };
}

// clean docs given to us by the user
/**
 *
 * @param docs
 */
function cleanDocs (docs) {
  for (const doc of docs) {
    if (doc._deleted) {
      delete doc._attachments; // ignore atts for deleted docs
    } else if (doc._attachments) {
      // filter out extraneous keys from _attachments
      const atts = Object.keys(doc._attachments);
      for (const att of atts) {
        doc._attachments[att] = pick(doc._attachments[att],
          ['data', 'digest', 'content_type', 'length', 'revpos', 'stub']);
      }
    }
  }
}

// compare two docs, first by _id then by _rev
/**
 *
 * @param a
 * @param b
 */
function compareByIdThenRev (a, b) {
  const idCompare = compare(a._id, b._id);
  if (idCompare !== 0) {
    return idCompare;
  }
  const aStart = a._revisions ? a._revisions.start : 0;
  const bStart = b._revisions ? b._revisions.start : 0;
  return compare(aStart, bStart);
}

// for every node in a revision tree computes its distance from the closest
// leaf
/**
 *
 * @param revs
 */
function computeHeight (revs) {
  const height = {};
  const edges = [];
  traverseRevTree(revs, function (isLeaf, pos, id, prnt) {
    const rev = pos + '-' + id;
    if (isLeaf) {
      height[rev] = 0;
    }
    if (prnt !== undefined) {
      edges.push({from: prnt, to: rev});
    }
    return rev;
  });

  edges.reverse();
  edges.forEach(function (edge) {
    height[edge.from] = height[edge.from] === undefined ? 1 + height[edge.to] : Math.min(height[edge.from], 1 + height[edge.to]);
  });
  return height;
}

/**
 *
 * @param api
 * @param opts
 * @param callback
 */
function allDocsKeysQuery (api, opts, callback) {
  const keys = ('limit' in opts)
    ? opts.keys.slice(opts.skip, opts.limit + opts.skip)
    : (opts.skip > 0) ? opts.keys.slice(opts.skip) : opts.keys;
  if (opts.descending) {
    keys.reverse();
  }
  if (!keys.length) {
    return api._allDocs({limit: 0}, callback);
  }
  const finalResults = {
    offset: opts.skip
  };
  return PouchPromise.all(keys.map(function (key) {
    const subOpts = jsExtend.extend({key, deleted: 'ok'}, opts);
    ['limit', 'skip', 'keys'].forEach(function (optKey) {
      delete subOpts[optKey];
    });
    return new PouchPromise(function (resolve, reject) {
      api._allDocs(subOpts, function (err, res) {
        /* istanbul ignore if */
        if (err) {
          return reject(err);
        }
        finalResults.total_rows = res.total_rows;
        resolve(res.rows[0] || {key, error: 'not_found'});
      });
    });
  })).then(function (results) {
    finalResults.rows = results;
    return finalResults;
  });
}

// all compaction is done in a queue, to avoid attaching
// too many listeners at once
/**
 *
 * @param self
 */
function doNextCompaction (self) {
  const task = self._compactionQueue[0];
  const {opts, callback} = task;
  self.get('_local/compaction').catch(function () {
    return false;
  }).then(function (doc) {
    if (doc && doc.last_seq) {
      opts.last_seq = doc.last_seq;
    }
    self._compact(opts, function (err, res) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
      } else {
        callback(null, res);
      }
      queueMicrotask(function () {
        self._compactionQueue.shift();
        if (self._compactionQueue.length) {
          doNextCompaction(self);
        }
      });
    });
  });
}

/**
 *
 * @param name
 */
function attachmentNameError (name) {
  if (name.charAt(0) === '_') {
    return name + 'is not a valid attachment name, attachment ' +
      'names cannot start with \'_\'';
  }
  return false;
}

/**
 *
 * @param api
 * @param cache
 * @param designDocName
 * @param callback
 */
function cacheUpdateRequired (api, cache, designDocName, callback) {
  cache.seq = cache.seq || 0;
  const changesOpts = {
    doc_ids: ['_design/' + designDocName],
    limit: 1,
    since: cache.seq
  };
  api.changes(changesOpts).then(function (res) {
    const latestSeq = res.results && res.results.length && res.results[0].seq;
    if (latestSeq && latestSeq > cache.seq) {
      // invalidate the cache
      cache.seq = latestSeq;
      delete cache.promise;
    }
    callback();
  }).catch(callback);
}

/**
 *
 * @param api
 * @param designDocName
 * @param callback
 */
function getDesignDocCache (api, designDocName, callback) {
  api._ddocCache = api._ddocCache || {};
  api._ddocCache[designDocName] = api._ddocCache[designDocName] || {};
  const cache = api._ddocCache[designDocName];
  cacheUpdateRequired(api, cache, designDocName, function (err) {
    if (err) {
      return callback(err);
    }
    if (!cache.promise) {
      cache.promise = new PouchPromise(function (resolve, reject) {
        api._get('_design/' + designDocName, {}, function (err, res) {
          if (err) {
            return reject(err);
          }
          const cache = {};
          ['views', 'filters'].forEach(function (propertyName) {
            cache[propertyName] = res.doc[propertyName];
          });
          resolve(cache);
        });
      });
    }
    cache.promise.then(function (cache) {
      callback(null, cache);
    }).catch(callback);
  });
}

/**
 *
 * @param api
 * @param designDocName
 * @param propertyName
 * @param propertyElement
 * @param callback
 */
function getDesignDocProperty (api, designDocName, propertyName,
  propertyElement, callback) {
  getDesignDocCache(api, designDocName, function (err, designDoc) {
    if (err) {
      return callback(err);
    }
    const element = designDoc[propertyName] &&
      designDoc[propertyName][propertyElement];
    if (!element) {
      return callback(createError(MISSING_DOC));
    }
    callback(null, element);
  });
}

inherits(AbstractPouchDB, events.EventEmitter);

/**
 *
 */
function AbstractPouchDB () {
  events.EventEmitter.call(this);
}

AbstractPouchDB.prototype.post =
  adapterFun('post', function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return callback(createError(NOT_AN_OBJECT));
    }
    this.bulkDocs({docs: [doc]}, opts, yankError(callback));
  });

AbstractPouchDB.prototype.put =
  adapterFun('put', getArguments(function (args) {
    let temp, temptype, opts, callback;
    const doc = args.shift();
    let id = '_id' in doc;
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      callback = args.pop();
      return callback(createError(NOT_AN_OBJECT));
    }

    /* eslint no-constant-condition: 0 */
    while (true) {
      temp = args.shift();
      temptype = typeof temp;
      if (temptype === 'string' && !id) {
        doc._id = temp;
        id = true;
      } else if (temptype === 'string' && id && !('_rev' in doc)) {
        doc._rev = temp;
      } else if (temptype === 'object') {
        opts = temp;
      } else if (temptype === 'function') {
        callback = temp;
      }
      if (!args.length) {
        break;
      }
    }
    opts ||= {};
    invalidIdError(doc._id);
    if (isLocalId(doc._id) && typeof this._putLocal === 'function') {
      if (doc._deleted) {
        return this._removeLocal(doc, callback);
      }
      return this._putLocal(doc, callback);
    }
    this.bulkDocs({docs: [doc]}, opts, yankError(callback));
  }));

AbstractPouchDB.prototype.putAttachment =
  adapterFun('putAttachment', function (docId, attachmentId, rev,
    blob, type) {
    const api = this;
    if (typeof type === 'function') {
      type = blob;
      blob = rev;
      rev = null;
    }
    // Lets fix in https://github.com/pouchdb/pouchdb/issues/3267
    /* istanbul ignore if */
    if (typeof type === 'undefined') {
      type = blob;
      blob = rev;
      rev = null;
    }

    /**
     *
     * @param doc
     */
    function createAttachment (doc) {
      let prevrevpos = '_rev' in doc ? parseInt(doc._rev, 10) : 0;
      doc._attachments = doc._attachments || {};
      doc._attachments[attachmentId] = {
        content_type: type,
        data: blob,
        revpos: ++prevrevpos
      };
      return api.put(doc);
    }

    return api.get(docId).then(function (doc) {
      if (doc._rev !== rev) {
        throw createError(REV_CONFLICT);
      }

      return createAttachment(doc);
    }, function (err) {
      // create new doc
      /* istanbul ignore else */
      if (err.reason === MISSING_DOC.message) {
        return createAttachment({_id: docId});
      }
      throw err;
    });
  });

AbstractPouchDB.prototype.removeAttachment =
  adapterFun('removeAttachment', function (docId, attachmentId, rev,
    callback) {
    const self = this;
    self.get(docId, function (err, obj) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
        return;
      }
      if (obj._rev !== rev) {
        callback(createError(REV_CONFLICT));
        return;
      }
      /* istanbul ignore if */
      if (!obj._attachments) {
        return callback();
      }
      delete obj._attachments[attachmentId];
      if (Object.keys(obj._attachments).length === 0) {
        delete obj._attachments;
      }
      self.put(obj, callback);
    });
  });

AbstractPouchDB.prototype.remove =
  adapterFun('remove', function (docOrId, optsOrRev, opts, callback) {
    let doc;
    if (typeof optsOrRev === 'string') {
      // id, rev, opts, callback style
      doc = {
        _id: docOrId,
        _rev: optsOrRev
      };
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
    } else {
      // doc, opts, callback style
      doc = docOrId;
      if (typeof optsOrRev === 'function') {
        callback = optsOrRev;
        opts = {};
      } else {
        callback = opts;
        opts = optsOrRev;
      }
    }
    opts ||= {};
    opts.was_delete = true;
    const newDoc = {_id: doc._id, _rev: (doc._rev || opts.rev), _deleted: true};
    if (isLocalId(newDoc._id) && typeof this._removeLocal === 'function') {
      return this._removeLocal(doc, callback);
    }
    this.bulkDocs({docs: [newDoc]}, opts, yankError(callback));
  });

AbstractPouchDB.prototype.revsDiff =
  adapterFun('revsDiff', function (req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    const ids = Object.keys(req);

    if (!ids.length) {
      return callback(null, {});
    }

    let count = 0;
    const missing = new pouchdbCollections.Map();

    /**
     *
     * @param id
     * @param revId
     */
    function addToMissing (id, revId) {
      if (!missing.has(id)) {
        missing.set(id, {missing: []});
      }
      missing.get(id).missing.push(revId);
    }

    /**
     *
     * @param id
     * @param rev_tree
     */
    function processDoc (id, rev_tree) {
      // Is this fast enough? Maybe we should switch to a set simulated by a map
      const missingForId = [...req[id]];
      traverseRevTree(rev_tree, function (isLeaf, pos, revHash, ctx,
        opts) {
        const rev = pos + '-' + revHash;
        const idx = missingForId.indexOf(rev);
        if (idx === -1) {
          return;
        }

        missingForId.splice(idx, 1);
        /* istanbul ignore if */
        if (opts.status !== 'available') {
          addToMissing(id, rev);
        }
      });

      // Traversing the tree is synchronous, so now `missingForId` contains
      // revisions that were not found in the tree
      missingForId.forEach(function (rev) {
        addToMissing(id, rev);
      });
    }

    ids.map(function (id) {
      this._getRevisionTree(id, function (err, rev_tree) {
        if (err && err.status === 404 && err.message === 'missing') {
          missing.set(id, {missing: req[id]});
        } else if (err) {
          /* c8 ignore next */
          return callback(err);
        } else {
          processDoc(id, rev_tree);
        }

        if (++count === ids.length) {
          // convert LazyMap to object
          const missingObj = {};
          missing.forEach(function (value, key) {
            missingObj[key] = value;
          });
          return callback(null, missingObj);
        }
      });
    }, this);
  });

// _bulk_get API for faster replication, as described in
// https://github.com/apache/couchdb-chttpd/pull/33
// At the "abstract" level, it will just run multiple get()s in
// parallel, because this isn't much of a performance cost
// for local databases (except the cost of multiple transactions, which is
// small). The http adapter overrides this in order
// to do a more efficient single HTTP request.
AbstractPouchDB.prototype.bulkGet =
  adapterFun('bulkGet', function (opts, callback) {
    bulkGet(this, opts, callback);
  });

// compact one document and fire callback
// by compacting we mean removing all revisions which
// are further from the leaf in revision tree than max_height
AbstractPouchDB.prototype.compactDocument =
  adapterFun('compactDocument', function (docId, maxHeight, callback) {
    const self = this;
    this._getRevisionTree(docId, function (err, revTree) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      const height = computeHeight(revTree);
      const candidates = [];
      const revs = [];
      Object.keys(height).forEach(function (rev) {
        if (height[rev] > maxHeight) {
          candidates.push(rev);
        }
      });

      traverseRevTree(revTree, function (isLeaf, pos, revHash, ctx, opts) {
        const rev = pos + '-' + revHash;
        if (opts.status === 'available' && candidates.includes(rev)) {
          revs.push(rev);
        }
      });
      self._doCompaction(docId, revs, callback);
    });
  });

// compact the whole database using single document
// compaction
AbstractPouchDB.prototype.compact =
  adapterFun('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    const self = this;
    opts ||= {};

    self._compactionQueue = self._compactionQueue || [];
    self._compactionQueue.push({opts, callback});
    if (self._compactionQueue.length === 1) {
      doNextCompaction(self);
    }
  });
AbstractPouchDB.prototype._compact = function (opts, callback) {
  const self = this;
  const changesOpts = {
    return_docs: false,
    last_seq: opts.last_seq || 0
  };
  const promises = [];

  /**
   *
   * @param row
   */
  function onChange (row) {
    promises.push(self.compactDocument(row.id, 0));
  }
  /**
   *
   * @param resp
   */
  function onComplete (resp) {
    const lastSeq = resp.last_seq;
    PouchPromise.all(promises).then(function () {
      return upsert(self, '_local/compaction', function deltaFunc (doc) {
        if (!doc.last_seq || doc.last_seq < lastSeq) {
          doc.last_seq = lastSeq;
          return doc;
        }
        return false; // somebody else got here first, don't update
      });
    }).then(function () {
      callback(null, {ok: true});
    }).catch(callback);
  }
  self.changes(changesOpts).
    on('change', onChange).
    on('complete', onComplete).
    on('error', callback);
};
/* Begin api wrappers. Specific functionality to storage belongs in the
 _[method] */
AbstractPouchDB.prototype.get =
  adapterFun('get', function (id, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (typeof id !== 'string') {
      return callback(createError(INVALID_ID));
    }
    if (isLocalId(id) && typeof this._getLocal === 'function') {
      return this._getLocal(id, callback);
    }
    let leaves = [], self = this;

    /**
     *
     */
    function finishOpenRevs () {
      const result = [];
      let count = leaves.length;
      /* istanbul ignore if */
      if (!count) {
        return callback(null, result);
      }
      // order with open_revs is unspecified
      leaves.forEach(function (leaf) {
        self.get(id, {
          rev: leaf,
          revs: opts.revs,
          attachments: opts.attachments
        }, function (err, doc) {
          if (!err) {
            result.push({ok: doc});
          } else {
            result.push({missing: leaf});
          }
          count--;
          if (!count) {
            callback(null, result);
          }
        });
      });
    }

    if (opts.open_revs) {
      if (opts.open_revs === 'all') {
        this._getRevisionTree(id, function (err, rev_tree) {
          if (err) {
            return callback(err);
          }
          leaves = collectLeaves(rev_tree).map(function (leaf) {
            return leaf.rev;
          });
          finishOpenRevs();
        });
      } else if (Array.isArray(opts.open_revs)) {
        leaves = opts.open_revs;
        for (const l of leaves) {
          // looks like it's the only thing couchdb checks
          if (!(typeof (l) === 'string' && (/^\d+-/).test(l))) {
            return callback(createError(INVALID_REV));
          }
        }
        finishOpenRevs();
      } else {
        return callback(createError(UNKNOWN_ERROR,
          'function_clause'));
      }
      return; // open_revs does not like other options
    }

    return this._get(id, opts, function (err, result) {
      if (err) {
        return callback(err);
      }

      const {doc} = result;
      const {metadata} = result;
      const {ctx} = result;

      if (opts.conflicts) {
        const conflicts = collectConflicts(metadata);
        if (conflicts.length) {
          doc._conflicts = conflicts;
        }
      }

      if (isDeleted(metadata, doc._rev)) {
        doc._deleted = true;
      }

      if (opts.revs || opts.revs_info) {
        const paths = rootToLeaf(metadata.rev_tree);
        const path = arrayFirst(paths, function (arr) {
          return arr.ids.map(function (x) {
            return x.id;
          }).
            includes(doc._rev.split('-', 2)[1]);
        });

        const indexOfRev = path.ids.map(function (x) {
          return x.id;
        }).
          indexOf(doc._rev.split('-', 2)[1]) + 1;
        const howMany = path.ids.length - indexOfRev;
        path.ids.splice(indexOfRev, howMany);
        path.ids.reverse();

        if (opts.revs) {
          doc._revisions = {
            start: (path.pos + path.ids.length) - 1,
            ids: path.ids.map(function (rev) {
              return rev.id;
            })
          };
        }
        if (opts.revs_info) {
          let pos = path.pos + path.ids.length;
          doc._revs_info = path.ids.map(function (rev) {
            pos--;
            return {
              rev: pos + '-' + rev.id,
              status: rev.opts.status
            };
          });
        }
      }

      if (opts.attachments && doc._attachments) {
        const attachments = doc._attachments;
        let count = Object.keys(attachments).length;
        if (count === 0) {
          return callback(null, doc);
        }
        Object.keys(attachments).forEach(function (key) {
          this._getAttachment(attachments[key], {
            binary: opts.binary,
            ctx
          }, function (err, data) {
            const att = doc._attachments[key];
            att.data = data;
            delete att.stub;
            delete att.length;
            if (!--count) {
              callback(null, doc);
            }
          });
        }, self);
      } else {
        if (doc._attachments) {
          for (const key in doc._attachments) {
            /* istanbul ignore else */
            if (doc._attachments.hasOwnProperty(key)) {
              doc._attachments[key].stub = true;
            }
          }
        }
        callback(null, doc);
      }
    });
  });

AbstractPouchDB.prototype.getView =
  adapterFun('getView', function (designDocName, viewName, callback) {
    getDesignDocProperty(this, designDocName, 'views', viewName, callback);
  });

AbstractPouchDB.prototype.getFilter =
  adapterFun('getFilter', function (designDocName, filterName, callback) {
    getDesignDocProperty(this, designDocName, 'filters', filterName, callback);
  });

AbstractPouchDB.prototype.getAttachment =
  adapterFun('getAttachment', function (docId, attachmentId, opts,
    callback) {
    const self = this;
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    this._get(docId, opts, function (err, res) {
      if (err) {
        return callback(err);
      }
      if (res.doc._attachments && res.doc._attachments[attachmentId]) {
        opts.ctx = res.ctx;
        opts.binary = true;
        self._getAttachment(res.doc._attachments[attachmentId], opts, callback);
      } else {
        return callback(createError(MISSING_DOC));
      }
    });
  });

AbstractPouchDB.prototype.allDocs =
  adapterFun('allDocs', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts.skip = typeof opts.skip !== 'undefined' ? opts.skip : 0;
    if (opts.start_key) {
      opts.startkey = opts.start_key;
    }
    if (opts.end_key) {
      opts.endkey = opts.end_key;
    }
    if ('keys' in opts) {
      if (!Array.isArray(opts.keys)) {
        return callback(new TypeError('options.keys must be an array'));
      }
      const incompatibleOpt =
        ['startkey', 'endkey', 'key'].find(function (incompatibleOpt) {
          return incompatibleOpt in opts;
        });
      if (incompatibleOpt) {
        callback(createError(QUERY_PARSE_ERROR,
          'Query parameter `' + incompatibleOpt +
          '` is not compatible with multi-get'));
        return;
      }
      if (this.type() !== 'http') {
        return allDocsKeysQuery(this, opts, callback);
      }
    }

    return this._allDocs(opts, callback);
  });

AbstractPouchDB.prototype.changes = function (opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  return new Changes(this, opts, callback);
};

AbstractPouchDB.prototype.close =
  adapterFun('close', function (callback) {
    this._closed = true;
    return this._close(callback);
  });

AbstractPouchDB.prototype.info = adapterFun('info', function (callback) {
  const self = this;
  this._info(function (err, info) {
    if (err) {
      return callback(err);
    }
    // assume we know better than the adapter, unless it informs us
    info.db_name = info.db_name || self._db_name;
    info.auto_compaction = Boolean(self.auto_compaction && self.type() !== 'http');
    info.adapter = self.type();
    callback(null, info);
  });
});

AbstractPouchDB.prototype.id = adapterFun('id', function (callback) {
  return this._id(callback);
});

AbstractPouchDB.prototype.type = function () {
  /* c8 ignore next */
  return (typeof this._type === 'function') ? this._type() : this.adapter;
};

AbstractPouchDB.prototype.bulkDocs =
  adapterFun('bulkDocs', function (req, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    opts ||= {};

    if (Array.isArray(req)) {
      req = {
        docs: req
      };
    }

    if (!req || !req.docs || !Array.isArray(req.docs)) {
      return callback(createError(MISSING_BULK_DOCS));
    }

    for (let i = 0; i < req.docs.length; ++i) {
      if (typeof req.docs[i] !== 'object' || Array.isArray(req.docs[i])) {
        return callback(createError(NOT_AN_OBJECT));
      }
    }

    let attachmentError;
    req.docs.forEach(function (doc) {
      if (doc._attachments) {
        Object.keys(doc._attachments).forEach(function (name) {
          attachmentError ||= attachmentNameError(name);
        });
      }
    });

    if (attachmentError) {
      return callback(createError(BAD_REQUEST, attachmentError));
    }

    if (!('new_edits' in opts)) {
      opts.new_edits = 'new_edits' in req ? req.new_edits : true;
    }

    if (!opts.new_edits && this.type() !== 'http') {
      // ensure revisions of the same doc are sorted, so that
      // the local adapter processes them correctly (#2935)
      req.docs.sort(compareByIdThenRev);
    }

    cleanDocs(req.docs);

    return this._bulkDocs(req, opts, function (err, res) {
      if (err) {
        return callback(err);
      }
      if (!opts.new_edits) {
        // this is what couch does when new_edits is false
        res = res.filter(function (x) {
          return x.error;
        });
      }
      callback(null, res);
    });
  });

AbstractPouchDB.prototype.registerDependentDatabase =
  adapterFun('registerDependentDatabase', function (dependentDb,
    callback) {
    const depDB = new this.constructor(dependentDb, this.__opts);

    /**
     *
     * @param doc
     */
    function diffFun (doc) {
      doc.dependentDbs = doc.dependentDbs || {};
      if (doc.dependentDbs[dependentDb]) {
        return false; // no update required
      }
      doc.dependentDbs[dependentDb] = true;
      return doc;
    }
    upsert(this, '_local/_pouch_dependentDbs', diffFun).
      then(function () {
        callback(null, {db: depDB});
      }).catch(callback);
  });

AbstractPouchDB.prototype.destroy =
  adapterFun('destroy', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    const self = this;
    const usePrefix = 'use_prefix' in self ? self.use_prefix : true;

    /**
     *
     */
    function destroyDb () {
      // call destroy method of the particular adaptor
      self._destroy(opts, function (err, resp) {
        if (err) {
          return callback(err);
        }
        self._destroyed = true;
        self.emit('destroyed');
        callback(null, resp || {ok: true});
      });
    }

    if (self.type() === 'http') {
      // no need to check for dependent DBs if it's a remote DB
      return destroyDb();
    }

    self.get('_local/_pouch_dependentDbs', function (err, localDoc) {
      if (err) {
        /* istanbul ignore if */
        if (err.status !== 404) {
          return callback(err);
        } // no dependencies
        return destroyDb();
      }
      const {dependentDbs} = localDoc;
      const PouchDB = self.constructor;
      const deletedMap = Object.keys(dependentDbs).map(function (name) {
        // use_prefix is only false in the browser
        /* c8 ignore next */
        const trueName = usePrefix
          ? name.replace(new RegExp('^' + PouchDB.prefix), '')
          : name;
        return new PouchDB(trueName, self.__opts).destroy();
      });
      PouchPromise.all(deletedMap).then(destroyDb, callback);
    });
  });

/**
 *
 */
function TaskQueue () {
  this.isReady = false;
  this.failed = false;
  this.queue = [];
}

TaskQueue.prototype.execute = function () {
  let fun;
  if (this.failed) {
    while ((fun = this.queue.shift())) {
      fun(this.failed);
    }
  } else {
    while ((fun = this.queue.shift())) {
      fun();
    }
  }
};

TaskQueue.prototype.fail = function (err) {
  this.failed = err;
  this.execute();
};

TaskQueue.prototype.ready = function (db) {
  this.isReady = true;
  this.db = db;
  this.execute();
};

TaskQueue.prototype.addTask = function (fun) {
  this.queue.push(fun);
  if (this.failed) {
    this.execute();
  }
};

/**
 *
 * @param err
 */
function defaultCallback (err) {
  /* c8 ignore next */
  if (err && globalThis.debug) {
    console.error(err);
  }
}

// OK, so here's the deal. Consider this code:
//     var db1 = new PouchDB('foo');
//     var db2 = new PouchDB('foo');
//     db1.destroy();
// ^ these two both need to emit 'destroyed' events,
// as well as the PouchDB constructor itself.
// So we have one db object (whichever one got destroy() called on it)
// responsible for emitting the initial event, which then gets emitted
// by the constructor, which then broadcasts it to any other dbs
// that may have been created with the same name.
/**
 *
 * @param self
 * @param opts
 */
function prepareForDestruction (self, opts) {
  const name = opts.originalName;
  const ctor = self.constructor;
  const destructionListeners = ctor._destructionListeners;

  /**
   *
   */
  function onDestroyed () {
    ctor.emit('destroyed', name);
  }

  /**
   *
   */
  function onConstructorDestroyed () {
    self.removeListener('destroyed', onDestroyed);
    self.emit('destroyed', self);
  }

  self.once('destroyed', onDestroyed);

  // in setup.js, the constructor is primed to listen for destroy events
  if (!destructionListeners.has(name)) {
    destructionListeners.set(name, []);
  }
  destructionListeners.get(name).push(onConstructorDestroyed);
}

inherits(PouchDB, AbstractPouchDB);
/**
 *
 * @param name
 * @param opts
 * @param callback
 */
function PouchDB (name, opts, callback) {
  if (!(this instanceof PouchDB)) {
    return new PouchDB(name, opts, callback);
  }
  const self = this;
  if (typeof opts === 'function' || typeof opts === 'undefined') {
    callback = opts;
    opts = {};
  }

  if (name && typeof name === 'object') {
    opts = name;
    name = undefined;
  }
  if (typeof callback === 'undefined') {
    callback = defaultCallback;
  }
  name ||= opts.name;
  opts = clone(opts);
  // if name was specified via opts, ignore for the sake of dependentDbs
  delete opts.name;
  this.__opts = opts;
  const oldCB = callback;
  self.auto_compaction = opts.auto_compaction;
  self.prefix = PouchDB.prefix;
  AbstractPouchDB.call(self);
  self.taskqueue = new TaskQueue();
  const promise = new PouchPromise(function (fulfill, reject) {
    callback = function (err, resp) {
      /* istanbul ignore if */
      if (err) {
        return reject(err);
      }
      delete resp.then;
      fulfill(resp);
    };

    opts = clone(opts);
    const originalName = opts.name || name;
    let backend, error;
    {
      try {
        if (typeof originalName !== 'string') {
          error = new Error('Missing/invalid DB name');
          error.code = 400;
          throw error;
        }

        backend = PouchDB.parseAdapter(originalName, opts);

        opts.originalName = originalName;
        opts.name = backend.name;
        if (opts.prefix && backend.adapter !== 'http' &&
          backend.adapter !== 'https') {
          opts.name = opts.prefix + opts.name;
        }
        opts.adapter = opts.adapter || backend.adapter;
        self._adapter = opts.adapter;
        debug('pouchdb:adapter')('Picked adapter: ' + opts.adapter);

        self._db_name = originalName;
        if (!PouchDB.adapters[opts.adapter]) {
          error = new Error('Adapter is missing');
          error.code = 404;
          throw error;
        }

        /* istanbul ignore if */
        if (!PouchDB.adapters[opts.adapter].valid()) {
          error = new Error('Invalid Adapter');
          error.code = 404;
          throw error;
        }
      } catch (err) {
        self.taskqueue.fail(err);
      }
    }
    if (error) {
      return reject(error); // constructor error, see above
    }
    self.adapter = opts.adapter;

    // needs access to PouchDB;
    self.replicate = {};

    self.replicate.from = function (url, opts, callback) {
      return self.constructor.replicate(url, self, opts, callback);
    };

    self.replicate.to = function (url, opts, callback) {
      return self.constructor.replicate(self, url, opts, callback);
    };

    self.sync = function (dbName, opts, callback) {
      return self.constructor.sync(self, dbName, opts, callback);
    };

    self.replicate.sync = self.sync;

    PouchDB.adapters[opts.adapter].call(self, opts, function (err) {
      /* istanbul ignore if */
      if (err) {
        self.taskqueue.fail(err);
        callback(err);
        return;
      }
      prepareForDestruction(self, opts);

      self.emit('created', self);
      PouchDB.emit('created', opts.originalName);
      self.taskqueue.ready(self);
      callback(null, self);
    });
  });
  promise.then(function (resp) {
    oldCB(null, resp);
  }, oldCB);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
}

PouchDB.debug = debug;

// in Node of course this is false
/**
 *
 */
function hasLocalStorage () {
  return false;
}

PouchDB.adapters = {};
PouchDB.preferredAdapters = [];

PouchDB.prefix = '_pouch_';

const eventEmitter = new events.EventEmitter();

/**
 *
 * @param Pouch
 */
function setUpEventEmitter (Pouch) {
  Object.keys(events.EventEmitter.prototype).forEach(function (key) {
    if (typeof events.EventEmitter.prototype[key] === 'function') {
      Pouch[key] = eventEmitter[key].bind(eventEmitter);
    }
  });

  // these are created in constructor.js, and allow us to notify each DB with
  // the same name that it was destroyed, via the constructor object
  const destructListeners = Pouch._destructionListeners = new pouchdbCollections.Map();
  Pouch.on('destroyed', function onConstructorDestroyed (name) {
    if (!destructListeners.has(name)) {
      return;
    }
    destructListeners.get(name).forEach(function (callback) {
      callback();
    });
    destructListeners.delete(name);
  });
}

setUpEventEmitter(PouchDB);

PouchDB.parseAdapter = function (name, opts) {
  const match = name.match(/([a-z\-]*):\/\/(.*)/);
  let adapter, adapterName;
  if (match) {
    // the http adapter expects the fully qualified name
    name = (/http(s?)/).test(match[1]) ? match[1] + '://' + match[2] : match[2];
    adapter = match[1];
    /* istanbul ignore if */
    if (!PouchDB.adapters[adapter].valid()) {
      throw 'Invalid adapter';
    }
    return {name, adapter: match[1]};
  }

  // check for browsers that have been upgraded from websql-only to websql+idb
  const skipIdb = 'idb' in PouchDB.adapters && 'websql' in PouchDB.adapters &&
    hasLocalStorage() &&
    localStorage['_pouch__websqldb_' + PouchDB.prefix + name];


  if (opts.adapter) {
    adapterName = opts.adapter;
  } else if (typeof opts !== 'undefined' && opts.db) {
    adapterName = 'leveldb';
  } else { // automatically determine adapter
    for (let i = 0; i < PouchDB.preferredAdapters.length; ++i) {
      adapterName = PouchDB.preferredAdapters[i];
      if (adapterName in PouchDB.adapters) {
        /* istanbul ignore if */
        if (skipIdb && adapterName === 'idb') {
          // log it, because this can be confusing during development
          console.log('PouchDB is downgrading "' + name + '" to WebSQL to' +
            ' avoid data loss, because it was already opened with WebSQL.');
          continue; // keep using websql to avoid user data loss
        }
        break;
      }
    }
  }

  adapter = PouchDB.adapters[adapterName];

  // if adapter is invalid, then an error will be thrown later
  const usePrefix = (adapter && 'use_prefix' in adapter)
    ? adapter.use_prefix
    : true;

  return {
    name: usePrefix ? (PouchDB.prefix + name) : name,
    adapter: adapterName
  };
};

PouchDB.adapter = function (id, obj, addToPreferredAdapters) {
  if (!obj.valid()) {
    return;
  }

  PouchDB.adapters[id] = obj;
  if (addToPreferredAdapters) {
    PouchDB.preferredAdapters.push(id);
  }
};

PouchDB.plugin = function (obj) {
  Object.keys(obj).forEach(function (id) {
    PouchDB.prototype[id] = obj[id];
  });

  return PouchDB;
};

PouchDB.defaults = function (defaultOpts) {
  /**
   *
   * @param name
   * @param opts
   * @param callback
   */
  function PouchAlt (name, opts, callback) {
    if (!(this instanceof PouchAlt)) {
      return new PouchAlt(name, opts, callback);
    }

    if (typeof opts === 'function' || typeof opts === 'undefined') {
      callback = opts;
      opts = {};
    }
    if (name && typeof name === 'object') {
      opts = name;
      name = undefined;
    }

    opts = jsExtend.extend({}, defaultOpts, opts);
    PouchDB.call(this, name, opts, callback);
  }

  inherits(PouchAlt, PouchDB);

  setUpEventEmitter(PouchAlt);

  PouchAlt.preferredAdapters = [...PouchDB.preferredAdapters];
  Object.keys(PouchDB).forEach(function (key) {
    if (!(key in PouchAlt)) {
      PouchAlt[key] = PouchDB[key];
    }
  });

  return PouchAlt;
};

// May seem redundant, but this is to allow switching with
// request-browser.js.
import request from 'request';

// non-standard, but we do this to mimic blobs in the browser
/**
 *
 * @param buffer
 * @param resp
 */
function applyTypeToBuffer (buffer, resp) {
  buffer.type = resp.headers['content-type'];
}

// this solely exists so we can exclude it in browserify
const buffer = Buffer;

/**
 *
 */
function defaultBody () {
  return new buffer('', 'binary');
}

/**
 *
 * @param options
 * @param callback
 */
function ajaxCore (options, callback) {
  options = clone(options);

  const defaultOptions = {
    method: 'GET',
    headers: {},
    json: true,
    processData: true,
    timeout: 10000,
    cache: false
  };

  options = jsExtend.extend(defaultOptions, options);

  /**
   *
   * @param obj
   * @param resp
   * @param cb
   */
  function onSuccess (obj, resp, cb) {
    if (!options.binary && options.json && typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch (e) {
        // Probably a malformed JSON from server
        return cb(e);
      }
    }
    if (Array.isArray(obj)) {
      obj = obj.map(function (v) {
        if (v.error || v.missing) {
          return generateErrorFromResponse(v);
        }
        return v;
      });
    }
    if (options.binary) {
      applyTypeToBuffer(obj, resp);
    }
    cb(null, obj, resp);
  }

  /**
   *
   * @param err
   * @param cb
   */
  function onError (err, cb) {
    let errParsed, errObj;
    if (err.code && err.status) {
      const err2 = new Error(err.message || err.code);
      err2.status = err.status;
      return cb(err2);
    }
    if (err.message && err.message === 'ETIMEDOUT') {
      return cb(err);
    }
    // We always get code && status in node
    /* c8 ignore next */
    try {
      errParsed = JSON.parse(err.responseText);
      // would prefer not to have a try/catch clause
      errObj = generateErrorFromResponse(errParsed);
    } catch (e) {
      errObj = generateErrorFromResponse(err);
    }
    /* c8 ignore next */
    cb(errObj);
  }


  if (options.json) {
    if (!options.binary) {
      options.headers.Accept = 'application/json';
    }
    options.headers['Content-Type'] = options.headers['Content-Type'] ||
      'application/json';
  }

  if (options.binary) {
    options.encoding = null;
    options.json = false;
  }

  if (!options.processData) {
    options.json = false;
  }

  return request(options, function (err, response, body) {
    if (err) {
      err.status = response ? response.statusCode : 400;
      return onError(err, callback);
    }

    const content_type = response.headers && response.headers['content-type'];
    let data = body || defaultBody();

    // CouchDB doesn't always return the right content-type for JSON data, so
    // we check for ^{ and }$ (ignoring leading/trailing whitespace)
    if (!options.binary && (options.json || !options.processData) &&
      typeof data !== 'object' &&
      ((/json/).test(content_type) ||
      ((/^[\s]*\{/).test(data) && (/\}[\s]*$/).test(data)))) {
      try {
        data = JSON.parse(data.toString());
      } catch (e) {}
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      onSuccess(data, response, callback);
    } else {
      const error = generateErrorFromResponse(data);
      error.status = response.statusCode;
      callback(error);
    }
  });
}

/**
 *
 * @param opts
 * @param callback
 */
function ajax (opts, callback) {
  // do nothing; all the action is in prerequest-browser.js
  return ajaxCore(opts, callback);
}

// originally parseUri 1.2.2, now patched by us
// (c) Steven Levithan <stevenlevithan.com>
// MIT License
const keys = ['source', 'protocol', 'authority', 'userInfo', 'user', 'password',
  'host', 'port', 'relative', 'path', 'directory', 'file', 'query', 'anchor'];
const qName = 'queryKey';
const qParser = /(?:^|&)([^&=]*)=?([^&]*)/g;

// use the "loose" parser

const parser = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

/**
 *
 * @param str
 */
function parseUri (str) {
  const m = parser.exec(str);
  const uri = {};
  let i = 14;

  while (i--) {
    const key = keys[i];
    const value = m[i] || '';
    const encoded = ['user', 'password'].includes(key);
    uri[key] = encoded ? decodeURIComponent(value) : value;
  }

  uri[qName] = {};
  uri[keys[12]].replaceAll(qParser, function ($0, $1, $2) {
    if ($1) {
      uri[qName][$1] = $2;
    }
  });

  return uri;
}

/**
 *
 * @param str
 */
function atob (str) {
  const base64 = new buffer(str, 'base64');
  // Node.js will just skip the characters it can't decode instead of
  // throwing an exception
  if (base64.toString('base64') !== str) {
    throw new Error('attachment is not a valid base64 string');
  }
  return base64.toString('binary');
}

/**
 *
 * @param str
 */
function btoa (str) {
  return new buffer(str, 'binary').toString('base64');
}

/**
 *
 * @param binString
 * @param buffType
 * @param type
 */
function typedBuffer (binString, buffType, type) {
  // buffType is either 'binary' or 'base64'
  const buff = new buffer(binString, buffType);
  buff.type = type; // non-standard, but used for consistency with the browser
  return buff;
}

/**
 *
 * @param binString
 * @param type
 */
function binStringToBluffer (binString, type) {
  return typedBuffer(binString, 'binary', type);
}

const extend$1 = jsExtend__default.extend;

const utils = {
  ajax,
  parseUri,
  uuid,
  Promise: PouchPromise,
  atob,
  btoa,
  binaryStringToBlobOrBuffer: binStringToBluffer,
  clone,
  extend: extend$1,
  createError
};

/**
 *
 * @param filter
 * @param doc
 * @param req
 */
function tryFilter (filter, doc, req) {
  try {
    return !filter(doc, req);
  } catch (err) {
    const msg = 'Filter function threw: ' + err.toString();
    return createError(BAD_REQUEST, msg);
  }
}

/**
 *
 * @param opts
 */
function filterChange (opts) {
  const req = {};
  const hasFilter = opts.filter && typeof opts.filter === 'function';
  req.query = opts.query_params;

  return function filter (change) {
    if (!change.doc) {
      // CSG sends events on the changes feed that don't have documents,
      // this hack makes a whole lot of existing code robust.
      change.doc = {};
    }

    const filterReturn = hasFilter && tryFilter(opts.filter, change.doc, req);

    if (typeof filterReturn === 'object') {
      return filterReturn;
    }

    if (filterReturn) {
      return false;
    }

    if (!opts.include_docs) {
      delete change.doc;
    } else if (!opts.attachments) {
      for (const att in change.doc._attachments) {
        /* istanbul ignore else */
        if (change.doc._attachments.hasOwnProperty(att)) {
          change.doc._attachments[att].stub = true;
        }
      }
    }
    return true;
  };
}

// We assume Node users don't need to see this warning
const res = function () {};

const collate$1 = pouchCollate__default.collate;

const CHECKPOINT_VERSION = 1;
const REPLICATOR = 'pouchdb';
// This is an arbitrary number to limit the
// amount of replication history we save in the checkpoint.
// If we save too much, the checkpoing docs will become very big,
// if we save fewer, we'll run a greater risk of having to
// read all the changes from 0 when checkpoint PUTs fail
// CouchDB 2.0 has a more involved history pruning,
// but let's go for the simple version for now.
const CHECKPOINT_HISTORY_SIZE = 5;
const LOWEST_SEQ = 0;

/**
 *
 * @param db
 * @param id
 * @param checkpoint
 * @param session
 * @param returnValue
 */
function updateCheckpoint (db, id, checkpoint, session, returnValue) {
  return db.get(id).catch(function (err) {
    if (err.status === 404) {
      if (db.type() === 'http') {
        res(
          404, 'PouchDB is just checking if a remote checkpoint exists.'
        );
      }
      return {
        session_id: session,
        _id: id,
        history: [],
        replicator: REPLICATOR,
        version: CHECKPOINT_VERSION
      };
    }
    throw err;
  }).then(function (doc) {
    if (returnValue.cancelled) {
      return;
    }
    // Filter out current entry for this replication
    doc.history = (doc.history || []).filter(function (item) {
      return item.session_id !== session;
    });

    // Add the latest checkpoint to history
    doc.history.unshift({
      last_seq: checkpoint,
      session_id: session
    });

    // Just take the last pieces in history, to
    // avoid really big checkpoint docs.
    // see comment on history size above
    doc.history = doc.history.slice(0, CHECKPOINT_HISTORY_SIZE);

    doc.version = CHECKPOINT_VERSION;
    doc.replicator = REPLICATOR;

    doc.session_id = session;
    doc.last_seq = checkpoint;

    return db.put(doc).catch(function (err) {
      if (err.status === 409) {
        // retry; someone is trying to write a checkpoint simultaneously
        return updateCheckpoint(db, id, checkpoint, session, returnValue);
      }
      throw err;
    });
  });
}

/**
 *
 * @param src
 * @param target
 * @param id
 * @param returnValue
 */
function Checkpointer (src, target, id, returnValue) {
  this.src = src;
  this.target = target;
  this.id = id;
  this.returnValue = returnValue;
}

Checkpointer.prototype.writeCheckpoint = function (checkpoint, session) {
  const self = this;
  return this.updateTarget(checkpoint, session).then(function () {
    return self.updateSource(checkpoint, session);
  });
};

Checkpointer.prototype.updateTarget = function (checkpoint, session) {
  return updateCheckpoint(this.target, this.id, checkpoint,
    session, this.returnValue);
};

Checkpointer.prototype.updateSource = function (checkpoint, session) {
  const self = this;
  if (this.readOnlySource) {
    return PouchPromise.resolve(true);
  }
  return updateCheckpoint(this.src, this.id, checkpoint,
    session, this.returnValue).
    catch(function (err) {
      if (isForbiddenError(err)) {
        self.readOnlySource = true;
        return true;
      }
      throw err;
    });
};

const comparisons = {
  undefined (targetDoc, sourceDoc) {
    // This is the previous comparison function
    if (collate$1(targetDoc.last_seq, sourceDoc.last_seq) === 0) {
      return sourceDoc.last_seq;
    }
    /* c8 ignore next */
    return 0;
  },
  1 (targetDoc, sourceDoc) {
    // This is the comparison function ported from CouchDB
    return compareReplicationLogs(sourceDoc, targetDoc).last_seq;
  }
};

Checkpointer.prototype.getCheckpoint = function () {
  const self = this;
  return self.target.get(self.id).then(function (targetDoc) {
    if (self.readOnlySource) {
      return PouchPromise.resolve(targetDoc.last_seq);
    }

    return self.src.get(self.id).then(function (sourceDoc) {
      // Since we can't migrate an old version doc to a new one
      // (no session id), we just go with the lowest seq in this case
      /* istanbul ignore if */
      if (targetDoc.version !== sourceDoc.version) {
        return LOWEST_SEQ;
      }

      let version;
      version = targetDoc.version ? targetDoc.version.toString() : 'undefined';

      if (version in comparisons) {
        return comparisons[version](targetDoc, sourceDoc);
      }
      /* c8 ignore next */
      return LOWEST_SEQ;
    }, function (err) {
      if (err.status === 404 && targetDoc.last_seq) {
        return self.src.put({
          _id: self.id,
          last_seq: LOWEST_SEQ
        }).then(function () {
          return LOWEST_SEQ;
        }, function (err) {
          if (isForbiddenError(err)) {
            self.readOnlySource = true;
            return targetDoc.last_seq;
          }
          /* c8 ignore next */
          return LOWEST_SEQ;
        });
      }
      throw err;
    });
  }).catch(function (err) {
    if (err.status !== 404) {
      throw err;
    }
    return LOWEST_SEQ;
  });
};
// This checkpoint comparison is ported from CouchDBs source
// they come from here:
// https://github.com/apache/couchdb-couch-replicator/blob/master/src/couch_replicator.erl#L863-L906

/**
 *
 * @param srcDoc
 * @param tgtDoc
 */
function compareReplicationLogs (srcDoc, tgtDoc) {
  if (srcDoc.session_id === tgtDoc.session_id) {
    return {
      last_seq: srcDoc.last_seq,
      history: srcDoc.history || []
    };
  }

  const sourceHistory = srcDoc.history || [];
  const targetHistory = tgtDoc.history || [];
  return compareReplicationHistory(sourceHistory, targetHistory);
}

/**
 *
 * @param sourceHistory
 * @param targetHistory
 */
function compareReplicationHistory (sourceHistory, targetHistory) {
  // the erlang loop via function arguments is not so easy to repeat in JS
  // therefore, doing this as recursion
  const S = sourceHistory[0];
  const sourceRest = sourceHistory.slice(1);
  const T = targetHistory[0];
  const targetRest = targetHistory.slice(1);

  if (!S || targetHistory.length === 0) {
    return {
      last_seq: LOWEST_SEQ,
      history: []
    };
  }

  const sourceId = S.session_id;
  /* istanbul ignore if */
  if (hasSessionId(sourceId, targetHistory)) {
    return {
      last_seq: S.last_seq,
      history: sourceHistory
    };
  }

  const targetId = T.session_id;
  if (hasSessionId(targetId, sourceRest)) {
    return {
      last_seq: T.last_seq,
      history: targetRest
    };
  }

  return compareReplicationHistory(sourceRest, targetRest);
}

/**
 *
 * @param sessionId
 * @param history
 */
function hasSessionId (sessionId, history) {
  const props = history[0];
  const rest = history.slice(1);

  if (!sessionId || history.length === 0) {
    return false;
  }

  if (sessionId === props.session_id) {
    return true;
  }

  return hasSessionId(sessionId, rest);
}

/**
 *
 * @param err
 */
function isForbiddenError (err) {
  return typeof err.status === 'number' && Math.floor(err.status / 100) === 4;
}

const STARTING_BACK_OFF = 0;

/**
 *
 * @param min
 * @param max
 */
function randomNumber (min, max) {
  min = parseInt(min, 10) || 0;
  max = parseInt(max, 10);
  if (max !== max || max <= min) {
    max = (min || 1) << 1; // doubling
  } else {
    max += 1;
  }
  const ratio = Math.random();
  const range = max - min;

  return Math.trunc(range * ratio + min); // ~~ coerces to an int, but fast.
}

/**
 *
 * @param min
 */
function defaultBackOff (min) {
  let max = 0;
  if (!min) {
    max = 2000;
  }
  return randomNumber(min, max);
}

/**
 *
 * @param opts
 * @param returnValue
 * @param error
 * @param callback
 */
function backOff (opts, returnValue, error, callback) {
  if (opts.retry === false) {
    returnValue.emit('error', error);
    returnValue.removeAllListeners();
    return;
  }
  if (typeof opts.back_off_function !== 'function') {
    opts.back_off_function = defaultBackOff;
  }
  returnValue.emit('requestError', error);
  if (returnValue.state === 'active' || returnValue.state === 'pending') {
    returnValue.emit('paused', error);
    returnValue.state = 'stopped';
    returnValue.once('active', function () {
      opts.current_back_off = STARTING_BACK_OFF;
    });
  }

  opts.current_back_off = opts.current_back_off || STARTING_BACK_OFF;
  opts.current_back_off = opts.back_off_function(opts.current_back_off);
  setTimeout(callback, opts.current_back_off);
}

const res$1 = toPromise(function (data, callback) {
  const base64 = crypto.createHash('md5').update(data).digest('base64');
  callback(null, base64);
});

/**
 *
 * @param queryParams
 */
function sortObjectPropertiesByKey (queryParams) {
  return Object.keys(queryParams).sort(pouchCollate.collate).reduce(function (result, key) {
    result[key] = queryParams[key];
    return result;
  }, {});
}

// Generate a unique id particular to this replication.
// Not guaranteed to align perfectly with CouchDB's rep ids.
/**
 *
 * @param src
 * @param target
 * @param opts
 */
function generateReplicationId (src, target, opts) {
  const docIds = opts.doc_ids ? opts.doc_ids.sort(pouchCollate.collate) : '';
  const filterFun = opts.filter ? opts.filter.toString() : '';
  let queryParams = '';
  let filterViewName = '';

  if (opts.filter && opts.query_params) {
    queryParams = JSON.stringify(sortObjectPropertiesByKey(opts.query_params));
  }

  if (opts.filter && opts.filter === '_view') {
    filterViewName = opts.view.toString();
  }

  return PouchPromise.all([src.id(), target.id()]).then(function (res) {
    const queryData = res[0] + res[1] + filterFun + filterViewName +
      queryParams + docIds;
    return res$1(queryData);
  }).then(function (md5sum) {
    // can't use straight-up md5 alphabet, because
    // the char '/' is interpreted as being for attachments,
    // and + is also not url-safe
    md5sum = md5sum.replaceAll('/', '.').replaceAll('+', '_');
    return '_local/' + md5sum;
  });
}

/**
 *
 * @param rev
 */
function isGenOne (rev) {
  return (rev).startsWith('1-');
}

/**
 *
 * @param diffs
 */
function createBulkGetOpts (diffs) {
  const requests = [];
  Object.keys(diffs).forEach(function (id) {
    const missingRevs = diffs[id].missing;
    missingRevs.forEach(function (missingRev) {
      requests.push({
        id,
        rev: missingRev
      });
    });
  });

  return {
    docs: requests,
    revs: true,
    attachments: true,
    binary: true
  };
}

//
// Fetch all the documents from the src as described in the "diffs",
// which is a mapping of docs IDs to revisions. If the state ever
// changes to "cancelled", then the returned promise will be rejected.
// Else it will be resolved with a list of fetched documents.
//
/**
 *
 * @param src
 * @param diffs
 * @param state
 */
function getDocs (src, diffs, state) {
  diffs = clone(diffs); // we do not need to modify this

  let resultDocs = [],
    ok = true;

  /**
   *
   */
  function getAllDocs () {
    const bulkGetOpts = createBulkGetOpts(diffs);

    if (!bulkGetOpts.docs.length) { // optimization: skip empty requests
      return;
    }

    return src.bulkGet(bulkGetOpts).then(function (bulkGetResponse) {
      /* istanbul ignore if */
      if (state.cancelled) {
        throw new Error('cancelled');
      }
      bulkGetResponse.results.forEach(function (bulkGetInfo) {
        bulkGetInfo.docs.forEach(function (doc) {
          if (doc.ok) {
            resultDocs.push(doc.ok);
          } else if (doc.error !== undefined) {
            ok = false;
          }
          // else: when AUTO_COMPACTION is set, docs can be returned which look
          // like this: {"missing":"1-7c3ac256b693c462af8442f992b83696"}
        });
      });
    });
  }

  /**
   *
   * @param doc
   */
  function hasAttachments (doc) {
    return doc._attachments && Object.keys(doc._attachments).length > 0;
  }

  /**
   *
   * @param ids
   */
  function fetchRevisionOneDocs (ids) {
    // Optimization: fetch gen-1 docs and attachments in
    // a single request using _all_docs
    return src.allDocs({
      keys: ids,
      include_docs: true
    }).then(function (res) {
      if (state.cancelled) {
        throw new Error('cancelled');
      }
      res.rows.forEach(function (row) {
        if (row.deleted || !row.doc || !isGenOne(row.value.rev) ||
          hasAttachments(row.doc)) {
          // if any of these conditions apply, we need to fetch using get()
          return;
        }

        // the doc we got back from allDocs() is sufficient
        resultDocs.push(row.doc);
        delete diffs[row.id];
      });
    });
  }

  /**
   *
   */
  function getRevisionOneDocs () {
    // filter out the generation 1 docs and get them
    // leaving the non-generation one docs to be got otherwise
    const ids = Object.keys(diffs).filter(function (id) {
      const {missing} = diffs[id];
      return missing.length === 1 && isGenOne(missing[0]);
    });
    if (ids.length > 0) {
      return fetchRevisionOneDocs(ids);
    }
  }

  /**
   *
   */
  function returnResult () {
    return {ok, docs: resultDocs};
  }

  return PouchPromise.resolve().
    then(getRevisionOneDocs).
    then(getAllDocs).
    then(returnResult);
}

/**
 *
 * @param src
 * @param target
 * @param opts
 * @param returnValue
 * @param result
 */
function replicate (src, target, opts, returnValue, result) {
  let batches = []; // list of batches to be processed
  let currentBatch; // the batch currently being processed
  let pendingBatch = {
    seq: 0,
    changes: [],
    docs: []
  }; // next batch, not yet ready to be processed
  let writingCheckpoint = false; // true while checkpoint is being written
  let changesCompleted = false; // true when all changes received
  let replicationCompleted = false; // true when replication has completed
  let last_seq = 0;
  const continuous = opts.continuous || opts.live || false;
  const batch_size = opts.batch_size || 100;
  const batches_limit = opts.batches_limit || 10;
  let changesPending = false; // true while src.changes is running
  const {doc_ids} = opts;
  let repId;
  let checkpointer;
  let allErrors = [];
  let changedDocs = [];
  // Like couchdb, every replication gets a unique session id
  const session = uuid();

  result ||= {
    ok: true,
    start_time: new Date(),
    docs_read: 0,
    docs_written: 0,
    doc_write_failures: 0,
    errors: []
  };

  let changesOpts = {};
  returnValue.ready(src, target);

  /**
   *
   */
  function initCheckpointer () {
    if (checkpointer) {
      return PouchPromise.resolve();
    }
    return generateReplicationId(src, target, opts).then(function (res) {
      repId = res;
      checkpointer = new Checkpointer(src, target, repId, returnValue);
    });
  }

  /**
   *
   */
  function writeDocs () {
    changedDocs = [];

    if (currentBatch.docs.length === 0) {
      return;
    }
    const {docs} = currentBatch;
    return target.bulkDocs({docs, new_edits: false}).then(function (res) {
      if (returnValue.cancelled) {
        completeReplication();
        throw new Error('cancelled');
      }
      const errors = [];
      const errorsById = {};
      res.forEach(function (res) {
        if (!res.error) {
          return;
        }

        result.doc_write_failures++;
        errors.push(res);
        errorsById[res.id] = res;
      });
      allErrors = allErrors.concat(errors);
      result.docs_written += currentBatch.docs.length - errors.length;
      const non403s = errors.filter(function (error) {
        return error.name !== 'unauthorized' && error.name !== 'forbidden';
      });

      docs.forEach(function (doc) {
        const error = errorsById[doc._id];
        if (error) {
          returnValue.emit('denied', clone(error));
        } else {
          changedDocs.push(doc);
        }
      });

      if (non403s.length > 0) {
        const error = new Error('bulkDocs error');
        error.other_errors = errors;
        abortReplication('target.bulkDocs failed to write docs', error);
        throw new Error('bulkWrite partial failure');
      }
    }, function (err) {
      result.doc_write_failures += docs.length;
      throw err;
    });
  }

  /**
   *
   */
  function finishBatch () {
    if (currentBatch.error) {
      throw new Error('There was a problem getting docs.');
    }
    result.last_seq = last_seq = currentBatch.seq;
    const outResult = clone(result);
    if (changedDocs.length) {
      outResult.docs = changedDocs;
      returnValue.emit('change', outResult);
    }
    writingCheckpoint = true;
    return checkpointer.writeCheckpoint(currentBatch.seq,
      session).then(function () {
      writingCheckpoint = false;
      if (returnValue.cancelled) {
        completeReplication();
        throw new Error('cancelled');
      }
      currentBatch = undefined;
      getChanges();
    }).catch(function (err) {
      writingCheckpoint = false;
      abortReplication('writeCheckpoint completed with error', err);
      throw err;
    });
  }

  /**
   *
   */
  function getDiffs () {
    const diff = {};
    currentBatch.changes.forEach(function (change) {
      // Couchbase Sync Gateway emits these, but we can ignore them
      /* istanbul ignore if */
      if (change.id === '_user/') {
        return;
      }
      diff[change.id] = change.changes.map(function (x) {
        return x.rev;
      });
    });
    return target.revsDiff(diff).then(function (diffs) {
      if (returnValue.cancelled) {
        completeReplication();
        throw new Error('cancelled');
      }
      // currentBatch.diffs elements are deleted as the documents are written
      currentBatch.diffs = diffs;
    });
  }

  /**
   *
   */
  function getBatchDocs () {
    return getDocs(src, currentBatch.diffs, returnValue).then(function (got) {
      currentBatch.error = !got.ok;
      got.docs.forEach(function (doc) {
        delete currentBatch.diffs[doc._id];
        result.docs_read++;
        currentBatch.docs.push(doc);
      });
    });
  }

  /**
   *
   */
  function startNextBatch () {
    if (returnValue.cancelled || currentBatch) {
      return;
    }
    if (batches.length === 0) {
      processPendingBatch(true);
      return;
    }
    currentBatch = batches.shift();
    getDiffs().
      then(getBatchDocs).
      then(writeDocs).
      then(finishBatch).
      then(startNextBatch).
      catch(function (err) {
        abortReplication('batch processing terminated with error', err);
      });
  }


  /**
   *
   * @param immediate
   */
  function processPendingBatch (immediate) {
    if (pendingBatch.changes.length === 0) {
      if (batches.length === 0 && !currentBatch) {
        if ((continuous && changesOpts.live) || changesCompleted) {
          returnValue.state = 'pending';
          returnValue.emit('paused');
        }
        if (changesCompleted) {
          completeReplication();
        }
      }
      return;
    }
    if (
      immediate ||
      changesCompleted ||
      pendingBatch.changes.length >= batch_size
    ) {
      batches.push(pendingBatch);
      pendingBatch = {
        seq: 0,
        changes: [],
        docs: []
      };
      if (returnValue.state === 'pending' || returnValue.state === 'stopped') {
        returnValue.state = 'active';
        returnValue.emit('active');
      }
      startNextBatch();
    }
  }


  /**
   *
   * @param reason
   * @param err
   */
  function abortReplication (reason, err) {
    if (replicationCompleted) {
      return;
    }
    if (!err.message) {
      err.message = reason;
    }
    result.ok = false;
    result.status = 'aborting';
    result.errors.push(err);
    allErrors = allErrors.concat(err);
    batches = [];
    pendingBatch = {
      seq: 0,
      changes: [],
      docs: []
    };
    completeReplication();
  }


  /**
   *
   */
  function completeReplication () {
    if (replicationCompleted) {
      return;
    }
    if (returnValue.cancelled) {
      result.status = 'cancelled';
      if (writingCheckpoint) {
        return;
      }
    }
    result.status = result.status || 'complete';
    result.end_time = new Date();
    result.last_seq = last_seq;
    replicationCompleted = true;
    const non403s = allErrors.filter(function (error) {
      return error.name !== 'unauthorized' && error.name !== 'forbidden';
    });
    if (non403s.length > 0) {
      const error = allErrors.pop();
      if (allErrors.length > 0) {
        error.other_errors = allErrors;
      }
      error.result = result;
      backOff(opts, returnValue, error, function () {
        replicate(src, target, opts, returnValue);
      });
    } else {
      result.errors = allErrors;
      returnValue.emit('complete', result);
      returnValue.removeAllListeners();
    }
  }


  /**
   *
   * @param change
   */
  function onChange (change) {
    if (returnValue.cancelled) {
      return completeReplication();
    }
    const filter = filterChange(opts)(change);
    if (!filter) {
      return;
    }
    pendingBatch.seq = change.seq;
    pendingBatch.changes.push(change);
    processPendingBatch(changesOpts.live);
  }


  /**
   *
   * @param changes
   */
  function onChangesComplete (changes) {
    changesPending = false;
    if (returnValue.cancelled) {
      return completeReplication();
    }

    // if no results were returned then we're done,
    // else fetch more
    if (changes.results.length > 0) {
      changesOpts.since = changes.last_seq;
      getChanges();
    } else if (continuous) {
      changesOpts.live = true;
      getChanges();
    } else {
      changesCompleted = true;
    }
    processPendingBatch(true);
  }


  /**
   *
   * @param err
   */
  function onChangesError (err) {
    changesPending = false;
    /* istanbul ignore if */
    if (returnValue.cancelled) {
      return completeReplication();
    }
    abortReplication('changes rejected', err);
  }


  /**
   *
   */
  function getChanges () {
    if (!(
      !changesPending &&
        !changesCompleted &&
        batches.length < batches_limit
    )) {
      return;
    }
    changesPending = true;
    /**
     *
     */
    function abortChanges () {
      changes.cancel();
    }
    /**
     *
     */
    function removeListener () {
      returnValue.removeListener('cancel', abortChanges);
    }

    if (returnValue._changes) { // remove old changes() and listeners
      returnValue.removeListener('cancel', returnValue._abortChanges);
      returnValue._changes.cancel();
    }
    returnValue.once('cancel', abortChanges);

    var changes = src.changes(changesOpts).
      on('change', onChange);
    changes.then(removeListener, removeListener);
    changes.then(onChangesComplete).
      catch(onChangesError);

    if (opts.retry) {
      // save for later so we can cancel if necessary
      returnValue._changes = changes;
      returnValue._abortChanges = abortChanges;
    }
  }


  /**
   *
   */
  function startChanges () {
    initCheckpointer().then(function () {
      if (returnValue.cancelled) {
        completeReplication();
        return;
      }
      return checkpointer.getCheckpoint().then(function (checkpoint) {
        last_seq = checkpoint;
        changesOpts = {
          since: last_seq,
          limit: batch_size,
          batch_size,
          style: 'all_docs',
          doc_ids,
          return_docs: true // required so we know when we're done
        };
        if (opts.filter) {
          if (typeof opts.filter !== 'string') {
            // required for the client-side filter in onChange
            changesOpts.include_docs = true;
          } else { // ddoc filter
            changesOpts.filter = opts.filter;
          }
        }
        if ('heartbeat' in opts) {
          changesOpts.heartbeat = opts.heartbeat;
        }
        if ('timeout' in opts) {
          changesOpts.timeout = opts.timeout;
        }
        if (opts.query_params) {
          changesOpts.query_params = opts.query_params;
        }
        if (opts.view) {
          changesOpts.view = opts.view;
        }
        getChanges();
      });
    }).catch(function (err) {
      abortReplication('getCheckpoint rejected with ', err);
    });
  }

  /* c8 ignore next */
  /**
   *
   * @param err
   */
  function onCheckpointError (err) {
    writingCheckpoint = false;
    abortReplication('writeCheckpoint completed with error', err);
    throw err;
  }

  /* istanbul ignore if */
  if (returnValue.cancelled) { // cancelled immediately
    completeReplication();
    return;
  }

  if (!returnValue._addedListeners) {
    returnValue.once('cancel', completeReplication);

    if (typeof opts.complete === 'function') {
      returnValue.once('error', opts.complete);
      returnValue.once('complete', function (result) {
        opts.complete(null, result);
      });
    }
    returnValue._addedListeners = true;
  }

  if (typeof opts.since === 'undefined') {
    startChanges();
  } else {
    initCheckpointer().then(function () {
      writingCheckpoint = true;
      return checkpointer.writeCheckpoint(opts.since, session);
    }).then(function () {
      writingCheckpoint = false;
      /* istanbul ignore if */
      if (returnValue.cancelled) {
        completeReplication();
        return;
      }
      last_seq = opts.since;
      startChanges();
    }).catch(onCheckpointError);
  }
}

// We create a basic promise so the caller can cancel the replication possibly
// before we have actually started listening to changes etc
inherits(Replication, events.EventEmitter);
/**
 *
 */
function Replication () {
  events.EventEmitter.call(this);
  this.cancelled = false;
  this.state = 'pending';
  const self = this;
  const promise = new PouchPromise(function (fulfill, reject) {
    self.once('complete', fulfill);
    self.once('error', reject);
  });
  self.then = function (resolve, reject) {
    return promise.then(resolve, reject);
  };
  self.catch = function (reject) {
    return promise.catch(reject);
  };
  // As we allow error handling via "error" event as well,
  // put a stub in here so that rejecting never throws UnhandledError.
  self.catch(function () {});
}

Replication.prototype.cancel = function () {
  this.cancelled = true;
  this.state = 'cancelled';
  this.emit('cancel');
};

Replication.prototype.ready = function (src, target) {
  const self = this;
  if (self._readyCalled) {
    return;
  }
  self._readyCalled = true;

  /**
   *
   */
  function onDestroy () {
    self.cancel();
  }
  src.once('destroyed', onDestroy);
  target.once('destroyed', onDestroy);
  /**
   *
   */
  function cleanup () {
    src.removeListener('destroyed', onDestroy);
    target.removeListener('destroyed', onDestroy);
  }
  self.once('complete', cleanup);
};

/**
 *
 * @param db
 * @param opts
 */
function toPouch (db, opts) {
  const {PouchConstructor} = opts;
  return typeof db === 'string' ? new PouchConstructor(db, opts) : db;
}

/**
 *
 * @param src
 * @param target
 * @param opts
 * @param callback
 */
function replicateWrapper (src, target, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  if (typeof opts === 'undefined') {
    opts = {};
  }

  if (opts.doc_ids && !Array.isArray(opts.doc_ids)) {
    throw createError(BAD_REQUEST,
      '`doc_ids` filter parameter is not a list.');
  }

  opts.complete = callback;
  opts = clone(opts);
  opts.continuous = opts.continuous || opts.live;
  opts.retry = ('retry' in opts) ? opts.retry : false;

  opts.PouchConstructor = opts.PouchConstructor || this;
  const replicateRet = new Replication(opts);
  const srcPouch = toPouch(src, opts);
  const targetPouch = toPouch(target, opts);
  replicate(srcPouch, targetPouch, opts, replicateRet);
  return replicateRet;
}

const replication = {
  replicate: replicateWrapper,
  toPouch
};

const replicate$1 = replication.replicate;
inherits(Sync, events.EventEmitter);
/**
 *
 * @param src
 * @param target
 * @param opts
 * @param callback
 */
function sync (src, target, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  if (typeof opts === 'undefined') {
    opts = {};
  }
  opts = clone(opts);

  opts.PouchConstructor = opts.PouchConstructor || this;
  src = replication.toPouch(src, opts);
  target = replication.toPouch(target, opts);
  return new Sync(src, target, opts, callback);
}

/**
 *
 * @param src
 * @param target
 * @param opts
 * @param callback
 */
function Sync (src, target, opts, callback) {
  const self = this;
  this.canceled = false;

  const optsPush = opts.push ? jsExtend.extend({}, opts, opts.push) : opts;
  const optsPull = opts.pull ? jsExtend.extend({}, opts, opts.pull) : opts;

  this.push = replicate$1(src, target, optsPush);
  this.pull = replicate$1(target, src, optsPull);

  this.pushPaused = true;
  this.pullPaused = true;

  /**
   *
   * @param change
   */
  function pullChange (change) {
    self.emit('change', {
      direction: 'pull',
      change
    });
  }
  /**
   *
   * @param change
   */
  function pushChange (change) {
    self.emit('change', {
      direction: 'push',
      change
    });
  }
  /**
   *
   * @param doc
   */
  function pushDenied (doc) {
    self.emit('denied', {
      direction: 'push',
      doc
    });
  }
  /**
   *
   * @param doc
   */
  function pullDenied (doc) {
    self.emit('denied', {
      direction: 'pull',
      doc
    });
  }
  /**
   *
   */
  function pushPaused () {
    self.pushPaused = true;
    if (self.pullPaused) {
      self.emit('paused');
    }
  }
  /**
   *
   */
  function pullPaused () {
    self.pullPaused = true;
    if (self.pushPaused) {
      self.emit('paused');
    }
  }
  /**
   *
   */
  function pushActive () {
    self.pushPaused = false;
    if (self.pullPaused) {
      self.emit('active', {
        direction: 'push'
      });
    }
  }
  /**
   *
   */
  function pullActive () {
    self.pullPaused = false;
    /* istanbul ignore if */
    if (self.pushPaused) {
      self.emit('active', {
        direction: 'pull'
      });
    }
  }

  const removed = {};

  /**
   *
   * @param type
   */
  function removeAll (type) { // type is 'push' or 'pull'
    return function (event, func) {
      const isChange = event === 'change' &&
        (func === pullChange || func === pushChange);
      const isDenied = event === 'denied' &&
        (func === pullDenied || func === pushDenied);
      const isPaused = event === 'paused' &&
        (func === pullPaused || func === pushPaused);
      const isActive = event === 'active' &&
        (func === pullActive || func === pushActive);

      if (isChange || isDenied || isPaused || isActive) {
        if (!(event in removed)) {
          removed[event] = {};
        }
        removed[event][type] = true;
        if (Object.keys(removed[event]).length === 2) {
          // both push and pull have asked to be removed
          self.removeAllListeners(event);
        }
      }
    };
  }

  if (opts.live) {
    this.push.on('complete', self.pull.cancel.bind(self.pull));
    this.pull.on('complete', self.push.cancel.bind(self.push));
  }

  this.on('newListener', function (event) {
    switch (event) {
    case 'change': {
      self.pull.on('change', pullChange);
      self.push.on('change', pushChange);

      break;
    }
    case 'denied': {
      self.pull.on('denied', pullDenied);
      self.push.on('denied', pushDenied);

      break;
    }
    case 'active': {
      self.pull.on('active', pullActive);
      self.push.on('active', pushActive);

      break;
    }
    case 'paused': {
      self.pull.on('paused', pullPaused);
      self.push.on('paused', pushPaused);

      break;
    }
    // No default
    }
  });

  this.on('removeListener', function (event) {
    switch (event) {
    case 'change': {
      self.pull.removeListener('change', pullChange);
      self.push.removeListener('change', pushChange);

      break;
    }
    case 'denied': {
      self.pull.removeListener('denied', pullDenied);
      self.push.removeListener('denied', pushDenied);

      break;
    }
    case 'active': {
      self.pull.removeListener('active', pullActive);
      self.push.removeListener('active', pushActive);

      break;
    }
    case 'paused': {
      self.pull.removeListener('paused', pullPaused);
      self.push.removeListener('paused', pushPaused);

      break;
    }
    // No default
    }
  });

  this.pull.on('removeListener', removeAll('pull'));
  this.push.on('removeListener', removeAll('push'));

  const promise = PouchPromise.all([
    this.push,
    this.pull
  ]).then(function (resp) {
    const out = {
      push: resp[0],
      pull: resp[1]
    };
    self.emit('complete', out);
    if (callback) {
      callback(null, out);
    }
    self.removeAllListeners();
    return out;
  }, function (err) {
    self.cancel();
    if (callback) {
      // if there's a callback, then the callback can receive
      // the error event
      callback(err);
    } else {
      // if there's no callback, then we're safe to emit an error
      // event, which would otherwise throw an unhandled error
      // due to 'error' being a special event in EventEmitters
      self.emit('error', err);
    }
    self.removeAllListeners();
    if (callback) {
      // no sense throwing if we're already emitting an 'error' event
      throw err;
    }
  });

  this.then = function (success, err) {
    return promise.then(success, err);
  };

  this.catch = function (err) {
    return promise.catch(err);
  };
}

Sync.prototype.cancel = function () {
  if (this.canceled) {
    return;
  }

  this.canceled = true;
  this.push.cancel();
  this.pull.cancel();
};

/**
 *
 * @param b64
 * @param type
 */
function b64ToBluffer (b64, type) {
  return typedBuffer(b64, 'base64', type);
}

/**
 *
 * @param blobOrBuffer
 */
function blobToBase64 (blobOrBuffer) {
  return PouchPromise.resolve(blobOrBuffer.toString('base64'));
}

/**
 *
 * @param arrs
 */
function flatten (arrs) {
  let res = [];
  for (const arr of arrs) {
    res = res.concat(arr);
  }
  return res;
}

const CHANGES_BATCH_SIZE = 25;
const MAX_SIMULTANEOUS_REVS = 50;

const supportsBulkGetMap = {};

// according to https://stackoverflow.com/a/417184/680742,
// the de facto URL length limit is 2000 characters.
// but since most of our measurements don't take the full
// URL into account, we fudge it a bit.
// TODO: we could measure the full URL to enforce exactly 2000 chars
const MAX_URL_LENGTH = 1800;

const log$1 = debug('pouchdb:http');
/**
 *
 * @param row
 */
function readAttachmentsAsBlobOrBuffer (row) {
  const atts = row.doc && row.doc._attachments;
  if (!atts) {
    return;
  }
  Object.keys(atts).forEach(function (filename) {
    const att = atts[filename];
    att.data = b64ToBluffer(att.data, att.content_type);
  });
}

/**
 *
 * @param id
 */
function encodeDocId (id) {
  if ((id).startsWith('_design')) {
    return '_design/' + encodeURIComponent(id.slice(8));
  }
  if ((id).startsWith('_local')) {
    return '_local/' + encodeURIComponent(id.slice(7));
  }
  return encodeURIComponent(id);
}

/**
 *
 * @param doc
 */
function preprocessAttachments (doc) {
  if (!doc._attachments || !Object.keys(doc._attachments)) {
    return PouchPromise.resolve();
  }

  return PouchPromise.all(Object.keys(doc._attachments).map(function (key) {
    const attachment = doc._attachments[key];
    if (attachment.data && typeof attachment.data !== 'string') {
      return blobToBase64(attachment.data).then(function (b64) {
        attachment.data = b64;
      });
    }
  }));
}

// Get all the information you possibly can about the URI given by name and
// return it as a suitable object.
/**
 *
 * @param name
 */
function getHost (name) {
  // Prase the URI into all its little bits
  const uri = parseUri(name);

  // Store the user and password as a separate auth object
  if (uri.user || uri.password) {
    uri.auth = {username: uri.user, password: uri.password};
  }

  // Split the path part of the URI into parts using '/' as the delimiter
  // after removing any leading '/' and any trailing '/'
  const parts = uri.path.replaceAll(/(^\/|\/$)/g, '').split('/');

  // Store the first part as the database name and remove it from the parts
  // array
  uri.db = parts.pop();
  // Prevent double encoding of URI component
  if (!uri.db.includes('%')) {
    uri.db = encodeURIComponent(uri.db);
  }

  // Restore the path by joining all the remaining parts (all the parts
  // except for the database name) with '/'s
  uri.path = parts.join('/');

  return uri;
}

// Generate a URL with the host data given by opts and the given path
/**
 *
 * @param opts
 * @param path
 */
function genDBUrl (opts, path) {
  return genUrl(opts, opts.db + '/' + path);
}

// Generate a URL with the host data given by opts and the given path
/**
 *
 * @param opts
 * @param path
 */
function genUrl (opts, path) {
  // If the host already has a path, then we need to have a path delimiter
  // Otherwise, the path delimiter is the empty string
  const pathDel = !opts.path ? '' : '/';

  // If the host already has a path, then we need to have a path delimiter
  // Otherwise, the path delimiter is the empty string
  return opts.protocol + '://' + opts.host +
    (opts.port ? (':' + opts.port) : '') +
    '/' + opts.path + pathDel + path;
}

/**
 *
 * @param params
 */
function paramsToStr (params) {
  return '?' + Object.entries(params).map(function ([k, value]) {
    return k + '=' + encodeURIComponent(value);
  }).join('&');
}

// Implements the PouchDB API for dealing with CouchDB instances over HTTP
/**
 *
 * @param opts
 * @param callback
 */
function HttpPouch (opts, callback) {
  // The functions that will be publicly available for HttpPouch
  const api = this;

  // Parse the URI given by opts.name into an easy-to-use object
  let getHostFun = getHost;

  // TODO: this seems to only be used by yarong for the Thali project.
  // Verify whether or not it's still needed.
  /* istanbul ignore if */
  if (opts.getHost) {
    getHostFun = opts.getHost;
  }

  const host = getHostFun(opts.name, opts);
  const dbUrl = genDBUrl(host, '');

  opts = clone(opts);
  const ajaxOpts = opts.ajax || {};

  api.getUrl = function () {
    return dbUrl;
  };
  api.getHeaders = function () {
    return ajaxOpts.headers || {};
  };

  if (opts.auth || host.auth) {
    const nAuth = opts.auth || host.auth;
    const str = nAuth.username + ':' + nAuth.password;
    const token = btoa(unescape(encodeURIComponent(str)));
    ajaxOpts.headers = ajaxOpts.headers || {};
    ajaxOpts.headers.Authorization = 'Basic ' + token;
  }

  /**
   *
   * @param userOpts
   * @param options
   * @param callback
   */
  function ajax (userOpts, options, callback) {
    const reqAjax = userOpts.ajax || {};
    const reqOpts = jsExtend.extend(clone(ajaxOpts), reqAjax, options);
    log$1(reqOpts.method + ' ' + reqOpts.url);
    return utils.ajax(reqOpts, callback);
  }

  /**
   *
   * @param userOpts
   * @param opts
   */
  function ajaxPromise (userOpts, opts) {
    return new PouchPromise(function (resolve, reject) {
      ajax(userOpts, opts, function (err, res$$) {
        if (err) {
          return reject(err);
        }
        resolve(res$$);
      });
    });
  }

  /**
   *
   * @param name
   * @param fun
   */
  function adapterFun$$ (name, fun) {
    return adapterFun(name, getArguments(function (args) {
      setup().then(function () {
        return fun.apply(this, args);
      }).catch(function (e) {
        const callback = args.pop();
        callback(e);
      });
    }));
  }

  var setupPromise;

  /**
   *
   */
  function setup () {
    // TODO: Remove `skipSetup` in favor of `skip_setup` in a future release
    if (opts.skipSetup || opts.skip_setup) {
      return PouchPromise.resolve();
    }

    // If there is a setup in process or previous successful setup
    // done then we will use that
    // If previous setups have been rejected we will try again
    if (setupPromise) {
      return setupPromise;
    }

    const checkExists = {method: 'GET', url: dbUrl};
    setupPromise = ajaxPromise({}, checkExists).catch(function (err) {
      if (err && err.status && err.status === 404) {
        // Doesnt exist, create it
        res(404, 'PouchDB is just detecting if the remote exists.');
        return ajaxPromise({}, {method: 'PUT', url: dbUrl});
      }
      return PouchPromise.reject(err);
    }).catch(function (err) {
      // If we try to create a database that already exists
      if (err && err.status && err.status === 412) {
        return true;
      }
      return PouchPromise.reject(err);
    });

    setupPromise.catch(function () {
      setupPromise = null;
    });

    return setupPromise;
  }

  setTimeout(function () {
    callback(null, api);
  }, 0);

  api.type = function () {
    return 'http';
  };

  api.id = adapterFun$$('id', function (callback) {
    ajax({}, {method: 'GET', url: genUrl(host, '')}, function (err, result) {
      const uuid = (result && result.uuid)
        ? (result.uuid + host.db)
        : genDBUrl(host, '');
      callback(null, uuid);
    });
  });

  api.request = adapterFun$$('request', function (options, callback) {
    options.url = genDBUrl(host, options.url);
    ajax({}, options, callback);
  });

  // Sends a POST request to the host calling the couchdb _compact function
  //    version: The version of CouchDB it is running
  api.compact = adapterFun$$('compact', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = clone(opts);
    ajax(opts, {
      url: genDBUrl(host, '_compact'),
      method: 'POST'
    }, function () {
      /**
       *
       */
      function ping () {
        api.info(function (err, res$$) {
          if (res$$ && !res$$.compact_running) {
            callback(null, {ok: true});
          } else {
            setTimeout(ping, opts.interval || 200);
          }
        });
      }
      // Ping the http if it's finished compaction
      ping();
    });
  });

  api.bulkGet = adapterFun('bulkGet', function (opts, callback) {
    const self = this;

    /**
     *
     * @param cb
     */
    function doBulkGet (cb) {
      const params = {};
      if (opts.revs) {
        params.revs = true;
      }
      if (opts.attachments) {
        params.attachments = true;
      }
      ajax({}, {
        url: genDBUrl(host, '_bulk_get' + paramsToStr(params)),
        method: 'POST',
        body: {docs: opts.docs}
      }, cb);
    }

    /**
     *
     */
    function doBulkGetShim () {
      // avoid "url too long error" by splitting up into multiple requests
      const batchSize = MAX_SIMULTANEOUS_REVS;
      const numBatches = Math.ceil(opts.docs.length / batchSize);
      let numDone = 0;
      const results = new Array(numBatches);

      /**
       *
       * @param batchNum
       */
      function onResult (batchNum) {
        return function (err, res$$) {
          // err is impossible because shim returns a list of errs in that case
          results[batchNum] = res$$.results;
          if (++numDone === numBatches) {
            callback(null, {results: flatten(results)});
          }
        };
      }

      for (let i = 0; i < numBatches; i++) {
        const subOpts = pick(opts, ['revs', 'attachments']);
        subOpts.ajax = ajaxOpts;
        subOpts.docs = opts.docs.slice(i * batchSize,
          Math.min(opts.docs.length, (i + 1) * batchSize));
        bulkGet(self, subOpts, onResult(i));
      }
    }

    // mark the whole database as either supporting or not supporting _bulk_get
    const dbUrl = genUrl(host, '');
    const supportsBulkGet = supportsBulkGetMap[dbUrl];

    if (typeof supportsBulkGet !== 'boolean') {
      // check if this database supports _bulk_get
      doBulkGet(function (err, res$$) {
        /* istanbul ignore else */
        if (err) {
          const status = Math.floor(err.status / 100);
          /* istanbul ignore else */
          if (status === 4 || status === 5) { // 40x or 50x
            supportsBulkGetMap[dbUrl] = false;
            res(
              err.status,
              'PouchDB is just detecting if the remote ' +
              'supports the _bulk_get API.'
            );
            doBulkGetShim();
          } else {
            callback(err);
          }
        } else {
          supportsBulkGetMap[dbUrl] = true;
          callback(null, res$$);
        }
      });
    } else if (supportsBulkGet) {
      /* c8 ignore next */
      doBulkGet(callback);
    } else {
      doBulkGetShim();
    }
  });

  // Calls GET on the host, which gets back a JSON string containing
  //    couchdb: A welcome string
  //    version: The version of CouchDB it is running
  api._info = function (callback) {
    setup().then(function () {
      ajax({}, {
        method: 'GET',
        url: genDBUrl(host, '')
      }, function (err, res$$) {
        /* c8 ignore next */
        if (err) {
          return callback(err);
        }
        res$$.host = genDBUrl(host, '');
        callback(null, res$$);
      });
    }).catch(callback);
  };

  // Get the document with the given id from the database given by host.
  // The id could be solely the _id in the database, or it may be a
  // _design/ID or _local/ID path
  api.get = adapterFun$$('get', function (id, opts, callback) {
    // If no options were given, set the callback to the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = clone(opts);

    // List of parameters to add to the GET request
    const params = {};

    if (opts.revs) {
      params.revs = true;
    }

    if (opts.revs_info) {
      params.revs_info = true;
    }

    if (opts.open_revs) {
      if (opts.open_revs !== 'all') {
        opts.open_revs = JSON.stringify(opts.open_revs);
      }
      params.open_revs = opts.open_revs;
    }

    if (opts.rev) {
      params.rev = opts.rev;
    }

    if (opts.conflicts) {
      params.conflicts = opts.conflicts;
    }

    id = encodeDocId(id);

    // Set the options for the ajax call
    const options = {
      method: 'GET',
      url: genDBUrl(host, id + paramsToStr(params))
    };

    /**
     *
     * @param doc
     */
    function fetchAttachments (doc) {
      const atts = doc._attachments;
      const filenames = atts && Object.keys(atts);
      if (!atts || !filenames.length) {
        return;
      }
      // we fetch these manually in separate XHRs, because
      // Sync Gateway would normally send it back as multipart/mixed,
      // which we cannot parse. Also, this is more efficient than
      // receiving attachments as base64-encoded strings.
      return PouchPromise.all(filenames.map(function (filename) {
        const att = atts[filename];
        const path = encodeDocId(doc._id) + '/' + encodeAttachmentId(filename) +
          '?rev=' + doc._rev;
        return ajaxPromise(opts, {
          method: 'GET',
          url: genDBUrl(host, path),
          binary: true
        }).then(function (blob) {
          if (opts.binary) {
            return blob;
          }
          return blobToBase64(blob);
        }).then(function (data) {
          delete att.stub;
          delete att.length;
          att.data = data;
        });
      }));
    }

    /**
     *
     * @param docOrDocs
     */
    function fetchAllAttachments (docOrDocs) {
      if (Array.isArray(docOrDocs)) {
        return PouchPromise.all(docOrDocs.map(function (doc) {
          if (doc.ok) {
            return fetchAttachments(doc.ok);
          }
        }));
      }
      return fetchAttachments(docOrDocs);
    }

    ajaxPromise(opts, options).then(function (res$$) {
      return PouchPromise.resolve().then(function () {
        if (opts.attachments) {
          return fetchAllAttachments(res$$);
        }
      }).then(function () {
        callback(null, res$$);
      });
    }).catch(callback);
  });

  // Delete the document given by doc from the database given by host.
  api.remove = adapterFun$$('remove',
    function (docOrId, optsOrRev, opts, callback) {
      let doc;
      if (typeof optsOrRev === 'string') {
        // id, rev, opts, callback style
        doc = {
          _id: docOrId,
          _rev: optsOrRev
        };
        if (typeof opts === 'function') {
          callback = opts;
          opts = {};
        }
      } else {
        // doc, opts, callback style
        doc = docOrId;
        if (typeof optsOrRev === 'function') {
          callback = optsOrRev;
          opts = {};
        } else {
          callback = opts;
          opts = optsOrRev;
        }
      }

      const rev = (doc._rev || opts.rev);

      // Delete the document
      ajax(opts, {
        method: 'DELETE',
        url: genDBUrl(host, encodeDocId(doc._id)) + '?rev=' + rev
      }, callback);
    });

  /**
   *
   * @param attachmentId
   */
  function encodeAttachmentId (attachmentId) {
    return attachmentId.split('/').map(encodeURIComponent).join('/');
  }

  // Get the attachment
  api.getAttachment =
    adapterFun$$('getAttachment', function (docId, attachmentId, opts,
      callback) {
      if (typeof opts === 'function') {
        callback = opts;
        opts = {};
      }
      const params = opts.rev ? ('?rev=' + opts.rev) : '';
      const url = genDBUrl(host, encodeDocId(docId)) + '/' +
        encodeAttachmentId(attachmentId) + params;
      ajax(opts, {
        method: 'GET',
        url,
        binary: true
      }, callback);
    });

  // Remove the attachment given by the id and rev
  api.removeAttachment =
    adapterFun$$('removeAttachment', function (docId, attachmentId, rev,
      callback) {
      const url = genDBUrl(host, encodeDocId(docId) + '/' +
          encodeAttachmentId(attachmentId)) + '?rev=' + rev;

      ajax({}, {
        method: 'DELETE',
        url
      }, callback);
    });

  // Add the attachment given by blob and its contentType property
  // to the document with the given id, the revision given by rev, and
  // add it to the database given by host.
  api.putAttachment =
    adapterFun$$('putAttachment', function (docId, attachmentId, rev, blob,
      type, callback) {
      if (typeof type === 'function') {
        callback = type;
        type = blob;
        blob = rev;
        rev = null;
      }
      const id = encodeDocId(docId) + '/' + encodeAttachmentId(attachmentId);
      let url = genDBUrl(host, id);
      if (rev) {
        url += '?rev=' + rev;
      }

      if (typeof blob === 'string') {
        // input is assumed to be a base64 string
        let binary;
        try {
          binary = atob(blob);
        } catch (err) {
          return callback(createError(BAD_ARG,
            'Attachment is not a valid base64 string'));
        }
        blob = binary ? binStringToBluffer(binary, type) : '';
      }

      const opts = {
        headers: {'Content-Type': type},
        method: 'PUT',
        url,
        processData: false,
        body: blob,
        timeout: ajaxOpts.timeout || 60000
      };
      // Add the attachment
      ajax({}, opts, callback);
    });

  // Update/create multiple documents given by req in the database
  // given by host.
  api._bulkDocs = function (req, opts, callback) {
    // If new_edits=false then it prevents the database from creating
    // new revision numbers for the documents. Instead it just uses
    // the old ones. This is used in database replication.
    req.new_edits = opts.new_edits;

    setup().then(function () {
      return PouchPromise.all(req.docs.map(preprocessAttachments));
    }).then(function () {
      // Update/create the documents
      ajax(opts, {
        method: 'POST',
        url: genDBUrl(host, '_bulk_docs'),
        body: req
      }, function (err, results) {
        if (err) {
          return callback(err);
        }
        results.forEach(function (result) {
          result.ok = true; // smooths out cloudant not adding this
        });
        callback(null, results);
      });
    }).catch(callback);
  };

  // Get a listing of the documents in the database given
  // by host and ordered by increasing id.
  api.allDocs = adapterFun$$('allDocs', function (opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    opts = clone(opts);

    // List of parameters to add to the GET request
    const params = {};
    let body;
    let method = 'GET';

    if (opts.conflicts) {
      params.conflicts = true;
    }

    if (opts.descending) {
      params.descending = true;
    }

    if (opts.include_docs) {
      params.include_docs = true;
    }

    // added in CouchDB 1.6.0
    if (opts.attachments) {
      params.attachments = true;
    }

    if (opts.key) {
      params.key = JSON.stringify(opts.key);
    }

    if (opts.start_key) {
      opts.startkey = opts.start_key;
    }

    if (opts.startkey) {
      params.startkey = JSON.stringify(opts.startkey);
    }

    if (opts.end_key) {
      opts.endkey = opts.end_key;
    }

    if (opts.endkey) {
      params.endkey = JSON.stringify(opts.endkey);
    }

    if (typeof opts.inclusive_end !== 'undefined') {
      params.inclusive_end = Boolean(opts.inclusive_end);
    }

    if (typeof opts.limit !== 'undefined') {
      params.limit = opts.limit;
    }

    if (typeof opts.skip !== 'undefined') {
      params.skip = opts.skip;
    }

    let paramStr = paramsToStr(params);

    if (typeof opts.keys !== 'undefined') {
      const keysAsString =
        'keys=' + encodeURIComponent(JSON.stringify(opts.keys));
      if (keysAsString.length + paramStr.length + 1 <= MAX_URL_LENGTH) {
        // If the keys are short enough, do a GET. we do this to work around
        // Safari not understanding 304s on POSTs (see issue #1239)
        paramStr += '&' + keysAsString;
      } else {
        // If keys are too long, issue a POST request to circumvent GET
        // query string limits
        // see https://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
        method = 'POST';
        body = {keys: opts.keys};
      }
    }

    // Get the document listing
    ajaxPromise(opts, {
      method,
      url: genDBUrl(host, '_all_docs' + paramStr),
      body
    }).then(function (res$$) {
      if (opts.include_docs && opts.attachments && opts.binary) {
        res$$.rows.forEach(readAttachmentsAsBlobOrBuffer);
      }
      callback(null, res$$);
    }).catch(callback);
  });

  // Get a list of changes made to documents in the database given by host.
  // TODO According to the README, there should be two other methods here,
  // api.changes.addListener and api.changes.removeListener.
  api._changes = function (opts) {
    // We internally page the results of a changes request, this means
    // if there is a large set of changes to be returned we can start
    // processing them quicker instead of waiting on the entire
    // set of changes to return and attempting to process them at once
    const batchSize = 'batch_size' in opts ? opts.batch_size : CHANGES_BATCH_SIZE;

    opts = clone(opts);
    opts.timeout = ('timeout' in opts)
      ? opts.timeout
      : ('timeout' in ajaxOpts)
        ? ajaxOpts.timeout
        : 30 * 1000;

    // We give a 5 second buffer for CouchDB changes to respond with
    // an ok timeout (if a timeout it set)
    const params = opts.timeout ? {timeout: opts.timeout - (5 * 1000)} : {};
    const limit = (typeof opts.limit !== 'undefined') ? opts.limit : false;
    let returnDocs;
    if ('return_docs' in opts) {
      returnDocs = opts.return_docs;
    } else if ('returnDocs' in opts) {
      // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }
    //
    let leftToFetch = limit;

    if (opts.style) {
      params.style = opts.style;
    }

    if (opts.include_docs || opts.filter && typeof opts.filter === 'function') {
      params.include_docs = true;
    }

    if (opts.attachments) {
      params.attachments = true;
    }

    if (opts.continuous) {
      params.feed = 'longpoll';
    }

    if (opts.conflicts) {
      params.conflicts = true;
    }

    if (opts.descending) {
      params.descending = true;
    }

    if ('heartbeat' in opts) {
      // If the heartbeat value is false, it disables the default heartbeat
      if (opts.heartbeat) {
        params.heartbeat = opts.heartbeat;
      }
    } else {
      // Default heartbeat to 10 seconds
      params.heartbeat = 10000;
    }

    if (opts.filter && typeof opts.filter === 'string') {
      params.filter = opts.filter;
      if (opts.filter === '_view' &&
        opts.view &&
        typeof opts.view === 'string') {
        params.view = opts.view;
      }
    }

    // If opts.query_params exists, pass it through to the changes request.
    // These parameters may be used by the filter on the source database.
    if (opts.query_params && typeof opts.query_params === 'object') {
      for (const param_name in opts.query_params) {
        /* istanbul ignore else */
        if (opts.query_params.hasOwnProperty(param_name)) {
          params[param_name] = opts.query_params[param_name];
        }
      }
    }

    let method = 'GET';
    let body;

    if (opts.doc_ids) {
      // set this automagically for the user; it's annoying that couchdb
      // requires both a "filter" and a "doc_ids" param.
      params.filter = '_doc_ids';

      const docIdsJson = JSON.stringify(opts.doc_ids);

      if (docIdsJson.length < MAX_URL_LENGTH) {
        params.doc_ids = docIdsJson;
      } else {
        // anything greater than ~2000 is unsafe for gets, so
        // use POST instead
        method = 'POST';
        body = {doc_ids: opts.doc_ids};
      }
    }

    let xhr;
    let lastFetchedSeq;

    // Get all the changes starting wtih the one immediately after the
    // sequence number given by since.
    const fetch = function (since, callback) {
      if (opts.aborted) {
        return;
      }
      params.since = since;
      // "since" can be any kind of json object in Coudant/CouchDB 2.x
      /* c8 ignore next */
      if (typeof params.since === 'object') {
        params.since = JSON.stringify(params.since);
      }

      if (opts.descending) {
        if (limit) {
          params.limit = leftToFetch;
        }
      } else {
        params.limit = (!limit || leftToFetch > batchSize)
          ? batchSize
          : leftToFetch;
      }

      // Set the options for the ajax call
      const xhrOpts = {
        method,
        url: genDBUrl(host, '_changes' + paramsToStr(params)),
        timeout: opts.timeout,
        body
      };
      lastFetchedSeq = since;

      /* istanbul ignore if */
      if (opts.aborted) {
        return;
      }

      // Get the changes
      setup().then(function () {
        xhr = ajax(opts, xhrOpts, callback);
      }).catch(callback);
    };

    // If opts.since exists, get all the changes from the sequence
    // number given by opts.since. Otherwise, get all the changes
    // from the sequence number 0.
    const results = {results: []};

    const fetched = function (err, res$$) {
      if (opts.aborted) {
        return;
      }
      let raw_results_length = 0;
      // If the result of the ajax call (res) contains changes (res.results)
      if (res$$ && res$$.results) {
        raw_results_length = res$$.results.length;
        results.last_seq = res$$.last_seq;
        // For each change
        const req = {query: opts.query_params};
        res$$.results = res$$.results.filter(function (c) {
          leftToFetch--;
          const ret = filterChange(opts)(c);
          if (ret) {
            if (opts.include_docs && opts.attachments && opts.binary) {
              readAttachmentsAsBlobOrBuffer(c);
            }
            if (returnDocs) {
              results.results.push(c);
            }
            opts.onChange(c);
          }
          return ret;
        });
      } else if (err) {
        // In case of an error, stop listening for changes and call
        // opts.complete
        opts.aborted = true;
        opts.complete(err);
        return;
      }

      // The changes feed may have timed out with no results
      // if so reuse last update sequence
      if (res$$ && res$$.last_seq) {
        lastFetchedSeq = res$$.last_seq;
      }

      const finished = (limit && leftToFetch <= 0) ||
        (res$$ && raw_results_length < batchSize) ||
        (opts.descending);

      if ((opts.continuous && !(limit && leftToFetch <= 0)) || !finished) {
        // Queue a call to fetch again with the newest sequence number
        setTimeout(function () {
          fetch(lastFetchedSeq, fetched);
        }, 0);
      } else {
        // We're done, call the callback
        opts.complete(null, results);
      }
    };

    fetch(opts.since || 0, fetched);

    // Return a method to cancel this method from processing any more
    return {
      cancel () {
        opts.aborted = true;
        if (xhr) {
          xhr.abort();
        }
      }
    };
  };

  // Given a set of document/revision IDs (given by req), tets the subset of
  // those that do NOT correspond to revisions stored in the database.
  // See https://wiki.apache.org/couchdb/HttpPostRevsDiff
  api.revsDiff = adapterFun$$('revsDiff', function (req, opts, callback) {
    // If no options were given, set the callback to be the second parameter
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    // Get the missing document/revision IDs
    ajax(opts, {
      method: 'POST',
      url: genDBUrl(host, '_revs_diff'),
      body: req
    }, callback);
  });

  api._close = function (callback) {
    callback();
  };

  api._destroy = function (options, callback) {
    ajax(options, {
      url: genDBUrl(host, ''),
      method: 'DELETE'
    }, function (err, resp) {
      if (err && err.status && err.status !== 404) {
        return callback(err);
      }
      api.emit('destroyed');
      api.constructor.emit('destroyed', opts.name);
      callback(null, resp);
    });
  };
}

// HttpPouch is a valid adapter.
HttpPouch.valid = function () {
  return true;
};

/**
 *
 */
function TaskQueue$1 () {
  this.promise = new PouchPromise(function (fulfill) {
    fulfill();
  });
}
TaskQueue$1.prototype.add = function (promiseFactory) {
  this.promise = this.promise.catch(function () {
    // just recover
  }).then(function () {
    return promiseFactory();
  });
  return this.promise;
};
TaskQueue$1.prototype.finish = function () {
  return this.promise;
};

/**
 *
 * @param string
 */
function MD5 (string) {
  return crypto.createHash('md5').update(string).digest('hex');
}

/**
 *
 * @param opts
 */
function createView (opts) {
  const sourceDB = opts.db;
  const {viewName} = opts;
  const mapFun = opts.map;
  const reduceFun = opts.reduce;
  const {temporary} = opts;

  // the "undefined" part is for backwards compatibility
  const viewSignature = mapFun.toString() + (reduceFun && reduceFun.toString()) +
    'undefined';

  if (!temporary && sourceDB._cachedViews) {
    const cachedView = sourceDB._cachedViews[viewSignature];
    if (cachedView) {
      return PouchPromise.resolve(cachedView);
    }
  }

  return sourceDB.info().then(function (info) {
    const depDbName = info.db_name + '-mrview-' +
      (temporary ? 'temp' : MD5(viewSignature));

    // save the view name in the source db so it can be cleaned up if necessary
    // (e.g. when the _design doc is deleted, remove all associated view data)
    /**
     *
     * @param doc
     */
    function diffFunction (doc) {
      doc.views = doc.views || {};
      let fullViewName = viewName;
      if (!fullViewName.includes('/')) {
        fullViewName = viewName + '/' + viewName;
      }
      const depDbs = doc.views[fullViewName] = doc.views[fullViewName] || {};
      /* istanbul ignore if */
      if (depDbs[depDbName]) {
        return; // no update necessary
      }
      depDbs[depDbName] = true;
      return doc;
    }
    return upsert(sourceDB, '_local/mrviews', diffFunction).then(function () {
      return sourceDB.registerDependentDatabase(depDbName).then(function (res) {
        const {db} = res;
        db.auto_compaction = true;
        const view = {
          name: depDbName,
          db,
          sourceDB,
          adapter: sourceDB.adapter,
          mapFun,
          reduceFun
        };
        return view.db.get('_local/lastSeq').catch(function (err) {
          /* istanbul ignore if */
          if (err.status !== 404) {
            throw err;
          }
        }).then(function (lastSeqDoc) {
          view.seq = lastSeqDoc ? lastSeqDoc.seq : 0;
          if (!temporary) {
            sourceDB._cachedViews = sourceDB._cachedViews || {};
            sourceDB._cachedViews[viewSignature] = view;
            view.db.once('destroyed', function () {
              delete sourceDB._cachedViews[viewSignature];
            });
          }
          return view;
        });
      });
    });
  });
}

/**
 *
 * @param func
 * @param emit
 * @param sum
 * @param log
 * @param isArray
 * @param toJSON
 */
function evalfunc (func, emit, sum, log, isArray, toJSON) {
  return scopedEval(
    'return (' + func.replace(/;\s*$/, '') + ');',
    {
      emit,
      sum,
      log,
      isArray,
      toJSON
    }
  );
}

const promisedCallback$1 = function (promise, callback) {
  if (callback) {
    promise.then(function (res) {
      queueMicrotask(function () {
        callback(null, res);
      });
    }, function (reason) {
      queueMicrotask(function () {
        callback(reason);
      });
    });
  }
  return promise;
};

const callbackify$1 = function (fun) {
  return getArguments(function (args) {
    const cb = args.pop();
    const promise = fun.apply(this, args);
    if (typeof cb === 'function') {
      promisedCallback$1(promise, cb);
    }
    return promise;
  });
};

// Promise finally util similar to Q.finally
const fin$1 = function (promise, finalPromiseFactory) {
  return promise.then(function (res) {
    return finalPromiseFactory().then(function () {
      return res;
    });
  }, function (reason) {
    return finalPromiseFactory().then(function () {
      throw reason;
    });
  });
};

const sequentialize$1 = function (queue, promiseFactory) {
  return function () {
    const args = arguments;
    const that = this;
    return queue.add(function () {
      return promiseFactory.apply(that, args);
    });
  };
};

// uniq an array of strings, order not guaranteed
// similar to underscore/lodash _.uniq
const uniq$1 = function (arr) {
  const map = {};

  for (var i = 0, len = arr.length; i < len; i++) {
    map['$' + arr[i]] = true;
  }

  const keys = Object.keys(map);
  const output = Array.from({length: keys.length});

  for (i = 0, len = keys.length; i < len; i++) {
    output[i] = keys[i].slice(1);
  }
  return output;
};

const utils$1 = {
  uniq: uniq$1,
  sequentialize: sequentialize$1,
  fin: fin$1,
  callbackify: callbackify$1,
  promisedCallback: promisedCallback$1
};

const collate$2 = pouchCollate__default.collate;
const {toIndexableString, normalizeKey, parseIndexableString} = pouchCollate__default;
let log$2;
/* istanbul ignore else */
log$2 = (typeof console !== 'undefined') && (typeof console.log === 'function') ? Function.prototype.bind.call(console.log, console) : function () {};
const {callbackify, sequentialize, uniq, fin, promisedCallback} = utils$1;
const persistentQueues = {};
const tempViewQueue = new TaskQueue$1();
const CHANGES_BATCH_SIZE$1 = 50;

/**
 *
 * @param name
 */
function parseViewName (name) {
  // can be either 'ddocname/viewname' or just 'viewname'
  // (where the ddoc name is the same)
  return !name.includes('/') ? [name, name] : name.split('/');
}

/**
 *
 * @param changes
 */
function isGenOne$1 (changes) {
  // only return true if the current change is 1-
  // and there are no other leafs
  return changes.length === 1 && (changes[0].rev).startsWith('1-');
}

/**
 *
 * @param db
 * @param e
 */
function emitError (db, e) {
  try {
    db.emit('error', e);
  } catch (err) {
    console.error(
      'The user\'s map/reduce function threw an uncaught error.\n' +
      'You can debug this error by doing:\n' +
      'myDatabase.on(\'error\', function (err) { debugger; });\n' +
      'Please double-check your map/reduce function.'
    );
    console.error(e);
  }
}

/**
 *
 * @param db
 * @param fun
 * @param args
 */
function tryCode (db, fun, args) {
  // emit an event if there was an error thrown by a map/reduce function.
  // putting try/catches in a single function also avoids deoptimizations.
  try {
    return {
      output: fun.apply(null, args)
    };
  } catch (e) {
    emitError(db, e);
    return {error: e};
  }
}

/**
 *
 * @param x
 * @param y
 */
function sortByKeyThenValue (x, y) {
  const keyCompare = collate$2(x.key, y.key);
  return keyCompare !== 0 ? keyCompare : collate$2(x.value, y.value);
}

/**
 *
 * @param results
 * @param limit
 * @param skip
 */
function sliceResults (results, limit, skip) {
  skip ||= 0;
  if (typeof limit === 'number') {
    return results.slice(skip, limit + skip);
  }
  if (skip > 0) {
    return results.slice(skip);
  }
  return results;
}

/**
 *
 * @param row
 */
function rowToDocId (row) {
  const val = row.value;
  // Users can explicitly specify a joined doc _id, or it
  // defaults to the doc _id that emitted the key/value.
  const docId = (val && typeof val === 'object' && val._id) || row.id;
  return docId;
}

/**
 *
 * @param res
 */
function readAttachmentsAsBlobOrBuffer$1 (res) {
  res.rows.forEach(function (row) {
    const atts = row.doc && row.doc._attachments;
    if (!atts) {
      return;
    }
    Object.keys(atts).forEach(function (filename) {
      const att = atts[filename];
      atts[filename].data = b64ToBluffer(att.data, att.content_type);
    });
  });
}

/**
 *
 * @param opts
 */
function postprocessAttachments (opts) {
  return function (res) {
    if (opts.include_docs && opts.attachments && opts.binary) {
      readAttachmentsAsBlobOrBuffer$1(res);
    }
    return res;
  };
}

/**
 *
 * @param name
 */
function createBuiltInError (name) {
  const message = 'builtin ' + name +
    ' function requires map values to be numbers' +
    ' or number arrays';
  return new BuiltInError(message);
}

/**
 *
 * @param values
 */
function sum (values) {
  let result = 0;
  for (const num of values) {
    if (typeof num !== 'number') {
      if (Array.isArray(num)) {
        // lists of numbers are also allowed, sum them separately
        result = typeof result === 'number' ? [result] : result;
        for (const [j, jNum] of num.entries()) {
          if (typeof jNum !== 'number') {
            throw createBuiltInError('_sum');
          }
          if (typeof result[j] === 'undefined') {
            result.push(jNum);
          } else {
            result[j] += jNum;
          }
        }
      } else { // not array/number
        throw createBuiltInError('_sum');
      }
    } else if (typeof result === 'number') {
      result += num;
    } else { // add number to array
      result[0] += num;
    }
  }
  return result;
}

const builtInReduce = {
  _sum (keys, values) {
    return sum(values);
  },

  _count (keys, values) {
    return values.length;
  },

  _stats (keys, values) {
    // no need to implement rereduce=true, because Pouch
    // will never call it
    /**
     *
     * @param values
     */
    function sumsqr (values) {
      let _sumsqr = 0;
      for (const num of values) {
        _sumsqr += (num * num);
      }
      return _sumsqr;
    }
    return {
      sum: sum(values),
      min: Math.min.apply(null, values),
      max: Math.max.apply(null, values),
      count: values.length,
      sumsqr: sumsqr(values)
    };
  }
};

/**
 *
 * @param paramName
 * @param opts
 * @param params
 * @param asJson
 */
function addHttpParam (paramName, opts, params, asJson) {
  // add an http param from opts to params, optionally json-encoded
  let val = opts[paramName];
  if (typeof val !== 'undefined') {
    if (asJson) {
      val = encodeURIComponent(JSON.stringify(val));
    }
    params.push(paramName + '=' + val);
  }
}

/**
 *
 * @param integerCandidate
 */
function coerceInteger (integerCandidate) {
  if (typeof integerCandidate === 'undefined') {
    return;
  }

  const asNumber = Number(integerCandidate);
  // prevents e.g. '1foo' or '1.1' being coerced to 1
  if (!isNaN(asNumber) && asNumber === parseInt(integerCandidate, 10)) {
    return asNumber;
  }
  return integerCandidate;
}

/**
 *
 * @param opts
 */
function coerceOptions (opts) {
  opts.group_level = coerceInteger(opts.group_level);
  opts.limit = coerceInteger(opts.limit);
  opts.skip = coerceInteger(opts.skip);
  return opts;
}

/**
 *
 * @param number
 */
function checkPositiveInteger (number) {
  if (!number) {
    return;
  }

  if (typeof number !== 'number') {
    return new QueryParseError('Invalid value for integer: "' +
      number + '"');
  }
  if (number < 0) {
    return new QueryParseError('Invalid value for positive integer: ' +
      '"' + number + '"');
  }
}

/**
 *
 * @param options
 * @param fun
 */
function checkQueryParseError (options, fun) {
  const startkeyName = options.descending ? 'endkey' : 'startkey';
  const endkeyName = options.descending ? 'startkey' : 'endkey';

  if (typeof options[startkeyName] !== 'undefined' &&
    typeof options[endkeyName] !== 'undefined' &&
    collate$2(options[startkeyName], options[endkeyName]) > 0) {
    throw new QueryParseError('No rows can match your key range, ' +
      'reverse your start_key and end_key or set {descending : true}');
  } else if (fun.reduce && options.reduce !== false) {
    if (options.include_docs) {
      throw new QueryParseError('{include_docs:true} is invalid for reduce');
    }
    if (options.keys && options.keys.length > 1 &&
      !options.group && !options.group_level) {
      throw new QueryParseError('Multi-key fetches for reduce views must use ' +
        '{group: true}');
    }
  }
  ['group_level', 'limit', 'skip'].forEach(function (optionName) {
    const error = checkPositiveInteger(options[optionName]);
    if (error) {
      throw error;
    }
  });
}

/**
 *
 * @param db
 * @param fun
 * @param opts
 */
function httpQuery (db, fun, opts) {
  // List of parameters to add to the PUT request
  let params = [];
  let body;
  let method = 'GET';

  // If opts.reduce exists and is defined, then add it to the list
  // of parameters.
  // If reduce=false then the results are that of only the map function
  // not the final result of map and reduce.
  addHttpParam('reduce', opts, params);
  addHttpParam('include_docs', opts, params);
  addHttpParam('attachments', opts, params);
  addHttpParam('limit', opts, params);
  addHttpParam('descending', opts, params);
  addHttpParam('group', opts, params);
  addHttpParam('group_level', opts, params);
  addHttpParam('skip', opts, params);
  addHttpParam('stale', opts, params);
  addHttpParam('conflicts', opts, params);
  addHttpParam('startkey', opts, params, true);
  addHttpParam('start_key', opts, params, true);
  addHttpParam('endkey', opts, params, true);
  addHttpParam('end_key', opts, params, true);
  addHttpParam('inclusive_end', opts, params);
  addHttpParam('key', opts, params, true);

  // Format the list of parameters into a valid URI query string
  params = params.join('&');
  params = params === '' ? '' : '?' + params;

  // If keys are supplied, issue a POST to circumvent GET query string limits
  // see https://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
  if (typeof opts.keys !== 'undefined') {
    const MAX_URL_LENGTH = 2000;
    // according to https://stackoverflow.com/a/417184/680742,
    // the de facto URL length limit is 2000 characters

    const keysAsString =
      'keys=' + encodeURIComponent(JSON.stringify(opts.keys));
    if (keysAsString.length + params.length + 1 <= MAX_URL_LENGTH) {
      // If the keys are short enough, do a GET. we do this to work around
      // Safari not understanding 304s on POSTs (see pouchdb/pouchdb#1239)
      params += (params[0] === '?' ? '&' : '?') + keysAsString;
    } else {
      method = 'POST';
      if (typeof fun === 'string') {
        body = {keys: opts.keys};
      } else { // fun is {map : mapfun}, so append to this
        fun.keys = opts.keys;
      }
    }
  }

  // We are referencing a query defined in the design doc
  if (typeof fun === 'string') {
    const parts = parseViewName(fun);
    return db.request({
      method,
      url: '_design/' + parts[0] + '/_view/' + parts[1] + params,
      body
    }).then(postprocessAttachments(opts));
  }

  // We are using a temporary view, terrible for performance, good for testing
  body ||= {};
  Object.keys(fun).forEach(function (key) {
    body[key] = Array.isArray(fun[key]) ? fun[key] : fun[key].toString();
  });
  return db.request({
    method: 'POST',
    url: '_temp_view' + params,
    body
  }).then(postprocessAttachments(opts));
}

// custom adapters can define their own api._query
// and override the default behavior
/* c8 ignore next */
/**
 *
 * @param db
 * @param fun
 * @param opts
 */
function customQuery (db, fun, opts) {
  return new PouchPromise(function (resolve, reject) {
    db._query(fun, opts, function (err, res) {
      if (err) {
        return reject(err);
      }
      resolve(res);
    });
  });
}

// custom adapters can define their own api._viewCleanup
// and override the default behavior
/* c8 ignore next */
/**
 *
 * @param db
 */
function customViewCleanup (db) {
  return new PouchPromise(function (resolve, reject) {
    db._viewCleanup(function (err, res) {
      if (err) {
        return reject(err);
      }
      resolve(res);
    });
  });
}

/**
 *
 * @param value
 */
function defaultsTo (value) {
  return function (reason) {
    /* istanbul ignore else */
    if (reason.status === 404) {
      return value;
    }
    throw reason;
  };
}

// returns a promise for a list of docs to update, based on the input docId.
// the order doesn't matter, because post-3.2.0, bulkDocs
// is an atomic operation in all three adapters.
/**
 *
 * @param docId
 * @param view
 * @param docIdsToChangesAndEmits
 */
function getDocsToPersist (docId, view, docIdsToChangesAndEmits) {
  const metaDocId = '_local/doc_' + docId;
  const defaultMetaDoc = {_id: metaDocId, keys: []};
  const docData = docIdsToChangesAndEmits[docId];
  const {indexableKeysToKeyValues, changes} = docData;

  /**
   *
   */
  function getMetaDoc () {
    if (isGenOne$1(changes)) {
      // generation 1, so we can safely assume initial state
      // for performance reasons (avoids unnecessary GETs)
      return PouchPromise.resolve(defaultMetaDoc);
    }
    return view.db.get(metaDocId).catch(defaultsTo(defaultMetaDoc));
  }

  /**
   *
   * @param metaDoc
   */
  function getKeyValueDocs (metaDoc) {
    if (!metaDoc.keys.length) {
      // no keys, no need for a lookup
      return PouchPromise.resolve({rows: []});
    }
    return view.db.allDocs({
      keys: metaDoc.keys,
      include_docs: true
    });
  }

  /**
   *
   * @param metaDoc
   * @param kvDocsRes
   */
  function processKvDocs (metaDoc, kvDocsRes) {
    const kvDocs = [];
    const oldKeysMap = {};

    for (let i = 0, len = kvDocsRes.rows.length; i < len; i++) {
      const row = kvDocsRes.rows[i];
      const {doc} = row;
      if (!doc) { // deleted
        continue;
      }
      kvDocs.push(doc);
      oldKeysMap[doc._id] = true;
      doc._deleted = !indexableKeysToKeyValues[doc._id];
      if (!doc._deleted) {
        const keyValue = indexableKeysToKeyValues[doc._id];
        if ('value' in keyValue) {
          doc.value = keyValue.value;
        }
      }
    }

    const newKeys = Object.keys(indexableKeysToKeyValues);
    newKeys.forEach(function (key) {
      if (oldKeysMap[key]) {
        return;
      }

      // new doc
      const kvDoc = {
        _id: key
      };
      const keyValue = indexableKeysToKeyValues[key];
      if ('value' in keyValue) {
        kvDoc.value = keyValue.value;
      }
      kvDocs.push(kvDoc);
    });
    metaDoc.keys = uniq(newKeys.concat(metaDoc.keys));
    kvDocs.push(metaDoc);

    return kvDocs;
  }

  return getMetaDoc().then(function (metaDoc) {
    return getKeyValueDocs(metaDoc).then(function (kvDocsRes) {
      return processKvDocs(metaDoc, kvDocsRes);
    });
  });
}

// updates all emitted key/value docs and metaDocs in the mrview database
// for the given batch of documents from the source database
/**
 *
 * @param view
 * @param docIdsToChangesAndEmits
 * @param seq
 */
function saveKeyValues (view, docIdsToChangesAndEmits, seq) {
  const seqDocId = '_local/lastSeq';
  return view.db.get(seqDocId).
    catch(defaultsTo({_id: seqDocId, seq: 0})).
    then(function (lastSeqDoc) {
      const docIds = Object.keys(docIdsToChangesAndEmits);
      return PouchPromise.all(docIds.map(function (docId) {
        return getDocsToPersist(docId, view, docIdsToChangesAndEmits);
      })).then(function (listOfDocsToPersist) {
        const docsToPersist = flatten(listOfDocsToPersist);
        lastSeqDoc.seq = seq;
        docsToPersist.push(lastSeqDoc);
        // write all docs in a single operation, update the seq once
        return view.db.bulkDocs({docs: docsToPersist});
      });
    });
}

/**
 *
 * @param view
 */
function getQueue (view) {
  const viewName = typeof view === 'string' ? view : view.name;
  let queue = persistentQueues[viewName];
  if (!queue) {
    queue = persistentQueues[viewName] = new TaskQueue$1();
  }
  return queue;
}

/**
 *
 * @param view
 */
function updateView (view) {
  return sequentialize(getQueue(view), function () {
    return updateViewInQueue(view);
  })();
}

/**
 *
 * @param view
 */
function updateViewInQueue (view) {
  // bind the emit function once
  let mapResults;
  let doc;

  /**
   *
   * @param key
   * @param value
   */
  function emit (key, value) {
    const output = {id: doc._id, key: normalizeKey(key)};
    // Don't explicitly store the value unless it's defined and non-null.
    // This saves on storage space, because often people don't use it.
    if (typeof value !== 'undefined' && value !== null) {
      output.value = normalizeKey(value);
    }
    mapResults.push(output);
  }

  let mapFun;
  // for temp_views one can use emit(doc, emit), see #38
  if (typeof view.mapFun === 'function' && view.mapFun.length === 2) {
    const origMap = view.mapFun;
    mapFun = function (doc) {
      return origMap(doc, emit);
    };
  } else {
    mapFun = evalfunc(view.mapFun.toString(), emit, sum, log$2, Array.isArray,
      JSON.parse);
  }

  let currentSeq = view.seq || 0;

  /**
   *
   * @param docIdsToChangesAndEmits
   * @param seq
   */
  function processChange (docIdsToChangesAndEmits, seq) {
    return function () {
      return saveKeyValues(view, docIdsToChangesAndEmits, seq);
    };
  }

  const queue = new TaskQueue$1();
  // TODO(neojski): https://github.com/daleharvey/pouchdb/issues/1521

  return new PouchPromise(function (resolve, reject) {
    /**
     *
     */
    function complete () {
      queue.finish().then(function () {
        view.seq = currentSeq;
        resolve();
      });
    }

    /**
     *
     */
    function processNextBatch () {
      view.sourceDB.changes({
        conflicts: true,
        include_docs: true,
        style: 'all_docs',
        since: currentSeq,
        limit: CHANGES_BATCH_SIZE$1
      }).on('complete', function (response) {
        const {results} = response;
        if (!results.length) {
          return complete();
        }
        const docIdsToChangesAndEmits = {};
        for (const change of results) {
          if (change.doc._id[0] !== '_') {
            mapResults = [];
            doc = change.doc;

            if (!doc._deleted) {
              tryCode(view.sourceDB, mapFun, [doc]);
            }
            mapResults.sort(sortByKeyThenValue);

            const indexableKeysToKeyValues = {};
            var lastKey;
            for (const [j, obj] of mapResults.entries()) {
              const complexKey = [obj.key, obj.id];
              if (collate$2(obj.key, lastKey) === 0) {
                complexKey.push(j); // dup key+id, so make it unique
              }
              const indexableKey = toIndexableString(complexKey);
              indexableKeysToKeyValues[indexableKey] = obj;
              lastKey = obj.key;
            }
            docIdsToChangesAndEmits[change.doc._id] = {
              indexableKeysToKeyValues,
              changes: change.changes
            };
          }
          currentSeq = change.seq;
        }
        queue.add(processChange(docIdsToChangesAndEmits, currentSeq));
        if (results.length < CHANGES_BATCH_SIZE$1) {
          return complete();
        }
        return processNextBatch();
      }).on('error', onError);
      /* c8 ignore next */
      /**
       *
       * @param err
       */
      function onError (err) {
        reject(err);
      }
    }

    processNextBatch();
  });
}

/**
 *
 * @param view
 * @param results
 * @param options
 */
function reduceView (view, results, options) {
  if (options.group_level === 0) {
    delete options.group_level;
  }

  const shouldGroup = options.group || options.group_level;

  let reduceFun;
  reduceFun = builtInReduce[view.reduceFun]
    ? builtInReduce[view.reduceFun]
    : evalfunc(
      view.reduceFun.toString(), null, sum, log$2, Array.isArray, JSON.parse
    );

  const groups = [];
  const lvl = isNaN(options.group_level)
    ? Infinity
    : options.group_level;
  results.forEach(function (e) {
    const last = groups.at(-1);
    let groupKey = shouldGroup ? e.key : null;

    // only set group_level for array keys
    if (shouldGroup && Array.isArray(groupKey)) {
      groupKey = groupKey.slice(0, lvl);
    }

    if (last && collate$2(last.groupKey, groupKey) === 0) {
      last.keys.push([e.key, e.id]);
      last.values.push(e.value);
      return;
    }
    groups.push({
      keys: [[e.key, e.id]],
      values: [e.value],
      groupKey
    });
  });
  results = [];
  for (const e of groups) {
    const reduceTry = tryCode(view.sourceDB, reduceFun,
      [e.keys, e.values, false]);
    if (reduceTry.error && reduceTry.error instanceof BuiltInError) {
      // CouchDB returns an error if a built-in errors out
      throw reduceTry.error;
    }
    results.push({
      // CouchDB just sets the value to null if a non-built-in errors out
      value: reduceTry.error ? null : reduceTry.output,
      key: e.groupKey
    });
  }
  // no total_rows/offset when reducing
  return {rows: sliceResults(results, options.limit, options.skip)};
}

/**
 *
 * @param view
 * @param opts
 */
function queryView (view, opts) {
  return sequentialize(getQueue(view), function () {
    return queryViewInQueue(view, opts);
  })();
}

/**
 *
 * @param view
 * @param opts
 */
function queryViewInQueue (view, opts) {
  let totalRows;
  const shouldReduce = view.reduceFun && opts.reduce !== false;
  const skip = opts.skip || 0;
  if (typeof opts.keys !== 'undefined' && !opts.keys.length) {
    // equivalent query
    opts.limit = 0;
    delete opts.keys;
  }

  /**
   *
   * @param viewOpts
   */
  function fetchFromView (viewOpts) {
    viewOpts.include_docs = true;
    return view.db.allDocs(viewOpts).then(function (res) {
      totalRows = res.total_rows;
      return res.rows.map(function (result) {
        // implicit migration - in older versions of PouchDB,
        // we explicitly stored the doc as {id: ..., key: ..., value: ...}
        // this is tested in a migration test
        /* c8 ignore next */
        if ('value' in result.doc && typeof result.doc.value === 'object' &&
          result.doc.value !== null) {
          const keys = Object.keys(result.doc.value).sort();
          // this detection method is not perfect, but it's unlikely the user
          // emitted a value which was an object with these 3 exact keys
          const expectedKeys = ['id', 'key', 'value'];
          if (!(keys < expectedKeys || keys > expectedKeys)) {
            return result.doc.value;
          }
        }

        const parsedKeyAndDocId = parseIndexableString(result.doc._id);
        return {
          key: parsedKeyAndDocId[0],
          id: parsedKeyAndDocId[1],
          value: ('value' in result.doc ? result.doc.value : null)
        };
      });
    });
  }

  /**
   *
   * @param rows
   */
  function onMapResultsReady (rows) {
    let finalResults;
    finalResults = shouldReduce
      ? reduceView(view, rows, opts)
      : {
        total_rows: totalRows,
        offset: skip,
        rows
      };
    if (opts.include_docs) {
      const docIds = uniq(rows.map(rowToDocId));

      return view.sourceDB.allDocs({
        keys: docIds,
        include_docs: true,
        conflicts: opts.conflicts,
        attachments: opts.attachments,
        binary: opts.binary
      }).then(function (allDocsRes) {
        const docIdsToDocs = {};
        allDocsRes.rows.forEach(function (row) {
          if (row.doc) {
            docIdsToDocs['$' + row.id] = row.doc;
          }
        });
        rows.forEach(function (row) {
          const docId = rowToDocId(row);
          const doc = docIdsToDocs['$' + docId];
          if (doc) {
            row.doc = doc;
          }
        });
        return finalResults;
      });
    }
    return finalResults;
  }

  if (typeof opts.keys !== 'undefined') {
    const {keys} = opts;
    const fetchPromises = keys.map(function (key) {
      const viewOpts = {
        startkey: toIndexableString([key]),
        endkey: toIndexableString([key, {}])
      };
      return fetchFromView(viewOpts);
    });
    return PouchPromise.all(fetchPromises).then(flatten).then(onMapResultsReady);
  }
  // normal query, no 'keys'
  const viewOpts = {
    descending: opts.descending
  };
  if (opts.start_key) {
    opts.startkey = opts.start_key;
  }
  if (opts.end_key) {
    opts.endkey = opts.end_key;
  }
  if (typeof opts.startkey !== 'undefined') {
    viewOpts.startkey = opts.descending
      ? toIndexableString([opts.startkey, {}])
      : toIndexableString([opts.startkey]);
  }
  if (typeof opts.endkey !== 'undefined') {
    let inclusiveEnd = opts.inclusive_end !== false;
    if (opts.descending) {
      inclusiveEnd = !inclusiveEnd;
    }

    viewOpts.endkey = toIndexableString(
      inclusiveEnd ? [opts.endkey, {}] : [opts.endkey]
    );
  }
  if (typeof opts.key !== 'undefined') {
    const keyStart = toIndexableString([opts.key]);
    const keyEnd = toIndexableString([opts.key, {}]);
    if (viewOpts.descending) {
      viewOpts.endkey = keyStart;
      viewOpts.startkey = keyEnd;
    } else {
      viewOpts.startkey = keyStart;
      viewOpts.endkey = keyEnd;
    }
  }
  if (!shouldReduce) {
    if (typeof opts.limit === 'number') {
      viewOpts.limit = opts.limit;
    }
    viewOpts.skip = skip;
  }
  return fetchFromView(viewOpts).then(onMapResultsReady);
}

/**
 *
 * @param db
 */
function httpViewCleanup (db) {
  return db.request({
    method: 'POST',
    url: '_view_cleanup'
  });
}

/**
 *
 * @param db
 */
function localViewCleanup (db) {
  return db.get('_local/mrviews').then(function (metaDoc) {
    const docsToViews = {};
    Object.keys(metaDoc.views).forEach(function (fullViewName) {
      const parts = parseViewName(fullViewName);
      const designDocName = '_design/' + parts[0];
      const viewName = parts[1];
      docsToViews[designDocName] = docsToViews[designDocName] || {};
      docsToViews[designDocName][viewName] = true;
    });
    const opts = {
      keys: Object.keys(docsToViews),
      include_docs: true
    };
    return db.allDocs(opts).then(function (res) {
      const viewsToStatus = {};
      res.rows.forEach(function (row) {
        const ddocName = row.key.slice(8);
        Object.keys(docsToViews[row.key]).forEach(function (viewName) {
          let fullViewName = ddocName + '/' + viewName;
          /* istanbul ignore if */
          if (!metaDoc.views[fullViewName]) {
            // new format, without slashes, to support PouchDB 2.2.0
            // migration test in pouchdb's browser.migration.js verifies this
            fullViewName = viewName;
          }
          const viewDBNames = Object.keys(metaDoc.views[fullViewName]);
          // design doc deleted, or view function nonexistent
          const statusIsGood = row.doc && row.doc.views &&
            row.doc.views[viewName];
          viewDBNames.forEach(function (viewDBName) {
            viewsToStatus[viewDBName] =
              viewsToStatus[viewDBName] || statusIsGood;
          });
        });
      });
      const dbsToDelete = Object.keys(viewsToStatus).filter(
        function (viewDBName) {
          return !viewsToStatus[viewDBName];
        }
      );
      const destroyPromises = dbsToDelete.map(function (viewDBName) {
        return sequentialize(getQueue(viewDBName), function () {
          return new db.constructor(viewDBName, db.__opts).destroy();
        })();
      });
      return PouchPromise.all(destroyPromises).then(function () {
        return {ok: true};
      });
    });
  }, defaultsTo({ok: true}));
}

const viewCleanup = callbackify(function () {
  const db = this;
  if (db._ddocCache) {
    delete db._ddocCache;
  }
  if (db.type() === 'http') {
    return httpViewCleanup(db);
  }
  /* c8 ignore next */
  if (typeof db._viewCleanup === 'function') {
    return customViewCleanup(db);
  }
  return localViewCleanup(db);
});

/**
 *
 * @param db
 * @param fun
 * @param opts
 */
function queryPromised (db, fun, opts) {
  if (db.type() === 'http') {
    return httpQuery(db, fun, opts);
  }

  /* c8 ignore next */
  if (typeof db._query === 'function') {
    return customQuery(db, fun, opts);
  }

  if (typeof fun !== 'string') {
    // temp_view
    checkQueryParseError(opts, fun);

    const createViewOpts = {
      db,
      viewName: 'temp_view/temp_view',
      map: fun.map,
      reduce: fun.reduce,
      temporary: true
    };
    tempViewQueue.add(function () {
      return createView(createViewOpts).then(function (view) {
        /**
         *
         */
        function cleanup () {
          return view.db.destroy();
        }
        return fin(updateView(view).then(function () {
          return queryView(view, opts);
        }), cleanup);
      });
    });
    return tempViewQueue.finish();
  }
  // persistent view
  const fullViewName = fun;
  const parts = parseViewName(fullViewName);
  const designDocName = parts[0];
  const viewName = parts[1];
  return db.getView(designDocName, viewName).then(function (fun) {
    checkQueryParseError(opts, fun);

    const createViewOpts = {
      db,
      viewName: fullViewName,
      map: fun.map,
      reduce: fun.reduce
    };
    return createView(createViewOpts).then(function (view) {
      if (opts.stale === 'ok' || opts.stale === 'update_after') {
        if (opts.stale === 'update_after') {
          queueMicrotask(function () {
            updateView(view);
          });
        }
        return queryView(view, opts);
      } // stale not ok
      return updateView(view).then(function () {
        return queryView(view, opts);
      });
    });
  });
}

const query = function (fun, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts = opts ? coerceOptions(opts) : {};

  if (typeof fun === 'function') {
    fun = {map: fun};
  }

  const db = this;
  const promise = PouchPromise.resolve().then(function () {
    return queryPromised(db, fun, opts);
  });
  promisedCallback(promise, callback);
  return promise;
};

/**
 *
 * @param message
 */
function QueryParseError (message) {
  this.status = 400;
  this.name = 'query_parse_error';
  this.message = message;
  this.error = true;
  try {
    Error.captureStackTrace(this, QueryParseError);
  } catch (e) {}
}

inherits(QueryParseError, Error);

/**
 *
 * @param message
 */
function BuiltInError (message) {
  this.status = 500;
  this.name = 'invalid_value';
  this.message = message;
  this.error = true;
  try {
    Error.captureStackTrace(this, BuiltInError);
  } catch (e) {}
}

inherits(BuiltInError, Error);

const mapreduce = {
  query,
  viewCleanup
};

// in Node of course this is false
/**
 *
 */
function isChromeApp () {
  return false;
}

inherits(Changes$1, events.EventEmitter);

/* c8 ignore next */
/**
 *
 * @param self
 */
function attachBrowserEvents (self) {
  if (isChromeApp()) {
    chrome.storage.onChanged.addListener(function (e) {
      // make sure it's event addressed to us
      if (e.db_name != null) {
        // object only has oldValue, newValue members
        self.emit(e.dbName.newValue);
      }
    });
  } else if (hasLocalStorage()) {
    if (typeof addEventListener !== 'undefined') {
      addEventListener('storage', function (e) {
        self.emit(e.key);
      });
    } else { // old IE
      globalThis.attachEvent('storage', function (e) {
        self.emit(e.key);
      });
    }
  }
}

/**
 *
 */
function Changes$1 () {
  events.EventEmitter.call(this);
  this._listeners = {};

  attachBrowserEvents(this);
}
Changes$1.prototype.addListener = function (dbName, id, db, opts) {
  /* istanbul ignore if */
  if (this._listeners[id]) {
    return;
  }
  const self = this;
  let inprogress = false;
  /**
   *
   */
  function eventFunction () {
    /* istanbul ignore if */
    if (!self._listeners[id]) {
      return;
    }
    if (inprogress) {
      inprogress = 'waiting';
      return;
    }
    inprogress = true;
    const changesOpts = pick(opts, [
      'style', 'include_docs', 'attachments', 'conflicts', 'filter',
      'doc_ids', 'view', 'since', 'query_params', 'binary'
    ]);

    /* c8 ignore next */
    /**
     *
     */
    function onError () {
      inprogress = false;
    }

    db.changes(changesOpts).on('change', function (c) {
      if (!(c.seq > opts.since) || opts.cancelled) {
        return;
      }

      opts.since = c.seq;
      opts.onChange(c);
    }).on('complete', function () {
      if (inprogress === 'waiting') {
        setTimeout(function () {
          eventFunction();
        }, 0);
      }
      inprogress = false;
    }).on('error', onError);
  }
  this._listeners[id] = eventFunction;
  this.on(dbName, eventFunction);
};

Changes$1.prototype.removeListener = function (dbName, id) {
  /* istanbul ignore if */
  if (!(id in this._listeners)) {
    return;
  }
  events.EventEmitter.prototype.removeListener.call(this, dbName,
    this._listeners[id]);
};


/* c8 ignore next */
Changes$1.prototype.notifyLocalWindows = function (dbName) {
  // do a useless change on a storage thing
  // in order to get other windows's listeners to activate
  if (isChromeApp()) {
    chrome.storage.local.set({dbName});
  } else if (hasLocalStorage()) {
    localStorage[dbName] = (localStorage[dbName] === 'a') ? 'b' : 'a';
  }
};

Changes$1.prototype.notify = function (dbName) {
  this.emit(dbName);
  this.notifyLocalWindows(dbName);
};

/**
 *
 * @param str
 */
function slowJsonParse (str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    /* c8 ignore next */
    return vuvuzela.parse(str);
  }
}

/**
 *
 * @param str
 */
function safeJsonParse (str) {
  // try/catch is deoptimized in V8, leading to slower
  // times than we'd like to have. Most documents are _not_
  // huge, and do not require a slower code path just to parse them.
  // We can be pretty sure that a document under 50000 characters
  // will not be so deeply nested as to throw a stack overflow error
  // (depends on the engine and available memory, though, so this is
  // just a hunch). 50000 was chosen based on the average length
  // of this string in our test suite, to try to find a number that covers
  // most of our test cases (26 over this size, 26378 under it).
  if (str.length < 50000) {
    return JSON.parse(str);
  }
  return slowJsonParse(str);
}

/**
 *
 * @param json
 */
function safeJsonStringify (json) {
  try {
    return JSON.stringify(json);
  } catch (e) {
    /* c8 ignore next */
    return vuvuzela.stringify(json);
  }
}

// compact a tree by marking its non-leafs as missing,
// and return a list of revs to delete
/**
 *
 * @param metadata
 */
function compactTree (metadata) {
  const revs = [];
  traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
    revHash, ctx, opts) {
    if (opts.status !== 'available' || isLeaf) {
      return;
    }

    revs.push(pos + '-' + revHash);
    opts.status = 'missing';
  });
  return revs;
}

/**
 *
 * @param a
 * @param b
 */
function sortByPos$1 (a, b) {
  return a.pos - b.pos;
}

// classic binary search
/**
 *
 * @param arr
 * @param item
 * @param comparator
 */
function binarySearch (arr, item, comparator) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (comparator(arr[mid], item) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

// assuming the arr is sorted, insert the item in the proper place
/**
 *
 * @param arr
 * @param item
 * @param comparator
 */
function insertSorted (arr, item, comparator) {
  const idx = binarySearch(arr, item, comparator);
  arr.splice(idx, 0, item);
}

// Turn a path as a flat array into a tree with a single branch.
// If any should be stemmed from the beginning of the array, that's passed
// in as the second argument
/**
 *
 * @param path
 * @param numStemmed
 */
function pathToTree (path, numStemmed) {
  let root;
  let leaf;
  for (let i = numStemmed, len = path.length; i < len; i++) {
    const node = path[i];
    const currentLeaf = [node.id, node.opts, []];
    if (leaf) {
      leaf[2].push(currentLeaf);
      leaf = currentLeaf;
    } else {
      root = leaf = currentLeaf;
    }
  }
  return root;
}

// compare the IDs of two trees
/**
 *
 * @param a
 * @param b
 */
function compareTree (a, b) {
  return a[0] < b[0] ? -1 : 1;
}

// Merge two trees together
// The roots of tree1 and tree2 must be the same revision
/**
 *
 * @param in_tree1
 * @param in_tree2
 */
function mergeTree (in_tree1, in_tree2) {
  const queue = [{tree1: in_tree1, tree2: in_tree2}];
  let conflicts = false;
  while (queue.length > 0) {
    const item = queue.pop();
    const {tree1, tree2} = item;

    if (tree1[1].status || tree2[1].status) {
      tree1[1].status =
        (tree1[1].status === 'available' ||
        tree2[1].status === 'available')
          ? 'available'
          : 'missing';
    }

    for (let i = 0; i < tree2[2].length; i++) {
      if (!tree1[2][0]) {
        conflicts = 'new_leaf';
        tree1[2][0] = tree2[2][i];
        continue;
      }

      let merged = false;
      for (let j = 0; j < tree1[2].length; j++) {
        if (tree1[2][j][0] !== tree2[2][i][0]) {
          continue;
        }

        queue.push({tree1: tree1[2][j], tree2: tree2[2][i]});
        merged = true;
      }
      if (!merged) {
        conflicts = 'new_branch';
        insertSorted(tree1[2], tree2[2][i], compareTree);
      }
    }
  }
  return {conflicts, tree: in_tree1};
}

/**
 *
 * @param tree
 * @param path
 * @param dontExpand
 */
function doMerge (tree, path, dontExpand) {
  const restree = [];
  if (!tree.length) {
    return {tree: [path], conflicts: 'new_leaf'};
  }
  let conflicts = false;
  let merged = false;

  let res;

  for (const branch of tree) {
    if (branch.pos === path.pos && branch.ids[0] === path.ids[0]) {
      // Paths start at the same position and have the same root, so they need
      // merged
      res = mergeTree(branch.ids, path.ids);
      restree.push({pos: branch.pos, ids: res.tree});
      conflicts ||= res.conflicts;
      merged = true;
    } else if (dontExpand !== true) {
      // The paths start at a different position, take the earliest path and
      // traverse up until it as at the same point from root as the path we
      // want to merge.  If the keys match we return the longer path with the
      // other merged After stemming we dont want to expand the trees

      const t1 = branch.pos < path.pos ? branch : path;
      const t2 = branch.pos < path.pos ? path : branch;
      const diff = t2.pos - t1.pos;

      const candidateParents = [];

      const trees = [{ids: t1.ids, diff, parent: null, parentIdx: null}];
      while (trees.length > 0) {
        const item = trees.pop();
        if (item.diff === 0) {
          if (item.ids[0] === t2.ids[0]) {
            candidateParents.push(item);
          }
          continue;
        }
        const elements = item.ids[2];
        for (const [j, element] of elements.entries()) {
          trees.push({
            ids: element,
            diff: item.diff - 1,
            parent: item.ids,
            parentIdx: j
          });
        }
      }

      const el = candidateParents[0];

      if (!el) {
        restree.push(branch);
      } else {
        res = mergeTree(el.ids, t2.ids);
        el.parent[2][el.parentIdx] = res.tree;
        restree.push({pos: t1.pos, ids: t1.ids});
        conflicts ||= res.conflicts;
        merged = true;
      }
    } else {
      restree.push(branch);
    }
  }

  // We didnt find
  if (!merged) {
    restree.push(path);
  }

  restree.sort(sortByPos$1);

  return {
    tree: restree,
    conflicts: conflicts || 'internal_node'
  };
}

// To ensure we dont grow the revision tree infinitely, we stem old revisions
/**
 *
 * @param tree
 * @param depth
 */
function stem (tree, depth) {
  // First we break out the tree into a complete list of root to leaf paths
  const paths = rootToLeaf(tree);
  const maybeStem = {};

  let result;
  for (const path of paths) {
    // Then for each path, we cut off the start of the path based on the
    // `depth` to stem to, and generate a new set of flat trees
    const stemmed = path.ids;
    const numStemmed = Math.max(0, stemmed.length - depth);
    const stemmedNode = {
      pos: path.pos + numStemmed,
      ids: pathToTree(stemmed, numStemmed)
    };

    for (let s = 0; s < numStemmed; s++) {
      const rev = (path.pos + s) + '-' + stemmed[s].id;
      maybeStem[rev] = true;
    }

    // Then we remerge all those flat trees together, ensuring that we dont
    // connect trees that would go beyond the depth limit
    result = result ? doMerge(result, stemmedNode, true).tree : [stemmedNode];
  }

  traverseRevTree(result, function (isLeaf, pos, revHash) {
    // some revisions may have been removed in a branch but not in another
    delete maybeStem[pos + '-' + revHash];
  });

  return {
    tree: result,
    revs: Object.keys(maybeStem)
  };
}

/**
 *
 * @param tree
 * @param path
 * @param depth
 */
function merge (tree, path, depth) {
  const newTree = doMerge(tree, path);
  const stemmed = stem(newTree.tree, depth);
  return {
    tree: stemmed.tree,
    stemmedRevs: stemmed.revs,
    conflicts: newTree.conflicts
  };
}

// return true if a rev exists in the rev tree, false otherwise
/**
 *
 * @param revs
 * @param rev
 */
function revExists (revs, rev) {
  const toVisit = [...revs];
  const splitRev = rev.split('-');
  const targetPos = parseInt(splitRev[0], 10);
  const targetId = splitRev[1];

  let node;
  while ((node = toVisit.pop())) {
    if (node.pos === targetPos && node.ids[0] === targetId) {
      return true;
    }
    const branches = node.ids[2];
    for (const branch of branches) {
      toVisit.push({pos: node.pos + 1, ids: branch});
    }
  }
  return false;
}

/**
 *
 * @param revLimit
 * @param prev
 * @param docInfo
 * @param results
 * @param i
 * @param cb
 * @param writeDoc
 * @param newEdits
 */
function updateDoc (revLimit, prev, docInfo, results,
  i, cb, writeDoc, newEdits) {
  if (revExists(prev.rev_tree, docInfo.metadata.rev)) {
    results[i] = docInfo;
    return cb();
  }

  // sometimes this is pre-calculated. historically not always
  const previousWinningRev = prev.winningRev || winningRev(prev);
  const previouslyDeleted = 'deleted' in prev
    ? prev.deleted
    : isDeleted(prev, previousWinningRev);
  const deleted = 'deleted' in docInfo.metadata
    ? docInfo.metadata.deleted
    : isDeleted(docInfo.metadata);
  const isRoot = (docInfo.metadata.rev).startsWith('1-');

  if (previouslyDeleted && !deleted && newEdits && isRoot) {
    const newDoc = docInfo.data;
    newDoc._rev = previousWinningRev;
    newDoc._id = docInfo.metadata.id;
    docInfo = parseDoc(newDoc, newEdits);
  }

  const merged = merge(prev.rev_tree, docInfo.metadata.rev_tree[0], revLimit);

  const inConflict = newEdits && (((previouslyDeleted && deleted) ||
    (!previouslyDeleted && merged.conflicts !== 'new_leaf') ||
    (previouslyDeleted && !deleted && merged.conflicts === 'new_branch')));

  if (inConflict) {
    const err = createError(REV_CONFLICT);
    results[i] = err;
    return cb();
  }

  const newRev = docInfo.metadata.rev;
  docInfo.metadata.rev_tree = merged.tree;
  docInfo.stemmedRevs = merged.stemmedRevs || [];
  /* istanbul ignore else */
  if (prev.rev_map) {
    docInfo.metadata.rev_map = prev.rev_map; // used only by leveldb
  }

  // recalculate
  const winningRev$$ = winningRev(docInfo.metadata);
  const winningRevIsDeleted = isDeleted(docInfo.metadata, winningRev$$);

  // calculate the total number of documents that were added/removed,
  // from the perspective of total_rows/doc_count
  const delta = (previouslyDeleted === winningRevIsDeleted)
    ? 0
    : previouslyDeleted < winningRevIsDeleted ? -1 : 1;

  let newRevIsDeleted;
  if (newRev === winningRev$$) {
    // if the new rev is the same as the winning rev, we can reuse that value
    newRevIsDeleted = winningRevIsDeleted;
  } else {
    // if they're not the same, then we need to recalculate
    newRevIsDeleted = isDeleted(docInfo.metadata, newRev);
  }

  writeDoc(docInfo, winningRev$$, winningRevIsDeleted, newRevIsDeleted,
    true, delta, i, cb);
}

/**
 *
 * @param docInfo
 */
function rootIsMissing (docInfo) {
  return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
}

/**
 *
 * @param revLimit
 * @param docInfos
 * @param api
 * @param fetchedDocs
 * @param tx
 * @param results
 * @param writeDoc
 * @param opts
 * @param overallCallback
 */
function processDocs (revLimit, docInfos, api, fetchedDocs, tx, results,
  writeDoc, opts, overallCallback) {
  // Default to 1000 locally
  revLimit ||= 1000;

  /**
   *
   * @param docInfo
   * @param resultsIdx
   * @param callback
   */
  function insertDoc (docInfo, resultsIdx, callback) {
    // Cant insert new deleted documents
    const winningRev$$ = winningRev(docInfo.metadata);
    const deleted = isDeleted(docInfo.metadata, winningRev$$);
    if ('was_delete' in opts && deleted) {
      results[resultsIdx] = createError(MISSING_DOC, 'deleted');
      return callback();
    }

    // 4712 - detect whether a new document was inserted with a _rev
    const inConflict = newEdits && rootIsMissing(docInfo);

    if (inConflict) {
      const err = createError(REV_CONFLICT);
      results[resultsIdx] = err;
      return callback();
    }

    const delta = deleted ? 0 : 1;

    writeDoc(docInfo, winningRev$$, deleted, deleted, false,
      delta, resultsIdx, callback);
  }

  var newEdits = opts.new_edits;
  const idsToDocs = new pouchdbCollections.Map();

  let docsDone = 0;
  let docsToDo = docInfos.length;

  /**
   *
   */
  function checkAllDocsDone () {
    if (++docsDone === docsToDo && overallCallback) {
      overallCallback();
    }
  }

  docInfos.forEach(function (currentDoc, resultsIdx) {
    if (currentDoc._id && isLocalId(currentDoc._id)) {
      const fun = currentDoc._deleted ? '_removeLocal' : '_putLocal';
      api[fun](currentDoc, {ctx: tx}, function (err, res) {
        results[resultsIdx] = err || res;
        checkAllDocsDone();
      });
      return;
    }

    const {id} = currentDoc.metadata;
    if (idsToDocs.has(id)) {
      docsToDo--; // duplicate
      idsToDocs.get(id).push([currentDoc, resultsIdx]);
    } else {
      idsToDocs.set(id, [[currentDoc, resultsIdx]]);
    }
  });

  // in the case of new_edits, the user can provide multiple docs
  // with the same id. these need to be processed sequentially
  idsToDocs.forEach(function (docs, id) {
    let numDone = 0;

    /**
     *
     */
    function docWritten () {
      if (++numDone < docs.length) {
        nextDoc();
      } else {
        checkAllDocsDone();
      }
    }
    /**
     *
     */
    function nextDoc () {
      const value = docs[numDone];
      const currentDoc = value[0];
      const resultsIdx = value[1];

      if (fetchedDocs.has(id)) {
        updateDoc(revLimit, fetchedDocs.get(id), currentDoc, results,
          resultsIdx, docWritten, writeDoc, newEdits);
      } else {
        // Ensure stemming applies to new writes as well
        const merged = merge([], currentDoc.metadata.rev_tree[0], revLimit);
        currentDoc.metadata.rev_tree = merged.tree;
        currentDoc.stemmedRevs = merged.stemmedRevs || [];
        insertDoc(currentDoc, resultsIdx, docWritten);
      }
    }
    nextDoc();
  });
}

const stores = [
  'document-store',
  'by-sequence',
  'attach-store',
  'attach-binary-store'
];
/**
 *
 * @param n
 */
function formatSeq (n) {
  return ('0000000000000000' + n).slice(-16);
}
const UPDATE_SEQ_KEY$1 = '_local_last_update_seq';
const DOC_COUNT_KEY$1 = '_local_doc_count';
const UUID_KEY$1 = '_local_uuid';

const toSublevel = function (name, db, callback) {
  // local require to prevent crashing if leveldown isn't installed.
  const leveldown = {};

  const base = path.resolve(name);
  /**
   *
   * @param store
   * @param index
   * @param cb
   */
  function move (store, index, cb) {
    const storePath = path.join(base, store);
    let opts;
    opts = index === 3
      ? {
        valueEncoding: 'binary'
      }
      : {
        valueEncoding: 'json'
      };
    const sub = db.sublevel(store, opts);
    const orig = levelup(storePath, opts);
    const from = orig.createReadStream();
    const writeStream = new LevelWriteStream(sub);
    const to = writeStream();
    from.on('end', function () {
      orig.close(function (err) {
        cb(err, storePath);
      });
    });
    from.pipe(to);
  }
  fs.unlink(base + '.uuid', function (err) {
    if (err) {
      return callback();
    }
    let todo = 4;
    const done = [];
    stores.forEach(function (store, i) {
      move(store, i, function (err, storePath) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        done.push(storePath);
        if (!(--todo)) {
          done.forEach(function (item) {
            leveldown.destroy(item, function () {
              if (++todo === done.length) {
                fs.rmdir(base, callback);
              }
            });
          });
        }
      });
    });
  });
};
const localAndMetaStores = function (db, stores, callback) {
  const batches = [];
  stores.bySeqStore.get(UUID_KEY$1, function (err, value) {
    if (err) {
      // no uuid key, so don't need to migrate;
      return callback();
    }
    batches.push({
      key: UUID_KEY$1,
      value,
      prefix: stores.metaStore,
      type: 'put',
      valueEncoding: 'json'
    }, {
      key: UUID_KEY$1,
      prefix: stores.bySeqStore,
      type: 'del'
    });
    stores.bySeqStore.get(DOC_COUNT_KEY$1, function (err, value) {
      if (value) {
        // if no doc count key,
        // just skip
        // we can live with this
        batches.push({
          key: DOC_COUNT_KEY$1,
          value,
          prefix: stores.metaStore,
          type: 'put',
          valueEncoding: 'json'
        }, {
          key: DOC_COUNT_KEY$1,
          prefix: stores.bySeqStore,
          type: 'del'
        });
      }
      stores.bySeqStore.get(UPDATE_SEQ_KEY$1, function (err, value) {
        if (value) {
          // if no UPDATE_SEQ_KEY
          // just skip
          // we've gone to far to stop.
          batches.push({
            key: UPDATE_SEQ_KEY$1,
            value,
            prefix: stores.metaStore,
            type: 'put',
            valueEncoding: 'json'
          }, {
            key: UPDATE_SEQ_KEY$1,
            prefix: stores.bySeqStore,
            type: 'del'
          });
        }
        const deletedSeqs = {};
        stores.docStore.createReadStream({
          startKey: '_',
          endKey: '_\u{FF}'
        }).pipe(through2.obj(function (ch, _, next) {
          if (!isLocalId(ch.key)) {
            return next();
          }
          batches.push({
            key: ch.key,
            prefix: stores.docStore,
            type: 'del'
          });
          const winner = winningRev(ch.value);
          Object.keys(ch.value.rev_map).forEach(function (key) {
            if (key !== 'winner') {
              this.push(formatSeq(ch.value.rev_map[key]));
            }
          }, this);
          const winningSeq = ch.value.rev_map[winner];
          stores.bySeqStore.get(formatSeq(winningSeq), function (err, value) {
            if (!err) {
              batches.push({
                key: ch.key,
                value,
                prefix: stores.localStore,
                type: 'put',
                valueEncoding: 'json'
              });
            }
            next();
          });
        })).pipe(through2.obj(function (seq, _, next) {
          /* istanbul ignore if */
          if (deletedSeqs[seq]) {
            return next();
          }
          deletedSeqs[seq] = true;
          stores.bySeqStore.get(seq, function (err, resp) {
            /* istanbul ignore if */
            if (err || !isLocalId(resp._id)) {
              return next();
            }
            batches.push({
              key: seq,
              prefix: stores.bySeqStore,
              type: 'del'
            });
            next();
          });
        }, function () {
          db.batch(batches, callback);
        }));
      });
    });
  });
};

const migrate = {
  toSublevel,
  localAndMetaStores
};

// shim for Function.prototype.name,
// for browsers that don't support it like IE

/* c8 ignore next */
/**
 *
 */
function f () {}

const hasName = f.name;
let res$2;

// We dont run coverage in IE
/* istanbul ignore else */
res$2 = hasName
  ? function (fun) {
    return fun.name;
  }
  : function (fun) {
    return fun.toString().match(/^\s*function\s*(\S*)\s*\(/)[1];
  };

const functionName = res$2;

/**
 *
 * @param storedObject
 * @param type
 */
function readAsBlobOrBuffer (storedObject, type) {
  // In Node, we've stored a buffer
  storedObject.type = type; // non-standard, but used for consistency
  return storedObject;
}

// in Node, we store the buffer directly
/**
 *
 * @param attData
 * @param cb
 */
function prepareAttachmentForStorage (attData, cb) {
  queueMicrotask(function () {
    cb(attData);
  });
}

/**
 *
 * @param type
 */
function createEmptyBlobOrBuffer (type) {
  return typedBuffer('', 'binary', type);
}

/**
 *
 * @param transaction
 * @param store
 */
function getCacheFor (transaction, store) {
  const prefix = store.prefix()[0];
  const cache = transaction._cache;
  let subCache = cache.get(prefix);
  if (!subCache) {
    subCache = new pouchdbCollections.Map();
    cache.set(prefix, subCache);
  }
  return subCache;
}

/**
 *
 */
function LevelTransaction () {
  this._batch = [];
  this._cache = new pouchdbCollections.Map();
}

LevelTransaction.prototype.get = function (store, key, callback) {
  const cache = getCacheFor(this, store);
  const exists = cache.get(key);
  if (exists) {
    return queueMicrotask(function () {
      callback(null, exists);
    });
  }
  if (exists === null) { // deleted marker
    /* c8 ignore next */
    return queueMicrotask(function () {
      callback({name: 'NotFoundError'});
    });
  }
  store.get(key, function (err, res) {
    if (err) {
      /* istanbul ignore else */
      if (err.name === 'NotFoundError') {
        cache.set(key, null);
      }
      return callback(err);
    }
    cache.set(key, res);
    callback(null, res);
  });
};

LevelTransaction.prototype.batch = function (batch) {
  for (const operation of batch) {
    const cache = getCacheFor(this, operation.prefix);

    if (operation.type === 'put') {
      cache.set(operation.key, operation.value);
    } else {
      cache.set(operation.key, null);
    }
  }
  this._batch = this._batch.concat(batch);
};

LevelTransaction.prototype.execute = function (db, callback) {
  const keys = new pouchdbCollections.Set();
  const uniqBatches = [];

  // remove duplicates; last one wins
  for (let i = this._batch.length - 1; i >= 0; i--) {
    const operation = this._batch[i];
    const lookupKey = operation.prefix.prefix()[0] + '\u{FF}' + operation.key;
    if (keys.has(lookupKey)) {
      continue;
    }
    keys.add(lookupKey);
    uniqBatches.push(operation);
  }

  db.batch(uniqBatches, callback);
};

const DOC_STORE = 'document-store';
const BY_SEQ_STORE = 'by-sequence';
const ATTACHMENT_STORE = 'attach-store';
const BINARY_STORE = 'attach-binary-store';
const LOCAL_STORE = 'local-store';
const META_STORE = 'meta-store';

// leveldb barks if we try to open a db multiple times
// so we cache opened connections here for initstore()
const dbStores = new pouchdbCollections.Map();

// store the value of update_seq in the by-sequence store the key name will
// never conflict, since the keys in the by-sequence store are integers
const UPDATE_SEQ_KEY = '_local_last_update_seq';
const DOC_COUNT_KEY = '_local_doc_count';
const UUID_KEY = '_local_uuid';

const MD5_PREFIX = 'md5-';

const safeJsonEncoding = {
  encode: safeJsonStringify,
  decode: safeJsonParse,
  buffer: false,
  type: 'cheap-json'
};

const levelChanges = new Changes$1();

// require leveldown. provide verbose output on error as it is the default
// nodejs adapter, which we do not provide for the user
/* c8 ignore next */
const requireLeveldown = function () {
  try {
    return {};
  } catch (err) {
    /* eslint no-ex-assign: 0*/
    err ||= 'leveldown import error';
    if (err.code === 'MODULE_NOT_FOUND') {
      // handle leveldown not installed case
      return new Error([
        'the \'leveldown\' package is not available. install it, or,',
        'specify another storage backend using the \'db\' option'
      ].join(' '));
    } else if (err.message && err.message.match('Module version mismatch')) {
      // handle common user enviornment error
      return new Error([
        err.message,
        'This generally implies that leveldown was built with a different',
        'version of node than that which is running now.  You may try',
        'fully removing and reinstalling PouchDB or leveldown to resolve.'
      ].join(' '));
    }
    // handle general internal nodejs require error
    return new Error(err.toString() + ': unable to import leveldown');
  }
};

// winningRev and deleted are performance-killers, but
// in newer versions of PouchDB, they are cached on the metadata
/**
 *
 * @param metadata
 */
function getWinningRev (metadata) {
  return 'winningRev' in metadata
    ? metadata.winningRev
    : winningRev(metadata);
}

/**
 *
 * @param metadata
 * @param winningRev
 */
function getIsDeleted (metadata, winningRev) {
  return 'deleted' in metadata
    ? metadata.deleted
    : isDeleted(metadata, winningRev);
}

/**
 *
 * @param att
 * @param stores
 * @param opts
 */
function fetchAttachment (att, stores, opts) {
  const type = att.content_type;
  return new PouchPromise(function (resolve, reject) {
    stores.binaryStore.get(att.digest, function (err, buffer) {
      let data;
      if (err) {
        /* istanbul ignore if */
        if (err.name !== 'NotFoundError') {
          return reject(err);
        }
        // empty
        data = !opts.binary ? '' : binStringToBluffer('', type);
      } else { // non-empty
        data = opts.binary ? readAsBlobOrBuffer(buffer, type) : buffer.toString('base64');
      }
      delete att.stub;
      delete att.length;
      att.data = data;
      resolve();
    });
  });
}

/**
 *
 * @param results
 * @param stores
 * @param opts
 */
function fetchAttachments (results, stores, opts) {
  const atts = [];
  results.forEach(function (row) {
    if (!(row.doc && row.doc._attachments)) {
      return;
    }
    const attNames = Object.keys(row.doc._attachments);
    attNames.forEach(function (attName) {
      const att = row.doc._attachments[attName];
      if (!('data' in att)) {
        atts.push(att);
      }
    });
  });

  return PouchPromise.all(atts.map(function (att) {
    return fetchAttachment(att, stores, opts);
  }));
}

/**
 *
 * @param opts
 * @param callback
 */
function LevelPouch (opts, callback) {
  opts = clone(opts);
  const api = this;
  let instanceId;
  const stores = {};
  const revLimit = opts.revs_limit;
  let db;
  const {name} = opts;
  if (typeof opts.createIfMissing === 'undefined') {
    opts.createIfMissing = true;
  }

  const leveldown = opts.db || requireLeveldown();
  /* istanbul ignore if */
  if (leveldown instanceof Error) {
    return callback(leveldown);
  }

  if (typeof leveldown.destroy !== 'function') {
    /* c8 ignore next */
    leveldown.destroy = function (name, cb) {
      cb();
    };
  }
  let dbStore;
  const leveldownName = functionName(leveldown);
  if (dbStores.has(leveldownName)) {
    dbStore = dbStores.get(leveldownName);
  } else {
    dbStore = new pouchdbCollections.Map();
    dbStores.set(leveldownName, dbStore);
  }
  if (dbStore.has(name)) {
    db = dbStore.get(name);
    afterDBCreated();
  } else {
    dbStore.set(name, sublevel(levelup(name, opts, function (err) {
      /* istanbul ignore if */
      if (err) {
        dbStore.delete(name);
        return callback(err);
      }
      db = dbStore.get(name);
      db._docCount = -1;
      db._queue = new Deque();
      if (opts.db || opts.noMigrate) {
        afterDBCreated();
      } else {
        migrate.toSublevel(name, db, afterDBCreated);
      }
    })));
  }

  /**
   *
   */
  function afterDBCreated () {
    stores.docStore = db.sublevel(DOC_STORE, {valueEncoding: safeJsonEncoding});
    stores.bySeqStore = db.sublevel(BY_SEQ_STORE, {valueEncoding: 'json'});
    stores.attachmentStore =
      db.sublevel(ATTACHMENT_STORE, {valueEncoding: 'json'});
    stores.binaryStore = db.sublevel(BINARY_STORE, {valueEncoding: 'binary'});
    stores.localStore = db.sublevel(LOCAL_STORE, {valueEncoding: 'json'});
    stores.metaStore = db.sublevel(META_STORE, {valueEncoding: 'json'});
    migrate.localAndMetaStores(db, stores, function () {
      stores.metaStore.get(UPDATE_SEQ_KEY, function (err, value) {
        if (typeof db._updateSeq === 'undefined') {
          db._updateSeq = value || 0;
        }
        stores.metaStore.get(DOC_COUNT_KEY, function (err, value) {
          db._docCount = !err ? value : 0;
          stores.metaStore.get(UUID_KEY, function (err, value) {
            instanceId = !err ? value : uuid();
            stores.metaStore.put(UUID_KEY, instanceId, function () {
              queueMicrotask(function () {
                callback(null, api);
              });
            });
          });
        });
      });
    });
  }

  /**
   *
   * @param callback
   */
  function countDocs (callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(new Error('database is closed'));
    }
    return callback(null, db._docCount); // use cached value
  }

  api.type = function () {
    return 'leveldb';
  };

  api._id = function (callback) {
    callback(null, instanceId);
  };

  api._info = function (callback) {
    const res = {
      doc_count: db._docCount,
      update_seq: db._updateSeq,
      backend_adapter: functionName(leveldown)
    };
    return queueMicrotask(function () {
      callback(null, res);
    });
  };

  /**
   *
   * @param fun
   * @param args
   */
  function tryCode (fun, args) {
    try {
      fun.apply(null, args);
    } catch (err) {
      args.at(-1)(err);
    }
  }

  /**
   *
   */
  function executeNext () {
    const firstTask = db._queue.peekFront();

    if (firstTask.type === 'read') {
      runReadOperation(firstTask);
    } else { // write, only do one at a time
      runWriteOperation(firstTask);
    }
  }

  /**
   *
   * @param firstTask
   */
  function runReadOperation (firstTask) {
    // do multiple reads at once simultaneously, because it's safe

    const readTasks = [firstTask];
    let i = 1;
    let nextTask = db._queue.get(i);
    while (typeof nextTask !== 'undefined' && nextTask.type === 'read') {
      readTasks.push(nextTask);
      i++;
      nextTask = db._queue.get(i);
    }

    let numDone = 0;

    readTasks.forEach(function (readTask) {
      const {args} = readTask;
      const callback = args.at(-1);
      args[args.length - 1] = getArguments(function (cbArgs) {
        callback.apply(null, cbArgs);
        if (++numDone === readTasks.length) {
          queueMicrotask(function () {
            // all read tasks have finished
            readTasks.forEach(function () {
              db._queue.shift();
            });
            if (db._queue.length) {
              executeNext();
            }
          });
        }
      });
      tryCode(readTask.fun, args);
    });
  }

  /**
   *
   * @param firstTask
   */
  function runWriteOperation (firstTask) {
    const {args} = firstTask;
    const callback = args.at(-1);
    args[args.length - 1] = getArguments(function (cbArgs) {
      callback.apply(null, cbArgs);
      queueMicrotask(function () {
        db._queue.shift();
        if (db._queue.length) {
          executeNext();
        }
      });
    });
    tryCode(firstTask.fun, args);
  }

  // all read/write operations to the database are done in a queue,
  // similar to how websql/idb works. this avoids problems such
  // as e.g. compaction needing to have a lock on the database while
  // it updates stuff. in the future we can revisit this.
  /**
   *
   * @param fun
   */
  function writeLock (fun) {
    return getArguments(function (args) {
      db._queue.push({
        fun,
        args,
        type: 'write'
      });

      if (db._queue.length === 1) {
        queueMicrotask(executeNext);
      }
    });
  }

  // same as the writelock, but multiple can run at once
  /**
   *
   * @param fun
   */
  function readLock (fun) {
    return getArguments(function (args) {
      db._queue.push({
        fun,
        args,
        type: 'read'
      });

      if (db._queue.length === 1) {
        queueMicrotask(executeNext);
      }
    });
  }

  /**
   *
   * @param n
   */
  function formatSeq (n) {
    return ('0000000000000000' + n).slice(-16);
  }

  /**
   *
   * @param s
   */
  function parseSeq (s) {
    return parseInt(s, 10);
  }

  api._get = readLock(function (id, opts, callback) {
    opts = clone(opts);

    stores.docStore.get(id, function (err, metadata) {
      if (err || !metadata) {
        return callback(createError(MISSING_DOC, 'missing'));
      }

      let rev = getWinningRev(metadata);
      const deleted = getIsDeleted(metadata, rev);
      if (deleted && !opts.rev) {
        return callback(createError(MISSING_DOC, 'deleted'));
      }

      rev = opts.rev ? opts.rev : rev;

      const seq = metadata.rev_map[rev];

      stores.bySeqStore.get(formatSeq(seq), function (err, doc) {
        if (!doc) {
          return callback(createError(MISSING_DOC));
        }
        /* istanbul ignore if */
        if ('_id' in doc && doc._id !== metadata.id) {
          // this failing implies something very wrong
          return callback(new Error('wrong doc returned'));
        }
        doc._id = metadata.id;
        if ('_rev' in doc) {
          /* istanbul ignore if */
          if (doc._rev !== rev) {
            // this failing implies something very wrong
            return callback(new Error('wrong doc returned'));
          }
        } else {
          // we didn't always store this
          doc._rev = rev;
        }
        return callback(null, {doc, metadata});
      });
    });
  });

  // not technically part of the spec, but if putAttachment has its own
  // method...
  api._getAttachment = function (attachment, opts, callback) {
    const {digest} = attachment;
    const type = attachment.content_type;

    stores.binaryStore.get(digest, function (err, attach) {
      if (err) {
        /* istanbul ignore if */
        if (err.name !== 'NotFoundError') {
          return callback(err);
        }
        // Empty attachment
        return callback(null, opts.binary ? createEmptyBlobOrBuffer(type) : '');
      }

      if (opts.binary) {
        callback(null, readAsBlobOrBuffer(attach, type));
      } else {
        callback(null, attach.toString('base64'));
      }
    });
  };

  api._bulkDocs = writeLock(function (req, opts, callback) {
    const newEdits = opts.new_edits;
    const results = Array.from({length: req.docs.length});
    const fetchedDocs = new pouchdbCollections.Map();
    const stemmedRevs = new pouchdbCollections.Map();

    const txn = new LevelTransaction();
    let docCountDelta = 0;
    let newUpdateSeq = db._updateSeq;

    // parse the docs and give each a sequence number
    const userDocs = req.docs;
    const docInfos = userDocs.map(function (doc) {
      if (doc._id && isLocalId(doc._id)) {
        return doc;
      }
      const newDoc = parseDoc(doc, newEdits);

      if (newDoc.metadata && !newDoc.metadata.rev_map) {
        newDoc.metadata.rev_map = {};
      }

      return newDoc;
    });
    const infoErrors = docInfos.filter(function (doc) {
      return doc.error;
    });

    if (infoErrors.length) {
      return callback(infoErrors[0]);
    }

    // verify any stub attachments as a precondition test

    /**
     *
     * @param digest
     * @param callback
     */
    function verifyAttachment (digest, callback) {
      txn.get(stores.attachmentStore, digest, function (levelErr) {
        if (levelErr) {
          const err = createError(MISSING_STUB,
            'unknown stub attachment with digest ' +
            digest);
          callback(err);
        } else {
          callback();
        }
      });
    }

    /**
     *
     * @param finish
     */
    function verifyAttachments (finish) {
      const digests = [];
      userDocs.forEach(function (doc) {
        if (doc && doc._attachments) {
          Object.keys(doc._attachments).forEach(function (filename) {
            const att = doc._attachments[filename];
            if (att.stub) {
              digests.push(att.digest);
            }
          });
        }
      });
      if (!digests.length) {
        return finish();
      }
      let numDone = 0;
      let err;

      digests.forEach(function (digest) {
        verifyAttachment(digest, function (attErr) {
          if (attErr && !err) {
            err = attErr;
          }

          if (++numDone === digests.length) {
            finish(err);
          }
        });
      });
    }

    /**
     *
     * @param finish
     */
    function fetchExistingDocs (finish) {
      let numDone = 0;
      let overallErr;
      /**
       *
       */
      function checkDone () {
        if (++numDone === userDocs.length) {
          return finish(overallErr);
        }
      }

      userDocs.forEach(function (doc) {
        if (doc._id && isLocalId(doc._id)) {
          // skip local docs
          return checkDone();
        }
        txn.get(stores.docStore, doc._id, function (err, info) {
          if (err) {
            /* istanbul ignore if */
            if (err.name !== 'NotFoundError') {
              overallErr = err;
            }
          } else {
            fetchedDocs.set(doc._id, info);
          }
          checkDone();
        });
      });
    }

    /**
     *
     * @param revsMap
     * @param callback
     */
    function compact (revsMap, callback) {
      let promise = PouchPromise.resolve();
      revsMap.forEach(function (revs, docId) {
        // TODO: parallelize, for now need to be sequential to
        // pass orphaned attachment tests
        promise = promise.then(function () {
          return new PouchPromise(function (resolve, reject) {
            api._doCompactionNoLock(docId, revs, {ctx: txn}, function (err) {
              /* istanbul ignore if */
              if (err) {
                return reject(err);
              }
              resolve();
            });
          });
        });
      });

      promise.then(function () {
        callback();
      }, callback);
    }

    /**
     *
     * @param callback
     */
    function autoCompact (callback) {
      const revsMap = new pouchdbCollections.Map();
      fetchedDocs.forEach(function (metadata, docId) {
        revsMap.set(docId, compactTree(metadata));
      });
      compact(revsMap, callback);
    }

    /**
     *
     */
    function finish () {
      if (api.auto_compaction) {
        return autoCompact(complete);
      }
      compact(stemmedRevs, complete);
    }

    /**
     *
     * @param docInfo
     * @param winningRev
     * @param winningRevIsDeleted
     * @param newRevIsDeleted
     * @param isUpdate
     * @param delta
     * @param resultsIdx
     * @param callback2
     */
    function writeDoc (docInfo, winningRev, winningRevIsDeleted, newRevIsDeleted,
      isUpdate, delta, resultsIdx, callback2) {
      docCountDelta += delta;

      let err = null;
      let recv = 0;

      docInfo.metadata.winningRev = winningRev;
      docInfo.metadata.deleted = winningRevIsDeleted;

      docInfo.data._id = docInfo.metadata.id;
      docInfo.data._rev = docInfo.metadata.rev;

      if (newRevIsDeleted) {
        docInfo.data._deleted = true;
      }

      if (docInfo.stemmedRevs.length) {
        stemmedRevs.set(docInfo.metadata.id, docInfo.stemmedRevs);
      }

      const attachments = docInfo.data._attachments
        ? Object.keys(docInfo.data._attachments)
        : [];

      /**
       *
       * @param attachmentErr
       */
      function attachmentSaved (attachmentErr) {
        recv++;
        if (!err) {
          /* istanbul ignore if */
          if (attachmentErr) {
            err = attachmentErr;
            callback2(err);
          } else if (recv === attachments.length) {
            finish();
          }
        }
      }

      /**
       *
       * @param doc
       * @param key
       * @param data
       * @param attachmentSaved
       */
      function onMD5Load (doc, key, data, attachmentSaved) {
        return function (result) {
          saveAttachment(doc, MD5_PREFIX + result, key, data, attachmentSaved);
        };
      }

      /**
       *
       * @param doc
       * @param key
       * @param attachmentSaved
       */
      function doMD5 (doc, key, attachmentSaved) {
        return function (data) {
          res$1(data).then(
            onMD5Load(doc, key, data, attachmentSaved)
          );
        };
      }

      for (const key of attachments) {
        const att = docInfo.data._attachments[key];

        if (att.stub) {
          // still need to update the refs mapping
          const id = docInfo.data._id;
          const rev = docInfo.data._rev;
          saveAttachmentRefs(id, rev, att.digest, attachmentSaved);
          continue;
        }
        var data;
        if (typeof att.data === 'string') {
          // input is assumed to be a base64 string
          try {
            data = atob(att.data);
          } catch (e) {
            callback(createError(BAD_ARG,
              'Attachment is not a valid base64 string'));
            return;
          }
          doMD5(docInfo, key, attachmentSaved)(data);
        } else {
          prepareAttachmentForStorage(att.data,
            doMD5(docInfo, key, attachmentSaved));
        }
      }

      /**
       *
       */
      function finish () {
        let seq = docInfo.metadata.rev_map[docInfo.metadata.rev];
        /* istanbul ignore if */
        if (seq) {
          // check that there aren't any existing revisions with the same
          // revision id, else we shouldn't do anything
          return callback2(null, docInfo.revsStemmed);
        }
        seq = ++newUpdateSeq;
        docInfo.metadata.rev_map[docInfo.metadata.rev] =
          docInfo.metadata.seq = seq;
        const seqKey = formatSeq(seq);
        const batch = [{
          key: seqKey,
          value: docInfo.data,
          prefix: stores.bySeqStore,
          type: 'put'
        }, {
          key: docInfo.metadata.id,
          value: docInfo.metadata,
          prefix: stores.docStore,
          type: 'put'
        }];
        txn.batch(batch);
        results[resultsIdx] = {
          ok: true,
          id: docInfo.metadata.id,
          rev: winningRev
        };
        fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
        callback2(null, docInfo.revsStemmed);
      }

      if (!attachments.length) {
        finish();
      }
    }

    // attachments are queued per-digest, otherwise the refs could be
    // overwritten by concurrent writes in the same bulkDocs session
    var attachmentQueues = {};

    /**
     *
     * @param id
     * @param rev
     * @param digest
     * @param callback
     */
    function saveAttachmentRefs (id, rev, digest, callback) {
      /**
       *
       */
      function fetchAtt () {
        return new PouchPromise(function (resolve, reject) {
          txn.get(stores.attachmentStore, digest, function (err, oldAtt) {
            /* istanbul ignore if */
            if (err && err.name !== 'NotFoundError') {
              return reject(err);
            }
            resolve(oldAtt);
          });
        });
      }

      /**
       *
       * @param oldAtt
       */
      function saveAtt (oldAtt) {
        const ref = [id, rev].join('@');
        const newAtt = {};

        if (oldAtt) {
          if (oldAtt.refs) {
            // only update references if this attachment already has them
            // since we cannot migrate old style attachments here without
            // doing a full db scan for references
            newAtt.refs = oldAtt.refs;
            newAtt.refs[ref] = true;
          }
        } else {
          newAtt.refs = {};
          newAtt.refs[ref] = true;
        }

        return new PouchPromise(function (resolve) {
          txn.batch([{
            type: 'put',
            prefix: stores.attachmentStore,
            key: digest,
            value: newAtt
          }]);
          resolve(!oldAtt);
        });
      }

      // put attachments in a per-digest queue, to avoid two docs with the same
      // attachment overwriting each other
      const queue = attachmentQueues[digest] || PouchPromise.resolve();
      attachmentQueues[digest] = queue.then(function () {
        return fetchAtt().then(saveAtt).then(function (isNewAttachment) {
          callback(null, isNewAttachment);
        }, callback);
      });
    }

    /**
     *
     * @param docInfo
     * @param digest
     * @param key
     * @param data
     * @param callback
     */
    function saveAttachment (docInfo, digest, key, data, callback) {
      const att = docInfo.data._attachments[key];
      delete att.data;
      att.digest = digest;
      att.length = data.length;
      const {id} = docInfo.metadata;
      const {rev} = docInfo.metadata;
      att.revpos = parseInt(rev, 10);

      saveAttachmentRefs(id, rev, digest, function (err, isNewAttachment) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        // do not try to store empty attachments
        if (data.length === 0) {
          return callback(err);
        }
        if (!isNewAttachment) {
          // small optimization - don't bother writing it again
          return callback(err);
        }
        txn.batch([{
          type: 'put',
          prefix: stores.binaryStore,
          key: digest,
          value: Buffer.from(data, 'binary')
        }]);
        callback();
      });
    }

    /**
     *
     * @param err
     */
    function complete (err) {
      /* istanbul ignore if */
      if (err) {
        return queueMicrotask(function () {
          callback(err);
        });
      }
      txn.batch([
        {
          prefix: stores.metaStore,
          type: 'put',
          key: UPDATE_SEQ_KEY,
          value: newUpdateSeq
        },
        {
          prefix: stores.metaStore,
          type: 'put',
          key: DOC_COUNT_KEY,
          value: db._docCount + docCountDelta
        }
      ]);
      txn.execute(db, function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        db._docCount += docCountDelta;
        db._updateSeq = newUpdateSeq;
        levelChanges.notify(name);
        queueMicrotask(function () {
          callback(null, results);
        });
      });
    }

    if (!docInfos.length) {
      return callback(null, []);
    }

    verifyAttachments(function (err) {
      if (err) {
        return callback(err);
      }
      fetchExistingDocs(function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        processDocs(revLimit, docInfos, api, fetchedDocs, txn, results,
          writeDoc, opts, finish);
      });
    });
  });
  api._allDocs = readLock(function (opts, callback) {
    opts = clone(opts);
    countDocs(function (err, docCount) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      const readstreamOpts = {};
      let skip = opts.skip || 0;
      if (opts.startkey) {
        readstreamOpts.gte = opts.startkey;
      }
      if (opts.endkey) {
        readstreamOpts.lte = opts.endkey;
      }
      if (opts.key) {
        readstreamOpts.gte = readstreamOpts.lte = opts.key;
      }
      if (opts.descending) {
        readstreamOpts.reverse = true;
        // switch start and ends
        const tmp = readstreamOpts.lte;
        readstreamOpts.lte = readstreamOpts.gte;
        readstreamOpts.gte = tmp;
      }
      let limit;
      if (typeof opts.limit === 'number') {
        limit = opts.limit;
      }
      if (limit === 0 ||
        ('start' in readstreamOpts && 'end' in readstreamOpts &&
        readstreamOpts.start > readstreamOpts.end)) {
        // should return 0 results when start is greater than end.
        // normally level would "fix" this for us by reversing the order,
        // so short-circuit instead
        return callback(null, {
          total_rows: docCount,
          offset: opts.skip,
          rows: []
        });
      }
      const results = [];
      const docstream = stores.docStore.readStream(readstreamOpts);

      var throughStream = through2.obj(function (entry, _, next) {
        const metadata = entry.value;
        // winningRev and deleted are performance-killers, but
        // in newer versions of PouchDB, they are cached on the metadata
        const winningRev = getWinningRev(metadata);
        const deleted = getIsDeleted(metadata, winningRev);
        if (!deleted) {
          if (skip-- > 0) {
            next();
            return;
          }
          if (typeof limit === 'number' && limit-- <= 0) {
            docstream.unpipe();
            docstream.destroy();
            next();
            return;
          }
        } else if (opts.deleted !== 'ok') {
          next();
          return;
        }
        /**
         *
         * @param data
         */
        function allDocsInner (data) {
          const doc = {
            id: metadata.id,
            key: metadata.id,
            value: {
              rev: winningRev
            }
          };
          if (opts.include_docs) {
            doc.doc = data;
            doc.doc._rev = doc.value.rev;
            if (opts.conflicts) {
              doc.doc._conflicts = collectConflicts(metadata);
            }
            for (const att in doc.doc._attachments) {
              if (doc.doc._attachments.hasOwnProperty(att)) {
                doc.doc._attachments[att].stub = true;
              }
            }
          }
          if (opts.inclusive_end === false && metadata.id === opts.endkey) {
            return next();
          }
          if (deleted) {
            if (opts.deleted === 'ok') {
              doc.value.deleted = true;
              doc.doc = null;
            } else {
              /* c8 ignore next */
              return next();
            }
          }
          results.push(doc);
          next();
        }
        if (opts.include_docs) {
          const seq = metadata.rev_map[winningRev];
          stores.bySeqStore.get(formatSeq(seq), function (err, data) {
            allDocsInner(data);
          });
        } else {
          allDocsInner();
        }
      }, function (next) {
        PouchPromise.resolve().then(function () {
          if (opts.include_docs && opts.attachments) {
            return fetchAttachments(results, stores, opts);
          }
        }).then(function () {
          callback(null, {
            total_rows: docCount,
            offset: opts.skip,
            rows: results
          });
        }, callback);
        next();
      }).on('unpipe', function () {
        throughStream.end();
      });

      docstream.on('error', callback);

      docstream.pipe(throughStream);
    });
  });

  api._changes = function (opts) {
    opts = clone(opts);

    if (opts.continuous) {
      const id = name + ':' + uuid();
      levelChanges.addListener(name, id, api, opts);
      levelChanges.notify(name);
      return {
        cancel () {
          levelChanges.removeListener(name, id);
        }
      };
    }

    const {descending} = opts;
    const results = [];
    let lastSeq = opts.since || 0;
    let called = 0;
    const streamOpts = {
      reverse: descending
    };
    let limit;
    if ('limit' in opts && opts.limit > 0) {
      limit = opts.limit;
    }
    if (!streamOpts.reverse) {
      streamOpts.start = formatSeq(opts.since || 0);
    }

    const docIds = opts.doc_ids && new pouchdbCollections.Set(opts.doc_ids);
    const filter = filterChange(opts);
    const docIdsToMetadata = new pouchdbCollections.Map();

    let returnDocs;
    if ('return_docs' in opts) {
      returnDocs = opts.return_docs;
    } else if ('returnDocs' in opts) {
      // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }

    /**
     *
     */
    function complete () {
      opts.done = true;
      if (returnDocs && opts.limit) {
        /* istanbul ignore if */
        if (opts.limit < results.length) {
          results.length = opts.limit;
        }
      }
      changeStream.unpipe(throughStream);
      changeStream.destroy();
      if (!opts.continuous && !opts.cancelled) {
        if (opts.include_docs && opts.attachments) {
          fetchAttachments(results, stores, opts).then(function () {
            opts.complete(null, {results, last_seq: lastSeq});
          });
        } else {
          opts.complete(null, {results, last_seq: lastSeq});
        }
      }
    }
    var changeStream = stores.bySeqStore.readStream(streamOpts);
    var throughStream = through2.obj(function (data, _, next) {
      if (limit && called >= limit) {
        complete();
        return next();
      }
      if (opts.cancelled || opts.done) {
        return next();
      }

      const seq = parseSeq(data.key);
      const doc = data.value;

      if (seq === opts.since && !descending) {
        // couchdb ignores `since` if descending=true
        return next();
      }

      if (docIds && !docIds.has(doc._id)) {
        return next();
      }

      let metadata;

      /**
       *
       * @param metadata
       */
      function onGetMetadata (metadata) {
        const winningRev = getWinningRev(metadata);

        /**
         *
         * @param winningDoc
         */
        function onGetWinningDoc (winningDoc) {
          const change = opts.processChange(winningDoc, metadata, opts);
          change.seq = metadata.seq;

          const filtered = filter(change);
          if (typeof filtered === 'object') {
            return opts.complete(filtered);
          }

          if (filtered) {
            called++;

            if (opts.attachments && opts.include_docs) {
              // fetch attachment immediately for the benefit
              // of live listeners
              fetchAttachments([change], stores, opts).then(function () {
                opts.onChange(change);
              });
            } else {
              opts.onChange(change);
            }

            if (returnDocs) {
              results.push(change);
            }
          }
          next();
        }

        if (metadata.seq !== seq) {
          // some other seq is later
          return next();
        }

        lastSeq = seq;

        if (winningRev === doc._rev) {
          return onGetWinningDoc(doc);
        }

        // fetch the winner

        const winningSeq = metadata.rev_map[winningRev];

        stores.bySeqStore.get(formatSeq(winningSeq), function (err, doc) {
          onGetWinningDoc(doc);
        });
      }

      metadata = docIdsToMetadata.get(doc._id);
      if (metadata) { // cached
        return onGetMetadata(metadata);
      }
      // metadata not cached, have to go fetch it
      stores.docStore.get(doc._id, function (err, metadata) {
        /* istanbul ignore if */
        if (opts.cancelled || opts.done || db.isClosed() ||
          isLocalId(metadata.id)) {
          return next();
        }
        docIdsToMetadata.set(doc._id, metadata);
        onGetMetadata(metadata);
      });
    }, function (next) {
      if (opts.cancelled) {
        return next();
      }
      if (returnDocs && opts.limit) {
        /* istanbul ignore if */
        if (opts.limit < results.length) {
          results.length = opts.limit;
        }
      }

      next();
    }).on('unpipe', function () {
      throughStream.end();
      complete();
    });
    changeStream.pipe(throughStream);
    return {
      cancel () {
        opts.cancelled = true;
        complete();
      }
    };
  };

  api._close = function (callback) {
    /* istanbul ignore if */
    if (db.isClosed()) {
      return callback(createError(NOT_OPEN));
    }
    db.close(function (err) {
      /* istanbul ignore if */
      if (err) {
        callback(err);
      } else {
        dbStore.delete(name);
        callback();
      }
    });
  };

  api._getRevisionTree = function (docId, callback) {
    stores.docStore.get(docId, function (err, metadata) {
      if (err) {
        callback(createError(MISSING_DOC));
      } else {
        callback(null, metadata.rev_tree);
      }
    });
  };

  api._doCompaction = writeLock(function (docId, revs, opts, callback) {
    api._doCompactionNoLock(docId, revs, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._doCompactionNoLock = function (docId, revs, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    if (!revs.length) {
      return callback();
    }
    const txn = opts.ctx || new LevelTransaction();

    txn.get(stores.docStore, docId, function (err, metadata) {
      /* istanbul ignore if */
      if (err) {
        return callback(err);
      }
      const seqs = revs.map(function (rev) {
        const seq = metadata.rev_map[rev];
        delete metadata.rev_map[rev];
        return seq;
      });
      traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
        revHash, ctx, opts) {
        const rev = pos + '-' + revHash;
        if (revs.includes(rev)) {
          opts.status = 'missing';
        }
      });

      let batch = [{
        key: metadata.id,
        value: metadata,
        type: 'put',
        prefix: stores.docStore
      }];

      const digestMap = {};
      let numDone = 0;
      let overallErr;
      /**
       *
       * @param err
       */
      function checkDone (err) {
        /* istanbul ignore if */
        if (err) {
          overallErr = err;
        }
        if (++numDone === revs.length) { // done
          /* istanbul ignore if */
          if (overallErr) {
            return callback(overallErr);
          }
          deleteOrphanedAttachments();
        }
      }

      /**
       *
       * @param err
       */
      function finish (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        txn.batch(batch);
        if (opts.ctx) {
          // don't execute immediately
          return callback();
        }
        txn.execute(db, callback);
      }

      /**
       *
       */
      function deleteOrphanedAttachments () {
        const possiblyOrphanedAttachments = Object.keys(digestMap);
        if (!possiblyOrphanedAttachments.length) {
          return finish();
        }
        let numDone = 0;
        let overallErr;
        /**
         *
         * @param err
         */
        function checkDone (err) {
          /* istanbul ignore if */
          if (err) {
            overallErr = err;
          }
          if (++numDone === possiblyOrphanedAttachments.length) {
            finish(overallErr);
          }
        }
        const refsToDelete = new pouchdbCollections.Map();
        revs.forEach(function (rev) {
          refsToDelete.set(docId + '@' + rev, true);
        });
        possiblyOrphanedAttachments.forEach(function (digest) {
          txn.get(stores.attachmentStore, digest, function (err, attData) {
            /* istanbul ignore if */
            if (err) {
              if (err.name === 'NotFoundError') {
                return checkDone();
              }
              return checkDone(err);
            }
            const refs = Object.keys(attData.refs || {}).filter(function (ref) {
              return !refsToDelete.has(ref);
            });
            const newRefs = {};
            refs.forEach(function (ref) {
              newRefs[ref] = true;
            });
            if (refs.length) { // not orphaned
              batch.push({
                key: digest,
                type: 'put',
                value: {refs: newRefs},
                prefix: stores.attachmentStore
              });
            } else { // orphaned, can safely delete
              batch = [...batch, {
                key: digest,
                type: 'del',
                prefix: stores.attachmentStore
              }, {
                key: digest,
                type: 'del',
                prefix: stores.binaryStore
              }];
            }
            checkDone();
          });
        });
      }

      seqs.forEach(function (seq) {
        batch.push({
          key: formatSeq(seq),
          type: 'del',
          prefix: stores.bySeqStore
        });
        txn.get(stores.bySeqStore, formatSeq(seq), function (err, doc) {
          /* istanbul ignore if */
          if (err) {
            if (err.name === 'NotFoundError') {
              return checkDone();
            }
            return checkDone(err);
          }
          const atts = Object.keys(doc._attachments || {});
          atts.forEach(function (attName) {
            const {digest} = doc._attachments[attName];
            digestMap[digest] = true;
          });
          checkDone();
        });
      });
    });
  };

  api._getLocal = function (id, callback) {
    stores.localStore.get(id, function (err, doc) {
      if (err) {
        callback(createError(MISSING_DOC));
      } else {
        callback(null, doc);
      }
    });
  };

  api._putLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._putLocalNoLock(doc, opts, callback);
    } else {
      api._putLocalWithLock(doc, opts, callback);
    }
  };

  api._putLocalWithLock = writeLock(function (doc, opts, callback) {
    api._putLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._putLocalNoLock = function (doc, opts, callback) {
    delete doc._revisions; // ignore this, trust the rev
    const oldRev = doc._rev;
    const id = doc._id;

    const txn = opts.ctx || new LevelTransaction();

    txn.get(stores.localStore, id, function (err, resp) {
      if (err && oldRev) {
        return callback(createError(REV_CONFLICT));
      }
      if (resp && resp._rev !== oldRev) {
        return callback(createError(REV_CONFLICT));
      }
      doc._rev =
        oldRev ? '0-' + (parseInt(oldRev.split('-', 2)[1], 10) + 1) : '0-1';
      const batch = [
        {
          type: 'put',
          prefix: stores.localStore,
          key: id,
          value: doc
        }
      ];

      txn.batch(batch);
      const ret = {ok: true, id: doc._id, rev: doc._rev};

      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  api._removeLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    if (opts.ctx) {
      api._removeLocalNoLock(doc, opts, callback);
    } else {
      api._removeLocalWithLock(doc, opts, callback);
    }
  };

  api._removeLocalWithLock = writeLock(function (doc, opts, callback) {
    api._removeLocalNoLock(doc, opts, callback);
  });

  // the NoLock version is for use by bulkDocs
  api._removeLocalNoLock = function (doc, opts, callback) {
    const txn = opts.ctx || new LevelTransaction();
    txn.get(stores.localStore, doc._id, function (err, resp) {
      if (err) {
        /* istanbul ignore if */
        if (err.name !== 'NotFoundError') {
          return callback(err);
        }
        return callback(createError(MISSING_DOC));
      }
      if (resp._rev !== doc._rev) {
        return callback(createError(REV_CONFLICT));
      }
      txn.batch([{
        prefix: stores.localStore,
        type: 'del',
        key: doc._id
      }]);
      const ret = {ok: true, id: doc._id, rev: '0-0'};
      if (opts.ctx) {
        // don't execute immediately
        return callback(null, ret);
      }
      txn.execute(db, function (err) {
        /* istanbul ignore if */
        if (err) {
          return callback(err);
        }
        callback(null, ret);
      });
    });
  };

  // close and delete open leveldb stores
  api._destroy = function (opts, callback) {
    let dbStore;
    const leveldownName = functionName(leveldown);
    /* istanbul ignore else */
    if (dbStores.has(leveldownName)) {
      dbStore = dbStores.get(leveldownName);
    } else {
      return callDestroy(name, callback);
    }

    /* istanbul ignore else */
    if (dbStore.has(name)) {
      levelChanges.removeAllListeners(name);

      dbStore.get(name).close(function () {
        dbStore.delete(name);
        callDestroy(name, callback);
      });
    } else {
      callDestroy(name, callback);
    }
  };
  /**
   *
   * @param name
   * @param cb
   */
  function callDestroy (name, cb) {
    /* istanbul ignore else */
    if (typeof leveldown.destroy === 'function') {
      leveldown.destroy(name, cb);
    } else {
      queueMicrotask(cb);
    }
  }
}

LevelPouch.valid = function () {
  // this gets overriden by the *down-based browser adapters
  return true;
};

LevelPouch.use_prefix = false;

const adapters = {
  leveldb: LevelPouch
};

PouchDB.ajax = ajax;
PouchDB.utils = utils;
PouchDB.Errors = allErrors;
PouchDB.replicate = replication.replicate;
PouchDB.sync = sync;
PouchDB.version = '5.3.2'; // will be automatically supplied by build.sh
PouchDB.adapter('http', HttpPouch);
PouchDB.adapter('https', HttpPouch);

PouchDB.plugin(mapreduce);

Object.keys(adapters).forEach(function (adapterName) {
  PouchDB.adapter(adapterName, adapters[adapterName], true);
});

import WebSqlPouch from './pouchdb-websql.js';
PouchDB.adapter('websql', WebSqlPouch, true);
PouchDB.preferredAdapters = ['websql'];

export default PouchDB;


