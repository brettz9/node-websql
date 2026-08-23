// Augments node-sqlite3's own types, which declare overloads for
// `configure('busyTimeout' | 'limit', ...)` but not for
// `configure('trace' | 'profile', callback)`, even though that's a real
// runtime-supported option (see `sqlite3`'s `supportedEvents` handling).
//
// This is deliberately a module (the `export {}` below), not a plain
// ambient script: augmenting an *existing* typed external module from a
// script-mode `declare module` merges incorrectly here -- from any other
// file, `import('sqlite3').Database` ends up with only this
// augmentation's own members, losing the real class's methods entirely.
// That reproduced identically on TypeScript 6 and 7, and went away as
// soon as this file became a module. (Compare `lib/ambient.d.ts`, which
// declares brand-new ambient modules for untyped packages and needs the
// opposite: script mode.)
export {};

declare module 'sqlite3' {
  interface Database {
    configure(option: 'trace', value: (sql: string) => void): void;
    configure(option: 'profile', value: (sql: string, time: number) => void): void;
  }
}
