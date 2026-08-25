export default WebSQLDatabase;
export type NonstandardTransCb = (currentTask: TransactionTask, err: Error | null, done: (er?: Error | boolean | null) => void, rollback: (err: Error | boolean, cb: () => void) => void, commit: (cb: () => void) => void) => boolean;
/**
 * The WebSQL `Database` object.
 */
declare class WebSQLDatabase {
    /**
     * @param {string} dbVersion
     * @param {import('../types.js').SqlDriver} db
     * @param {import('../types.js').WebSQLOverrides} webSQLOverrides
     */
    constructor(dbVersion: string, db: import("../types.js").SqlDriver, webSQLOverrides: import("../types.js").WebSQLOverrides);
    version: string;
    _db: import("../types.js").SqlDriver;
    /** @type {import('tiny-queue').default<TransactionTask>} */
    _txnQueue: import("tiny-queue").default<TransactionTask>;
    _concurrentReaders: boolean;
    /** @type {Set<TransactionTask>} */
    _activeReaders: Set<TransactionTask>;
    /** @type {TransactionTask | null} */
    _activeWriter: TransactionTask | null;
    _transactionDelay: typeof immediate | import("../types.js").Delay;
    _executeDelay: typeof immediate | import("../types.js").Delay;
    /**
     * Not a true `#private` method: `WebSQLTransaction` calls this on its
     * owning `WebSQLDatabase` once it's finished running its SQL queue.
     * @param {Error | null} err
     * @param {WebSQLTransaction} transaction
     */
    _onTransactionComplete(err: Error | null, transaction: WebSQLTransaction): void;
    /**
     * @param {(trans: WebSQLTransaction) => void} txnCallback
     * @param {(err: Error) => void} [errorCallback]
     * @param {() => void} [successCallback]
     * @param {NonstandardTransCb} [nonstandardTransCb]
     */
    transaction(txnCallback: (trans: WebSQLTransaction) => void, errorCallback?: (err: Error) => void, successCallback?: () => void, nonstandardTransCb?: NonstandardTransCb): void;
    /**
     * @param {(trans: WebSQLTransaction) => void} txnCallback
     * @param {(err: Error) => void} [errorCallback]
     * @param {() => void} [successCallback]
     * @param {NonstandardTransCb} [nonstandardTransCb]
     */
    readTransaction(txnCallback: (trans: WebSQLTransaction) => void, errorCallback?: (err: Error) => void, successCallback?: () => void, nonstandardTransCb?: NonstandardTransCb): void;
    #private;
}
/**
 * V8 likes predictable objects.
 */
export class TransactionTask {
    /**
     * @param {boolean} readOnly
     * @param {(trans: WebSQLTransaction) => void} txnCallback
     * @param {(err: Error) => void} errorCallback
     * @param {() => void} successCallback
     * @param {NonstandardTransCb} [nonstandardTransCb]
     */
    constructor(readOnly: boolean, txnCallback: (trans: WebSQLTransaction) => void, errorCallback: (err: Error) => void, successCallback: () => void, nonstandardTransCb?: NonstandardTransCb);
    readOnly: boolean;
    txnCallback: (trans: WebSQLTransaction) => void;
    errorCallback: (err: Error) => void;
    successCallback: () => void;
    nonstandardTransCb: NonstandardTransCb | undefined;
}
import immediate from 'immediate';
import WebSQLTransaction from './WebSQLTransaction.js';
//# sourceMappingURL=WebSQLDatabase.d.ts.map