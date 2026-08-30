import jsExtend from 'js-extend';
import inherits from 'inherits';
import vuvuzela from 'vuvuzela';
import events from 'node:events';
import lie from 'lie';
import getArguments from 'argsarray';
import pouchdbCollections from 'pouchdb-collections';
import crypto from 'node:crypto';
import openDatabase from '../lib/index.js';

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
 * @param id
 */
function isLocalId (id) {
  return (/^_local/).test(id);
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

// this solely exists so we can exclude it in browserify
const buffer = Buffer;

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

// in Node of course this is false
/**
 *
 */
function hasLocalStorage () {
  return false;
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

// in Node of course this is false
/**
 *
 */
function isChromeApp () {
  return false;
}

inherits(Changes, events.EventEmitter);

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
function Changes () {
  events.EventEmitter.call(this);
  this._listeners = {};

  attachBrowserEvents(this);
}
Changes.prototype.addListener = function (dbName, id, db, opts) {
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

Changes.prototype.removeListener = function (dbName, id) {
  /* istanbul ignore if */
  if (!(id in this._listeners)) {
    return;
  }
  events.EventEmitter.prototype.removeListener.call(this, dbName,
    this._listeners[id]);
};


/* c8 ignore next */
Changes.prototype.notifyLocalWindows = function (dbName) {
  // do a useless change on a storage thing
  // in order to get other windows's listeners to activate
  if (isChromeApp()) {
    chrome.storage.local.set({dbName});
  } else if (hasLocalStorage()) {
    localStorage[dbName] = (localStorage[dbName] === 'a') ? 'b' : 'a';
  }
};

Changes.prototype.notify = function (dbName) {
  this.emit(dbName);
  this.notifyLocalWindows(dbName);
};

/* c8 ignore next */
const PouchPromise = typeof Promise === 'function' ? Promise : lie;

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

// In Node, this is just a Buffer rather than an ArrayBuffer
/**
 *
 * @param buffer
 */
function arrayBufferToBinaryString (buffer) {
  return buffer.toString('binary');
}

// In Node.js, just convert the Buffer to a Buffer rather than
// convert a Blob to an ArrayBuffer. This function is just a convenience
// function so we can easily switch Node vs browser environments.
/**
 *
 * @param buffer
 * @param callback
 */
function readAsArrayBuffer (buffer, callback) {
  queueMicrotask(function () {
    callback(buffer);
  });
}

// In Node, this is just a Buffer rather than an ArrayBuffer
/**
 *
 * @param buffer
 */
function arrayBufferToBase64 (buffer) {
  return buffer.toString('binary');
}

const res = toPromise(function (data, callback) {
  const base64 = crypto.createHash('md5').update(data).digest('base64');
  callback(null, base64);
});

/**
 *
 * @param docInfos
 * @param blobType
 * @param callback
 */
function preprocessAttachments (docInfos, blobType, callback) {
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
      return atob(data);
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
        att.data = btoa(asBinary);
      } else { // binary
        att.data = asBinary;
      }
      res(asBinary).then(function (result) {
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
        res(buff).then(function (result) {
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

/**
 *
 * @param str
 */
function quote (str) {
  // Double quotes (SQL identifier quoting), not single (string literal):
  // better-sqlite3 builds SQLite with strict quoting (SQLITE_DQS=0), which
  // will not accept a single-quoted string where a table name is expected.
  return '"' + str + '"';
}

const ADAPTER_VERSION = 7; // used to manage migrations

// The object stores created for each database
// DOC_STORE stores the document meta data, its revision history and state
const DOC_STORE = quote('document-store');
// BY_SEQ_STORE stores a particular version of a document, keyed by its
// sequence id
const BY_SEQ_STORE = quote('by-sequence');
// Where we store attachments
const ATTACH_STORE = quote('attach-store');
const LOCAL_STORE = quote('local-store');
const META_STORE = quote('metadata-store');
// where we store many-to-many relations between attachment
// digests and seqs
const ATTACH_AND_SEQ_STORE = quote('attach-seq-store');

// nodejs version of websql

/**
 *
 */
function createOpenDBFunction () {
  return function openDB (opts) {
    return openDatabase('testdbs/' +
      opts.name, opts.version, opts.description, opts.size);
  };
}

/**
 *
 */
function valid () {
  return true; // in Node, this is always true
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
function compactRevs (revs, docId, tx) {
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
      ATTACH_AND_SEQ_STORE + ' WHERE seq IN ' + qMarks(seqs.length);

    tx.executeSql(sql, seqs, function (tx, res) {
      const digestsToCheck = [];
      for (let i = 0; i < res.rows.length; i++) {
        digestsToCheck.push(res.rows.item(i).digest);
      }
      if (!digestsToCheck.length) {
        return;
      }

      const sql = 'DELETE FROM ' + ATTACH_AND_SEQ_STORE +
        ' WHERE seq IN (' +
        seqs.map(function () {
          return '?';
        }).join(',') +
        ')';
      tx.executeSql(sql, seqs, function (tx) {
        const sql = 'SELECT digest FROM ' + ATTACH_AND_SEQ_STORE +
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
              'DELETE FROM ' + ATTACH_AND_SEQ_STORE + ' WHERE digest=?',
              [digest]
            );
            tx.executeSql(
              'DELETE FROM ' + ATTACH_STORE + ' WHERE digest=?', [digest]
            );
          });
        });
      });
    });
  }

  // update by-seq and attach stores in parallel
  revs.forEach(function (rev) {
    const sql = 'SELECT seq FROM ' + BY_SEQ_STORE +
      ' WHERE doc_id=? AND rev=?';

    tx.executeSql(sql, [docId, rev], function (tx, res) {
      if (!res.rows.length) { // already deleted
        return checkDone();
      }
      const {seq} = res.rows.item(0);
      seqs.push(seq);

      tx.executeSql(
        'DELETE FROM ' + BY_SEQ_STORE + ' WHERE seq=?', [seq], checkDone
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
    const sql = 'SELECT count(*) as cnt FROM ' + ATTACH_STORE +
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
      const sql = 'INSERT INTO ' + BY_SEQ_STORE +
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
          const sql = 'INSERT INTO ' + ATTACH_AND_SEQ_STORE +
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
        const fetchSql = select('seq', BY_SEQ_STORE, null,
          'doc_id=? AND rev=?');
        tx.executeSql(fetchSql, [id, rev], function (tx, res) {
          const {seq} = res.rows.item(0);
          const sql = 'UPDATE ' + BY_SEQ_STORE +
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
        compactRevs(compactTree(docInfo.metadata), id, tx);
      } else if (docInfo.stemmedRevs.length) {
        compactRevs(docInfo.stemmedRevs, id, tx);
      }

      docInfo.metadata.seq = seq;
      delete docInfo.metadata.rev;

      const sql = isUpdate
        ? 'UPDATE ' + DOC_STORE +
      ' SET json=?, max_seq=?, winningseq=' +
      '(SELECT seq FROM ' + BY_SEQ_STORE +
      ' WHERE doc_id=' + DOC_STORE + '.id AND rev=?) WHERE id=?'
        : 'INSERT INTO ' + DOC_STORE +
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
      tx.executeSql('SELECT json FROM ' + DOC_STORE +
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
    let sql = 'SELECT digest FROM ' + ATTACH_STORE + ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      if (result.rows.length) { // attachment already exists
        return callback();
      }
      // we could just insert before selecting and catch the error,
      // but my hunch is that it's cheaper not to serialize the blob
      // from JS to C if we don't have to (TODO: confirm this)
      sql = 'INSERT INTO ' + ATTACH_STORE +
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

  preprocessAttachments(docInfos, 'binary', function (err) {
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

const websqlChanges = new Changes();

/**
 *
 * @param doc
 * @param opts
 * @param api
 * @param txn
 * @param cb
 */
function fetchAttachmentsIfNecessary (doc, opts, api, txn, cb) {
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
  BY_SEQ_STORE + ' (seq, deleted)';
const BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS \'by-seq-doc-id-rev\' ON ' +
  BY_SEQ_STORE + ' (doc_id, rev)';
const DOC_STORE_WINNINGSEQ_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'doc-winningseq-idx\' ON ' +
  DOC_STORE + ' (winningseq)';
const ATTACH_AND_SEQ_STORE_SEQ_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS \'attach-seq-seq-idx\' ON ' +
  ATTACH_AND_SEQ_STORE + ' (seq)';
const ATTACH_AND_SEQ_STORE_ATTACH_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS \'attach-seq-digest-idx\' ON ' +
  ATTACH_AND_SEQ_STORE + ' (digest, seq)';

const DOC_STORE_AND_BY_SEQ_JOINER = BY_SEQ_STORE +
  '.seq = ' + DOC_STORE + '.winningseq';

const SELECT_DOCS = BY_SEQ_STORE + '.seq AS seq, ' +
  BY_SEQ_STORE + '.deleted AS deleted, ' +
  BY_SEQ_STORE + '.json AS data, ' +
  BY_SEQ_STORE + '.rev AS rev, ' +
  DOC_STORE + '.json AS metadata';

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

    tx.executeSql('ALTER TABLE ' + BY_SEQ_STORE +
      ' ADD COLUMN deleted TINYINT(1) DEFAULT 0', [], function () {
      tx.executeSql(BY_SEQ_STORE_DELETED_INDEX_SQL);
      tx.executeSql('ALTER TABLE ' + DOC_STORE +
        ' ADD COLUMN local TINYINT(1) DEFAULT 0', [], function () {
        tx.executeSql('CREATE INDEX IF NOT EXISTS \'doc-store-local-idx\' ON ' +
          DOC_STORE + ' (local, id)');

        const sql = 'SELECT ' + DOC_STORE + '.winningseq AS seq, ' + DOC_STORE +
          '.json AS metadata FROM ' + BY_SEQ_STORE + ' JOIN ' + DOC_STORE +
          ' ON ' + BY_SEQ_STORE + '.seq = ' + DOC_STORE + '.winningseq';

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
          tx.executeSql('UPDATE ' + DOC_STORE + 'SET local = 1 WHERE id IN ' +
            qMarks(local.length), local, function () {
            tx.executeSql('UPDATE ' + BY_SEQ_STORE +
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
    const local = 'CREATE TABLE IF NOT EXISTS ' + LOCAL_STORE +
      ' (id UNIQUE, rev, json)';
    tx.executeSql(local, [], function () {
      const sql = 'SELECT ' + DOC_STORE + '.id AS id, ' +
        BY_SEQ_STORE + '.json AS data ' +
        'FROM ' + BY_SEQ_STORE + ' JOIN ' +
        DOC_STORE + ' ON ' + BY_SEQ_STORE + '.seq = ' +
        DOC_STORE + '.winningseq WHERE local = 1';
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
          tx.executeSql('INSERT INTO ' + LOCAL_STORE +
            ' (id, rev, json) VALUES (?,?,?)',
          [row.id, rev, row.data], function (tx) {
            tx.executeSql('DELETE FROM ' + DOC_STORE + ' WHERE id=?',
              [row.id], function (tx) {
                tx.executeSql('DELETE FROM ' + BY_SEQ_STORE + ' WHERE seq=?',
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
        const sql = 'UPDATE ' + BY_SEQ_STORE +
          ' SET doc_id=?, rev=? WHERE doc_id_rev=?';
        tx.executeSql(sql, [doc_id, rev, doc_id_rev], function () {
          doNext();
        });
      }
      doNext();
    }

    const sql = 'ALTER TABLE ' + BY_SEQ_STORE + ' ADD COLUMN doc_id';
    tx.executeSql(sql, [], function (tx) {
      const sql = 'ALTER TABLE ' + BY_SEQ_STORE + ' ADD COLUMN rev';
      tx.executeSql(sql, [], function (tx) {
        tx.executeSql(BY_SEQ_STORE_DOC_ID_REV_INDEX_SQL, [], function (tx) {
          const sql = 'SELECT hex(doc_id_rev) as hex FROM ' + BY_SEQ_STORE;
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
      const sql = 'SELECT COUNT(*) AS cnt FROM ' + ATTACH_STORE;
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
            SELECT_DOCS + ', ' + DOC_STORE + '.id AS id',
            [DOC_STORE, BY_SEQ_STORE],
            DOC_STORE_AND_BY_SEQ_JOINER,
            null,
            DOC_STORE + '.id '
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
              const sql = 'INSERT INTO ' + ATTACH_AND_SEQ_STORE +
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
      ATTACH_AND_SEQ_STORE + ' (digest, seq INTEGER)';
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
    const sql = 'ALTER TABLE ' + ATTACH_STORE +
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
    const sql = 'ALTER TABLE ' + DOC_STORE +
      ' ADD COLUMN max_seq INTEGER';
    tx.executeSql(sql, [], function (tx) {
      const sql = 'UPDATE ' + DOC_STORE + ' SET max_seq=(SELECT MAX(seq) FROM ' +
        BY_SEQ_STORE + ' WHERE doc_id=id)';
      tx.executeSql(sql, [], function (tx) {
        // add unique index after filling, else we'll get a constraint
        // error when we do the ALTER TABLE
        const sql =
          'CREATE UNIQUE INDEX IF NOT EXISTS \'doc-max-seq-idx\' ON ' +
          DOC_STORE + ' (max_seq)';
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
    tx.executeSql("SELECT HEX('a') AS hex", [], function (tx, res) {
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

      const meta = 'CREATE TABLE IF NOT EXISTS ' + META_STORE +
        ' (dbid, db_version INTEGER)';
      const attach = 'CREATE TABLE IF NOT EXISTS ' + ATTACH_STORE +
        ' (digest UNIQUE, escaped TINYINT(1), body BLOB)';
      const attachAndRev = 'CREATE TABLE IF NOT EXISTS ' +
        ATTACH_AND_SEQ_STORE + ' (digest, seq INTEGER)';
      // TODO: migrate winningseq to INTEGER
      const doc = 'CREATE TABLE IF NOT EXISTS ' + DOC_STORE +
        ' (id unique, json, winningseq, max_seq INTEGER UNIQUE)';
      const seq = 'CREATE TABLE IF NOT EXISTS ' + BY_SEQ_STORE +
        ' (seq INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, ' +
        'json, deleted TINYINT(1), doc_id, rev)';
      const local = 'CREATE TABLE IF NOT EXISTS ' + LOCAL_STORE +
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
            const initSeq = 'INSERT INTO ' + META_STORE +
              ' (db_version, dbid) VALUES (?,?)';
            instanceId = uuid();
            const initSeqArgs = [ADAPTER_VERSION, instanceId];
            tx.executeSql(initSeq, initSeqArgs, function () {
              onGetInstanceId();
            });
          });
        });
      });
    } else { // version > 0
      const setupDone = function () {
        const migrated = dbVersion < ADAPTER_VERSION;
        if (migrated) {
          // update the db version within this transaction
          tx.executeSql('UPDATE ' + META_STORE + ' SET db_version = ' +
            ADAPTER_VERSION);
        }
        // notify db.id() callers
        const sql = 'SELECT dbid FROM ' + META_STORE;
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
    // `META_STORE` is an identifier-quoted name (`"metadata-store"`); here it
    // is needed as a string *value*, so pass the bare name as a bound param.
    const sql = 'SELECT sql FROM sqlite_master WHERE tbl_name = ?';
    tx.executeSql(sql, [META_STORE.replaceAll('"', '')], function (tx, result) {
      if (!result.rows.length) {
        // database hasn't even been created yet (version 0)
        onGetVersion(tx, 0);
      } else if (!(/db_version/).test(result.rows.item(0).sql)) {
        // table was created, but without the new db_version column,
        // so add it.
        tx.executeSql('ALTER TABLE ' + META_STORE +
          ' ADD COLUMN db_version INTEGER', [], function () {
          // before version 2, this column didn't even exist
          onGetVersion(tx, 1);
        });
      } else { // column exists, we can safely get it
        tx.executeSql('SELECT db_version FROM ' + META_STORE,
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
        const sql = 'SELECT MAX(seq) AS seq FROM ' + BY_SEQ_STORE;
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
        [DOC_STORE, BY_SEQ_STORE],
        DOC_STORE + '.id=' + BY_SEQ_STORE + '.doc_id',
        [BY_SEQ_STORE + '.doc_id=?', BY_SEQ_STORE + '.rev=?']
      );
      sqlArgs = [id, opts.rev];
    } else {
      sql = select(
        SELECT_DOCS,
        [DOC_STORE, BY_SEQ_STORE],
        DOC_STORE_AND_BY_SEQ_JOINER,
        DOC_STORE + '.id=?'
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
      'COUNT(' + DOC_STORE + '.id) AS \'num\'',
      [DOC_STORE, BY_SEQ_STORE],
      DOC_STORE_AND_BY_SEQ_JOINER,
      BY_SEQ_STORE + '.deleted=0'
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
      criteria.push(DOC_STORE + '.id = ?');
      sqlArgs.push(key);
    } else if (start !== false || end !== false) {
      if (start !== false) {
        criteria.push(DOC_STORE + '.id ' + (descending ? '<=' : '>=') + ' ?');
        sqlArgs.push(start);
      }
      if (end !== false) {
        let comparator = descending ? '>' : '<';
        if (inclusiveEnd) {
          comparator += '=';
        }
        criteria.push(DOC_STORE + '.id ' + comparator + ' ?');
        sqlArgs.push(end);
      }
      if (key !== false) {
        criteria.push(DOC_STORE + '.id = ?');
        sqlArgs.push(key);
      }
    }

    if (opts.deleted !== 'ok') {
      // report deleted if keys are specified
      criteria.push(BY_SEQ_STORE + '.deleted = 0');
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
          [DOC_STORE, BY_SEQ_STORE],
          DOC_STORE_AND_BY_SEQ_JOINER,
          criteria,
          DOC_STORE + '.id ' + (descending ? 'DESC' : 'ASC')
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
              fetchAttachmentsIfNecessary(doc.doc, opts, api, tx);
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
        DOC_STORE + '.json AS metadata, ' +
        DOC_STORE + '.max_seq AS maxSeq, ' +
        BY_SEQ_STORE + '.json AS winningDoc, ' +
        BY_SEQ_STORE + '.rev AS winningRev ';

      const from = DOC_STORE + ' JOIN ' + BY_SEQ_STORE;

      const joiner = DOC_STORE + '.id=' + BY_SEQ_STORE + '.doc_id' +
        ' AND ' + DOC_STORE + '.winningseq=' + BY_SEQ_STORE + '.seq';

      const criteria = ['maxSeq > ?'];
      let sqlArgs = [opts.since];

      if (opts.doc_ids) {
        criteria.push(DOC_STORE + '.id IN ' + qMarks(opts.doc_ids.length));
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
                fetchAttachmentsIfNecessary(doc, opts, api, tx,
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
      ATTACH_STORE + ' WHERE digest=?';
    tx.executeSql(sql, [digest], function (tx, result) {
      // websql has a bug where \u0000 causes early truncation in strings
      // and blobs. to work around this, we used to use the hex() function,
      // but that's not performant. after migration 6, we remove \u0000
      // and add it back in afterwards
      const item = result.rows.item(0);
      const data = item.escaped
        ? unescapeBlob(item.body)
        : parseHexString(item.body, encoding);
      res = opts.binary ? binStringToBluffer(data, type) : btoa(data);
      callback(null, res);
    });
  };

  api._getRevisionTree = function (docId, callback) {
    db.readTransaction(function (tx) {
      const sql = 'SELECT json AS metadata FROM ' + DOC_STORE + ' WHERE id = ?';
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
      const sql = 'SELECT json AS metadata FROM ' + DOC_STORE + ' WHERE id = ?';
      tx.executeSql(sql, [docId], function (tx, result) {
        const metadata = safeJsonParse(result.rows.item(0).metadata);
        traverseRevTree(metadata.rev_tree, function (isLeaf, pos,
          revHash, ctx, opts) {
          const rev = pos + '-' + revHash;
          if (revs.includes(rev)) {
            opts.status = 'missing';
          }
        });

        const sql = 'UPDATE ' + DOC_STORE + ' SET json = ? WHERE id = ?';
        tx.executeSql(sql, [safeJsonStringify(metadata), docId]);
      });

      compactRevs(revs, docId, tx);
    }, websqlError(callback), function () {
      callback();
    });
  };

  api._getLocal = function (id, callback) {
    db.readTransaction(function (tx) {
      const sql = 'SELECT json, rev FROM ' + LOCAL_STORE + ' WHERE id=?';
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
        sql = 'UPDATE ' + LOCAL_STORE + ' SET rev=?, json=? ' +
          'WHERE id=? AND rev=?';
        values = [newRev, json, id, oldRev];
      } else {
        sql = 'INSERT INTO ' + LOCAL_STORE + ' (id, rev, json) VALUES (?,?,?)';
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
      const sql = 'DELETE FROM ' + LOCAL_STORE + ' WHERE id=? AND rev=?';
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
      const stores = [DOC_STORE, BY_SEQ_STORE, ATTACH_STORE, META_STORE,
        LOCAL_STORE, ATTACH_AND_SEQ_STORE];
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

export default WebSqlPouch;
