import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import {rimraf} from 'rimraf';
import {mkdirp} from 'mkdirp';

chai.use(chaiAsPromised);

// A `describe(name, async function () {...})` wrapper around the
// `await import(...)` calls below was tried previously, to give the
// imported test files a shared parent suite to hang `before`/`after`
// cleanup hooks off of. That doesn't work: Mocha's BDD interface calls the
// `describe` callback and, since it's an `async function`, gets back a
// pending `Promise` immediately and moves on -- popping that suite off its
// "current suite" stack right away, well before the callback's first
// `await` resumes. Every `describe()`/`it()` call made after that point
// (i.e. everything in every imported file below) ends up attached to
// whatever suite was current *before* this one, not to it -- so hooks
// registered on that wrapper suite (like the `testdb`/`testdbs` cleanup
// this file needs) silently never run. Genuine top-level `await` at the
// file's own top level does not have this problem, and Mocha's ESM loader
// (unlike a synchronous `require()`) supports it directly.
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

// test.compaction.js and the rest below exercise a large vendored PouchDB
// test suite against test/pouchdb-node.js's WebSQL adapter. c8's coverage
// check (see the "c8" field in package.json) only instruments `lib/`,
// which test.main.js alone already covers at 100%, and this legacy suite
// takes several minutes to run -- so it's skipped by default. Set
// RUN_LEGACY_TESTS=1 to include it, e.g. to sanity-check
// pouchdb-node.js/pouchdb-browser.js after touching them.
if (process.env.RUN_LEGACY_TESTS) {
  await import('./test.compaction.js');
  await import('./test.mapreduce.js');
  await import('./test.attachments.js');
  await import('./test.basics.js');
  await import('./test.changes.js');
  await import('./test.bulk_docs.js');
  await import('./test.all_docs.js');
  await import('./test.replication.js');
}
