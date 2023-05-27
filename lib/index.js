import SQLiteDatabase from './sqlite/SQLiteDatabase.js';
import customOpenDatabase from './custom.js';

export default customOpenDatabase(SQLiteDatabase);
