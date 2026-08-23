const isBrowser = typeof process === 'undefined' || process.browser;

const {default: PouchDB} = isBrowser
  ? await import('./pouchdb-browser.js')
  : await import('./pouchdb-node.js');

export default PouchDB;
