'use strict';

var SQLiteDatabase = require('./BetterSQLiteDatabase');
var customOpenDatabase = require('./lib/custom');

module.exports = customOpenDatabase(SQLiteDatabase);
