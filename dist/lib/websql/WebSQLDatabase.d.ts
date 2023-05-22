export = WebSQLDatabase;
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
    transaction(txnCallback: any, errorCallback: any, successCallback: any, nonstandardTransCb: any): void;
    readTransaction(txnCallback: any, errorCallback: any, successCallback: any): void;
}
//# sourceMappingURL=WebSQLDatabase.d.ts.map