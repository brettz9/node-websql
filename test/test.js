import bluebird from 'bluebird';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import denodeify from 'denodeify';
import rimrafOriginal from 'rimraf';
import mkdirp from 'mkdirp';

bluebird.longStackTraces();
chai.use(chaiAsPromised);
const rimraf = denodeify(rimrafOriginal);

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
  });

  after(function () {
    if (typeof process !== 'undefined' && !process.browser) {
      return rimraf('testdb').then(function () {
        return rimraf('testdbs');
      });
    }
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
