export default WebSQLDatabase;
declare function WebSQLDatabase(dbVersion: any, db: any, webSQLOverrides: any): void;
declare class WebSQLDatabase {
    constructor(dbVersion: any, db: any, webSQLOverrides: any);
    version: any;
    _db: any;
    _txnQueue: any;
    _running: boolean;
    _currentTask: any;
    _transactionDelay: any;
    _executeDelay: any;
    _onTransactionComplete(err: any): void;
    _runTransaction(): void;
    _runNextTransaction(): void;
    _createTransaction(readOnly: any, txnCallback: any, errorCallback: any, successCallback: any, nonstandardTransCb: any): void;
    /**
     * @param {(trans: import('./WebSQLTransaction.js').default) => void} txnCallback
     * @param {(err: SQLError) => void} [errorCallback]
     * @param {() => void} [successCallback]
     * @param {(
     *   currentTask: TransactionTask,
     *   err: Error,
     *   done: () => void,
     *   rollback: (err: boolean|Error|SQLError, cb: () => void) => void,
     *   commit: (cb: () => void) => void
     * ) => boolean} [nonstandardTransCb]
     */
    transaction(txnCallback: (trans: import('./WebSQLTransaction.js').default) => void, errorCallback?: ((err: SQLError) => void) | undefined, successCallback?: (() => void) | undefined, nonstandardTransCb?: ((currentTask: TransactionTask, err: Error, done: () => void, rollback: (err: boolean | Error | SQLError, cb: () => void) => void, commit: (cb: () => void) => void) => boolean) | undefined): void;
    /**
     * @param {(trans: import('./WebSQLTransaction.js').default) => void} txnCallback
     * @param {(err: Error) => void} [errorCallback]
     * @param {() => void} [successCallback]
     */
    readTransaction(txnCallback: (trans: import('./WebSQLTransaction.js').default) => void, errorCallback?: ((err: Error) => void) | undefined, successCallback?: (() => void) | undefined): void;
}
declare function TransactionTask(readOnly: any, txnCallback: any, errorCallback: any, successCallback: any, nonstandardTransCb: any): void;
declare class TransactionTask {
    constructor(readOnly: any, txnCallback: any, errorCallback: any, successCallback: any, nonstandardTransCb: any);
    readOnly: any;
    txnCallback: any;
    errorCallback: any;
    successCallback: any;
    nonstandardTransCb: any;
}
//# sourceMappingURL=WebSQLDatabase.d.ts.map