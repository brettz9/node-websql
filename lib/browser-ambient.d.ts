// `lib/browser.js` re-exports the browser's native global, which is only
// declared (via `index.d.ts`, at the package root) on `Window`/
// `WorkerUtils`, and this project doesn't pull in DOM lib types.
//
// This is deliberately its own file, separate from `lib/ambient.d.ts`:
// `browser.js` isn't reachable from any published `.d.ts` (it's swapped in
// only via package.json's bundler-only `"browser"` field, which TypeScript
// doesn't follow for types), so unlike `ambient.d.ts` this file must NOT
// be reference-chained into the public type surface -- doing so would
// require `index.d.ts` (for `WindowDatabase`) to also be reachable there,
// which it isn't (see `tsconfig.json`'s comment on `index.d.ts`). This
// file only needs to be part of the *local* dev-time program that
// type-checks `lib/browser.js` itself.
declare var openDatabase: WindowDatabase['openDatabase'];
