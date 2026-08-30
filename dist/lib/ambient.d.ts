// Ambient declarations for dependencies that ship no types of their own.
//
// This is deliberately a plain ambient *script* (no top-level import or
// export), not a module: in a module file, `declare module 'x' {}` for a
// package with no existing type declarations is rejected as "cannot
// augment an untyped module" (TS2665). In script mode it instead declares
// a brand-new ambient module, which is what these packages need.

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
