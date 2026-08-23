import bluebird from 'bluebird';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import denodeify from 'denodeify';
import rimrafOriginal from 'rimraf';
import mkdirp from 'mkdirp';

bluebird.longStackTraces();
chai.use(chaiAsPromised);
const rimraf = denodeify(rimrafOriginal);

// This can't use a top-level `await import(...)` below instead of the
// `async function` here: Mocha loads the entry test file via a synchronous
// `require()`, which throws `ERR_REQUIRE_ASYNC_MODULE` for any ES module
// that has top-level await. Wrapping the imports in this `describe()`
// callback avoids that, at the cost of Mocha not awaiting this callback --
// if one of the `await import(...)` calls below throws, every test after
// it silently never registers (the run reports "0 passing" with no error).
describe('node-websql test suite', async function () {
  this.timeout(300000);

  before(function () {
    if (typeof process !== 'undefined' && !process.browser) {
      return rimraf('testdb').then(function () {
        return rimraf('testdbs');
      }).then(function () {
        return mkdirp('testdbs');
      });
    }
    return undefined;
  });

  after(function () {
    if (typeof process !== 'undefined' && !process.browser) {
      return rimraf('testdb').then(function () {
        return rimraf('testdbs');
      });
    }
    return undefined;
  });

  await import('./test.main.js');
  await import('./test.compaction.js');
  await import('./test.mapreduce.js');
  await import('./test.attachments.js');
  await import('./test.basics.js');
  await import('./test.changes.js');
  await import('./test.bulk_docs.js');
  await import('./test.all_docs.js');
  await import('./test.replication.js');
});
