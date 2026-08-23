import PouchDB from './pouchdb.js';

const testUtils = {};

/**
 *
 * @param list
 */
function uniq (list) {
  const map = {};
  list.forEach(function (item) {
    map[item] = true;
  });
  return Object.keys(map);
}

testUtils.isCouchMaster = function () {
  return 'SERVER' in testUtils.params() &&
    testUtils.params().SERVER === 'couchdb-master';
};

testUtils.isSyncGateway = function () {
  return 'SERVER' in testUtils.params() &&
    testUtils.params().SERVER === 'sync-gateway';
};

testUtils.isExpressRouter = function () {
  return 'SERVER' in testUtils.params() &&
    testUtils.params().SERVER === 'pouchdb-express-router';
};

testUtils.params = function () {
  if (typeof process !== 'undefined' && !process.browser) {
    return process.env;
  }
  const paramStr = document.location.search.slice(1);
  return paramStr.split('&').reduce(function (acc, val) {
    if (!val) {
      return acc;
    }
    const tmp = val.split('=');
    acc[tmp[0]] = decodeURIComponent(tmp[1]) || true;
    return acc;
  }, {});
};

testUtils.couchHost = function () {
  if (typeof window !== 'undefined' && globalThis.cordova) {
    // magic route to localhost on android emulator
    return 'http://10.0.2.2:5984';
  }

  if (typeof window !== 'undefined' && globalThis.COUCH_HOST) {
    return globalThis.COUCH_HOST;
  }

  if (typeof process !== 'undefined' && process.env.COUCH_HOST) {
    return process.env.COUCH_HOST;
  }

  if ('couchHost' in testUtils.params()) {
    return testUtils.params().couchHost;
  }

  return 'http://localhost:5984';
};

// Abstracts constructing a Blob object, so it also works in older
// browsers that don't support the native Blob constructor (e.g.
// old QtWebKit versions, Android < 4.4).
// Copied over from createBlob.js in PouchDB because we don't
// want to have to export this function in utils
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

testUtils.makeBlob = function (data, type) {
  if (typeof process !== 'undefined' && !process.browser) {
    return Buffer.from(data, 'binary');
  }
  return createBlob([data], {
    type: (type || 'text/plain')
  });
};

testUtils.binaryStringToBlob = function (bin, type) {
  return PouchDB.utils.binaryStringToBlobOrBuffer(bin, type);
};

testUtils.btoa = function (arg) {
  return PouchDB.utils.btoa(arg);
};

testUtils.atob = function (arg) {
  return PouchDB.utils.atob(arg);
};

testUtils.readBlob = function (blob, callback) {
  if (typeof process !== 'undefined' && !process.browser) {
    callback(blob.toString('binary'));
  } else {
    const reader = new FileReader();
    reader.onloadend = function () {
      let binary = '';
      const bytes = new Uint8Array(this.result || '');
      const length = bytes.byteLength;

      for (let i = 0; i < length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }

      callback(binary);
    };
    reader.readAsArrayBuffer(blob);
  }
};

testUtils.readBlobPromise = function (blob) {
  return new PouchDB.utils.Promise(function (resolve) {
    testUtils.readBlob(blob, resolve);
  });
};

testUtils.base64Blob = function (blob, callback) {
  if (typeof process !== 'undefined' && !process.browser) {
    callback(blob.toString('base64'));
  } else {
    testUtils.readBlob(blob, function (binary) {
      callback(PouchDB.utils.btoa(binary));
    });
  }
};

// Prefix http adapter database names with their host and
// node adapter ones with a db location
testUtils.adapterUrl = function (adapter, name) {
  if (adapter === 'http') {
    return testUtils.couchHost() + '/' + name;
  }
  return name;
};

// Delete specified databases
testUtils.cleanup = function (dbs, done) {
  dbs = uniq(dbs);
  let num = dbs.length;
  const finished = function () {
    if (--num === 0) {
      done();
    }
  };

  dbs.forEach(function (db) {
    new PouchDB(db).destroy(finished, finished);
  });
};

// Put doc after prevRev (so that doc is a child of prevDoc
// in rev_tree). Doc must have _rev. If prevRev is not specified
// just insert doc with correct _rev (new_edits=false!)
testUtils.putAfter = function (db, doc, prevRev, callback) {
  const newDoc = PouchDB.utils.extend({}, doc);
  if (!prevRev) {
    db.put(newDoc, {new_edits: false}, callback);
    return;
  }
  newDoc._revisions = {
    start: +newDoc._rev.split('-', 1)[0],
    ids: [
      newDoc._rev.split('-', 2)[1],
      prevRev.split('-', 2)[1]
    ]
  };
  db.put(newDoc, {new_edits: false}, callback);
};

// docs will be inserted one after another
// starting from root
testUtils.putBranch = function (db, docs, callback) {
  /**
   *
   * @param i
   */
  function insert (i) {
    const doc = docs[i];
    const prev = i > 0 ? docs[i - 1]._rev : null;
    /**
     *
     */
    function next () {
      if (i < docs.length - 1) {
        insert(i + 1);
      } else {
        callback();
      }
    }
    db.get(doc._id, {rev: doc._rev}, function (err) {
      if (err) {
        testUtils.putAfter(db, docs[i], prev, function () {
          next();
        });
      } else {
        next();
      }
    });
  }
  insert(0);
};

testUtils.putTree = function (db, tree, callback) {
  /**
   *
   * @param i
   */
  function insert (i) {
    const branch = tree[i];
    testUtils.putBranch(db, branch, function () {
      if (i < tree.length - 1) {
        insert(i + 1);
      } else {
        callback();
      }
    });
  }
  insert(0);
};

testUtils.isCouchDB = function (cb) {
  cb(null, false);
};

testUtils.writeDocs = function (db, docs, callback, res) {
  if (!res) {
    res = [];
  }
  if (!docs.length) {
    return callback(null, res);
  }
  const doc = docs.shift();
  db.put(doc, function (err, info) {
    res.push(info);
    testUtils.writeDocs(db, docs, callback, res);
  });
};

// Borrowed from: https://stackoverflow.com/a/840849
testUtils.eliminateDuplicates = function (arr) {
  let i, element, len = arr.length, out = [], obj = {};
  for (i = 0; i < len; i++) {
    obj[arr[i]] = 0;
  }
  for (element in obj) {
    if (obj.hasOwnProperty(element)) {
      out.push(element);
    }
  }
  return out;
};

// Promise finally util similar to Q.finally
testUtils.fin = function (promise, cb) {
  return promise.then(function (res) {
    const promise2 = cb();
    if (typeof promise2.then === 'function') {
      return promise2.then(function () {
        return res;
      });
    }
    return res;
  }, function (reason) {
    const promise2 = cb();
    if (typeof promise2.then === 'function') {
      return promise2.then(function () {
        throw reason;
      });
    }
    throw reason;
  });
};

testUtils.promisify = function (fun, context) {
  return function () {
    const args = [...arguments];
    return new PouchDB.utils.Promise(function (resolve, reject) {
      args.push(function (err, res) {
        if (err) {
          return reject(err);
        }
        return resolve(res);
      });
      fun.apply(context, args);
    });
  };
};

export default testUtils;
