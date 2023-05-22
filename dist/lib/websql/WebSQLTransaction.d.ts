export = WebSQLTransaction;
declare function WebSQLTransaction(websqlDatabase: any, executeDelay: any): void;
declare class WebSQLTransaction {
    constructor(websqlDatabase: any, executeDelay: any);
    _websqlDatabase: any;
    _error: any;
    _complete: boolean;
    _runningTimeout: boolean;
    _executeDelay: any;
    _sqlQueue: any;
    executeSql(sql: any, args: any, sqlCallback: any, sqlErrorCallback: any): void;
    _checkDone(): void;
}
//# sourceMappingURL=WebSQLTransaction.d.ts.map