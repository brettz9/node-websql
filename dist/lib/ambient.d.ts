/// <reference path="./sqlite3-augment.d.ts" />

// Ambient declarations for dependencies that ship no types of their own.
//
// This is deliberately a plain ambient *script* (no top-level import or
// export), not a module: in a module file, `declare module 'x' {}` for a
// package with no existing type declarations is rejected as "cannot
// augment an untyped module" (TS2665). In script mode it instead declares
// a brand-new ambient module, which is what these packages need. (Compare
// `lib/sqlite3-augment.d.ts`, which augments 'sqlite3' -- a package that
// *does* ship its own types -- and needs the opposite: module mode. It's
// referenced here via a triple-slash reference, not an import, so that
// this file can stay a script -- and it's chained in via `types.d.ts`'s
// own reference to this file, so that whichever emitted `.d.ts` a
// consumer's program pulls in first still gets both.)

declare module 'immediate' {
  function immediate<Args extends unknown[]>(
    task: (...args: Args) => void,
    ...args: Args
  ): void;
  export default immediate;
}

declare module 'noop-fn' {
  function noop(...args: unknown[]): void;
  export default noop;
}

declare module 'tiny-queue' {
  export default class Queue<T = unknown> {
    length: number;
    push(item: T): void;
    shift(): T | undefined;
    slice(start?: number, end?: number): T[];
  }
}
