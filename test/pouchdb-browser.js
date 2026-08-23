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
import Md5 from 'spark-md5';
import vuvuzela from 'vuvuzela';

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
  return object instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && object instanceof Blob);
}

/**
 *
 * @param buff
 */
function cloneArrayBuffer (buff) {
  if (typeof buff.slice === 'function') {
    return [...buff];
  }
  // IE10-11 slice() polyfill
  const target = new ArrayBuffer(buff.byteLength);
  const targetArray = new Uint8Array(target);
  const sourceArray = new Uint8Array(buff);
  targetArray.set(sourceArray);
  return target;
}

/**
 *
 * @param object
 */
function cloneBinaryObject (object) {
  if (object instanceof ArrayBuffer) {
    return cloneArrayBuffer(object);
  }
  const {size} = object;
  const {type} = object;
  // Blob
  if (typeof object.slice === 'function') {
    return object.slice(0, size, type);
  }
  // PhantomJS slice() replacement
  return object.webkitSlice(0, size, type);
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
    /* istanbul ignore next 4 */
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
    /* istanbul ignore next 18 */
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

/**
 *
 */
function isChromeApp () {
  return (typeof chrome !== 'undefined' &&
  typeof chrome.storage !== 'undefined' &&
  typeof chrome.storage.local !== 'undefined');
}

let hasLocal;

if (isChromeApp()) {
  hasLocal = false;
} else {
  try {
    localStorage.setItem('_pouch_check_localstorage', 1);
    hasLocal = Boolean(localStorage.getItem('_pouch_check_localstorage'));
  } catch (e) {
    hasLocal = false;
  }
}

/**
 *
 */
function hasLocalStorage () {
  return hasLocal;
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

// Abstracts constructing a Blob object, so it also works in older
// browsers that don't support the native Blob constructor (e.g.
// old QtWebKit versions, Android < 4.4).
/**
 *
 * @param parts
 * @param properties
 */
function createBlob (parts, properties) {
  /* global BlobBuilder,MSBlobBuilder,MozBlobBuilder,WebKitBlobBuilder */
  parts ||= [];
  properties ||= {};
  try {
    return new Blob(parts, properties);
  } catch (e) {
    if (e.name !== 'TypeError') {
      throw e;
    }
    const Builder = typeof BlobBuilder !== 'undefined'
      ? BlobBuilder
      : typeof MSBlobBuilder !== 'undefined'
        ? MSBlobBuilder
        : typeof MozBlobBuilder !== 'undefined'
          ? MozBlobBuilder
          : WebKitBlobBuilder;
    const builder = new Builder();
    for (const part of parts) {
      builder.append(part);
    }
    return builder.getBlob(properties.type);
  }
}

// simplified API. universal browser support is assumed
/**
 *
 * @param blob
 * @param callback
 */
function readAsArrayBuffer (blob, callback) {
  if (typeof FileReader === 'undefined') {
    // fix for Firefox in a web worker:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=901097
    return callback(new FileReaderSync().readAsArrayBuffer(blob));
  }

  const reader = new FileReader();
  reader.onloadend = function (e) {
    const result = e.target.result || new ArrayBuffer(0);
    callback(result);
  };
  reader.readAsArrayBuffer(blob);
}

/**
 *
 */
function wrappedFetch () {
  const wrappedPromise = {};

  const promise = new PouchPromise(function (resolve, reject) {
    wrappedPromise.resolve = resolve;
    wrappedPromise.reject = reject;
  });

  const args = Array.from({length: arguments.length});

  for (let i = 0; i < args.length; i++) {
    args[i] = arguments[i];
  }

  wrappedPromise.promise = promise;

  PouchPromise.resolve().then(function () {
    return fetch.apply(null, args);
  }).then(function (response) {
    wrappedPromise.resolve(response);
  }).catch(function (error) {
    wrappedPromise.reject(error);
  });

  return wrappedPromise;
}

/**
 *
 * @param options
 * @param callback
 */
function fetchRequest (options, callback) {
  let wrappedPromise, timer, response;

  const headers = new Headers();

  const fetchOptions = {
    method: options.method,
    credentials: 'include',
    headers
  };

  if (options.json) {
    headers.set('Accept', 'application/json');
    headers.set('Content-Type', options.headers['Content-Type'] ||
      'application/json');
  }

  if (options.body && (options.body instanceof Blob)) {
    readAsArrayBuffer(options.body, function (arrayBuffer) {
      fetchOptions.body = arrayBuffer;
    });
  } else if (options.body &&
    options.processData &&
    typeof options.body !== 'string') {
    fetchOptions.body = JSON.stringify(options.body);
  } else if ('body' in options) {
    fetchOptions.body = options.body;
  } else {
    fetchOptions.body = null;
  }

  Object.keys(options.headers).forEach(function (key) {
    if (options.headers.hasOwnProperty(key)) {
      headers.set(key, options.headers[key]);
    }
  });

  wrappedPromise = wrappedFetch(options.url, fetchOptions);

  if (options.timeout > 0) {
    timer = setTimeout(function () {
      wrappedPromise.reject(new Error('Load timeout for resource: ' +
        options.url));
    }, options.timeout);
  }

  wrappedPromise.promise.then(function (fetchResponse) {
    response = {
      statusCode: fetchResponse.status
    };

    if (options.timeout > 0) {
      clearTimeout(timer);
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return options.binary ? fetchResponse.blob() : fetchResponse.text();
    }

    return fetchResponse.json();
  }).then(function (result) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      callback(null, response, result);
    } else {
      callback(result, response);
    }
  }).catch(function (error) {
    callback(error, response);
  });

  return {abort: wrappedPromise.reject};
}

/**
 *
 * @param options
 * @param callback
 */
function xhRequest (options, callback) {
  let xhr, timer;
  let timedout = false;

  const abortReq = function () {
    xhr.abort();
  };

  const timeoutReq = function () {
    timedout = true;
    xhr.abort();
  };

  xhr = options.xhr ? new options.xhr() : new XMLHttpRequest();

  try {
    xhr.open(options.method, options.url);
  } catch (exception) {
    /* error code hardcoded to throw INVALID_URL */
    callback(exception, {statusCode: 413});
  }

  xhr.withCredentials = ('withCredentials' in options)
    ? options.withCredentials
    : true;

  if (options.method === 'GET') {
    delete options.headers['Content-Type'];
  } else if (options.json) {
    options.headers.Accept = 'application/json';
    options.headers['Content-Type'] = options.headers['Content-Type'] ||
      'application/json';
    if (options.body &&
      options.processData &&
      typeof options.body !== 'string') {
      options.body = JSON.stringify(options.body);
    }
  }

  if (options.binary) {
    xhr.responseType = 'arraybuffer';
  }

  if (!('body' in options)) {
    options.body = null;
  }

  for (const key in options.headers) {
    if (options.headers.hasOwnProperty(key)) {
      xhr.setRequestHeader(key, options.headers[key]);
    }
  }

  if (options.timeout > 0) {
    timer = setTimeout(timeoutReq, options.timeout);
    xhr.addEventListener('progress', function () {
      clearTimeout(timer);
      if (xhr.readyState !== 4) {
        timer = setTimeout(timeoutReq, options.timeout);
      }
    });
    if (typeof xhr.upload !== 'undefined') { // does not exist in ie9
      xhr.upload.addEventListener('progress', xhr.onprogress);
    }
  }

  xhr.addEventListener('readystatechange', function () {
    if (xhr.readyState !== 4) {
      return;
    }

    const response = {
      statusCode: xhr.status
    };

    if (xhr.status >= 200 && xhr.status < 300) {
      let data;
      data = options.binary
        ? createBlob([xhr.response || ''], {
          type: xhr.getResponseHeader('Content-Type')
        })
        : xhr.responseText;
      callback(null, response, data);
    } else {
      let err = {};
      if (timedout) {
        err = new Error('ETIMEDOUT');
        response.statusCode = 400; // for consistency with node request
      } else {
        try {
          err = JSON.parse(xhr.response);
        } catch (e) {}
      }
      callback(err, response);
    }
  });

  if (options.body && (options.body instanceof Blob)) {
    readAsArrayBuffer(options.body, function (arrayBuffer) {
      xhr.send(arrayBuffer);
    });
  } else {
    xhr.send(options.body);
  }

  return {abort: abortReq};
}

/**
 *
 */
function testXhr () {
  try {
    new XMLHttpRequest();
    return true;
  } catch (err) {
    return false;
  }
}

const hasXhr = testXhr();

/**
 *
 * @param options
 * @param callback
 */
function ajax$1 (options, callback) {
  return hasXhr || options.xhr ? xhRequest(options, callback) : fetchRequest(options, callback);
}

// the blob already has a type; do nothing
const res = function () {};

/**
 *
 */
function defaultBody () {
  return '';
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
      res(obj, resp);
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

  return ajax$1(options, function (err, response, body) {
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
  // cache-buster, specifically designed to work around IE's aggressive caching
  // see https://www.dashbay.com/2011/05/internet-explorer-caches-ajax/
  // Also Safari caches POSTs, so we need to cache-bust those too.
  const ua = (navigator && navigator.userAgent)
    ? navigator.userAgent.toLowerCase()
    : '';

  const isSafari = ua.includes('safari') && !ua.includes('chrome');
  const isIE = ua.includes('msie');
  const isEdge = ua.includes('edge');

  // it appears the new version of safari also caches GETs,
  // see https://github.com/pouchdb/pouchdb/issues/5010
  const shouldCacheBust = (isSafari ||
  ((isIE || isEdge) && opts.method === 'GET'));

  const cache = 'cache' in opts ? opts.cache : true;

  const isBlobUrl = (opts.url).startsWith('blob:'); // don't append nonces for blob URLs

  if (!isBlobUrl && (shouldCacheBust || !cache)) {
    const hasArgs = opts.url.includes('?');
    opts.url += (hasArgs ? '&' : '?') + '_nonce=' + Date.now();
  }

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

const atob$1 = function (str) {
  return atob(str);
};

const btoa$1 = function (str) {
  return btoa(str);
};

// From https://stackoverflow.com/questions/14967647/ (continues on next line)
// encode-decode-image-with-base64-breaks-image (2013-04-21)
/**
 *
 * @param bin
 */
function binaryStringToArrayBuffer (bin) {
  const {length} = bin;
  const buf = new ArrayBuffer(length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < length; i++) {
    arr[i] = bin.charCodeAt(i);
  }
  return buf;
}

/**
 *
 * @param binString
 * @param type
 */
function binStringToBluffer (binString, type) {
  return createBlob([binaryStringToArrayBuffer(binString)], {type});
}

const extend$1 = jsExtend__default.extend;

const utils = {
  ajax,
  parseUri,
  uuid,
  Promise: PouchPromise,
  atob: atob$1,
  btoa: btoa$1,
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

// designed to give info to browser users, who are disturbed
// when they see http errors in the console
/**
 *
 * @param status
 * @param str
 */
function explainError (status, str) {
  if ('console' in globalThis && 'info' in console) {
    console.info('The above ' + status + ' is totally normal. ' + str);
  }
}

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
        explainError(
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

const setImmediateShim = globalThis.setImmediate || globalThis.setTimeout;
const MD5_CHUNK_SIZE = 32768;

/**
 *
 * @param raw
 */
function rawToBase64 (raw) {
  return btoa$1(raw);
}

/**
 *
 * @param buffer
 * @param data
 * @param start
 * @param end
 */
function appendBuffer (buffer, data, start, end) {
  if (start > 0 || end < data.byteLength) {
    // only create a subarray if we really need to
    data = new Uint8Array(data, start,
      Math.min(end, data.byteLength) - start);
  }
  buffer.append(data);
}

/**
 *
 * @param buffer
 * @param data
 * @param start
 * @param end
 */
function appendString (buffer, data, start, end) {
  if (start > 0 || end < data.length) {
    // only create a substring if we really need to
    data = data.substring(start, end);
  }
  buffer.appendBinary(data);
}

const md5 = toPromise(function (data, callback) {
  const inputIsString = typeof data === 'string';
  const len = inputIsString ? data.length : data.byteLength;
  const chunkSize = Math.min(MD5_CHUNK_SIZE, len);
  const chunks = Math.ceil(len / chunkSize);
  let currentChunk = 0;
  const buffer = inputIsString ? new Md5() : new Md5.ArrayBuffer();

  const append = inputIsString ? appendString : appendBuffer;

  /**
   *
   */
  function loadNextChunk () {
    const start = currentChunk * chunkSize;
    const end = start + chunkSize;
    currentChunk++;
    if (currentChunk < chunks) {
      append(buffer, data, start, end);
      setImmediateShim(loadNextChunk);
    } else {
      append(buffer, data, start, end);
      const raw = buffer.end(true);
      const base64 = rawToBase64(raw);
      callback(null, base64);
      buffer.destroy();
    }
  }
  loadNextChunk();
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
    return md5(queryData);
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
  return binStringToBluffer(atob$1(b64), type);
}

// Can't find original post, but this is close
// https://stackoverflow.com/questions/6965107/ (continues on next line)
// converting-between-strings-and-arraybuffers
/**
 *
 * @param buffer
 */
function arrayBufferToBinaryString (buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const length = bytes.byteLength;
  for (let i = 0; i < length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

// shim for browsers that don't support it
/**
 *
 * @param blob
 * @param callback
 */
function readAsBinaryString (blob, callback) {
  if (typeof FileReader === 'undefined') {
    // fix for Firefox in a web worker
    // https://bugzilla.mozilla.org/show_bug.cgi?id=901097
    return callback(arrayBufferToBinaryString(
      new FileReaderSync().readAsArrayBuffer(blob)
    ));
  }

  const reader = new FileReader();
  const hasBinaryString = typeof reader.readAsBinaryString === 'function';
  reader.onloadend = function (e) {
    const result = e.target.result || '';
    if (hasBinaryString) {
      return callback(result);
    }
    callback(arrayBufferToBinaryString(result));
  };
  if (hasBinaryString) {
    reader.readAsBinaryString(blob);
  } else {
    reader.readAsArrayBuffer(blob);
  }
}

/**
 *
 * @param blobOrBuffer
 */
function blobToBase64 (blobOrBuffer) {
  return new PouchPromise(function (resolve) {
    readAsBinaryString(blobOrBuffer, function (bin) {
      resolve(btoa$1(bin));
    });
  });
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
    const token = btoa$1(unescape(encodeURIComponent(str)));
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
      ajax(userOpts, opts, function (err, res) {
        if (err) {
          return reject(err);
        }
        resolve(res);
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
        explainError(404, 'PouchDB is just detecting if the remote exists.');
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
        api.info(function (err, res) {
          if (res && !res.compact_running) {
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
        return function (err, res) {
          // err is impossible because shim returns a list of errs in that case
          results[batchNum] = res.results;
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
      doBulkGet(function (err, res) {
        /* istanbul ignore else */
        if (err) {
          const status = Math.floor(err.status / 100);
          /* istanbul ignore else */
          if (status === 4 || status === 5) { // 40x or 50x
            supportsBulkGetMap[dbUrl] = false;
            explainError(
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
          callback(null, res);
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
      }, function (err, res) {
        /* c8 ignore next */
        if (err) {
          return callback(err);
        }
        res.host = genDBUrl(host, '');
        callback(null, res);
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

    ajaxPromise(opts, options).then(function (res) {
      return PouchPromise.resolve().then(function () {
        if (opts.attachments) {
          return fetchAllAttachments(res);
        }
      }).then(function () {
        callback(null, res);
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
          binary = atob$1(blob);
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
    }).then(function (res) {
      if (opts.include_docs && opts.attachments && opts.binary) {
        res.rows.forEach(readAttachmentsAsBlobOrBuffer);
      }
      callback(null, res);
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

    const fetched = function (err, res) {
      if (opts.aborted) {
        return;
      }
      let raw_results_length = 0;
      // If the result of the ajax call (res) contains changes (res.results)
      if (res && res.results) {
        raw_results_length = res.results.length;
        results.last_seq = res.last_seq;
        // For each change
        const req = {query: opts.query_params};
        res.results = res.results.filter(function (c) {
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
      if (res && res.last_seq) {
        lastFetchedSeq = res.last_seq;
      }

      const finished = (limit && leftToFetch <= 0) ||
        (res && raw_results_length < batchSize) ||
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
function md5$1 (string) {
  return Md5.hash(string);
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
      (temporary ? 'temp' : md5$1(viewSignature));

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

/**
 *
 * @param buffer
 */
function arrayBufferToBase64 (buffer) {
  return btoa$1(arrayBufferToBinaryString(buffer));
}

/**
 *
 * @param docInfos
 * @param blobType
 * @param callback
 */
function preprocessAttachments$1 (docInfos, blobType, callback) {
  if (!docInfos.length) {
    return callback();
  }

  let docv = 0;

  /**
   *
   * @param data
   */
  function parseBase64 (data) {
    try {
      return atob$1(data);
    } catch (e) {
      const err = createError(BAD_ARG,
        'Attachment is not a valid base64 string');
      return {error: err};
    }
  }

  /**
   *
   * @param att
   * @param callback
   */
  function preprocessAttachment (att, callback) {
    if (att.stub) {
      return callback();
    }
    if (typeof att.data === 'string') {
      // input is assumed to be a base64 string

      const asBinary = parseBase64(att.data);
      if (asBinary.error) {
        return callback(asBinary.error);
      }

      att.length = asBinary.length;
      if (blobType === 'blob') {
        att.data = binStringToBluffer(asBinary, att.content_type);
      } else if (blobType === 'base64') {
        att.data = btoa$1(asBinary);
      } else { // binary
        att.data = asBinary;
      }
      md5(asBinary).then(function (result) {
        att.digest = 'md5-' + result;
        callback();
      });
    } else { // input is a blob
      readAsArrayBuffer(att.data, function (buff) {
        if (blobType === 'binary') {
          att.data = arrayBufferToBinaryString(buff);
        } else if (blobType === 'base64') {
          att.data = arrayBufferToBase64(buff);
        }
        md5(buff).then(function (result) {
          att.digest = 'md5-' + result;
          att.length = buff.byteLength;
          callback();
        });
      });
    }
  }

  let overallErr;

  docInfos.forEach(function (docInfo) {
    const attachments = docInfo.data && docInfo.data._attachments
      ? Object.keys(docInfo.data._attachments)
      : [];
    let recv = 0;

    if (!attachments.length) {
      return done();
    }

    /**
     *
     * @param err
     */
    function processedAttachment (err) {
      overallErr = err;
      recv++;
      if (recv === attachments.length) {
        done();
      }
    }

    for (const key in docInfo.data._attachments) {
      if (docInfo.data._attachments.hasOwnProperty(key)) {
        preprocessAttachment(docInfo.data._attachments[key],
          processedAttachment);
      }
    }
  });

  /**
   *
   */
  function done () {
    docv++;
    if (docInfos.length === docv) {
      if (overallErr) {
        callback(overallErr);
      } else {
        callback();
      }
    }
  }
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

// IndexedDB requires a versioned database structure, so we use the
// version here to manage migrations.
const ADAPTER_VERSION = 5;

// The object stores created for each database
// DOC_STORE stores the document meta data, its revision history and state
// Keyed by document id
const DOC_STORE = 'document-store';
// BY_SEQ_STORE stores a particular version of a document, keyed by its
// sequence id
const BY_SEQ_STORE = 'by-sequence';
// Where we store attachments
const ATTACH_STORE = 'attach-store';
// Where we store many-to-many relations
// between attachment digests and seqs
const ATTACH_AND_SEQ_STORE = 'attach-seq-store';

// Where we store database-wide meta data in a single record
// keyed by id: META_STORE
const META_STORE = 'meta-store';
// Where we store local documents
const LOCAL_STORE = 'local-store';
// Where we detect blob support
const DETECT_BLOB_SUPPORT_STORE = 'detect-blob-support';

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

/**
 *
 * @param fun
 * @param that
 * @param args
 * @param PouchDB
 */
function tryCode$1 (fun, that, args, PouchDB) {
  try {
    fun.apply(that, args);
  } catch (err) {
    // Shouldn't happen, but in some odd cases
    // IndexedDB implementations might throw a sync
    // error, in which case this will at least log it.
    PouchDB.emit('error', err);
  }
}

const taskQueue = {
  running: false,
  queue: []
};

/**
 *
 * @param PouchDB
 */
function applyNext (PouchDB) {
  if (taskQueue.running || !taskQueue.queue.length) {
    return;
  }
  taskQueue.running = true;
  const item = taskQueue.queue.shift();
  item.action(function (err, res) {
    tryCode$1(item.callback, this, [err, res], PouchDB);
    taskQueue.running = false;
    queueMicrotask(function () {
      applyNext(PouchDB);
    });
  });
}

/**
 *
 * @param callback
 */
function idbError (callback) {
  return function (evt) {
    let message = 'unknown_error';
    if (evt.target && evt.target.error) {
      message = evt.target.error.name || evt.target.error.message;
    }
    callback(createError(IDB_ERROR, message, evt.type));
  };
}

// Unfortunately, the metadata has to be stringified
// when it is put into the database, because otherwise
// IndexedDB can throw errors for deeply-nested objects.
// Originally we just used JSON.parse/JSON.stringify; now
// we use this custom vuvuzela library that avoids recursion.
// If we could do it all over again, we'd probably use a
// format for the revision trees other than JSON.
/**
 *
 * @param metadata
 * @param winningRev
 * @param deleted
 */
function encodeMetadata (metadata, winningRev, deleted) {
  return {
    data: safeJsonStringify(metadata),
    winningRev,
    deletedOrLocal: deleted ? '1' : '0',
    seq: metadata.seq, // highest seq for this doc
    id: metadata.id
  };
}

/**
 *
 * @param storedObject
 */
function decodeMetadata (storedObject) {
  if (!storedObject) {
    return null;
  }
  const metadata = safeJsonParse(storedObject.data);
  metadata.winningRev = storedObject.winningRev;
  metadata.deleted = storedObject.deletedOrLocal === '1';
  metadata.seq = storedObject.seq;
  return metadata;
}

// read the doc back out from the database. we don't store the
// _id or _rev because we already have _doc_id_rev.
/**
 *
 * @param doc
 */
function decodeDoc (doc) {
  if (!doc) {
    return doc;
  }
  const idx = doc._doc_id_rev.lastIndexOf(':');
  doc._id = doc._doc_id_rev.slice(0, Math.max(0, idx - 1));
  doc._rev = doc._doc_id_rev.slice(Math.max(0, idx + 1));
  delete doc._doc_id_rev;
  return doc;
}

// Read a blob from the database, encoding as necessary
// and translating from base64 if the IDB doesn't support
// native Blobs
/**
 *
 * @param body
 * @param type
 * @param asBlob
 * @param callback
 */
function readBlobData (body, type, asBlob, callback) {
  if (asBlob) {
    if (!body) {
      callback(createBlob([''], {type}));
    } else if (typeof body !== 'string') { // we have blob support
      callback(body);
    } else { // no blob support
      callback(b64ToBluffer(body, type));
    }
  } else { // as base64 string
    if (!body) {
      callback('');
    } else if (typeof body !== 'string') { // we have blob support
      readAsBinaryString(body, function (binary) {
        callback(btoa$1(binary));
      });
    } else { // no blob support
      callback(body);
    }
  }
}

/**
 *
 * @param doc
 * @param opts
 * @param txn
 * @param cb
 */
function fetchAttachmentsIfNecessary (doc, opts, txn, cb) {
  const attachments = Object.keys(doc._attachments || {});
  if (!attachments.length) {
    return cb && cb();
  }
  let numDone = 0;

  /**
   *
   */
  function checkDone () {
    if (++numDone === attachments.length && cb) {
      cb();
    }
  }

  /**
   *
   * @param doc
   * @param att
   */
  function fetchAttachment (doc, att) {
    const attObj = doc._attachments[att];
    const {digest} = attObj;
    const req = txn.objectStore(ATTACH_STORE).get(digest);
    req.onsuccess = function (e) {
      attObj.body = e.target.result.body;
      checkDone();
    };
  }

  attachments.forEach(function (att) {
    if (opts.attachments && opts.include_docs) {
      fetchAttachment(doc, att);
    } else {
      doc._attachments[att].stub = true;
      checkDone();
    }
  });
}

// IDB-specific postprocessing necessary because
// we don't know whether we stored a true Blob or
// a base64-encoded string, and if it's a Blob it
// needs to be read outside of the transaction context
/**
 *
 * @param results
 * @param asBlob
 */
function postProcessAttachments (results, asBlob) {
  return PouchPromise.all(results.map(function (row) {
    if (!(row.doc && row.doc._attachments)) {
      return;
    }

    const attNames = Object.keys(row.doc._attachments);
    return PouchPromise.all(attNames.map(function (att) {
      const attObj = row.doc._attachments[att];
      if (!('body' in attObj)) { // already processed
        return;
      }
      const {body} = attObj;
      const type = attObj.content_type;
      return new PouchPromise(function (resolve) {
        readBlobData(body, type, asBlob, function (data) {
          row.doc._attachments[att] = jsExtend.extend(
            pick(attObj, ['digest', 'content_type']),
            {data}
          );
          resolve();
        });
      });
    }));
  }));
}

/**
 *
 * @param revs
 * @param docId
 * @param txn
 */
function compactRevs (revs, docId, txn) {
  const possiblyOrphanedDigests = [];
  const seqStore = txn.objectStore(BY_SEQ_STORE);
  const attStore = txn.objectStore(ATTACH_STORE);
  const attAndSeqStore = txn.objectStore(ATTACH_AND_SEQ_STORE);
  let count = revs.length;

  /**
   *
   */
  function checkDone () {
    count--;
    if (!count) { // done processing all revs
      deleteOrphanedAttachments();
    }
  }

  /**
   *
   */
  function deleteOrphanedAttachments () {
    if (!possiblyOrphanedDigests.length) {
      return;
    }
    possiblyOrphanedDigests.forEach(function (digest) {
      const countReq = attAndSeqStore.index('digestSeq').count(
        IDBKeyRange.bound(
          digest + '::', digest + '::\u{FFFF}', false, false
        )
      );
      countReq.onsuccess = function (e) {
        const count = e.target.result;
        if (!count) {
          // orphaned
          attStore.delete(digest);
        }
      };
    });
  }

  revs.forEach(function (rev) {
    const index = seqStore.index('_doc_id_rev');
    const key = docId + '::' + rev;
    index.getKey(key).onsuccess = function (e) {
      const seq = e.target.result;
      if (typeof seq !== 'number') {
        return checkDone();
      }
      seqStore.delete(seq);

      const cursor = attAndSeqStore.index('seq').
        openCursor(IDBKeyRange.only(seq));

      cursor.onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          const digest = cursor.value.digestSeq.split('::', 1)[0];
          possiblyOrphanedDigests.push(digest);
          attAndSeqStore.delete(cursor.primaryKey);
          cursor.continue();
        } else { // done
          checkDone();
        }
      };
    };
  });
}

/**
 *
 * @param idb
 * @param stores
 * @param mode
 */
function openTransactionSafely (idb, stores, mode) {
  try {
    return {
      txn: idb.transaction(stores, mode)
    };
  } catch (err) {
    return {
      error: err
    };
  }
}

/**
 *
 * @param dbOpts
 * @param req
 * @param opts
 * @param api
 * @param idb
 * @param idbChanges
 * @param callback
 */
function idbBulkDocs (dbOpts, req, opts, api, idb, idbChanges, callback) {
  const docInfos = req.docs;
  let txn;
  let docStore;
  let bySeqStore;
  let attachStore;
  let attachAndSeqStore;
  let docInfoError;
  let docCountDelta = 0;

  for (let i = 0, len = docInfos.length; i < len; i++) {
    let doc = docInfos[i];
    if (doc._id && isLocalId(doc._id)) {
      continue;
    }
    doc = docInfos[i] = parseDoc(doc, opts.new_edits);
    if (doc.error && !docInfoError) {
      docInfoError = doc;
    }
  }

  if (docInfoError) {
    return callback(docInfoError);
  }

  const results = Array.from({length: docInfos.length});
  const fetchedDocs = new pouchdbCollections.Map();
  let preconditionErrored = false;
  const blobType = api._meta.blobSupport ? 'blob' : 'base64';

  preprocessAttachments$1(docInfos, blobType, function (err) {
    if (err) {
      return callback(err);
    }
    startTransaction();
  });

  /**
   *
   */
  function startTransaction () {
    const stores = [
      DOC_STORE, BY_SEQ_STORE,
      ATTACH_STORE,
      LOCAL_STORE, ATTACH_AND_SEQ_STORE
    ];
    const txnResult = openTransactionSafely(idb, stores, 'readwrite');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    txn = txnResult.txn;
    txn.onabort = idbError(callback);
    txn.ontimeout = idbError(callback);
    txn.oncomplete = complete;
    docStore = txn.objectStore(DOC_STORE);
    bySeqStore = txn.objectStore(BY_SEQ_STORE);
    attachStore = txn.objectStore(ATTACH_STORE);
    attachAndSeqStore = txn.objectStore(ATTACH_AND_SEQ_STORE);

    verifyAttachments(function (err) {
      if (err) {
        preconditionErrored = true;
        return callback(err);
      }
      fetchExistingDocs();
    });
  }

  /**
   *
   */
  function idbProcessDocs () {
    processDocs(dbOpts.revs_limit, docInfos, api, fetchedDocs,
      txn, results, writeDoc, opts);
  }

  /**
   *
   */
  function fetchExistingDocs () {
    if (!docInfos.length) {
      return;
    }

    let numFetched = 0;

    /**
     *
     */
    function checkDone () {
      if (++numFetched === docInfos.length) {
        idbProcessDocs();
      }
    }

    /**
     *
     * @param event
     */
    function readMetadata (event) {
      const metadata = decodeMetadata(event.target.result);

      if (metadata) {
        fetchedDocs.set(metadata.id, metadata);
      }
      checkDone();
    }

    for (const docInfo of docInfos) {
      if (docInfo._id && isLocalId(docInfo._id)) {
        checkDone(); // skip local docs
        continue;
      }
      const req = docStore.get(docInfo.metadata.id);
      req.onsuccess = readMetadata;
    }
  }

  /**
   *
   */
  function complete () {
    if (preconditionErrored) {
      return;
    }

    idbChanges.notify(api._meta.name);
    api._meta.docCount += docCountDelta;
    callback(null, results);
  }

  /**
   *
   * @param digest
   * @param callback
   */
  function verifyAttachment (digest, callback) {
    const req = attachStore.get(digest);
    req.onsuccess = function (e) {
      if (!e.target.result) {
        const err = createError(MISSING_STUB,
          'unknown stub attachment with digest ' +
          digest);
        err.status = 412;
        callback(err);
      } else {
        callback();
      }
    };
  }

  /**
   *
   * @param finish
   */
  function verifyAttachments (finish) {
    const digests = [];
    docInfos.forEach(function (docInfo) {
      if (docInfo.data && docInfo.data._attachments) {
        Object.keys(docInfo.data._attachments).forEach(function (filename) {
          const att = docInfo.data._attachments[filename];
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

    /**
     *
     */
    function checkDone () {
      if (++numDone === digests.length) {
        finish(err);
      }
    }
    digests.forEach(function (digest) {
      verifyAttachment(digest, function (attErr) {
        if (attErr && !err) {
          err = attErr;
        }
        checkDone();
      });
    });
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
   * @param callback
   */
  function writeDoc (docInfo, winningRev, winningRevIsDeleted, newRevIsDeleted,
    isUpdate, delta, resultsIdx, callback) {
    docCountDelta += delta;

    docInfo.metadata.winningRev = winningRev;
    docInfo.metadata.deleted = winningRevIsDeleted;

    const doc = docInfo.data;
    doc._id = docInfo.metadata.id;
    doc._rev = docInfo.metadata.rev;

    if (newRevIsDeleted) {
      doc._deleted = true;
    }

    const hasAttachments = doc._attachments &&
      Object.keys(doc._attachments).length;
    if (hasAttachments) {
      return writeAttachments(docInfo, winningRev, winningRevIsDeleted,
        isUpdate, resultsIdx, callback);
    }

    finishDoc(docInfo, winningRev, winningRevIsDeleted,
      isUpdate, resultsIdx, callback);
  }

  /**
   *
   * @param docInfo
   */
  function autoCompact (docInfo) {
    const revsToDelete = compactTree(docInfo.metadata);
    compactRevs(revsToDelete, docInfo.metadata.id, txn);
  }

  /**
   *
   * @param docInfo
   * @param winningRev
   * @param winningRevIsDeleted
   * @param isUpdate
   * @param resultsIdx
   * @param callback
   */
  function finishDoc (docInfo, winningRev, winningRevIsDeleted,
    isUpdate, resultsIdx, callback) {
    const doc = docInfo.data;
    const {metadata} = docInfo;

    doc._doc_id_rev = metadata.id + '::' + metadata.rev;
    delete doc._id;
    delete doc._rev;

    /**
     *
     * @param e
     */
    function afterPutDoc (e) {
      if (isUpdate && api.auto_compaction) {
        autoCompact(docInfo);
      } else if (docInfo.stemmedRevs.length) {
        compactRevs(docInfo.stemmedRevs, docInfo.metadata.id, txn);
      }

      metadata.seq = e.target.result;
      // Current _rev is calculated from _rev_tree on read
      delete metadata.rev;
      const metadataToStore = encodeMetadata(metadata, winningRev,
        winningRevIsDeleted);
      const metaDataReq = docStore.put(metadataToStore);
      metaDataReq.onsuccess = afterPutMetadata;
    }

    /**
     *
     * @param e
     */
    function afterPutDocError (e) {
      // ConstraintError, need to update, not put (see #1638 for details)
      e.preventDefault(); // avoid transaction abort
      e.stopPropagation(); // avoid transaction onerror
      const index = bySeqStore.index('_doc_id_rev');
      const getKeyReq = index.getKey(doc._doc_id_rev);
      getKeyReq.onsuccess = function (e) {
        const putReq = bySeqStore.put(doc, e.target.result);
        putReq.onsuccess = afterPutDoc;
      };
    }

    /**
     *
     */
    function afterPutMetadata () {
      results[resultsIdx] = {
        ok: true,
        id: metadata.id,
        rev: winningRev
      };
      fetchedDocs.set(docInfo.metadata.id, docInfo.metadata);
      insertAttachmentMappings(docInfo, metadata.seq, callback);
    }

    const putReq = bySeqStore.put(doc);

    putReq.onsuccess = afterPutDoc;
    putReq.onerror = afterPutDocError;
  }

  /**
   *
   * @param docInfo
   * @param winningRev
   * @param winningRevIsDeleted
   * @param isUpdate
   * @param resultsIdx
   * @param callback
   */
  function writeAttachments (docInfo, winningRev, winningRevIsDeleted,
    isUpdate, resultsIdx, callback) {
    const doc = docInfo.data;

    let numDone = 0;
    const attachments = Object.keys(doc._attachments);

    /**
     *
     */
    function collectResults () {
      if (numDone === attachments.length) {
        finishDoc(docInfo, winningRev, winningRevIsDeleted,
          isUpdate, resultsIdx, callback);
      }
    }

    /**
     *
     */
    function attachmentSaved () {
      numDone++;
      collectResults();
    }

    attachments.forEach(function (key) {
      const att = docInfo.data._attachments[key];
      if (!att.stub) {
        const {data} = att;
        delete att.data;
        att.revpos = parseInt(winningRev, 10);
        const {digest} = att;
        saveAttachment(digest, data, attachmentSaved);
      } else {
        numDone++;
        collectResults();
      }
    });
  }

  // map seqs to attachment digests, which
  // we will need later during compaction
  /**
   *
   * @param docInfo
   * @param seq
   * @param callback
   */
  function insertAttachmentMappings (docInfo, seq, callback) {
    let attsAdded = 0;
    const attsToAdd = Object.keys(docInfo.data._attachments || {});

    if (!attsToAdd.length) {
      return callback();
    }

    /**
     *
     */
    function checkDone () {
      if (++attsAdded === attsToAdd.length) {
        callback();
      }
    }

    /**
     *
     * @param att
     */
    function add (att) {
      const {digest} = docInfo.data._attachments[att];
      const req = attachAndSeqStore.put({
        seq,
        digestSeq: digest + '::' + seq
      });

      req.onsuccess = checkDone;
      req.onerror = function (e) {
        // this callback is for a constaint error, which we ignore
        // because this docid/rev has already been associated with
        // the digest (e.g. when new_edits == false)
        e.preventDefault(); // avoid transaction abort
        e.stopPropagation(); // avoid transaction onerror
        checkDone();
      };
    }
    for (const element of attsToAdd) {
      add(element); // do in parallel
    }
  }

  /**
   *
   * @param digest
   * @param data
   * @param callback
   */
  function saveAttachment (digest, data, callback) {
    const getKeyReq = attachStore.count(digest);
    getKeyReq.onsuccess = function (e) {
      const count = e.target.result;
      if (count) {
        return callback(); // already exists
      }
      const newAtt = {
        digest,
        body: data
      };
      const putReq = attachStore.put(newAtt);
      putReq.onsuccess = callback;
    };
  }
}

/**
 *
 * @param start
 * @param end
 * @param inclusiveEnd
 * @param key
 * @param descending
 */
function createKeyRange (start, end, inclusiveEnd, key, descending) {
  try {
    if (start && end) {
      return descending ? IDBKeyRange.bound(end, start, !inclusiveEnd, false) : IDBKeyRange.bound(start, end, false, !inclusiveEnd);
    }
    if (start) {
      if (descending) {
        return IDBKeyRange.upperBound(start);
      }
      return IDBKeyRange.lowerBound(start);
    }
    if (end) {
      if (descending) {
        return IDBKeyRange.lowerBound(end, !inclusiveEnd);
      }
      return IDBKeyRange.upperBound(end, !inclusiveEnd);
    }
    if (key) {
      return IDBKeyRange.only(key);
    }
  } catch (e) {
    return {error: e};
  }
  return null;
}

/**
 *
 * @param api
 * @param opts
 * @param err
 * @param callback
 */
function handleKeyRangeError (api, opts, err, callback) {
  if (err.name === 'DataError' && err.code === 0) {
    // data error, start is less than end
    return callback(null, {
      total_rows: api._meta.docCount,
      offset: opts.skip,
      rows: []
    });
  }
  callback(createError(IDB_ERROR, err.name, err.message));
}

/**
 *
 * @param opts
 * @param api
 * @param idb
 * @param callback
 */
function idbAllDocs (opts, api, idb, callback) {
  /**
   *
   * @param opts
   * @param callback
   */
  function allDocsQuery (opts, callback) {
    const start = 'startkey' in opts ? opts.startkey : false;
    const end = 'endkey' in opts ? opts.endkey : false;
    const key = 'key' in opts ? opts.key : false;
    let skip = opts.skip || 0;
    let limit = typeof opts.limit === 'number' ? opts.limit : -1;
    const inclusiveEnd = opts.inclusive_end !== false;
    const descending = 'descending' in opts && opts.descending ? 'prev' : null;

    const keyRange = createKeyRange(start, end, inclusiveEnd, key, descending);
    if (keyRange && keyRange.error) {
      return handleKeyRangeError(api, opts, keyRange.error, callback);
    }

    const stores = [DOC_STORE, BY_SEQ_STORE];

    if (opts.attachments) {
      stores.push(ATTACH_STORE);
    }
    const txnResult = openTransactionSafely(idb, stores, 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    const {txn} = txnResult;
    const docStore = txn.objectStore(DOC_STORE);
    const seqStore = txn.objectStore(BY_SEQ_STORE);
    const cursor = descending
      ? docStore.openCursor(keyRange, descending)
      : docStore.openCursor(keyRange);
    const docIdRevIndex = seqStore.index('_doc_id_rev');
    const results = [];
    let docCount = 0;

    // if the user specifies include_docs=true, then we don't
    // want to block the main cursor while we're fetching the doc
    /**
     *
     * @param metadata
     * @param row
     * @param winningRev
     */
    function fetchDocAsynchronously (metadata, row, winningRev) {
      const key = metadata.id + '::' + winningRev;
      docIdRevIndex.get(key).onsuccess = function onGetDoc (e) {
        row.doc = decodeDoc(e.target.result);
        if (opts.conflicts) {
          row.doc._conflicts = collectConflicts(metadata);
        }
        fetchAttachmentsIfNecessary(row.doc, opts, txn);
      };
    }

    /**
     *
     * @param cursor
     * @param winningRev
     * @param metadata
     */
    function allDocsInner (cursor, winningRev, metadata) {
      const row = {
        id: metadata.id,
        key: metadata.id,
        value: {
          rev: winningRev
        }
      };
      const {deleted} = metadata;
      if (opts.deleted === 'ok') {
        results.push(row);
        // deleted docs are okay with "keys" requests
        if (deleted) {
          row.value.deleted = true;
          row.doc = null;
        } else if (opts.include_docs) {
          fetchDocAsynchronously(metadata, row, winningRev);
        }
      } else if (!deleted && skip-- <= 0) {
        results.push(row);
        if (opts.include_docs) {
          fetchDocAsynchronously(metadata, row, winningRev);
        }
        if (--limit === 0) {
          return;
        }
      }
      cursor.continue();
    }

    /**
     *
     * @param e
     */
    function onGetCursor (e) {
      docCount = api._meta.docCount; // do this within the txn for consistency
      const cursor = e.target.result;
      if (!cursor) {
        return;
      }
      const metadata = decodeMetadata(cursor.value);
      const {winningRev} = metadata;

      allDocsInner(cursor, winningRev, metadata);
    }

    /**
     *
     */
    function onResultsReady () {
      callback(null, {
        total_rows: docCount,
        offset: opts.skip,
        rows: results
      });
    }

    /**
     *
     */
    function onTxnComplete () {
      if (opts.attachments) {
        postProcessAttachments(results, opts.binary).then(onResultsReady);
      } else {
        onResultsReady();
      }
    }

    txn.oncomplete = onTxnComplete;
    cursor.onsuccess = onGetCursor;
  }

  /**
   *
   * @param opts
   * @param callback
   */
  function allDocs (opts, callback) {
    if (opts.limit === 0) {
      return callback(null, {
        total_rows: api._meta.docCount,
        offset: opts.skip,
        rows: []
      });
    }
    allDocsQuery(opts, callback);
  }

  allDocs(opts, callback);
}

//
// Blobs are not supported in all versions of IndexedDB, notably
// Chrome <37 and Android <5. In those versions, storing a blob will throw.
//
// Various other blob bugs exist in Chrome v37-42 (inclusive).
// Detecting them is expensive and confusing to users, and Chrome 37-42
// is at very low usage worldwide, so we do a hacky userAgent check instead.
//
// content-type bug: https://code.google.com/p/chromium/issues/detail?id=408120
// 404 bug: https://code.google.com/p/chromium/issues/detail?id=447916
// FileReader bug: https://code.google.com/p/chromium/issues/detail?id=447836
//
/**
 *
 * @param txn
 */
function checkBlobSupport (txn) {
  return new PouchPromise(function (resolve) {
    const blob = createBlob(['']);
    txn.objectStore(DETECT_BLOB_SUPPORT_STORE).put(blob, 'key');

    txn.addEventListener('abort', function (e) {
      // If the transaction aborts now its due to not being able to
      // write to the database, likely due to the disk being full
      e.preventDefault();
      e.stopPropagation();
      resolve(false);
    });

    txn.oncomplete = function () {
      const matchedChrome = navigator.userAgent.match(/Chrome\/(\d+)/);
      const matchedEdge = navigator.userAgent.match(/Edge\//);
      // MS Edge pretends to be Chrome 42:
      // https://msdn.microsoft.com/en-us/library/hh869301%28v=vs.85%29.aspx
      resolve(matchedEdge || !matchedChrome ||
        parseInt(matchedChrome[1], 10) >= 43);
    };
  }).catch(function () {
    return false; // error, so assume unsupported
  });
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

const cachedDBs = new pouchdbCollections.Map();
let blobSupportPromise;
const idbChanges = new Changes$1();
const openReqList = new pouchdbCollections.Map();

/**
 *
 * @param opts
 * @param callback
 */
function IdbPouch (opts, callback) {
  const api = this;

  taskQueue.queue.push({
    action (thisCallback) {
      init(api, opts, thisCallback);
    },
    callback
  });
  applyNext(api.constructor);
}

/**
 *
 * @param api
 * @param opts
 * @param callback
 */
function init (api, opts, callback) {
  const dbName = opts.name;

  let idb = null;
  api._meta = null;

  // called when creating a fresh new database
  /**
   *
   * @param db
   */
  function createSchema (db) {
    const docStore = db.createObjectStore(DOC_STORE, {keyPath: 'id'});
    db.createObjectStore(BY_SEQ_STORE, {autoIncrement: true}).
      createIndex('_doc_id_rev', '_doc_id_rev', {unique: true});
    db.createObjectStore(ATTACH_STORE, {keyPath: 'digest'});
    db.createObjectStore(META_STORE, {keyPath: 'id', autoIncrement: false});
    db.createObjectStore(DETECT_BLOB_SUPPORT_STORE);

    // added in v2
    docStore.createIndex('deletedOrLocal', 'deletedOrLocal', {unique: false});

    // added in v3
    db.createObjectStore(LOCAL_STORE, {keyPath: '_id'});

    // added in v4
    const attAndSeqStore = db.createObjectStore(ATTACH_AND_SEQ_STORE,
      {autoIncrement: true});
    attAndSeqStore.createIndex('seq', 'seq');
    attAndSeqStore.createIndex('digestSeq', 'digestSeq', {unique: true});
  }

  // migration to version 2
  // unfortunately "deletedOrLocal" is a misnomer now that we no longer
  // store local docs in the main doc-store, but whaddyagonnado
  /**
   *
   * @param txn
   * @param callback
   */
  function addDeletedOrLocalIndex (txn, callback) {
    const docStore = txn.objectStore(DOC_STORE);
    docStore.createIndex('deletedOrLocal', 'deletedOrLocal', {unique: false});

    docStore.openCursor().onsuccess = function (event) {
      const cursor = event.target.result;
      if (cursor) {
        const metadata = cursor.value;
        const deleted = isDeleted(metadata);
        metadata.deletedOrLocal = deleted ? '1' : '0';
        docStore.put(metadata);
        cursor.continue();
      } else {
        callback();
      }
    };
  }

  // migration to version 3 (part 1)
  /**
   *
   * @param db
   */
  function createLocalStoreSchema (db) {
    db.createObjectStore(LOCAL_STORE, {keyPath: '_id'}).
      createIndex('_doc_id_rev', '_doc_id_rev', {unique: true});
  }

  // migration to version 3 (part 2)
  /**
   *
   * @param txn
   * @param cb
   */
  function migrateLocalStore (txn, cb) {
    const localStore = txn.objectStore(LOCAL_STORE);
    const docStore = txn.objectStore(DOC_STORE);
    const seqStore = txn.objectStore(BY_SEQ_STORE);

    const cursor = docStore.openCursor();
    cursor.onsuccess = function (event) {
      const cursor = event.target.result;
      if (cursor) {
        const metadata = cursor.value;
        const docId = metadata.id;
        const local = isLocalId(docId);
        const rev = winningRev(metadata);
        if (local) {
          const docIdRev = docId + '::' + rev;
          // remove all seq entries
          // associated with this docId
          const start = docId + '::';
          const end = docId + '::~';
          const index = seqStore.index('_doc_id_rev');
          const range = IDBKeyRange.bound(start, end, false, false);
          let seqCursor = index.openCursor(range);
          seqCursor.onsuccess = function (e) {
            seqCursor = e.target.result;
            if (!seqCursor) {
              // done
              docStore.delete(cursor.primaryKey);
              cursor.continue();
            } else {
              const data = seqCursor.value;
              if (data._doc_id_rev === docIdRev) {
                localStore.put(data);
              }
              seqStore.delete(seqCursor.primaryKey);
              seqCursor.continue();
            }
          };
        } else {
          cursor.continue();
        }
      } else if (cb) {
        cb();
      }
    };
  }

  // migration to version 4 (part 1)
  /**
   *
   * @param db
   */
  function addAttachAndSeqStore (db) {
    const attAndSeqStore = db.createObjectStore(ATTACH_AND_SEQ_STORE,
      {autoIncrement: true});
    attAndSeqStore.createIndex('seq', 'seq');
    attAndSeqStore.createIndex('digestSeq', 'digestSeq', {unique: true});
  }

  // migration to version 4 (part 2)
  /**
   *
   * @param txn
   * @param callback
   */
  function migrateAttsAndSeqs (txn, callback) {
    const seqStore = txn.objectStore(BY_SEQ_STORE);
    const attStore = txn.objectStore(ATTACH_STORE);
    const attAndSeqStore = txn.objectStore(ATTACH_AND_SEQ_STORE);

    // need to actually populate the table. this is the expensive part,
    // so as an optimization, check first that this database even
    // contains attachments
    const req = attStore.count();
    req.onsuccess = function (e) {
      const count = e.target.result;
      if (!count) {
        return callback(); // done
      }

      seqStore.openCursor().onsuccess = function (e) {
        const cursor = e.target.result;
        if (!cursor) {
          return callback(); // done
        }
        const doc = cursor.value;
        const seq = cursor.primaryKey;
        const atts = Object.keys(doc._attachments || {});
        const digestMap = {};
        for (var j = 0; j < atts.length; j++) {
          const att = doc._attachments[atts[j]];
          digestMap[att.digest] = true; // uniq digests, just in case
        }
        const digests = Object.keys(digestMap);
        for (j = 0; j < digests.length; j++) {
          const digest = digests[j];
          attAndSeqStore.put({
            seq,
            digestSeq: digest + '::' + seq
          });
        }
        cursor.continue();
      };
    };
  }

  // migration to version 5
  // Instead of relying on on-the-fly migration of metadata,
  // this brings the doc-store to its modern form:
  // - metadata.winningrev
  // - metadata.seq
  // - stringify the metadata when storing it
  /**
   *
   * @param txn
   */
  function migrateMetadata (txn) {
    /**
     *
     * @param storedObject
     */
    function decodeMetadataCompat (storedObject) {
      if (!storedObject.data) {
        // old format, when we didn't store it stringified
        storedObject.deleted = storedObject.deletedOrLocal === '1';
        return storedObject;
      }
      return decodeMetadata(storedObject);
    }

    // ensure that every metadata has a winningRev and seq,
    // which was previously created on-the-fly but better to migrate
    const bySeqStore = txn.objectStore(BY_SEQ_STORE);
    const docStore = txn.objectStore(DOC_STORE);
    const cursor = docStore.openCursor();
    cursor.onsuccess = function (e) {
      const cursor = e.target.result;
      if (!cursor) {
        return; // done
      }
      const metadata = decodeMetadataCompat(cursor.value);

      metadata.winningRev = metadata.winningRev ||
        winningRev(metadata);

      /**
       *
       */
      function fetchMetadataSeq () {
        // metadata.seq was added post-3.2.0, so if it's missing,
        // we need to fetch it manually
        const start = metadata.id + '::';
        const end = metadata.id + '::\u{FFFF}';
        const req = bySeqStore.index('_doc_id_rev').openCursor(
          IDBKeyRange.bound(start, end)
        );

        let metadataSeq = 0;
        req.onsuccess = function (e) {
          const cursor = e.target.result;
          if (!cursor) {
            metadata.seq = metadataSeq;
            return onGetMetadataSeq();
          }
          const seq = cursor.primaryKey;
          if (seq > metadataSeq) {
            metadataSeq = seq;
          }
          cursor.continue();
        };
      }

      /**
       *
       */
      function onGetMetadataSeq () {
        const metadataToStore = encodeMetadata(metadata,
          metadata.winningRev, metadata.deleted);

        const req = docStore.put(metadataToStore);
        req.onsuccess = function () {
          cursor.continue();
        };
      }

      if (metadata.seq) {
        return onGetMetadataSeq();
      }

      fetchMetadataSeq();
    };
  }

  api.type = function () {
    return 'idb';
  };

  api._id = toPromise(function (callback) {
    callback(null, api._meta.instanceId);
  });

  api._bulkDocs = function idb_bulkDocs (req, reqOpts, callback) {
    idbBulkDocs(opts, req, reqOpts, api, idb, idbChanges, callback);
  };

  // First we look up the metadata in the ids database, then we fetch the
  // current revision(s) from the by sequence store
  api._get = function idb_get (id, opts, callback) {
    let doc;
    let metadata;
    let err;
    let txn = opts.ctx;
    if (!txn) {
      const txnResult = openTransactionSafely(idb,
        [DOC_STORE, BY_SEQ_STORE, ATTACH_STORE], 'readonly');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      txn = txnResult.txn;
    }

    /**
     *
     */
    function finish () {
      callback(err, {doc, metadata, ctx: txn});
    }

    txn.objectStore(DOC_STORE).get(id).onsuccess = function (e) {
      metadata = decodeMetadata(e.target.result);
      // we can determine the result here if:
      // 1. there is no such document
      // 2. the document is deleted and we don't ask about specific rev
      // When we ask with opts.rev we expect the answer to be either
      // doc (possibly with _deleted=true) or missing error
      if (!metadata) {
        err = createError(MISSING_DOC, 'missing');
        return finish();
      }
      if (isDeleted(metadata) && !opts.rev) {
        err = createError(MISSING_DOC, 'deleted');
        return finish();
      }
      const objectStore = txn.objectStore(BY_SEQ_STORE);

      const rev = opts.rev || metadata.winningRev;
      const key = metadata.id + '::' + rev;

      objectStore.index('_doc_id_rev').get(key).onsuccess = function (e) {
        doc = e.target.result;
        if (doc) {
          doc = decodeDoc(doc);
        }
        if (!doc) {
          err = createError(MISSING_DOC, 'missing');
          return finish();
        }
        finish();
      };
    };
  };

  api._getAttachment = function (attachment, opts, callback) {
    let txn;
    if (opts.ctx) {
      txn = opts.ctx;
    } else {
      const txnResult = openTransactionSafely(idb,
        [DOC_STORE, BY_SEQ_STORE, ATTACH_STORE], 'readonly');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      txn = txnResult.txn;
    }
    const {digest} = attachment;
    const type = attachment.content_type;

    txn.objectStore(ATTACH_STORE).get(digest).onsuccess = function (e) {
      const {body} = e.target.result;
      readBlobData(body, type, opts.binary, function (blobData) {
        callback(null, blobData);
      });
    };
  };

  api._info = function idb_info (callback) {
    if (idb === null || !cachedDBs.has(dbName)) {
      const error = new Error('db isn\'t open');
      error.id = 'idbNull';
      return callback(error);
    }
    let updateSeq;
    let docCount;

    const txnResult = openTransactionSafely(idb, [BY_SEQ_STORE], 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    const {txn} = txnResult;
    const cursor = txn.objectStore(BY_SEQ_STORE).openCursor(null, 'prev');
    cursor.onsuccess = function (event) {
      const cursor = event.target.result;
      updateSeq = cursor ? cursor.key : 0;
      // count within the same txn for consistency
      docCount = api._meta.docCount;
    };

    txn.oncomplete = function () {
      callback(null, {
        doc_count: docCount,
        update_seq: updateSeq,
        // for debugging
        idb_attachment_format: (api._meta.blobSupport ? 'binary' : 'base64')
      });
    };
  };

  api._allDocs = function idb_allDocs (opts, callback) {
    idbAllDocs(opts, api, idb, callback);
  };

  api._changes = function (opts) {
    opts = clone(opts);

    if (opts.continuous) {
      const id = dbName + ':' + uuid();
      idbChanges.addListener(dbName, id, api, opts);
      idbChanges.notify(dbName);
      return {
        cancel () {
          idbChanges.removeListener(dbName, id);
        }
      };
    }

    const docIds = opts.doc_ids && new pouchdbCollections.Set(opts.doc_ids);

    opts.since = opts.since || 0;
    let lastSeq = opts.since;

    let limit = 'limit' in opts ? opts.limit : -1;
    if (limit === 0) {
      limit = 1; // per CouchDB _changes spec
    }
    let returnDocs;
    if ('return_docs' in opts) {
      returnDocs = opts.return_docs;
    } else if ('returnDocs' in opts) {
      // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }

    const results = [];
    let numResults = 0;
    const filter = filterChange(opts);
    const docIdsToMetadata = new pouchdbCollections.Map();

    let txn;
    let bySeqStore;
    let docStore;
    let docIdRevIndex;

    /**
     *
     * @param cursor
     */
    function onGetCursor (cursor) {
      const doc = decodeDoc(cursor.value);
      const seq = cursor.key;

      if (docIds && !docIds.has(doc._id)) {
        return cursor.continue();
      }

      let metadata;

      /**
       *
       */
      function onGetMetadata () {
        if (metadata.seq !== seq) {
          // some other seq is later
          return cursor.continue();
        }

        lastSeq = seq;

        if (metadata.winningRev === doc._rev) {
          return onGetWinningDoc(doc);
        }

        fetchWinningDoc();
      }

      /**
       *
       */
      function fetchWinningDoc () {
        const docIdRev = doc._id + '::' + metadata.winningRev;
        const req = docIdRevIndex.get(docIdRev);
        req.onsuccess = function (e) {
          onGetWinningDoc(decodeDoc(e.target.result));
        };
      }

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
          numResults++;
          if (returnDocs) {
            results.push(change);
          }
          // process the attachment immediately
          // for the benefit of live listeners
          if (opts.attachments && opts.include_docs) {
            fetchAttachmentsIfNecessary(winningDoc, opts, txn, function () {
              postProcessAttachments([change], opts.binary).then(function () {
                opts.onChange(change);
              });
            });
          } else {
            opts.onChange(change);
          }
        }
        if (numResults !== limit) {
          cursor.continue();
        }
      }

      metadata = docIdsToMetadata.get(doc._id);
      if (metadata) { // cached
        return onGetMetadata();
      }
      // metadata not cached, have to go fetch it
      docStore.get(doc._id).onsuccess = function (event) {
        metadata = decodeMetadata(event.target.result);
        docIdsToMetadata.set(doc._id, metadata);
        onGetMetadata();
      };
    }

    /**
     *
     * @param event
     */
    function onsuccess (event) {
      const cursor = event.target.result;

      if (!cursor) {
        return;
      }
      onGetCursor(cursor);
    }

    /**
     *
     */
    function fetchChanges () {
      const objectStores = [DOC_STORE, BY_SEQ_STORE];
      if (opts.attachments) {
        objectStores.push(ATTACH_STORE);
      }
      const txnResult = openTransactionSafely(idb, objectStores, 'readonly');
      if (txnResult.error) {
        return opts.complete(txnResult.error);
      }
      txn = txnResult.txn;
      txn.onabort = idbError(opts.complete);
      txn.oncomplete = onTxnComplete;

      bySeqStore = txn.objectStore(BY_SEQ_STORE);
      docStore = txn.objectStore(DOC_STORE);
      docIdRevIndex = bySeqStore.index('_doc_id_rev');

      let req;

      req = opts.descending ? bySeqStore.openCursor(null, 'prev') : bySeqStore.openCursor(IDBKeyRange.lowerBound(opts.since, true));

      req.onsuccess = onsuccess;
    }

    fetchChanges();

    /**
     *
     */
    function onTxnComplete () {
      /**
       *
       */
      function finish () {
        opts.complete(null, {
          results,
          last_seq: lastSeq
        });
      }

      if (!opts.continuous && opts.attachments) {
        // cannot guarantee that postProcessing was already done,
        // so do it again
        postProcessAttachments(results).then(finish);
      } else {
        finish();
      }
    }
  };

  api._close = function (callback) {
    if (idb === null) {
      return callback(createError(NOT_OPEN));
    }

    // https://developer.mozilla.org/en-US/docs/IndexedDB/IDBDatabase#close
    // "Returns immediately and closes the connection in a separate thread..."
    idb.close();
    cachedDBs.delete(dbName);
    idb = null;
    callback();
  };

  api._getRevisionTree = function (docId, callback) {
    const txnResult = openTransactionSafely(idb, [DOC_STORE], 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    const {txn} = txnResult;
    const req = txn.objectStore(DOC_STORE).get(docId);
    req.onsuccess = function (event) {
      const doc = decodeMetadata(event.target.result);
      if (!doc) {
        callback(createError(MISSING_DOC));
      } else {
        callback(null, doc.rev_tree);
      }
    };
  };

  // This function removes revisions of document docId
  // which are listed in revs and sets this document
  // revision to to rev_tree
  api._doCompaction = function (docId, revs, callback) {
    const stores = [
      DOC_STORE,
      BY_SEQ_STORE,
      ATTACH_STORE,
      ATTACH_AND_SEQ_STORE
    ];
    const txnResult = openTransactionSafely(idb, stores, 'readwrite');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    const {txn} = txnResult;

    const docStore = txn.objectStore(DOC_STORE);

    docStore.get(docId).onsuccess = function (event) {
      const metadata = decodeMetadata(event.target.result);
      traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
        revHash, ctx, opts) {
        const rev = pos + '-' + revHash;
        if (revs.includes(rev)) {
          opts.status = 'missing';
        }
      });
      compactRevs(revs, docId, txn);
      const {winningRev, deleted} = metadata;
      txn.objectStore(DOC_STORE).put(
        encodeMetadata(metadata, winningRev, deleted)
      );
    };
    txn.onabort = idbError(callback);
    txn.oncomplete = function () {
      callback();
    };
  };


  api._getLocal = function (id, callback) {
    const txnResult = openTransactionSafely(idb, [LOCAL_STORE], 'readonly');
    if (txnResult.error) {
      return callback(txnResult.error);
    }
    const tx = txnResult.txn;
    const req = tx.objectStore(LOCAL_STORE).get(id);

    req.onerror = idbError(callback);
    req.onsuccess = function (e) {
      const doc = e.target.result;
      if (!doc) {
        callback(createError(MISSING_DOC));
      } else {
        delete doc._doc_id_rev; // for backwards compat
        callback(null, doc);
      }
    };
  };

  api._putLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    delete doc._revisions; // ignore this, trust the rev
    const oldRev = doc._rev;
    const id = doc._id;
    doc._rev = !oldRev ? '0-1' : '0-' + (parseInt(oldRev.split('-', 2)[1], 10) + 1);

    let tx = opts.ctx;
    let ret;
    if (!tx) {
      const txnResult = openTransactionSafely(idb, [LOCAL_STORE], 'readwrite');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      tx = txnResult.txn;
      tx.onerror = idbError(callback);
      tx.oncomplete = function () {
        if (ret) {
          callback(null, ret);
        }
      };
    }

    const oStore = tx.objectStore(LOCAL_STORE);
    let req;
    if (oldRev) {
      req = oStore.get(id);
      req.onsuccess = function (e) {
        const oldDoc = e.target.result;
        if (!oldDoc || oldDoc._rev !== oldRev) {
          callback(createError(REV_CONFLICT));
        } else { // update
          const req = oStore.put(doc);
          req.onsuccess = function () {
            ret = {ok: true, id: doc._id, rev: doc._rev};
            if (opts.ctx) { // return immediately
              callback(null, ret);
            }
          };
        }
      };
    } else { // new doc
      req = oStore.add(doc);
      req.onerror = function (e) {
        // constraint error, already exists
        callback(createError(REV_CONFLICT));
        e.preventDefault(); // avoid transaction abort
        e.stopPropagation(); // avoid transaction onerror
      };
      req.onsuccess = function () {
        ret = {ok: true, id: doc._id, rev: doc._rev};
        if (opts.ctx) { // return immediately
          callback(null, ret);
        }
      };
    }
  };

  api._removeLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    let tx = opts.ctx;
    if (!tx) {
      const txnResult = openTransactionSafely(idb, [LOCAL_STORE], 'readwrite');
      if (txnResult.error) {
        return callback(txnResult.error);
      }
      tx = txnResult.txn;
      tx.oncomplete = function () {
        if (ret) {
          callback(null, ret);
        }
      };
    }
    var ret;
    const id = doc._id;
    const oStore = tx.objectStore(LOCAL_STORE);
    const req = oStore.get(id);

    req.onerror = idbError(callback);
    req.onsuccess = function (e) {
      const oldDoc = e.target.result;
      if (!oldDoc || oldDoc._rev !== doc._rev) {
        callback(createError(MISSING_DOC));
      } else {
        oStore.delete(id);
        ret = {ok: true, id, rev: '0-0'};
        if (opts.ctx) { // return immediately
          callback(null, ret);
        }
      }
    };
  };

  api._destroy = function (opts, callback) {
    idbChanges.removeAllListeners(dbName);

    // Close open request for "dbName" database to fix ie delay.
    const openReq = openReqList.get(dbName);
    if (openReq && openReq.result) {
      openReq.result.close();
      cachedDBs.delete(dbName);
    }
    const req = indexedDB.deleteDatabase(dbName);

    req.onsuccess = function () {
      // Remove open request from the list.
      openReqList.delete(dbName);
      if (hasLocalStorage() && (dbName in localStorage)) {
        delete localStorage[dbName];
      }
      callback(null, {ok: true});
    };

    req.onerror = idbError(callback);
  };

  const cached = cachedDBs.get(dbName);

  if (cached) {
    idb = cached.idb;
    api._meta = cached.global;
    queueMicrotask(function () {
      callback(null, api);
    });
    return;
  }

  let req;
  req = opts.storage ? tryStorageOption(dbName, opts.storage) : indexedDB.open(dbName, ADAPTER_VERSION);

  openReqList.set(dbName, req);

  req.onupgradeneeded = function (e) {
    const db = e.target.result;
    if (e.oldVersion < 1) {
      return createSchema(db); // new db, initial schema
    }
    // do migrations

    const txn = e.currentTarget.transaction;
    // these migrations have to be done in this function, before
    // control is returned to the event loop, because IndexedDB

    if (e.oldVersion < 3) {
      createLocalStoreSchema(db); // v2 -> v3
    }
    if (e.oldVersion < 4) {
      addAttachAndSeqStore(db); // v3 -> v4
    }

    const migrations = [
      addDeletedOrLocalIndex, // v1 -> v2
      migrateLocalStore, // v2 -> v3
      migrateAttsAndSeqs, // v3 -> v4
      migrateMetadata // v4 -> v5
    ];

    let i = e.oldVersion;

    /**
     *
     */
    function next () {
      const migration = migrations[i - 1];
      i++;
      if (migration) {
        migration(txn, next);
      }
    }

    next();
  };

  req.onsuccess = function (e) {
    idb = e.target.result;

    idb.onversionchange = function () {
      idb.close();
      cachedDBs.delete(dbName);
    };

    idb.addEventListener('abort', function (e) {
      console.error('Database has a global failure', e.target.error);
      idb.close();
      cachedDBs.delete(dbName);
    });

    const txn = idb.transaction([
      META_STORE,
      DETECT_BLOB_SUPPORT_STORE,
      DOC_STORE
    ], 'readwrite');

    const req = txn.objectStore(META_STORE).get(META_STORE);

    let blobSupport = null;
    let docCount = null;
    let instanceId = null;

    req.onsuccess = function (e) {
      const checkSetupComplete = function () {
        if (blobSupport === null || docCount === null ||
          instanceId === null) {

        } else {
          api._meta = {
            name: dbName,
            instanceId,
            blobSupport,
            docCount
          };

          cachedDBs.set(dbName, {
            idb,
            global: api._meta
          });
          callback(null, api);
        }
      };

      //
      // fetch/store the id
      //

      const meta = e.target.result || {id: META_STORE};
      if (dbName + '_id' in meta) {
        instanceId = meta[dbName + '_id'];
        checkSetupComplete();
      } else {
        instanceId = uuid();
        meta[dbName + '_id'] = instanceId;
        txn.objectStore(META_STORE).put(meta).onsuccess = function () {
          checkSetupComplete();
        };
      }

      //
      // check blob support
      //

      if (!blobSupportPromise) {
        // make sure blob support is only checked once
        blobSupportPromise = checkBlobSupport(txn);
      }

      blobSupportPromise.then(function (val) {
        blobSupport = val;
        checkSetupComplete();
      });

      //
      // count docs
      //

      const index = txn.objectStore(DOC_STORE).index('deletedOrLocal');
      index.count(IDBKeyRange.only('0')).onsuccess = function (e) {
        docCount = e.target.result;
        checkSetupComplete();
      };
    };
  };

  req.onerror = function () {
    const msg = 'Failed to open indexedDB, are you in private browsing mode?';
    console.error(msg);
    callback(createError(IDB_ERROR, msg));
  };
}

IdbPouch.valid = function () {
  // Issue #2533, we finally gave up on doing bug
  // detection instead of browser sniffing. Safari brought us
  // to our knees.
  const isSafari = typeof openDatabase !== 'undefined' &&
    (/(Safari|iPhone|iPad|iPod)/).test(navigator.userAgent) &&
    !(/Chrome/).test(navigator.userAgent) &&
    !(/BlackBerry/).test(navigator.platform);

  // some outdated implementations of IDB that appear on Samsung
  // and HTC Android devices <4.4 are missing IDBKeyRange
  return !isSafari && typeof indexedDB !== 'undefined' &&
    typeof IDBKeyRange !== 'undefined';
};

/**
 *
 * @param dbName
 * @param storage
 */
function tryStorageOption (dbName, storage) {
  try { // option only available in Firefox 26+
    return indexedDB.open(dbName, {
      version: ADAPTER_VERSION,
      storage
    });
  } catch (err) {
    return indexedDB.open(dbName, ADAPTER_VERSION);
  }
}

//
// Parsing hex strings. Yeah.
//
// So basically we need this because of a bug in WebSQL:
// https://code.google.com/p/chromium/issues/detail?id=422690
// https://bugs.webkit.org/show_bug.cgi?id=137637
//
// UTF-8 and UTF-16 are provided as separate functions
// for meager performance improvements
//

/**
 *
 * @param str
 */
function decodeUtf8 (str) {
  return decodeURIComponent(globalThis.escape(str));
}

/**
 *
 * @param charCode
 */
function hexToInt (charCode) {
  // '0'-'9' is 48-57
  // 'A'-'F' is 65-70
  // SQLite will only give us uppercase hex
  return charCode < 65 ? (charCode - 48) : (charCode - 55);
}


// Example:
// pragma encoding=utf8;
// select hex('A');
// returns '41'
/**
 *
 * @param str
 * @param start
 * @param end
 */
function parseHexUtf8 (str, start, end) {
  let result = '';
  while (start < end) {
    result += String.fromCharCode(
      (hexToInt(str.charCodeAt(start++)) << 4) |
      hexToInt(str.charCodeAt(start++))
    );
  }
  return result;
}

// Example:
// pragma encoding=utf16;
// select hex('A');
// returns '4100'
// notice that the 00 comes after the 41 (i.e. it's swizzled)
/**
 *
 * @param str
 * @param start
 * @param end
 */
function parseHexUtf16 (str, start, end) {
  let result = '';
  while (start < end) {
    // UTF-16, so swizzle the bytes
    result += String.fromCharCode(
      (hexToInt(str.charCodeAt(start + 2)) << 12) |
      (hexToInt(str.charCodeAt(start + 3)) << 8) |
      (hexToInt(str.charCodeAt(start)) << 4) |
      hexToInt(str.charCodeAt(start + 1))
    );
    start += 4;
  }
  return result;
}

/**
 *
 * @param str
 * @param encoding
 */
function parseHexString (str, encoding) {
  return encoding === 'UTF-8' ? decodeUtf8(parseHexUtf8(str, 0, str.length)) : parseHexUtf16(str, 0, str.length);
}

/**
 *
 * @param str
 */
function quote (str) {
  return "'" + str + "'";
}

const ADAPTER_VERSION$1 = 7; // used to manage migrations

// The object stores created for each database
// DOC_STORE stores the document meta data, its revision history and state
const DOC_STORE$1 = quote('document-store');
// BY_SEQ_STORE stores a particular version of a document, keyed by its
// sequence id
const BY_SEQ_STORE$1 = quote('by-sequence');
// Where we store attachments
const ATTACH_STORE$1 = quote('attach-store');
const LOCAL_STORE$1 = quote('local-store');
const META_STORE$1 = quote('metadata-store');
// where we store many-to-many relations between attachment
// digests and seqs
const ATTACH_AND_SEQ_STORE$1 = quote('attach-seq-store');

/**
 *
 */
function createOpenDBFunction () {
  if (typeof sqlitePlugin !== 'undefined') {
    // The SQLite Plugin started deviating pretty heavily from the
    // standard openDatabase() function, as they started adding more features.
    // It's better to just use their "new" format and pass in a big ol'
    // options object.
    return sqlitePlugin.openDatabase.bind(sqlitePlugin);
  }

  if (typeof openDatabase !== 'undefined') {
    return function openDB (opts) {
      // Traditional WebSQL API
      return openDatabase(opts.name, opts.version, opts.description, opts.size);
    };
  }
}

/**
 *
 */
function valid () {
  // SQLitePlugin leaks this global object, which we can use
  // to detect if it's installed or not. The benefit is that it's
  // declared immediately, before the 'deviceready' event has fired.
  return typeof openDatabase !== 'undefined' ||
    typeof SQLitePlugin !== 'undefined';
}

// escapeBlob and unescapeBlob are workarounds for a websql bug:
// https://code.google.com/p/chromium/issues/detail?id=422690
// https://bugs.webkit.org/show_bug.cgi?id=137637
// The goal is to never actually insert the \u0000 character
// in the database.
/**
 *
 * @param str
 */
function escapeBlob (str) {
  return str.
    replaceAll('\u{2}', '\u{2}\u{2}').
    replaceAll('\u{1}', '\u{1}\u{2}').
    replaceAll('\u{0}', '\u{1}\u{1}');
}

/**
 *
 * @param str
 */
function unescapeBlob (str) {
  return str.
    replaceAll('\u{1}\u{1}', '\u{0}').
    replaceAll('\u{1}\u{2}', '\u{1}').
    replaceAll('\u{2}\u{2}', '\u{2}');
}

/**
 *
 * @param doc
 */
function stringifyDoc (doc) {
  // don't bother storing the id/rev. it uses lots of space,
  // in persistent map/reduce especially
  delete doc._id;
  delete doc._rev;
  return JSON.stringify(doc);
}

/**
 *
 * @param doc
 * @param id
 * @param rev
 */
function unstringifyDoc (doc, id, rev) {
  doc = JSON.parse(doc);
  doc._id = id;
  doc._rev = rev;
  return doc;
}

// question mark groups IN queries, e.g. 3 -> '(?,?,?)'
/**
 *
 * @param num
 */
function qMarks (num) {
  let s = '(';
  while (num--) {
    s += '?';
    if (num) {
      s += ',';
    }
  }
  return s + ')';
}

/**
 *
 * @param selector
 * @param table
 * @param joiner
 * @param where
 * @param orderBy
 */
function select (selector, table, joiner, where, orderBy) {
  return 'SELECT ' + selector + ' FROM ' +
    (typeof table === 'string' ? table : table.join(' JOIN ')) +
    (joiner ? (' ON ' + joiner) : '') +
    (where
      ? (' WHERE ' +
    (typeof where === 'string' ? where : where.join(' AND ')))
      : '') +
    (orderBy ? (' ORDER BY ' + orderBy) : '');
}

/**
 *
 * @param revs
 * @param docId
 * @param tx
 */
function compactRevs$1 (revs, docId, tx) {
  if (!revs.length) {
    return;
  }

  let numDone = 0;
  const seqs = [];

  /**
   *
   */
  function checkDone () {
    if (++numDone === revs.length) { // done
      deleteOrphans();
    }
  }

  /**
   *
   */
  function deleteOrphans () {
    // find orphaned attachment digests

    if (!seqs.length) {
      return;
    }

    const sql = 'SELECT DISTINCT digest AS digest FROM ' +
      ATTACH_AND_SEQ_STORE$1 + ' WHERE seq IN ' + qMarks(seqs.length);

    tx.executeSql(sql, seqs, function (tx, res) {
      const digestsToCheck = [];
      for (let i = 0; i < res.rows.length; i++) {
        digestsToCheck.push(res.rows.item(i).digest);
      }
      if (!digestsToCheck.length) {
        return;
      }

      const sql = 'DELETE FROM ' + ATTACH_AND_SEQ_STORE$1 +
        ' WHERE seq IN (' +
        seqs.map(function () {
          return '?';
        }).join(',') +
        ')';
      tx.executeSql(sql, seqs, function (tx) {
        const sql = 'SELECT digest FROM ' + ATTACH_AND_SEQ_STORE$1 +
          ' WHERE digest IN (' +
          digestsToCheck.map(function () {
            return '?';
          }).join(',') +
          ')';
        tx.executeSql(sql, digestsToCheck, function (tx, res) {
          const nonOrphanedDigests = new pouchdbCollections.Set();
          for (let i = 0; i < res.rows.length; i++) {
            nonOrphanedDigests.add(res.rows.item(i).digest);
          }
          digestsToCheck.forEach(function (digest) {
            if (nonOrphanedDigests.has(digest)) {
              return;
            }
            tx.executeSql(
              'DELETE FROM ' + ATTACH_AND_SEQ_STORE$1 + ' WHERE digest=?',
              [digest]
            );
            tx.executeSql(
              'DELETE FROM ' + ATTACH_STORE$1 + ' WHERE digest=?', [digest]
            );
          });
        });
      });
    });
  }

  // update by-seq and attach stores in parallel
  revs.forEach(function (rev) {
    const sql = 'SELECT seq FROM ' + BY_SEQ_STORE$1 +
      ' WHERE doc_id=? AND rev=?';

    tx.executeSql(sql, [docId, rev], function (tx, res) {
      if (!res.rows.length) { // already deleted
        return checkDone();
      }
      const {seq} = res.rows.item(0);
      seqs.push(seq);

      tx.executeSql(
        'DELETE FROM ' + BY_SEQ_STORE$1 + ' WHERE seq=?', [seq], checkDone
      );
    });
  });
}

/**
 *
 * @param callback
 */
function websqlError (callback) {
  return function (event) {
    console.error('WebSQL threw an error', event);
    // event may actually be a SQLError object, so report is as such
    const errorNameMatch = event && event.constructor.toString().
      match(/function ([^\(]+)/);
    const errorName = (errorNameMatch && errorNameMatch[1]) || event.type;
    const errorReason = event.target || event.message;
    callback(createError(WSQ_ERROR, errorReason, errorName));
  };
}

/**
 *
 * @param opts
 */
function getSize (opts) {
  if ('size' in opts) {
    // triggers immediate popup in iOS, fixes #2347
    // e.g. 5000001 asks for 5 MB, 10000001 asks for 10 MB,
    return opts.size * 1000000;
  }
  // In iOS, doesn't matter as long as it's <= 5000000.
  // Except that if you request too much, our tests fail
  // because of the native "do you accept?" popup.
  // In Android <=4.3, this value is actually used as an
  // honest-to-god ceiling for data, so we need to
  // set it to a decently high number.
  const isAndroid = typeof navigator !== 'undefined' &&
    (/Android/).test(navigator.userAgent);
  return isAndroid ? 5000000 : 1; // in PhantomJS, if you use 0 it will crash
}

/**
 *
 * @param openDBFunction
 * @param opts
 */
function openDBSafely (openDBFunction, opts) {
  try {
    return {
      db: openDBFunction(opts)
    };
  } catch (err) {
    return {
      error: err
    };
  }
}

const cachedDatabases = new pouchdbCollections.Map();

/**
 *
 * @param opts
 */
function openDB (opts) {
  let cachedResult = cachedDatabases.get(opts.name);
  if (!cachedResult) {
    const openDBFun = createOpenDBFunction();
    cachedResult = openDBSafely(openDBFun, opts);
    cachedDatabases.set(opts.name, cachedResult);
    if (cachedResult.db) {
      cachedResult.db._sqlitePlugin = typeof sqlitePlugin !== 'undefined';
    }
  }
  return cachedResult;
}

/**
 *
 * @param dbOpts
 * @param req
 * @param opts
 * @param api
 * @param db
 * @param websqlChanges
 * @param callback
 */
function websqlBulkDocs (dbOpts, req, opts, api, db, websqlChanges, callback) {
  const newEdits = opts.new_edits;
  const userDocs = req.docs;

  // Parse the docs, give them a sequence number for the result
  const docInfos = userDocs.map(function (doc) {
    if (doc._id && isLocalId(doc._id)) {
      return doc;
    }
    const newDoc = parseDoc(doc, newEdits);
    return newDoc;
  });

  const docInfoErrors = docInfos.filter(function (docInfo) {
    return docInfo.error;
  });
  if (docInfoErrors.length) {
    return callback(docInfoErrors[0]);
  }

  let tx;
  const results = Array.from({length: docInfos.length});
  const fetchedDocs = new pouchdbCollections.Map();

  let preconditionErrored;
  /**
   *
   */
  function complete () {
    if (preconditionErrored) {
      return callback(preconditionErrored);
    }
    websqlChanges.notify(api._name);
    api._docCount = -1; // invalidate
    callback(null, results);
  }

  /**
   *
   * @param digest
   * @param callback
   */
  function verifyAttachment (digest, callback) {
    const sql = 'SELECT count(*) as cnt FROM ' + ATTACH_STORE$1 +
      ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      if (result.rows.item(0).cnt === 0) {
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
    docInfos.forEach(function (docInfo) {
      if (docInfo.data && docInfo.data._attachments) {
        Object.keys(docInfo.data._attachments).forEach(function (filename) {
          const att = docInfo.data._attachments[filename];
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

    /**
     *
     */
    function checkDone () {
      if (++numDone === digests.length) {
        finish(err);
      }
    }
    digests.forEach(function (digest) {
      verifyAttachment(digest, function (attErr) {
        if (attErr && !err) {
          err = attErr;
        }
        checkDone();
      });
    });
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
   * @param callback
   */
  function writeDoc (docInfo, winningRev, winningRevIsDeleted, newRevIsDeleted,
    isUpdate, delta, resultsIdx, callback) {
    /**
     *
     */
    function finish () {
      const {data} = docInfo;
      const deletedInt = newRevIsDeleted ? 1 : 0;

      const id = data._id;
      const rev = data._rev;
      const json = stringifyDoc(data);
      const sql = 'INSERT INTO ' + BY_SEQ_STORE$1 +
        ' (doc_id, rev, json, deleted) VALUES (?, ?, ?, ?);';
      const sqlArgs = [id, rev, json, deletedInt];

      // map seqs to attachment digests, which
      // we will need later during compaction
      /**
       *
       * @param seq
       * @param callback
       */
      function insertAttachmentMappings (seq, callback) {
        let attsAdded = 0;
        const attsToAdd = Object.keys(data._attachments || {});

        if (!attsToAdd.length) {
          return callback();
        }
        /**
         *
         */
        function checkDone () {
          if (++attsAdded === attsToAdd.length) {
            callback();
          }
          return false; // ack handling a constraint error
        }
        /**
         *
         * @param att
         */
        function add (att) {
          const sql = 'INSERT INTO ' + ATTACH_AND_SEQ_STORE$1 +
            ' (digest, seq) VALUES (?,?)';
          const sqlArgs = [data._attachments[att].digest, seq];
          tx.executeSql(sql, sqlArgs, checkDone, checkDone);
          // second callback is for a constaint error, which we ignore
          // because this docid/rev has already been associated with
          // the digest (e.g. when new_edits == false)
        }
        for (const element of attsToAdd) {
          add(element); // do in parallel
        }
      }

      tx.executeSql(sql, sqlArgs, function (tx, result) {
        const seq = result.insertId;
        insertAttachmentMappings(seq, function () {
          dataWritten(tx, seq);
        });
      }, function () {
        // constraint error, recover by updating instead (see #1638)
        const fetchSql = select('seq', BY_SEQ_STORE$1, null,
          'doc_id=? AND rev=?');
        tx.executeSql(fetchSql, [id, rev], function (tx, res) {
          const {seq} = res.rows.item(0);
          const sql = 'UPDATE ' + BY_SEQ_STORE$1 +
            ' SET json=?, deleted=? WHERE doc_id=? AND rev=?;';
          const sqlArgs = [json, deletedInt, id, rev];
          tx.executeSql(sql, sqlArgs, function (tx) {
            insertAttachmentMappings(seq, function () {
              dataWritten(tx, seq);
            });
          });
        });
        return false; // ack that we've handled the error
      });
    }

    /**
     *
     * @param attachmentErr
     */
    function collectResults (attachmentErr) {
      if (!err) {
        if (attachmentErr) {
          err = attachmentErr;
          callback(err);
        } else if (recv === attachments.length) {
          finish();
        }
      }
    }

    var err = null;
    var recv = 0;

    docInfo.data._id = docInfo.metadata.id;
    docInfo.data._rev = docInfo.metadata.rev;
    var attachments = Object.keys(docInfo.data._attachments || {});


    if (newRevIsDeleted) {
      docInfo.data._deleted = true;
    }

    /**
     *
     * @param err
     */
    function attachmentSaved (err) {
      recv++;
      collectResults(err);
    }

    attachments.forEach(function (key) {
      const att = docInfo.data._attachments[key];
      if (!att.stub) {
        const {data} = att;
        delete att.data;
        att.revpos = parseInt(winningRev, 10);
        const {digest} = att;
        saveAttachment(digest, data, attachmentSaved);
      } else {
        recv++;
        collectResults();
      }
    });

    if (!attachments.length) {
      finish();
    }

    /**
     *
     * @param tx
     * @param seq
     */
    function dataWritten (tx, seq) {
      const {id} = docInfo.metadata;
      if (isUpdate && api.auto_compaction) {
        compactRevs$1(compactTree(docInfo.metadata), id, tx);
      } else if (docInfo.stemmedRevs.length) {
        compactRevs$1(docInfo.stemmedRevs, id, tx);
      }

      docInfo.metadata.seq = seq;
      delete docInfo.metadata.rev;

      const sql = isUpdate
        ? 'UPDATE ' + DOC_STORE$1 +
      ' SET json=?, max_seq=?, winningseq=' +
      '(SELECT seq FROM ' + BY_SEQ_STORE$1 +
      ' WHERE doc_id=' + DOC_STORE$1 + '.id AND rev=?) WHERE id=?'
        : 'INSERT INTO ' + DOC_STORE$1 +
      ' (id, winningseq, max_seq, json) VALUES (?,?,?,?);';
      const metadataStr = safeJsonStringify(docInfo.metadata);
      const params = isUpdate
        ? [metadataStr, seq, winningRev, id]
        : [id, seq, seq, metadataStr];
      tx.executeSql(sql, params, function () {
        results[resultsIdx] = {
          ok: true,
          id: docInfo.metadata.id,
          rev: winningRev
        };
        fetchedDocs.set(id, docInfo.metadata);
        callback();
      });
    }
  }

  /**
   *
   */
  function websqlProcessDocs () {
    processDocs(dbOpts.revs_limit, docInfos, api, fetchedDocs, tx,
      results, writeDoc, opts);
  }

  /**
   *
   * @param callback
   */
  function fetchExistingDocs (callback) {
    if (!docInfos.length) {
      return callback();
    }

    let numFetched = 0;

    /**
     *
     */
    function checkDone () {
      if (++numFetched === docInfos.length) {
        callback();
      }
    }

    docInfos.forEach(function (docInfo) {
      if (docInfo._id && isLocalId(docInfo._id)) {
        return checkDone(); // skip local docs
      }
      const {id} = docInfo.metadata;
      tx.executeSql('SELECT json FROM ' + DOC_STORE$1 +
        ' WHERE id = ?', [id], function (tx, result) {
        if (result.rows.length) {
          const metadata = safeJsonParse(result.rows.item(0).json);
          fetchedDocs.set(id, metadata);
        }
        checkDone();
      });
    });
  }

  /**
   *
   * @param digest
   * @param data
   * @param callback
   */
  function saveAttachment (digest, data, callback) {
    let sql = 'SELECT digest FROM ' + ATTACH_STORE$1 + ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      if (result.rows.length) { // attachment already exists
        return callback();
      }
      // we could just insert before selecting and catch the error,
      // but my hunch is that it's cheaper not to serialize the blob
      // from JS to C if we don't have to (TODO: confirm this)
      sql = 'INSERT INTO ' + ATTACH_STORE$1 +
        ' (digest, body, escaped) VALUES (?,?,1)';
      tx.executeSql(sql, [digest, escapeBlob(data)], function () {
        callback();
      }, function () {
        // ignore constaint errors, means it already exists
        callback();
        return false; // ack we handled the error
      });
    });
  }

  preprocessAttachments$1(docInfos, 'binary', function (err) {
    if (err) {
      return callback(err);
    }
    db.transaction(function (txn) {
      tx = txn;
      verifyAttachments(function (err) {
        if (err) {
          preconditionErrored = err;
        } else {
          fetchExistingDocs(websqlProcessDocs);
        }
      });
    }, websqlError(callback), complete);
  });
}

const websqlChanges = new Changes$1();

/**
 *
 * @param doc
 * @param opts
 * @param api
 * @param txn
 * @param cb
 */
function fetchAttachmentsIfNecessary$1 (doc, opts, api, txn, cb) {
  const attachments = Object.keys(doc._attachments || {});
  if (!attachments.length) {
    return cb && cb();
  }
  let numDone = 0;

  /**
   *
   */
  function checkDone () {
    if (++numDone === attachments.length && cb) {
      cb();
    }
  }

  /**
   *
   * @param doc
   * @param att
   */
  function fetchAttachment (doc, att) {
    const attObj = doc._attachments[att];
    const attOpts = {binary: opts.binary, ctx: txn};
    api._getAttachment(attObj, attOpts, function (_, data) {
      doc._attachments[att] = jsExtend.extend(
        pick(attObj, ['digest', 'content_type']),
        {data}
      );
      checkDone();
    });
  }

  attachments.forEach(function (att) {
    if (opts.attachments && opts.include_docs) {
      fetchAttachment(doc, att);
    } else {
      doc._attachments[att].stub = true;
      checkDone();
    }
  });
}

const POUCH_VERSION = 1;

// these indexes cover the ground for most allDocs queries
const BY_SEQ_STORE_DELETED_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'by-seq-deleted-idx\' ON ' +
  BY_SEQ_STORE$1 + ' (seq, deleted)';
const BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS \'by-seq-doc-id-rev\' ON ' +
  BY_SEQ_STORE$1 + ' (doc_id, rev)';
const DOC_STORE_WINNINGSEQ_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'doc-winningseq-idx\' ON ' +
  DOC_STORE$1 + ' (winningseq)';
const ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'attach-seq-seq-idx\' ON ' +
  ATTACH_AND_SEQ_STORE$1 + ' (seq)';
const ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS \'attach-seq-digest-idx\' ON ' +
  ATTACH_AND_SEQ_STORE$1 + ' (digest, seq)';

const DOC_STORE_AND_BY_SEQ_JOINER = BY_SEQ_STORE$1 +
  '.seq = ' + DOC_STORE$1 + '.winningseq';

const SELECT_DOCS = BY_SEQ_STORE$1 + '.seq AS seq, ' +
  BY_SEQ_STORE$1 + '.deleted AS deleted, ' +
  BY_SEQ_STORE$1 + '.json AS data, ' +
  BY_SEQ_STORE$1 + '.rev AS rev, ' +
  DOC_STORE$1 + '.json AS metadata';

/**
 *
 * @param opts
 * @param callback
 */
function WebSqlPouch (opts, callback) {
  const api = this;
  let instanceId = null;
  const size = getSize(opts);
  const idRequests = [];
  let encoding;

  api._docCount = -1; // cache sqlite count(*) for performance
  api._name = opts.name;

  // extend the options here, because sqlite plugin has a ton of options
  // and they are constantly changing, so it's more prudent to allow anything
  const websqlOpts = jsExtend.extend({}, opts, {size, version: POUCH_VERSION});
  const openDBResult = openDB(websqlOpts);
  if (openDBResult.error) {
    return websqlError(callback)(openDBResult.error);
  }
  const {db} = openDBResult;
  if (typeof db.readTransaction !== 'function') {
    // doesn't exist in sqlite plugin
    db.readTransaction = db.transaction;
  }

  /**
   *
   */
  function dbCreated () {
    // note the db name in case the browser upgrades to idb
    if (hasLocalStorage()) {
      localStorage['_pouch__websqldb_' + api._name] = true;
    }
    callback(null, api);
  }

  // In this migration, we added the 'deleted' and 'local' columns to the
  // by-seq and doc store tables.
  // To preserve existing user data, we re-process all the existing JSON
  // and add these values.
  // Called migration2 because it corresponds to adapter version (db_version) #2
  /**
   *
   * @param tx
   * @param callback
   */
  function runMigration2 (tx, callback) {
    // index used for the join in the allDocs query
    tx.executeSql(DOC_STORE_WINNINGSEQ_INDEX_SQL);

    tx.executeSql('ALTER TABLE ' + BY_SEQ_STORE$1 +
      ' ADD COLUMN deleted TINYINT(1) DEFAULT 0', [], function () {
      tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
      tx.executeSql('ALTER TABLE ' + DOC_STORE$1 +
        ' ADD COLUMN local TINYINT(1) DEFAULT 0', [], function () {
        tx.executeSql('CREATE INDEX IF NOT EXISTS \'doc-store-local-idx\' ON ' +
          DOC_STORE$1 + ' (local, id)');

        const sql = 'SELECT ' + DOC_STORE$1 + '.winningseq AS seq, ' + DOC_STORE$1 +
          '.json AS metadata FROM ' + BY_SEQ_STORE$1 + ' JOIN ' + DOC_STORE$1 +
          ' ON ' + BY_SEQ_STORE$1 + '.seq = ' + DOC_STORE$1 + '.winningseq';

        tx.executeSql(sql, [], function (tx, result) {
          const deleted = [];
          const local = [];

          for (let i = 0; i < result.rows.length; i++) {
            const item = result.rows.item(i);
            const {seq} = item;
            const metadata = JSON.parse(item.metadata);
            if (isDeleted(metadata)) {
              deleted.push(seq);
            }
            if (isLocalId(metadata.id)) {
              local.push(metadata.id);
            }
          }
          tx.executeSql('UPDATE ' + DOC_STORE$1 + 'SET local = 1 WHERE id IN ' +
            qMarks(local.length), local, function () {
            tx.executeSql('UPDATE ' + BY_SEQ_STORE$1 +
              ' SET deleted = 1 WHERE seq IN ' +
              qMarks(deleted.length), deleted, callback);
          });
        });
      });
    });
  }

  // in this migration, we make all the local docs unversioned
  /**
   *
   * @param tx
   * @param callback
   */
  function runMigration3 (tx, callback) {
    const local = 'CREATE TABLE IF NOT EXISTS ' + LOCAL_STORE$1 +
      ' (id UNIQUE, rev, json)';
    tx.executeSql(local, [], function () {
      const sql = 'SELECT ' + DOC_STORE$1 + '.id AS id, ' +
        BY_SEQ_STORE$1 + '.json AS data ' +
        'FROM ' + BY_SEQ_STORE$1 + ' JOIN ' +
        DOC_STORE$1 + ' ON ' + BY_SEQ_STORE$1 + '.seq = ' +
        DOC_STORE$1 + '.winningseq WHERE local = 1';
      tx.executeSql(sql, [], function (tx, res) {
        const rows = [];
        for (let i = 0; i < res.rows.length; i++) {
          rows.push(res.rows.item(i));
        }
        /**
         *
         */
        function doNext () {
          if (!rows.length) {
            return callback(tx);
          }
          const row = rows.shift();
          const rev = JSON.parse(row.data)._rev;
          tx.executeSql('INSERT INTO ' + LOCAL_STORE$1 +
            ' (id, rev, json) VALUES (?,?,?)',
          [row.id, rev, row.data], function (tx) {
            tx.executeSql('DELETE FROM ' + DOC_STORE$1 + ' WHERE id=?',
              [row.id], function (tx) {
                tx.executeSql('DELETE FROM ' + BY_SEQ_STORE$1 + ' WHERE seq=?',
                  [row.seq], function () {
                    doNext();
                  });
              });
          });
        }
        doNext();
      });
    });
  }

  // in this migration, we remove doc_id_rev and just use rev
  /**
   *
   * @param tx
   * @param callback
   */
  function runMigration4 (tx, callback) {
    /**
     *
     * @param rows
     */
    function updateRows (rows) {
      /**
       *
       */
      function doNext () {
        if (!rows.length) {
          return callback(tx);
        }
        const row = rows.shift();
        const doc_id_rev = parseHexString(row.hex, encoding);
        const idx = doc_id_rev.lastIndexOf('::');
        const doc_id = doc_id_rev.slice(0, Math.max(0, idx));
        const rev = doc_id_rev.slice(Math.max(0, idx + 2));
        const sql = 'UPDATE ' + BY_SEQ_STORE$1 +
          ' SET doc_id=?, rev=? WHERE doc_id_rev=?';
        tx.executeSql(sql, [doc_id, rev, doc_id_rev], function () {
          doNext();
        });
      }
      doNext();
    }

    const sql = 'ALTER TABLE ' + BY_SEQ_STORE$1 + ' ADD COLUMN doc_id';
    tx.executeSql(sql, [], function (tx) {
      const sql = 'ALTER TABLE ' + BY_SEQ_STORE$1 + ' ADD COLUMN rev';
      tx.executeSql(sql, [], function (tx) {
        tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL, [], function (tx) {
          const sql = 'SELECT hex(doc_id_rev) as hex FROM ' + BY_SEQ_STORE$1;
          tx.executeSql(sql, [], function (tx, res) {
            const rows = [];
            for (let i = 0; i < res.rows.length; i++) {
              rows.push(res.rows.item(i));
            }
            updateRows(rows);
          });
        });
      });
    });
  }

  // in this migration, we add the attach_and_seq table
  // for issue #2818
  /**
   *
   * @param tx
   * @param callback
   */
  function runMigration5 (tx, callback) {
    /**
     *
     * @param tx
     */
    function migrateAttsAndSeqs (tx) {
      // need to actually populate the table. this is the expensive part,
      // so as an optimization, check first that this database even
      // contains attachments
      const sql = 'SELECT COUNT(*) AS cnt FROM ' + ATTACH_STORE$1;
      tx.executeSql(sql, [], function (tx, res) {
        const count = res.rows.item(0).cnt;
        if (!count) {
          return callback(tx);
        }

        let offset = 0;
        const pageSize = 10;
        /**
         *
         */
        function nextPage () {
          let sql = select(
            SELECT_DOCS + ', ' + DOC_STORE$1 + '.id AS id',
            [DOC_STORE$1, BY_SEQ_STORE$1],
            DOC_STORE_AND_BY_SEQ_JOINER,
            null,
            DOC_STORE$1 + '.id '
          );
          sql += ' LIMIT ' + pageSize + ' OFFSET ' + offset;
          offset += pageSize;
          tx.executeSql(sql, [], function (tx, res) {
            if (!res.rows.length) {
              return callback(tx);
            }
            const digestSeqs = {};
            /**
             *
             * @param digest
             * @param seq
             */
            function addDigestSeq (digest, seq) {
              // uniq digest/seq pairs, just in case there are dups
              const seqs = digestSeqs[digest] = (digestSeqs[digest] || []);
              if (!seqs.includes(seq)) {
                seqs.push(seq);
              }
            }
            for (let i = 0; i < res.rows.length; i++) {
              const row = res.rows.item(i);
              const doc = unstringifyDoc(row.data, row.id, row.rev);
              const atts = Object.keys(doc._attachments || {});
              for (const att_ of atts) {
                const att = doc._attachments[att_];
                addDigestSeq(att.digest, row.seq);
              }
            }
            const digestSeqPairs = [];
            Object.keys(digestSeqs).forEach(function (digest) {
              const seqs = digestSeqs[digest];
              seqs.forEach(function (seq) {
                digestSeqPairs.push([digest, seq]);
              });
            });
            if (!digestSeqPairs.length) {
              return nextPage();
            }
            let numDone = 0;
            digestSeqPairs.forEach(function (pair) {
              const sql = 'INSERT INTO ' + ATTACH_AND_SEQ_STORE$1 +
                ' (digest, seq) VALUES (?,?)';
              tx.executeSql(sql, pair, function () {
                if (++numDone === digestSeqPairs.length) {
                  nextPage();
                }
              });
            });
          });
        }
        nextPage();
      });
    }

    const attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
      ATTACH_AND_SEQ_STORE$1 + ' (digest, seq INTEGER)';
    tx.executeSql(attachAndRev, [], function (tx) {
      tx.executeSql(
        ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL, [], function (tx) {
          tx.executeSql(
            ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL, [],
            migrateAttsAndSeqs
          );
        }
      );
    });
  }

  // in this migration, we use escapeBlob() and unescapeBlob()
  // instead of reading out the binary as HEX, which is slow
  /**
   *
   * @param tx
   * @param callback
   */
  function runMigration6 (tx, callback) {
    const sql = 'ALTER TABLE ' + ATTACH_STORE$1 +
      ' ADD COLUMN escaped TINYINT(1) DEFAULT 0';
    tx.executeSql(sql, [], callback);
  }

  // issue #3136, in this migration we need a "latest seq" as well
  // as the "winning seq" in the doc store
  /**
   *
   * @param tx
   * @param callback
   */
  function runMigration7 (tx, callback) {
    const sql = 'ALTER TABLE ' + DOC_STORE$1 +
      ' ADD COLUMN max_seq INTEGER';
    tx.executeSql(sql, [], function (tx) {
      const sql = 'UPDATE ' + DOC_STORE$1 + ' SET max_seq=(SELECT MAX(seq) FROM ' +
        BY_SEQ_STORE$1 + ' WHERE doc_id=id)';
      tx.executeSql(sql, [], function (tx) {
        // add unique index after filling, else we'll get a constraint
        // error when we do the ALTER TABLE
        const sql =
          'CREATE UNIQUE INDEX IF NOT EXISTS \'doc-max-seq-idx\' ON ' +
          DOC_STORE$1 + ' (max_seq)';
        tx.executeSql(sql, [], callback);
      });
    });
  }

  /**
   *
   * @param tx
   * @param cb
   */
  function checkEncoding (tx, cb) {
    // UTF-8 on chrome/android, UTF-16 on safari < 7.1
    tx.executeSql('SELECT HEX("a") AS hex', [], function (tx, res) {
      const {hex} = res.rows.item(0);
      encoding = hex.length === 2 ? 'UTF-8' : 'UTF-16';
      cb();
    });
  }

  /**
   *
   */
  function onGetInstanceId () {
    while (idRequests.length > 0) {
      const idCallback = idRequests.pop();
      idCallback(null, instanceId);
    }
  }

  /**
   *
   * @param tx
   * @param dbVersion
   */
  function onGetVersion (tx, dbVersion) {
    if (dbVersion === 0) {
      // initial schema

      const meta = 'CREATE TABLE IF NOT EXISTS ' + META_STORE$1 +
        ' (dbid, db_version INTEGER)';
      const attach = 'CREATE TABLE IF NOT EXISTS ' + ATTACH_STORE$1 +
        ' (digest UNIQUE, escaped TINYINT(1), body BLOB)';
      const attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
        ATTACH_AND_SEQ_STORE$1 + ' (digest, seq INTEGER)';
      // TODO: migrate winningseq to INTEGER
      const doc = 'CREATE TABLE IF NOT EXISTS ' + DOC_STORE$1 +
        ' (id unique, json, winningseq, max_seq INTEGER UNIQUE)';
      const seq = 'CREATE TABLE IF NOT EXISTS ' + BY_SEQ_STORE$1 +
        ' (seq INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
        'json, deleted TINYINT(1), doc_id, rev)';
      const local = 'CREATE TABLE IF NOT EXISTS ' + LOCAL_STORE$1 +
        ' (id UNIQUE, rev, json)';

      // creates
      tx.executeSql(attach);
      tx.executeSql(local);
      tx.executeSql(attachAndRev, [], function () {
        tx.executeSql(ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL);
        tx.executeSql(ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL);
      });
      tx.executeSql(doc, [], function () {
        tx.executeSql(DOC_STORE_WINNINGSEQ_INDEX_SQL);
        tx.executeSql(seq, [], function () {
          tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
          tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL);
          tx.executeSql(meta, [], function () {
            // mark the db version, and new dbid
            const initSeq = 'INSERT INTO ' + META_STORE$1 +
              ' (db_version, dbid) VALUES (?,?)';
            instanceId = uuid();
            const initSeqArgs = [ADAPTER_VERSION$1, instanceId];
            tx.executeSql(initSeq, initSeqArgs, function () {
              onGetInstanceId();
            });
          });
        });
      });
    } else { // version > 0
      const setupDone = function () {
        const migrated = dbVersion < ADAPTER_VERSION$1;
        if (migrated) {
          // update the db version within this transaction
          tx.executeSql('UPDATE ' + META_STORE$1 + ' SET db_version = ' +
            ADAPTER_VERSION$1);
        }
        // notify db.id() callers
        const sql = 'SELECT dbid FROM ' + META_STORE$1;
        tx.executeSql(sql, [], function (tx, result) {
          instanceId = result.rows.item(0).dbid;
          onGetInstanceId();
        });
      };

      // would love to use promises here, but then websql
      // ends the transaction early
      const tasks = [
        runMigration2,
        runMigration3,
        runMigration4,
        runMigration5,
        runMigration6,
        runMigration7,
        setupDone
      ];

      // run each migration sequentially
      let i = dbVersion;
      const nextMigration = function (tx) {
        tasks[i - 1](tx, nextMigration);
        i++;
      };
      nextMigration(tx);
    }
  }

  /**
   *
   */
  function setup () {
    db.transaction(function (tx) {
      // first check the encoding
      checkEncoding(tx, function () {
        // then get the version
        fetchVersion(tx);
      });
    }, websqlError(callback), dbCreated);
  }

  /**
   *
   * @param tx
   */
  function fetchVersion (tx) {
    const sql = 'SELECT sql FROM sqlite_master WHERE tbl_name = ' + META_STORE$1;
    tx.executeSql(sql, [], function (tx, result) {
      if (!result.rows.length) {
        // database hasn't even been created yet (version 0)
        onGetVersion(tx, 0);
      } else if (!(/db_version/).test(result.rows.item(0).sql)) {
        // table was created, but without the new db_version column,
        // so add it.
        tx.executeSql('ALTER TABLE ' + META_STORE$1 +
          ' ADD COLUMN db_version INTEGER', [], function () {
          // before version 2, this column didn't even exist
          onGetVersion(tx, 1);
        });
      } else { // column exists, we can safely get it
        tx.executeSql('SELECT db_version FROM ' + META_STORE$1,
          [], function (tx, result) {
            const dbVersion = result.rows.item(0).db_version;
            onGetVersion(tx, dbVersion);
          });
      }
    });
  }

  setup();

  api.type = function () {
    return 'websql';
  };

  api._id = toPromise(function (callback) {
    callback(null, instanceId);
  });

  api._info = function (callback) {
    db.readTransaction(function (tx) {
      countDocs(tx, function (docCount) {
        const sql = 'SELECT MAX(seq) AS seq FROM ' + BY_SEQ_STORE$1;
        tx.executeSql(sql, [], function (tx, res) {
          const updateSeq = res.rows.item(0).seq || 0;
          callback(null, {
            doc_count: docCount,
            update_seq: updateSeq,
            // for debugging
            sqlite_plugin: db._sqlitePlugin,
            websql_encoding: encoding
          });
        });
      });
    }, websqlError(callback));
  };

  api._bulkDocs = function (req, reqOpts, callback) {
    websqlBulkDocs(opts, req, reqOpts, api, db, websqlChanges, callback);
  };

  api._get = function (id, opts, callback) {
    let doc;
    let metadata;
    let err;
    const tx = opts.ctx;
    if (!tx) {
      return db.readTransaction(function (txn) {
        api._get(id, jsExtend.extend({ctx: txn}, opts), callback);
      });
    }

    /**
     *
     */
    function finish () {
      callback(err, {doc, metadata, ctx: tx});
    }

    let sql;
    let sqlArgs;
    if (opts.rev) {
      sql = select(
        SELECT_DOCS,
        [DOC_STORE$1, BY_SEQ_STORE$1],
        DOC_STORE$1 + '.id=' + BY_SEQ_STORE$1 + '.doc_id',
        [BY_SEQ_STORE$1 + '.doc_id=?', BY_SEQ_STORE$1 + '.rev=?']
      );
      sqlArgs = [id, opts.rev];
    } else {
      sql = select(
        SELECT_DOCS,
        [DOC_STORE$1, BY_SEQ_STORE$1],
        DOC_STORE_AND_BY_SEQ_JOINER,
        DOC_STORE$1 + '.id=?'
      );
      sqlArgs = [id];
    }
    tx.executeSql(sql, sqlArgs, function (a, results) {
      if (!results.rows.length) {
        err = createError(MISSING_DOC, 'missing');
        return finish();
      }
      const item = results.rows.item(0);
      metadata = safeJsonParse(item.metadata);
      if (item.deleted && !opts.rev) {
        err = createError(MISSING_DOC, 'deleted');
        return finish();
      }
      doc = unstringifyDoc(item.data, metadata.id, item.rev);
      finish();
    });
  };

  /**
   *
   * @param tx
   * @param callback
   */
  function countDocs (tx, callback) {
    if (api._docCount !== -1) {
      return callback(api._docCount);
    }

    // count the total rows
    const sql = select(
      'COUNT(' + DOC_STORE$1 + '.id) AS \'num\'',
      [DOC_STORE$1, BY_SEQ_STORE$1],
      DOC_STORE_AND_BY_SEQ_JOINER,
      BY_SEQ_STORE$1 + '.deleted=0'
    );

    tx.executeSql(sql, [], function (tx, result) {
      api._docCount = result.rows.item(0).num;
      callback(api._docCount);
    });
  }

  api._allDocs = function (opts, callback) {
    const results = [];
    let totalRows;

    const start = 'startkey' in opts ? opts.startkey : false;
    const end = 'endkey' in opts ? opts.endkey : false;
    const key = 'key' in opts ? opts.key : false;
    const descending = 'descending' in opts ? opts.descending : false;
    const limit = 'limit' in opts ? opts.limit : -1;
    const offset = 'skip' in opts ? opts.skip : 0;
    const inclusiveEnd = opts.inclusive_end !== false;

    const sqlArgs = [];
    const criteria = [];

    if (key !== false) {
      criteria.push(DOC_STORE$1 + '.id = ?');
      sqlArgs.push(key);
    } else if (start !== false || end !== false) {
      if (start !== false) {
        criteria.push(DOC_STORE$1 + '.id ' + (descending ? '<=' : '>=') + ' ?');
        sqlArgs.push(start);
      }
      if (end !== false) {
        let comparator = descending ? '>' : '<';
        if (inclusiveEnd) {
          comparator += '=';
        }
        criteria.push(DOC_STORE$1 + '.id ' + comparator + ' ?');
        sqlArgs.push(end);
      }
      if (key !== false) {
        criteria.push(DOC_STORE$1 + '.id = ?');
        sqlArgs.push(key);
      }
    }

    if (opts.deleted !== 'ok') {
      // report deleted if keys are specified
      criteria.push(BY_SEQ_STORE$1 + '.deleted = 0');
    }

    db.readTransaction(function (tx) {
      // first count up the total rows
      countDocs(tx, function (count) {
        totalRows = count;

        if (limit === 0) {
          return;
        }

        // then actually fetch the documents
        let sql = select(
          SELECT_DOCS,
          [DOC_STORE$1, BY_SEQ_STORE$1],
          DOC_STORE_AND_BY_SEQ_JOINER,
          criteria,
          DOC_STORE$1 + '.id ' + (descending ? 'DESC' : 'ASC')
        );
        sql += ' LIMIT ' + limit + ' OFFSET ' + offset;

        tx.executeSql(sql, sqlArgs, function (tx, result) {
          for (let i = 0, l = result.rows.length; i < l; i++) {
            const item = result.rows.item(i);
            const metadata = safeJsonParse(item.metadata);
            const {id} = metadata;
            const data = unstringifyDoc(item.data, id, item.rev);
            const winningRev = data._rev;
            const doc = {
              id,
              key: id,
              value: {rev: winningRev}
            };
            if (opts.include_docs) {
              doc.doc = data;
              doc.doc._rev = winningRev;
              if (opts.conflicts) {
                doc.doc._conflicts = collectConflicts(metadata);
              }
              fetchAttachmentsIfNecessary$1(doc.doc, opts, api, tx);
            }
            if (item.deleted) {
              if (opts.deleted === 'ok') {
                doc.value.deleted = true;
                doc.doc = null;
              } else {
                continue;
              }
            }
            results.push(doc);
          }
        });
      });
    }, websqlError(callback), function () {
      callback(null, {
        total_rows: totalRows,
        offset: opts.skip,
        rows: results
      });
    });
  };

  api._changes = function (opts) {
    opts = clone(opts);

    if (opts.continuous) {
      const id = api._name + ':' + uuid();
      websqlChanges.addListener(api._name, id, api, opts);
      websqlChanges.notify(api._name);
      return {
        cancel () {
          websqlChanges.removeListener(api._name, id);
        }
      };
    }

    const {descending} = opts;

    // Ignore the `since` parameter when `descending` is true
    opts.since = opts.since && !descending ? opts.since : 0;

    let limit = 'limit' in opts ? opts.limit : -1;
    if (limit === 0) {
      limit = 1; // per CouchDB _changes spec
    }

    let returnDocs;
    if ('return_docs' in opts) {
      returnDocs = opts.return_docs;
    } else if ('returnDocs' in opts) {
      // TODO: Remove 'returnDocs' in favor of 'return_docs' in a future release
      returnDocs = opts.returnDocs;
    } else {
      returnDocs = true;
    }
    const results = [];
    let numResults = 0;

    /**
     *
     */
    function fetchChanges () {
      const selectStmt =
        DOC_STORE$1 + '.json AS metadata, ' +
        DOC_STORE$1 + '.max_seq AS maxSeq, ' +
        BY_SEQ_STORE$1 + '.json AS winningDoc, ' +
        BY_SEQ_STORE$1 + '.rev AS winningRev ';

      const from = DOC_STORE$1 + ' JOIN ' + BY_SEQ_STORE$1;

      const joiner = DOC_STORE$1 + '.id=' + BY_SEQ_STORE$1 + '.doc_id' +
        ' AND ' + DOC_STORE$1 + '.winningseq=' + BY_SEQ_STORE$1 + '.seq';

      const criteria = ['maxSeq > ?'];
      let sqlArgs = [opts.since];

      if (opts.doc_ids) {
        criteria.push(DOC_STORE$1 + '.id IN ' + qMarks(opts.doc_ids.length));
        sqlArgs = sqlArgs.concat(opts.doc_ids);
      }

      const orderBy = 'maxSeq ' + (descending ? 'DESC' : 'ASC');

      let sql = select(selectStmt, from, joiner, criteria, orderBy);

      const filter = filterChange(opts);
      if (!opts.view && !opts.filter) {
        // we can just limit in the query
        sql += ' LIMIT ' + limit;
      }

      let lastSeq = opts.since || 0;
      db.readTransaction(function (tx) {
        tx.executeSql(sql, sqlArgs, function (tx, result) {
          /**
           *
           * @param change
           */
          function reportChange (change) {
            return function () {
              opts.onChange(change);
            };
          }
          for (let i = 0, l = result.rows.length; i < l; i++) {
            const item = result.rows.item(i);
            const metadata = safeJsonParse(item.metadata);
            lastSeq = item.maxSeq;

            const doc = unstringifyDoc(item.winningDoc, metadata.id,
              item.winningRev);
            const change = opts.processChange(doc, metadata, opts);
            change.seq = item.maxSeq;

            const filtered = filter(change);
            if (typeof filtered === 'object') {
              return opts.complete(filtered);
            }

            if (filtered) {
              numResults++;
              if (returnDocs) {
                results.push(change);
              }
              // process the attachment immediately
              // for the benefit of live listeners
              if (opts.attachments && opts.include_docs) {
                fetchAttachmentsIfNecessary$1(doc, opts, api, tx,
                  reportChange(change));
              } else {
                reportChange(change)();
              }
            }
            if (numResults === limit) {
              break;
            }
          }
        });
      }, websqlError(opts.complete), function () {
        if (!opts.continuous) {
          opts.complete(null, {
            results,
            last_seq: lastSeq
          });
        }
      });
    }

    fetchChanges();
  };

  api._close = function (callback) {
    // WebSQL databases do not need to be closed
    callback();
  };

  api._getAttachment = function (attachment, opts, callback) {
    let res;
    const tx = opts.ctx;
    const {digest} = attachment;
    const type = attachment.content_type;
    const sql = 'SELECT escaped, ' +
      'CASE WHEN escaped = 1 THEN body ELSE HEX(body) END AS body FROM ' +
      ATTACH_STORE$1 + ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      // websql has a bug where \u0000 causes early truncation in strings
      // and blobs. to work around this, we used to use the hex() function,
      // but that's not performant. after migration 6, we remove \u0000
      // and add it back in afterwards
      const item = result.rows.item(0);
      const data = item.escaped
        ? unescapeBlob(item.body)
        : parseHexString(item.body, encoding);
      res = opts.binary ? binStringToBluffer(data, type) : btoa$1(data);
      callback(null, res);
    });
  };

  api._getRevisionTree = function (docId, callback) {
    db.readTransaction(function (tx) {
      const sql = 'SELECT json AS metadata FROM ' + DOC_STORE$1 + ' WHERE id = ?';
      tx.executeSql(sql, [docId], function (tx, result) {
        if (!result.rows.length) {
          callback(createError(MISSING_DOC));
        } else {
          const data = safeJsonParse(result.rows.item(0).metadata);
          callback(null, data.rev_tree);
        }
      });
    });
  };

  api._doCompaction = function (docId, revs, callback) {
    if (!revs.length) {
      return callback();
    }
    db.transaction(function (tx) {
      // update doc store
      const sql = 'SELECT json AS metadata FROM ' + DOC_STORE$1 + ' WHERE id = ?';
      tx.executeSql(sql, [docId], function (tx, result) {
        const metadata = safeJsonParse(result.rows.item(0).metadata);
        traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
          revHash, ctx, opts) {
          const rev = pos + '-' + revHash;
          if (revs.includes(rev)) {
            opts.status = 'missing';
          }
        });

        const sql = 'UPDATE ' + DOC_STORE$1 + ' SET json = ? WHERE id = ?';
        tx.executeSql(sql, [safeJsonStringify(metadata), docId]);
      });

      compactRevs$1(revs, docId, tx);
    }, websqlError(callback), function () {
      callback();
    });
  };

  api._getLocal = function (id, callback) {
    db.readTransaction(function (tx) {
      const sql = 'SELECT json, rev FROM ' + LOCAL_STORE$1 + ' WHERE id=?';
      tx.executeSql(sql, [id], function (tx, res) {
        if (res.rows.length) {
          const item = res.rows.item(0);
          const doc = unstringifyDoc(item.json, id, item.rev);
          callback(null, doc);
        } else {
          callback(createError(MISSING_DOC));
        }
      });
    });
  };

  api._putLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    delete doc._revisions; // ignore this, trust the rev
    const oldRev = doc._rev;
    const id = doc._id;
    let newRev;
    newRev = doc._rev = !oldRev ? '0-1' : '0-' + (parseInt(oldRev.split('-', 2)[1], 10) + 1);
    const json = stringifyDoc(doc);

    let ret;
    /**
     *
     * @param tx
     */
    function putLocal (tx) {
      let sql;
      let values;
      if (oldRev) {
        sql = 'UPDATE ' + LOCAL_STORE$1 + ' SET rev=?, json=? ' +
          'WHERE id=? AND rev=?';
        values = [newRev, json, id, oldRev];
      } else {
        sql = 'INSERT INTO ' + LOCAL_STORE$1 + ' (id, rev, json) VALUES (?,?,?)';
        values = [id, newRev, json];
      }
      tx.executeSql(sql, values, function (tx, res) {
        if (res.rowsAffected) {
          ret = {ok: true, id, rev: newRev};
          if (opts.ctx) { // return immediately
            callback(null, ret);
          }
        } else {
          callback(createError(REV_CONFLICT));
        }
      }, function () {
        callback(createError(REV_CONFLICT));
        return false; // ack that we handled the error
      });
    }

    if (opts.ctx) {
      putLocal(opts.ctx);
    } else {
      db.transaction(putLocal, websqlError(callback), function () {
        if (ret) {
          callback(null, ret);
        }
      });
    }
  };

  api._removeLocal = function (doc, opts, callback) {
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }
    let ret;

    /**
     *
     * @param tx
     */
    function removeLocal (tx) {
      const sql = 'DELETE FROM ' + LOCAL_STORE$1 + ' WHERE id=? AND rev=?';
      const params = [doc._id, doc._rev];
      tx.executeSql(sql, params, function (tx, res) {
        if (!res.rowsAffected) {
          return callback(createError(MISSING_DOC));
        }
        ret = {ok: true, id: doc._id, rev: '0-0'};
        if (opts.ctx) { // return immediately
          callback(null, ret);
        }
      });
    }

    if (opts.ctx) {
      removeLocal(opts.ctx);
    } else {
      db.transaction(removeLocal, websqlError(callback), function () {
        if (ret) {
          callback(null, ret);
        }
      });
    }
  };

  api._destroy = function (opts, callback) {
    websqlChanges.removeAllListeners(api._name);
    db.transaction(function (tx) {
      const stores = [DOC_STORE$1, BY_SEQ_STORE$1, ATTACH_STORE$1, META_STORE$1,
        LOCAL_STORE$1, ATTACH_AND_SEQ_STORE$1];
      stores.forEach(function (store) {
        tx.executeSql('DROP TABLE IF EXISTS ' + store, []);
      });
    }, websqlError(callback), function () {
      if (hasLocalStorage()) {
        delete localStorage['_pouch__websqldb_' + api._name];
        delete localStorage[api._name];
      }
      callback(null, {ok: true});
    });
  };
}

// in the browser, use a prefix. in Node, don't bother having one
WebSqlPouch.use_prefix = Boolean(typeof process === 'undefined' || process.browser);

WebSqlPouch.valid = valid;

const adapters = {
  idb: IdbPouch,
  websql: WebSqlPouch
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

PouchDB.preferredAdapters = ['websql'];

export default PouchDB;


