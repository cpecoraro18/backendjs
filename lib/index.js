//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

exports.logger = require(__dirname + '/logger');
exports.lib = require(__dirname + '/lib');
exports.core = require(__dirname + '/core');
exports.pool = require(__dirname + '/pool');
exports.ipc = require(__dirname + '/ipc');
exports.aws = require(__dirname + '/aws');
exports.db = require(__dirname + '/db');
exports.msg = require(__dirname + '/msg');
exports.server = require(__dirname + '/server');
exports.api = require(__dirname + '/api');
exports.auth = require(__dirname + '/auth');
exports.jobs = require(__dirname + '/jobs');
exports.events = require(__dirname + '/events');
exports.metrics = require(__dirname + '/metrics');
exports.httpGet = require(__dirname + '/httpget');
exports.app = require(__dirname + '/app');
exports.shell = { name: "shell", help: [] };

for (const p in exports) exports.core.addModule(exports[p]);

exports.run = exports.core.run;
