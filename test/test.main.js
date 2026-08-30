import Promise from 'bluebird';
import assert from 'node:assert';

import openDatabase from '../lib/index.js';
import customOpenDatabase from '../lib/custom.js';
import SQLiteDatabase from '../lib/sqlite/SQLiteDatabase.js';

Promise.longStackTraces();

/**
 *
 * @param promise
 */
function expectError (promise) {
  return promise.then(function () {
    throw new Error('expected an error');
  }, function (err) {
    assert.ok(err, 'error was thrown');
  });
}

describe('basic test suite', function () {
  this.timeout(60000);

  it('throw error for openDatabase args < 1', function () {
    return expectError(Promise.resolve().then(function () {
      openDatabase();
    }));
  });
  it('throw error for openDatabase args < 2', function () {
    return expectError(Promise.resolve().then(function () {
      openDatabase(':memory:');
    }));
  });
  it('throw error for openDatabase args < 3', function () {
    return expectError(Promise.resolve().then(function () {
      openDatabase(':memory:', 'yolo');
    }));
  });

  it('throw error for openDatabase args < 4', function () {
    return expectError(Promise.resolve().then(function () {
      openDatabase(':memory:', 'yolo', 'hey');
    }));
  });

  it('does a basic database operation', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }).then(function (res) {
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows.item(0)['1 + 1'], 2);
    });
  });

  it('handles an error - select', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return expectError(new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT foo FROM yolo', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }));
  });

  it('handles an error - drop', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return expectError(new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('DROP TABLE blargy blah', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }));
  });

  it('handles an error - delete', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return expectError(new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('DELETE FROM yolo', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }));
  });

  it('handles an error - create', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return expectError(new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE blargy blah', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }));
  });

  it('handles an error - insert', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return expectError(new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('INSERT INTO blargy blah', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }));
  });

  it('does multiple queries', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function (txn, result) {
          resolve(result);
        }, function (txn, err) {
          reject(err);
        });
      });
    }).then(function (res) {
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows.item(0)['1 + 1'], 2);

      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT 2 + 1', [], function (txn, result) {
            resolve(result);
          }, function (txn, err) {
            reject(err);
          });
        });
      });
    }).then(function (res) {
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 1);
      assert.equal(res.rows.item(0)['2 + 1'], 3);
    });
  });

  it('does multiple queries, same event loop', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        const results = Array.from({length: 2});
        let done = 0;
        /**
         *
         */
        function checkDone () {
          if (++done === 2) {
            resolve(results);
          }
        }

        txn.executeSql('SELECT 1 + 1', [], function (txn, result) {
          results[0] = result;
          checkDone();
        }, function (txn, err) {
          reject(err);
        });

        txn.executeSql('SELECT 2 + 1', [], function (txn, result) {
          results[1] = result;
          checkDone();
        }, function (txn, err) {
          reject(err);
        });
      });
    }).then(function (results) {
      assert.equal(results[0].rowsAffected, 0);
      assert.equal(results[0].rows.length, 1);
      assert.equal(results[0].rows.item(0)['1 + 1'], 2);

      assert.equal(results[1].rowsAffected, 0);
      assert.equal(results[1].rows.length, 1);
      assert.equal(results[1].rows.item(0)['2 + 1'], 3);
    });
  });

  it('calls transaction complete callback', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    let called = 0;

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
          txn.executeSql('SELECT 1 + 1', [], function () {
            called++;
            txn.executeSql('SELECT 1 + 1', [], function () {
              called++;
            });
          });
        });
      }, reject, resolve);
    }).then(function () {
      assert.equal(called, 4);
    });
  });

  it('calls transaction complete callback - empty txn', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    const called = 0;

    return new Promise(function (resolve, reject) {
      db.transaction(function () {
      }, reject, resolve);
    }).then(function () {
      assert.equal(called, 0);
    });
  });

  it('calls transaction complete callback - null txn', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    return expectError(new Promise(function (resolve, reject) {
      try {
        db.transaction(null, reject, resolve);
      } catch (err) {
        reject(err);
      }
    }));
  });

  it('calls transaction error callback', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    let called = 0;

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
          txn.executeSql('SELECT 1 + 1', [], function () {
            called++;
            txn.executeSql('SELECT yolo from baz', [], function () {
              called++;
            });
          });
        });
      }, function (err) {
        if (!err) {
          reject(new Error('expected an error here'));
          return;
        }
        resolve();
      }, reject);
    }).then(function () {
      assert.equal(called, 3);
    });
  });

  it('recovers from errors', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    let called = 0;

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
          txn.executeSql('SELECT 1 + 1', [], function () {
            called++;
            txn.executeSql('SELECT yolo from baz', [], function () {
              called++;
            }, function (err) {
              if (!err) {
                return reject(new Error('expected an error here'));
              }
              return false; // ack that the error was handled
            });
          });
        });
      }, reject, resolve);
    }).then(function () {
      assert.equal(called, 3);
    });
  });

  it('recovers from errors, returning undefined', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    let called = 0;

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
          txn.executeSql('SELECT 1 + 1', [], function () {
            called++;
            txn.executeSql('SELECT yolo from baz', [], function () {
              called++;
            }, function (err) {
              if (!err) {
                return reject(new Error('expected an error here'));
              }
              return undefined;
            });
          });
        });
      }, reject, resolve);
    }).then(function () {
      assert.equal(called, 3);
    });
  });

  it('doesn\'t recover if you return true', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    let called = 0;

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called++;
          txn.executeSql('SELECT 1 + 1', [], function () {
            called++;
            txn.executeSql('SELECT yolo from baz', [], function () {
              called++;
            }, function (err) {
              if (!err) {
                return reject(new Error('expected an error here'));
              }
              return true;
            });
          });
        });
      }, function (err) {
        if (!err) {
          reject(new Error('expected an error here'));
          return;
        }
        resolve();
      }, reject);
    }).then(function () {
      assert.equal(called, 3);
    });
  });

  it('queries executed in right order', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);

    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('a');
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('k');
        });
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('b');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('l');
          });
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('c');
            txn.executeSql('SELECT 1 + 1', [], function () {
              called.push('m');
            });
            txn.executeSql('SELECT 1 + 1', [], function () {
              called.push('n');
            });
            txn.executeSql('SELECT yolo from baz', [], function () {
            }, function () {
              called.push('e');
              txn.executeSql('SELECT 1 + 1', [], function () {
                called.push('f');
                txn.executeSql('SELECT yolo from baz', [], function () {
                }, function () {
                  called.push('h');
                  txn.executeSql('SELECT 1 + 1', [], function () {
                    called.push('g');
                  });
                });
                txn.executeSql('SELECT 1 + 1', [], function () {
                  called.push('o');
                });
              });
            });
            txn.executeSql('SELECT 1 + 1', [], function () {
              called.push('i');
            });
          });
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('j');
          });
        });
      }, reject, resolve);
    }).then(function () {
      assert.deepEqual(called,
        ['a', 'k', 'b', 'l', 'c', 'j', 'm', 'n', 'e', 'i', 'f', 'h', 'o', 'g']);
    });
  });

  it('has a version', function () {
    const db = openDatabase(':memory:', '1.0', 'yolo', 100000);
    assert.equal(db.version, '1.0');
  });
});

/**
 *
 * @param db
 * @param sql
 * @param sqlArgs
 */
function transactionPromise (db, sql, sqlArgs) {
  return new Promise(function (resolve, reject) {
    let result;
    db.transaction(function (txn) {
      txn.executeSql(sql, sqlArgs, function (txn, res) {
        result = res;
      });
    }, reject, function () {
      resolve(result);
    });
  });
}

/**
 *
 * @param db
 * @param sql
 * @param sqlArgs
 */
function readTransactionPromise (db, sql, sqlArgs) {
  return new Promise(function (resolve, reject) {
    let result;
    db.readTransaction(function (txn) {
      txn.executeSql(sql, sqlArgs, function (txn, res) {
        result = res;
      });
    }, reject, function () {
      resolve(result);
    });
  });
}

/**
 *
 * @param res
 */
function getInsertId (res) {
  try {
    return res.insertId; // WebSQL will normally throw an error on access here
  } catch (err) {
    return undefined;
  }
}

describe('dedicated db test suite - in-memory', function () {
  this.timeout(60000);

  let db;

  beforeEach(function () {
    db = openDatabase(':memory:', '1.0', 'yolo', 100000);
  });

  afterEach(function () {
    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('DROP TABLE IF EXISTS table1');
        txn.executeSql('DROP TABLE IF EXISTS table2');
        txn.executeSql('DROP TABLE IF EXISTS table3');
      }, reject, resolve);
    }).then(function () {
      db = null;
    });
  });

  it('returns correct rowsAffected/insertId 1', function () {
    const sql = 'SELECT 1 + 1';
    return transactionPromise(db, sql).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
    }).then(function () {
      const sql = 'SELECT 1 + 2';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
    });
  });

  it('returns correct rowsAffected/insertId 2', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function (res) {
      assert.equal(getInsertId(res), 0, 'insertId 1');
      assert.equal(res.rowsAffected, 0, '1 rowsAffected == ' + res.rowsAffected);
      assert.equal(res.rows.length, 0, 'rows.length');
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('foo', 'bar')";
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), 1, 'insertId 2');
      assert.equal(res.rowsAffected, 1, '2 rowsAffected == ' + res.rowsAffected);
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = 'SELECT * from table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId');
      assert.equal(res.rowsAffected, 0, '3 rowsAffected == ' + res.rowsAffected);
      assert.equal(res.rows.length, 1, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'foo',
        text2: 'bar'
      });
    });
  });

  it('returns correct rowsAffected/insertId 3', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function (res) {
      assert.equal(getInsertId(res), 0, 'insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('baz', 'quux')";
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), 1, 'insertId');
      assert.equal(res.rowsAffected, 1, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = 'SELECT * from table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'baz',
        text2: 'quux'
      });
    });
  });

  it('returns correct rowsAffected/insertId 4', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function (res) {
      assert.equal(getInsertId(res), 0, 'insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('baz', 'quux')";
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), 1, 'insertId');
      assert.equal(res.rowsAffected, 1, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), 2);
      assert.equal(res.rowsAffected, 1, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = "UPDATE table1 SET text1 = 'baz' WHERE text2 = 'foobar';";
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId 1');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = "UPDATE table1 SET text1 = 'bongo' WHERE text2 = 'haha';";
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 1, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = 'SELECT * from table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId 2');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 2, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'baz',
        text2: 'quux'
      });
      assert.deepEqual(res.rows.item(1), {
        text1: 'bongo',
        text2: 'haha'
      });
    });
  });

  it('returns correct rowsAffected/insertId 5', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function (res) {
      assert.equal(getInsertId(res), 0, 'insertId 1');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
    }).then(function () {
      const sql = 'CREATE TABLE table2 (text1 string, text2 string)';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), 0, 'insertId 2');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
      const sql = 'CREATE TABLE table3 (text1 string, text2 string)';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), 0, 'insertId 3');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 0, 'rows.length');
    });
  });

  it('returns correct rowsAffected/insertId - delete', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = 'DELETE FROM table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 0);
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = 'DELETE FROM table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 1);
      assert.equal(res.rows.length, 0);
    });
  });

  it('returns correct rowsAffected/insertId - delete 2', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = 'DELETE FROM table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 0);
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('baz', 'bar')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = 'DELETE FROM table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 2);
      assert.equal(res.rows.length, 0);
    });
  });

  it('returns correct rowsAffected/insertId - drop 1', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = 'DROP TABLE table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 0);
    });
  });

  it('returns correct rowsAffected/insertId - drop 2', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = 'DROP TABLE table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 0);
    });
  });

  it('returns correct rowsAffected/insertId - drop 3', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('baz', 'bar')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = 'DROP TABLE table1';
      return transactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined);
      assert.equal(res.rowsAffected, 0);
      assert.equal(res.rows.length, 0);
    });
  });

  it('valid read transaction', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = 'SELECT * from table1';
      return readTransactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId 2');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'toto',
        text2: 'haha'
      });
    });
  });

  it('throws error for writes during read-only transaction', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('quux', 'haha')";
      return expectError(readTransactionPromise(db, sql));
    });
  });

  it('query ignored for invalid read-only transaction write', function () {
    const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
    return transactionPromise(db, sql).then(function () {
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('toto', 'haha')";
      return transactionPromise(db, sql);
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('quux', 'haha')";
      return expectError(readTransactionPromise(db, sql));
    }).then(function () {
      const sql = 'SELECT * from table1';
      return readTransactionPromise(db, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId 2');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'toto',
        text2: 'haha'
      });
    });
  });
});

describe('dedicated db test suite - actual DB', function () {
  this.timeout(60000);

  let db;

  beforeEach(function () {
    db = openDatabase('testdb', '1.0', 'yolo', 100000);
  });

  afterEach(function () {
    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('DROP TABLE IF EXISTS table1');
        txn.executeSql('DROP TABLE IF EXISTS table2');
        txn.executeSql('DROP TABLE IF EXISTS table3');
      }, reject, resolve);
    }).then(function () {
      db = null;
    });
  });


  it('stores data between two DBs', function () {
    const db1 = openDatabase('testdb', '1.0', 'yolo', 100000);
    const db2 = openDatabase('testdb', '1.0', 'yolo', 100000);

    return Promise.resolve().then(function () {
      const sql = 'CREATE TABLE table1 (text1 string, text2 string)';
      return transactionPromise(db1, sql);
    }).then(function () {
      const sql = "INSERT INTO table1 VALUES ('foo', 'bar')";
      return transactionPromise(db1, sql);
    }).then(function () {
      const sql = 'SELECT * from table1;';
      return transactionPromise(db1, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'foo',
        text2: 'bar'
      });
      const sql = 'SELECT * from table1;';
      return transactionPromise(db2, sql);
    }).then(function (res) {
      assert.equal(getInsertId(res), undefined, 'no insertId');
      assert.equal(res.rowsAffected, 0, 'rowsAffected');
      assert.equal(res.rows.length, 1, 'rows.length');
      assert.deepEqual(res.rows.item(0), {
        text1: 'foo',
        text2: 'bar'
      });
    });
  });
});

describe('advanced test suite - actual DB', function () {
  this.timeout(60000);

  let db;

  beforeEach(function () {
    db = openDatabase('testdb', '1.0', 'yolo', 100000);
  });

  afterEach(function () {
    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('DROP TABLE IF EXISTS table1');
        txn.executeSql('DROP TABLE IF EXISTS table2');
        txn.executeSql('DROP TABLE IF EXISTS table3');
        txn.executeSql('DROP TABLE IF EXISTS foo');
        txn.executeSql('DROP TABLE IF EXISTS yolo');
      }, reject, resolve);
    }).then(function () {
      db = null;
    });
  });

  /**
   *
   * @param res
   */
  function rowsToJson (res) {
    const output = [];
    for (let i = 0; i < res.rows.length; i++) {
      output.push(res.rows.item(i));
    }
    return structuredClone(output);
  }

  it('handles errors and callback correctly 0', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE foo (bar text);', [], function () {
          called.push('a');
        });
        txn.executeSql("INSERT INTO foo VALUES ('baz')", [], function () {
          called.push('b');
        });
      }, function (err) {
        console.log(err);
        reject(err);
      }, resolve);
    }).then(function () {
      assert.deepEqual(called, ['a', 'b']);
    });
  });

  it('handles errors and callback correctly 1', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE foo (bar text);', [], function () {
          called.push('a');
        });
        txn.executeSql("INSERT INTO foo VALUES ('baz')", [], function () {
          called.push('b');
          txn.executeSql("INSERT INTO yolo VALUES ('hey')", [], function () {
            called.push('z');
          }, function () {
            called.push('c');
            txn.executeSql("INSERT INTO foo VALUES ('baz')", [], function () {
              called.push('f');
            });
          });
          txn.executeSql("INSERT INTO foo VALUES ('haha')", [], null, function () {
            called.push('e');
          });
        });
      }, function (err) {
        console.log(err);
        reject(err);
      }, resolve);
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'c', 'f']);
    });
  });

  it('handles errors and callback correctly 2', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (bar text);', [], function () {
          called.push('a');
        });
        txn.executeSql("INSERT INTO table1 VALUES ('buzz')", [], function () {
          called.push('b');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({a: rowsToJson(res)});
          });
          txn.executeSql("INSERT INTO table1 VALUES ('hey')", [], null, function () {
            called.push('c');
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({d: rowsToJson(res)});
            });
            txn.executeSql("INSERT INTO table1 VALUES ('baz')", [], function () {
              called.push('f');
              txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
                called.push({f: rowsToJson(res)});
              });
            });
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({e: rowsToJson(res)});
            });
          });
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({b: rowsToJson(res)});
          });
          txn.executeSql("INSERT INTO table1 VALUES ('haha')", [], null, function () {
            called.push('e');
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({d: rowsToJson(res)});
            });
          });
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({c: rowsToJson(res)});
          });
        });
      }, function (err) {
        console.log(err);
        reject(err);
      }, resolve);
    }).then(function () {
      assert.deepEqual(called, [
        'a',
        'b',
        {
          a: [
            {bar: 'buzz'}
          ]
        },
        {
          b: [
            {bar: 'buzz'},
            {bar: 'hey'}
          ]
        },
        {
          c: [
            {bar: 'buzz'},
            {bar: 'hey'},
            {bar: 'haha'}
          ]
        }
      ]);
    });
  });

  it('handles errors and callback correctly 3', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (bar text);', [], function () {
          called.push('a');
        });
        txn.executeSql("INSERT INTO table1 VALUES ('buzz')", [], function () {
          called.push('b');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({a: rowsToJson(res)});
          });
          txn.executeSql("INSERT INTO yolo VALUES ('hey')", [], null, function () {
            called.push('c');
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({d: rowsToJson(res)});
            });
            txn.executeSql("INSERT INTO table1 VALUES ('baz')", [], function () {
              called.push('f');
              txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
                called.push({f: rowsToJson(res)});
              });
            });
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({e: rowsToJson(res)});
            });
          });
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({b: rowsToJson(res)});
          });
          txn.executeSql("INSERT INTO table1 VALUES ('haha')", [], null, function () {
            called.push('e');
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({d: rowsToJson(res)});
            });
          });
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({c: rowsToJson(res)});
          });
        });
      }, function (err) {
        console.log(err);
        reject(err);
      }, resolve);
    }).then(function () {
      assert.deepEqual(called, [
        'a',
        'b',
        {
          a: [{bar: 'buzz'}]
        },
        'c',
        {
          b: [{bar: 'buzz'}]
        },
        {
          c: [{bar: 'buzz'}, {bar: 'haha'}]
        },
        {
          d: [{bar: 'buzz'}, {bar: 'haha'}]
        },
        'f',
        {
          e: [{bar: 'buzz'}, {bar: 'haha'}, {bar: 'baz'}]
        },
        {
          f: [{bar: 'buzz'}, {bar: 'haha'}, {bar: 'baz'}]
        }
      ]);
    });
  });

  it('handles errors and callback correctly 4', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (bar text);', [], function () {
          called.push('a');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({1: rowsToJson(res)});
          });
        });
        txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
          called.push('b');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({2: rowsToJson(res)});
          });
        });
        txn.executeSql("INSERT INTO table1 VALUES ('c')", [], function () {
          called.push('c');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({3: rowsToJson(res)});
          });
        });
        txn.executeSql('DROP TABLE table1', [], function () {
          called.push('d');
        });
        txn.executeSql('CREATE TABLE table1 (bar text);', [], function () {
          called.push('e');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({4: rowsToJson(res)});
          });
        });
      }, function (err) {
        console.log(err);
        reject(err);
      }, resolve);
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'c', 'd', 'e', {1: []}, {2: []}, {3: []}, {4: []}]);
    });
  });

  it('handles errors and callback correctly 5', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (bar text);', [], function () {
          called.push('a');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({1: rowsToJson(res)});
          });
        });
        txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
          called.push({z: rowsToJson(res)});
        });
        txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
          called.push('b');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({2: rowsToJson(res)});
          });
        });
        txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
          called.push({x: rowsToJson(res)});
        });
        txn.executeSql("INSERT INTO table1 VALUES ('b')", [], function () {
          called.push('c');
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({3: rowsToJson(res)});
          });
        });
        txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
          called.push({y: rowsToJson(res)});
        });
        txn.executeSql('DROP TABLE table1', [], function () {
          called.push('d');
        });
        txn.executeSql('SELECT * FROM table1', [], function () {
          called.push('should not happen');
        }, function () {
          called.push('expected error');
        });
        txn.executeSql('CREATE TABLE table1 (bar text);', [], function () {
          called.push('e');
          txn.executeSql("INSERT INTO table1 VALUES ('c')", [], function () {
            called.push('w');
            txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
              called.push({v: rowsToJson(res)});
            });
          });
          txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
            called.push({4: rowsToJson(res)});
          });
        });
        txn.executeSql('SELECT * FROM table1', [], function (txn, res) {
          called.push({x: rowsToJson(res)});
        });
      }, function (err) {
        console.log(err);
        reject(err);
      }, resolve);
    }).then(function () {
      assert.deepEqual(called, [
        'a',
        {z: []},
        'b',
        {x: [{bar: 'a'}]},
        'c',
        {y: [{bar: 'a'}, {bar: 'b'}]},
        'd',
        'expected error',
        'e',
        {x: []},
        {1: []},
        {2: []},
        {3: []},
        'w',
        {4: [{bar: 'c'}]},
        {v: [{bar: 'c'}]}
      ]);
    });
  });

  it('handles errors and callback correctly 6', function () {
    const called = [];

    return new Promise(function (resolve) {
      try {
        db.transaction(function (txn) {
          called.push(1);
          txn.executeSql('SELECT 1', [], function () {
            called.push(2);
            throw new Error('boom');
          }, function () {
            called.push(3);
            return true;
          });
        }, function () {
          called.push(4);
          resolve(true);
        }, function () {
          called.push(5);
        });
      } catch (error) {
        called.push(6);
      }
    }).then(function () {
      assert.deepEqual(called, [1, 2, 4]);
    });
  });

  it('rolls back after an error 1', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('DELETE FROM table1', [], function () {
            called.push('c');
          });
          txn.executeSql('SELECT * FROM notexist', function () {
            called.push('z');
          });
        }, resolve, reject);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'c', [{foo: 'a'}]]);
    });
  });

  it('rolls back after an error 2', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('DELETE FROM table1', [], function () {
            called.push('c');
            txn.executeSql('SELECT * FROM notexist', function () {
              called.push('z');
            });
          });
        }, resolve, reject);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'c', [{foo: 'a'}]]);
    });
  });

  it('rolls back after an error 3', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
            called.push('d');
          });
          txn.executeSql("INSERT INTO table1 VALUES ('z')", [], function () {
            called.push('c');
            txn.executeSql("INSERT INTO table1 VALUES ('v')", [], function () {
              called.push('f');
            });
            txn.executeSql('SELECT * FROM notexist', function () {
              called.push('z');
            });
            txn.executeSql("INSERT INTO table1 VALUES ('u')", [], function () {
              called.push('g');
            });
          });
          txn.executeSql("INSERT INTO table1 VALUES ('w')", [], function () {
            called.push('e');
          });
        }, resolve, reject);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'd', 'c', 'e', 'f', [{foo: 'a'}]]);
    });
  });

  it('rolls back after an error 4', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.readTransaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function () {
            called.push('d');
          });
          // readTransaction throws an error here
          txn.executeSql("INSERT INTO table1 VALUES ('z')", [], function () {
            called.push('c');
          });
          txn.executeSql('SELECT * FROM table1', [], function () {
            called.push('e');
          });
        }, resolve, reject);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'd', [{foo: 'a'}]]);
    });
  });

  it('rolls back after an error 5', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.readTransaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function () {
            called.push('d');
          });
          txn.executeSql('SELECT * FROM table1', [], function () {
            called.push('e');
            txn.executeSql('SELECT * FROM table1', [], function () {
              called.push('f');
              // readTransaction throws an error here
              txn.executeSql("INSERT INTO table1 VALUES ('z')", [], function () {
                called.push('c');
              });
            });
          });
        }, resolve, reject);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'd', 'e', 'f', [{foo: 'a'}]]);
    });
  });

  it('does not roll back if caught 1', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.readTransaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function () {
            called.push('d');
          });
          // readTransaction throws an error here
          txn.executeSql("INSERT INTO table1 VALUES ('z')", [], function () {
            called.push('c');
          }, function () {
            called.push('g');
          });
          txn.executeSql('SELECT * FROM table1', [], function () {
            called.push('e');
          });
        }, reject, resolve);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'd', 'g', 'e', [{foo: 'a'}]]);
    });
  });

  it('does not roll back if caught 2', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql("INSERT INTO table1 VALUES ('n')", [], function () {
            called.push('d');
          });
          txn.executeSql("INSERT INTO yolo VALUES ('z')", [], function () {
            called.push('c');
          }, function () {
            called.push('g');
            txn.executeSql("INSERT INTO table1 VALUES ('p')", [], function () {
              called.push('f');
            });
          });
          txn.executeSql("INSERT INTO table1 VALUES ('o')", [], function () {
            called.push('e');
          });
        }, reject, resolve);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, [
        'a', 'b', 'd', 'g', 'e', 'f', [{foo: 'a'},
          {foo: 'n'}, {foo: 'o'}, {foo: 'p'}]
      ]);
    });
  });

  it('does not roll back if caught 3', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("INSERT INTO table1 VALUES ('a')", [], function () {
            called.push('b');
          });
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql("INSERT INTO table1 VALUES ('n')", [], function () {
            called.push('d');
          });
          txn.executeSql("INSERT INTO yolo VALUES ('z')", [], function () {
            called.push('c');
          }, function () {
            called.push('g');
            txn.executeSql("INSERT INTO yolo VALUES ('p')", [], function () {
              called.push('f');
            }, function () {
              called.push('h');
              txn.executeSql("INSERT INTO table1 VALUES ('x')", [], function () {
                called.push('i');
              });
              txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
                called.push('j');
              });
              txn.executeSql("INSERT INTO table1 VALUES ('z')", [], function () {
                called.push('k');
              });
            });
          });
          txn.executeSql("INSERT INTO table1 VALUES ('o')", [], function () {
            called.push('e');
          });
        }, reject, resolve);
      });
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, [
        'a', 'b', 'd', 'g', 'e', 'h', 'i', 'j', 'k',
        [{foo: 'a'}, {foo: 'n'}, {foo: 'o'}, {foo: 'x'},
          {foo: 'y'}, {foo: 'z'}]
      ]);
    });
  });

  it('query order matters 1', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql("INSERT INTO table1 VALUES ('x')", [], function () {
          called.push('x');
        }, function () {
          called.push('y');
        });
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
        });
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('z');
        }, function () {
          called.push('w');
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['y', 'a', 'z', [{foo: 'y'}]]);
    });
  });

  it('query order matters 2', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql("INSERT INTO table1 VALUES ('x')", [], function () {
          called.push('x');
        }, function () {
          called.push('y');
        });
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("DELETE FROM table1 WHERE foo='y'", [], function () {
            called.push('c');
          });
        });
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('z');
        }, function () {
          called.push('w');
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['y', 'a', 'z', 'c', []]);
    });
  });

  it('query order matters 3', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
        });
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('b');
        });
        txn.executeSql("DELETE FROM table1 WHERE foo='y'", [], function () {
          called.push('c');
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'c', []]);
    });
  });

  it('query order matters 4', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql("DELETE FROM table1 WHERE foo='y'", [], function () {
            called.push('c');
          });
        });
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('b');
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'b', 'c', []]);
    });
  });

  it('query order matters 5', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
        });
        txn.executeSql("DELETE FROM table1 WHERE foo='y'", [], function () {
          called.push('c');
        });
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('b');
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'c', 'b', [{foo: 'y'}]]);
    });
  });

  it('query order matters 6', function () {
    const called = [];

    return new Promise(function (resolve, reject) {
      db.transaction(function (txn) {
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('a');
          txn.executeSql('DROP TABLE table1;', [], function () {
            called.push('b');
          });
          txn.executeSql('CREATE TABLE table1 (foo text);', [], function () {
            called.push('c');
          });
          txn.executeSql("INSERT INTO table1 VALUES ('x')", [], function () {
            called.push('d');
          });
        });
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('e');
        });
      }, reject, resolve);
    }).then(function () {
      return new Promise(function (resolve, reject) {
        db.transaction(function (txn) {
          txn.executeSql('SELECT * FROM table1', [], function (tx, res) {
            called.push(rowsToJson(res));
          });
        }, reject, resolve);
      });
    }).then(function () {
      assert.deepEqual(called, ['a', 'e', 'b', 'c', 'd', [{foo: 'x'}]]);
    });
  });

  it('callback order 1', function () {
    const called = [];
    return new Promise(function (resolve, reject) {
      let numTransactions = 2;
      let rejected;
      /**
       *
       */
      function done () {
        if (rejected) {
          reject();
          return;
        }
        resolve();
      }
      /**
       *
       */
      function resolveOne () {
        if (!--numTransactions) {
          done();
        }
      }
      /**
       *
       */
      function rejectOne () {
        rejected = true;
        if (!--numTransactions) {
          done();
        }
      }

      called.push('a');
      db.transaction(function (txn) {
        called.push('b');
        txn.executeSql('CREATE TABLE table1 (foo text)', [], function () {
          called.push('c');
          txn.executeSql('DROP TABLE table1;', [], function () {
            called.push('d');
          });
          called.push('e');
          txn.executeSql('CREATE TABLE table1 (foo text);', [], function () {
            called.push('f');
          });
          called.push('g');
          txn.executeSql("INSERT INTO table1 VALUES ('x')", [], function () {
            called.push('h');
          });
          called.push('i');
        });
        called.push('j');
        txn.executeSql("INSERT INTO table1 VALUES ('y')", [], function () {
          called.push('k');
        });
        called.push('l');
      }, rejectOne, resolveOne);
      called.push('m');
      db.transaction(function (txn) {
        called.push('n');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('o');
        });
        called.push('p');
      }, rejectOne, resolveOne);
    }).then(function () {
      const expected = [
        'a', 'm', 'b', 'j', 'l', 'c', 'e', 'g', 'i', 'k', 'd', 'f', 'h', 'n', 'p', 'o'
      ];
      assert.deepEqual(called, expected);
    });
  });

  it('callback order 2', function () {
    const called = [];
    return new Promise(function (resolve, reject) {
      let numTransactions = 7;
      let rejected;
      /**
       *
       */
      function done () {
        if (rejected) {
          reject();
          return;
        }
        resolve();
      }
      /**
       *
       */
      function resolveOne () {
        if (!--numTransactions) {
          done();
        }
      }
      /**
       *
       */
      function rejectOne () {
        rejected = true;
        if (!--numTransactions) {
          done();
        }
      }

      called.push('a');
      db.readTransaction(function (txn) {
        called.push('b');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('c');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('d');
          });
          called.push('e');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('f');
          });
          called.push('g');
        });
        called.push('j');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('k');
        });
        called.push('l');
      }, rejectOne, resolveOne);
      called.push('m');
      db.transaction(function (txn) {
        called.push('n');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('o');
        });
        called.push('p');
      }, rejectOne, resolveOne);
      called.push('1');
      db.readTransaction(function (txn) {
        called.push('2');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('3');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('4');
          });
          called.push('5');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('6');
          });
          called.push('7');
        });
        called.push('8');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('9');
        });
        called.push('10');
      }, rejectOne, resolveOne);
      called.push('11');
      db.readTransaction(function (txn) {
        called.push('alpha');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('beta');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('gamma');
          });
          called.push('delta');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('epsilon');
          });
          called.push('zeta');
        });
        called.push('eta');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('theta');
        });
        called.push('iota');
      }, rejectOne, resolveOne);
      called.push('ichi');
      db.readTransaction(function (txn) {
        called.push('ni');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('san');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('shi');
          });
          called.push('go');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('roku');
          });
          called.push('shichi');
        });
        called.push('hachi');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('kyuu');
        });
        called.push('juu');
      }, rejectOne, resolveOne);
      called.push('un');
      db.readTransaction(function (txn) {
        called.push('deux');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('trois');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('quatre');
          });
          called.push('cinq');
          txn.executeSql('SELECT 1 + 1', [], function () {
            called.push('six');
          });
          called.push('sept');
        });
        called.push('huit');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('neuf');
        });
        called.push('dix');
      }, rejectOne, resolveOne);
      called.push('onze');
      db.transaction(function (txn) {
        called.push('12');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('13');
        });
        called.push('14');
      }, rejectOne, resolveOne);
    }).then(function () {
      const expected = ['a', 'm', '1', '11', 'ichi', 'un', 'onze', 'b', 'j',
        'l', 'c', 'e', 'g', 'k', 'd', 'f', 'n', 'p', 'o', '2', '8', '10',
        '3', '5', '7', '9', '4', '6', 'alpha', 'eta', 'iota', 'beta',
        'delta', 'zeta', 'theta', 'gamma', 'epsilon', 'ni', 'hachi', 'juu',
        'san', 'go', 'shichi', 'kyuu', 'shi', 'roku', 'deux', 'huit', 'dix',
        'trois', 'cinq', 'sept', 'neuf', 'quatre', 'six', '12', '14', '13'];
      assert.deepEqual(called, expected);
    });
  });

  it('callback order 3', function () {
    const called = [];
    return new Promise(function (resolve) {
      called.push('a');
      const db2 = openDatabase('testdbs/testdb-' + Math.random(),
        '1.0', 'yolo', 1, function (db3) {
          called.push('b');
          resolve([db2, db3]);
        });
      called.push('c');
    }).then(function (dbs) {
      assert.ok(dbs[0] === dbs[1]);
      assert.deepEqual(called, ['a', 'c', 'b']);
    });
  });

  it('concurrentReaders: true lets multiple readTransaction()s run concurrently', function () {
    const called = [];
    const openConcurrentDb = customOpenDatabase(SQLiteDatabase, {websql: {concurrentReaders: true}});
    const db2 = openConcurrentDb('testdbs/testdb-' + Math.random(), '1.0', 'yolo', 100000);
    return new Promise(function (resolve, reject) {
      let numTransactions = 2;
      let rejected;
      /**
       *
       */
      function resolveOne () {
        if (!--numTransactions) {
          if (rejected) {
            reject();
          } else {
            resolve();
          }
        }
      }
      /**
       *
       */
      function rejectOne () {
        rejected = true;
        resolveOne();
      }

      db2.readTransaction(function (txn) {
        called.push('reader1-start');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('reader1-end');
        });
      }, rejectOne, resolveOne);
      db2.readTransaction(function (txn) {
        called.push('reader2-start');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('reader2-end');
        });
      }, rejectOne, resolveOne);
    }).then(function () {
      // Both readers were already running -- neither had finished -- by the
      // time the second one started, proving they ran concurrently rather
      // than the second waiting on the first's full completion.
      assert.deepEqual(called.slice(0, 2), ['reader1-start', 'reader2-start']);
    });
  });

  it('concurrentReaders: true still gives transaction() exclusivity over queued readers', function () {
    const called = [];
    const openConcurrentDb = customOpenDatabase(SQLiteDatabase, {websql: {concurrentReaders: true}});
    const db2 = openConcurrentDb('testdbs/testdb-' + Math.random(), '1.0', 'yolo', 100000);
    return new Promise(function (resolve, reject) {
      let numTransactions = 3;
      let rejected;
      /**
       *
       */
      function resolveOne () {
        if (!--numTransactions) {
          if (rejected) {
            reject();
          } else {
            resolve();
          }
        }
      }
      /**
       *
       */
      function rejectOne () {
        rejected = true;
        resolveOne();
      }

      db2.transaction(function (txn) {
        called.push('writer-start');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('writer-end');
        });
      }, rejectOne, resolveOne);
      db2.readTransaction(function (txn) {
        called.push('reader1-start');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('reader1-end');
        });
      }, rejectOne, resolveOne);
      db2.readTransaction(function (txn) {
        called.push('reader2-start');
        txn.executeSql('SELECT 1 + 1', [], function () {
          called.push('reader2-end');
        });
      }, rejectOne, resolveOne);
    }).then(function () {
      // Both readers, though queued after the writer while
      // `concurrentReaders` is on, still waited for the writer to finish
      // rather than starting alongside it.
      assert.deepEqual(called.slice(0, 2), ['writer-start', 'writer-end']);
    });
  });
});

describe('SQLiteDatabase driver internals', function () {
  this.timeout(10000);

  /**
   * @param {string} label
   * @returns {string}
   */
  function tmpName (label) {
    return 'testdbs/drv-' + label + '-' + Math.random();
  }

  /**
   * Promised, single-batch `SQLiteDatabase#exec`.
   * @param {import('../lib/sqlite/SQLiteDatabase.js').default} db
   * @param {string | {sql: string, args: unknown[]}[]} batch
   * @param {boolean} [readOnly]
   * @returns {Promise<import('../lib/sqlite/SQLiteResult.js').default[]>}
   */
  function exec (db, batch, readOnly) {
    const queries = typeof batch === 'string' ? [{sql: batch, args: []}] : batch;
    return new Promise(function (resolve, reject) {
      db.exec(queries, Boolean(readOnly), function (err, results) {
        if (err) {
          reject(err);
          return;
        }
        resolve(/** @type {import('../lib/sqlite/SQLiteResult.js').default[]} */ (
          results
        ));
      });
    });
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function wait (ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  const BEGIN = [{sql: 'BEGIN', args: []}];
  const COMMIT = [{sql: 'COMMIT', args: []}];
  const ROLLBACK = [{sql: 'ROLLBACK', args: []}];

  it('configure() accepts busyTimeout, trace, profile and memoryQuota', async function () {
    const db = new SQLiteDatabase(':memory:');
    db.configure('busyTimeout', 3000);
    db.configure('memoryQuota', 500000);
    /** @type {string[]} */
    const traced = [];
    /** @type {number[]} */
    const profiled = [];
    db.configure('trace', function (sql) {
      traced.push(sql);
    });
    db.configure('profile', function (sql, ms) {
      profiled.push(/** @type {number} */ (ms));
    });
    await exec(db, 'CREATE TABLE t (a)');
    await exec(db, 'SELECT * FROM t', true);
    assert.ok(traced.includes('CREATE TABLE t (a)'));
    assert.ok(traced.includes('SELECT * FROM t'));
    assert.equal(profiled.length, 2);
    assert.equal(typeof profiled[0], 'number');
    db.close();
  });

  it('constructor options are applied (busyTimeout, memoryQuota, trace, profile)', async function () {
    /** @type {string[]} */
    const traced = [];
    /** @type {number} */
    let profileCalls = 0;
    const db = new SQLiteDatabase(':memory:', {
      busyTimeout: 2500,
      memoryQuota: 400000,
      trace (sql) {
        traced.push(sql);
      },
      profile () {
        profileCalls++;
      }
    });
    await exec(db, 'CREATE TABLE t (a)');
    assert.deepEqual(traced, ['CREATE TABLE t (a)']);
    assert.equal(profileCalls, 1);
    db.close();
  });

  it('close() reports success and surfaces errors through its callback', function (done) {
    // no callback, succeeds
    new SQLiteDatabase(':memory:').close();

    const ok = new SQLiteDatabase(':memory:');
    ok.close(function (err) {
      assert.equal(err, null);

      const boom = new SQLiteDatabase(':memory:');
      boom._db.close = function () {
        throw new Error('boom');
      };
      boom.close(function (err2) {
        assert.equal(/** @type {Error} */ (err2).message, 'boom');

        // error path with no callback must not throw
        const boom2 = new SQLiteDatabase(':memory:');
        boom2._db.close = function () {
          throw new Error('boom2');
        };
        assert.doesNotThrow(function () {
          boom2.close();
        });
        done();
      });
    });
  });

  it('readOnly batch rejects a non-SELECT statement without executing it', async function () {
    const db = new SQLiteDatabase(':memory:');
    const [res] = await exec(db, 'DELETE FROM whatever', true);
    assert.ok(res.error);
    db.close();
  });

  it('a file-path batch with no BEGIN bypasses the per-file lock', async function () {
    const db = new SQLiteDatabase(tmpName('nobegin'));
    const [res] = await exec(db, 'SELECT 1 AS x', true);
    assert.equal(res.rows[0].x, 1);
    db.close();
  });

  it('a second writer waits for the first to COMMIT', async function () {
    const name = tmpName('ww');
    const a = new SQLiteDatabase(name);
    const b = new SQLiteDatabase(name);
    /** @type {string[]} */
    const order = [];

    await exec(a, BEGIN);
    order.push('a-begin');

    const bBegun = exec(b, BEGIN).then(function () {
      order.push('b-begin');
    });
    await wait(50);
    assert.deepEqual(order, ['a-begin'], 'b stayed queued while a held the writer lock');

    await exec(a, COMMIT);
    order.push('a-commit');
    await bBegun;
    // b only ran after a released the writer lock; the exact a-commit/b-begin
    // interleaving past that point is down to scheduler timing.
    assert.equal(order[0], 'a-begin');
    assert.deepEqual([...order].sort(), ['a-begin', 'a-commit', 'b-begin']);

    await exec(b, COMMIT);
    a.close();
    b.close();
  });

  it('the same instance re-issuing BEGIN is not blocked by its own writer lock', async function () {
    const name = tmpName('self');
    const a = new SQLiteDatabase(name);
    await exec(a, BEGIN);
    const [res] = await exec(a, BEGIN); // activeWriter === this: proceeds, SQLite reports the nested-BEGIN error
    assert.ok(res.error);
    await exec(a, ROLLBACK);
    a.close();
  });

  it('concurrent readers share the file; a queued writer waits for the last reader', async function () {
    const name = tmpName('rr');
    const setup = new SQLiteDatabase(name);
    await exec(setup, [
      {sql: 'BEGIN', args: []},
      {sql: 'CREATE TABLE t (a)', args: []},
      {sql: 'COMMIT', args: []}
    ]);
    setup.close();

    const r1 = new SQLiteDatabase(name);
    const r2 = new SQLiteDatabase(name);
    const w = new SQLiteDatabase(name);
    /** @type {string[]} */
    const order = [];

    await exec(r1, BEGIN, true);
    order.push('r1');
    await exec(r2, BEGIN, true);
    order.push('r2');

    const wBegun = exec(w, BEGIN).then(function () {
      order.push('w');
    });
    await wait(50);
    assert.deepEqual(order, ['r1', 'r2'], 'writer waits while readers hold the file');

    await exec(r1, COMMIT, true);
    await wait(30);
    assert.deepEqual(order, ['r1', 'r2'], 'writer still waits with one reader remaining');

    await exec(r2, COMMIT, true);
    await wBegun;
    assert.deepEqual(order, ['r1', 'r2', 'w']);

    await exec(w, COMMIT);
    r1.close();
    r2.close();
    w.close();
  });

  it('readers queued behind a writer are all resumed together when it COMMITs', async function () {
    const name = tmpName('wrr');
    const w = new SQLiteDatabase(name);
    const r1 = new SQLiteDatabase(name);
    const r2 = new SQLiteDatabase(name);
    /** @type {string[]} */
    const order = [];

    await exec(w, BEGIN);
    order.push('w');

    const r1Begun = exec(r1, BEGIN, true).then(function () {
      order.push('r1');
    });
    const r2Begun = exec(r2, BEGIN, true).then(function () {
      order.push('r2');
    });
    await wait(50);
    assert.deepEqual(order, ['w'], 'both readers stayed queued behind the writer');

    await exec(w, COMMIT);
    await Promise.all([r1Begun, r2Begun]);
    assert.deepEqual([...order].sort(), ['r1', 'r2', 'w']);

    await exec(r1, COMMIT, true);
    await exec(r2, COMMIT, true);
    w.close();
    r1.close();
    r2.close();
  });
});
