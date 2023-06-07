export default WebSQLTransaction;
declare function WebSQLTransaction(websqlDatabase: any, executeDelay: any): void;
declare class WebSQLTransaction {
    constructor(websqlDatabase: any, executeDelay: any);
    _websqlDatabase: any;
    _error: any;
    _complete: boolean;
    _runningTimeout: boolean;
    _executeDelay: any;
    _sqlQueue: any;
    /**
     * @param {string} sql
     * @param {ObjectArray} args
     * @param {SQLStatementCallback} sqlCallback
     * @param {SQLStatementErrorCallback} sqlErrorCallback
     */
    executeSql(sql: string, args: ObjectArray, sqlCallback: SQLStatementCallback, sqlErrorCallback: SQLStatementErrorCallback): void;
    _checkDone(): void;
}
//# sourceMappingURL=WebSQLTransaction.d.ts.map