//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var util = require('util');
var url = require('url');
var net = require('net');
var fs = require('fs');
var path = require('path');
var domain = require('domain');
var logger = require(__dirname + '/logger');
var core = require(__dirname + '/core');
var lib = require(__dirname + '/lib');
var ipc = require(__dirname + '/ipc');
var aws = require(__dirname + '/aws');
var cluster = require('cluster');
var os = require('os');
var metrics = require(__dirname + "/metrics");
var bkcache = require('bkjs-cache');

// The Database API, a thin abstraction layer on top of SQLite, PostgreSQL, DynamoDB and Cassandra.
// The idea is not to introduce new abstraction layer on top of all databases but to make
// the API usable for common use cases. On the source code level access to all databases will be possible using
// this API but any specific usage like SQL queries syntax or data types available only for some databases will not be
// unified or automatically converted but passed to the database directly. Only conversion between JavaScript types and
// database types is unified to some degree meaning JavaScript data type will be converted into the corresponding
// data type supported by any particular database and vice versa.
//
// Basic operations are supported for all database and modelled after NoSQL usage, this means no SQL joins are supported
// by the API, only single table access. SQL joins can be passed as SQL statements directly to the database using low level db.query
// API call, all high level operations like add/put/del perform SQL generation for single table on the fly.
//
// The common convention is to pass options object with flags that are common for all drivers along with specific,
// this options object can be modified with new properties but all driver should try not to
// modify or delete existing properties, so the same options object can be reused in subsequent operations.
//
// All queries and update operations ignore properties that starts with underscore.
//
// Before the DB functions can be used the `core.init` MUST be called first, the typical usage:
//
//          var backend = require("backendjs"), core = backend.core, db = backend.db;
//          core.init(function(err) {
//              db.add(...
//              ...
//          });
//
// All database methods can use default db pool or any other available db pool by using `pool: name` in the options. If not specified,
// then default db pool is used, sqlite is default if no -db-pool config parameter specified in the command line or the config file.
// Even if the specified pool does not exist, the default pool will be returned, this allows to pre-confgure the app with different pools
// in the code and enable or disable any particular pool at any time.
//
//  Example, use PostgreSQL db pool to get a record and update the current pool
//
//          db.get("bk_account", { id: "123" }, { pool: "pgsql" }, function(err, row) {
//              if (row) db.update("bk_account", row);
//          });
//
// Most database pools can be configured with options `min` and `max` for number of connections to be maintained, so no overload will happen and keep warm connection for
// faster responses. Even for DynamoDB which uses HTTPS this can be configured without hitting provisioned limits which will return an error but
// put extra requests into the waiting queue and execute once some requests finished.
//
//  Example:
//
//          db-pgsql-pool-max = 100
//          db-dynamodb-pool-max = 100
//
// Also, to spread functionality between different databases it is possible to assign some tables to the specific pools using `db-X-pool-tables` parameters
// thus redirecting the requests to one or another databases depending on the table, this for example can be useful when using fast but expensive
// database like DynamoDB for real-time requests and slower SQL database running on some slow instance for rare requests, reports or statistics processing.
//
//  Example, run the backend with default PostgreSQL database but keep all config parametrs in the DynamoDB table for availability:
//
//          db-pool = pgsql
//          db-dynamodb-pool = default
//          db-dynamodb-pool-tables = bk_config
//
//
// The following databases are supported with the basic db API methods:
// Sqlite, PostgreSQL, MySQL, DynamoDB, MongoDB, Elasticsearch, Cassandra, Redis, LMDB, LevelDB, Riak, CouchDB
//
// All these drivers fully support all methods and operations, some natively, some with emulation in the user space except Redis driver cannot perform sorting
// due to using Hash items for records, sorting can be done in memory but with pagination it is not possible so this part must be mentioned specifically. But the rest of the
// operations on top of Redis are fully supported which makes it a good candidate to use for in-memory tables like sessions with the same database API, later moving to
// other database will not require any application code changes.
//
// Multiple connections of the same type can be opened, just add -n suffix to all database config parameters where n is a number, referer to such pools in the code as `poolN`.
//
// Example:
//
//          db-pgsql-pool = postgresql://locahost/backend
//          db-pgsql-pool-1 = postgresql://localhost/billing
//          db-pgsql-pool-max-1 = 100
//
//          in the Javascript:
//
//          db.select("bills", { status: "ok" }, { pool: "pgsql1" }, lib.log)
//
var db = {
    name: 'db',

    // Config parameters
    args: [{ name: "pool", dns: 1, descr: "Default pool to be used for db access without explicit pool specified" },
           { name: "name", key: "db-name", descr: "Default database name to be used for default connections in cases when no db is specified in the connection url" },
           { name: "create-tables", make: "_createTables", type: "bool", nocamel: 1, master: 1, descr: "Create tables in the database or perform table upgrades for new columns in all pools, only master processes can perform this operation, never workers" },
           { name: "cache-tables", array: 1, type: "list", descr: "List of tables that can be cached: bk_auth, bk_counter. This list defines which DB calls will cache data with currently configured cache. This is global for all db pools." },
           { name: "describe-tables", type: "callback", callback: function(v) { this.describeTables(lib.jsonParse(v, {datatype:"obj",logger:"error"})) }, descr: "A JSON object with table descriptions to be merged with the existing definitions" },
           { name: "cache-ttl", type: "int", obj: "cacheTtl", key: "default", descr: "Default global TTL for cached tables", },
           { name: "cache-ttl-(.+)", type: "int", obj: "cacheTtl", nocamel: 1, strip: /cache-ttl-/, descr: "TTL in milliseconds for each individual table being cached", },
           { name: "cache-name-(.+)", obj: "cacheName", nocamel: 1, strip: /cache-name-/, descr: "Cache client name to use for each table instead of the default in order to split cache usage for different tables, it can be just a table name or `pool.table`", },
           { name: "cache2-(.+)", obj: "cache2", type: "int", nocamel: 1, strip: /cache2-/, min: 50, descr: "Tables with TTL for level2 cache, i.e. in the local process LRU memory. It works before the primary cache and keeps records in the local LRU cache for the giben amount of time, the TTL is in ms and must be greater than zero for level 2 cache to work. Make sure `ipc-lru-max-` is properly configured for each process role" },
           { name: "local", descr: "Local database pool for properties, cookies and other local instance only specific stuff" },
           { name: "config", descr: "Configuration database pool to be used to retrieve config parameters from the database, must be defined to use remote db for config parameters, set to `default` to use current default pool" },
           { name: "config-interval", type: "number", min: 0, descr: "Interval between loading configuration from the database configured with -db-config, in minutes, 0 disables refreshing config from the db" },
           { name: "cache-columns-interval", type: "int", descr: "How often in minutes to refresh tables columns from the database, it calls cacheColumns for each pool which supports it" },
           { name: "([a-z]+)-pool(-[0-9]+)?", obj: 'poolParams.$1$2', make: "url", novalue: "default", descr: "A database pool name, depending on the driver it can be an URL, name or pathname, examples of db pools: ```-db-pgsql-pool, -db-dynamodb-pool```, examples of urls: ```postgresql://[user:password@]hostname[:port]/db, mysql://[user:password@]hostname/db, mongodb://hostname[:port]/dbname, cql://[user:password@]hostname[:port]/dbname```" },
           { name: "([a-z]+)-pool-(max)(-[0-9]+)?", obj: 'poolParams.$1$3', make: "$2", type: "number", min: 1, descr: "Max number of open connections for a pool, default is Infinity" },
           { name: "([a-z]+)-pool-(min)(-[0-9]+)?", obj: 'poolParams.$1$3', make: "$2", type: "number", min: 1, descr: "Min number of open connections for a pool" },
           { name: "([a-z]+)-pool-(idle)(-[0-9]+)?", obj: 'poolParams.$1$3', make: "$2", type: "number", min: 1000, descr: "Number of ms for a db pool connection to be idle before being destroyed" },
           { name: "([a-z]+)-pool-tables(-[0-9]+)?", obj: 'poolTables', strip: /PoolTables/, type: "list", reverse: 1, descr: "A DB pool tables, list of tables that belong to this pool only" },
           { name: "([a-z]+)-pool-(connect)(-[0-9]+)?", obj: 'poolParams.$1$3', make: "$2", type: "json", descr: "Options for a DB pool driver passed during connection or creation of the pool" },
           { name: "([a-z]+)-pool-(cache-columns)(-[0-9]+)?", obj: 'poolParams.$1$3.poolOptions', make: "$2", type: "bool", descr: "Enable caching table columns for this pool if it supports it" },
           { name: "([a-z]+)-pool-(create-tables)(-[0-9]+)?", master: 1, obj: 'poolParams.$1$3.poolOptions', make: "$2", type: "bool", descr: "Create tables for this pool on startup" },
           { name: "([a-z]+)-pool-cache2-(.+)", obj: 'cache2', nocamel: 1, strip: /pool-cache2-/, type: "int", descr: "Level 2 cache TTL for the specified pool and table" },
    ],

    // Database drivers
    modules: [],

    // Database connection pools by pool name
    pools: {},

    // Configuration parameters
    poolParams: { none: {}, sqlite: { idle: 900000 } },

    // Default database name
    dbName: "backend",

    // Pools by table name
    poolTables: {},

    // Tables to be cached
    cacheTables: [],
    cacheName: {},
    cacheTtl: {},
    cache2: {},

    // Default database pool for the backend
    pool: 'sqlite',

    // Local db pool, sqlite is default, used for local storage by the core
    local: 'sqlite',

    // Refresh config from the db
    configInterval: 1440,

    // Refresh columns from time to time to have the actual table columns
    cacheColumnsInterval: 1440,

    processRows: {},
    processColumns: [],

    // Separator to combined columns
    separator: "|",

    // Translation map for similar operators from different database drivers, merge with the basic SQL mapping
    sqlPoolOptions: {
        sql: true,
        schema: [],
        noAppend: 1,
        typesMap: { uuid: 'text', counter: "int", bigint: "int", smallint: "int" },
        opsMap: { begins_with: 'like%', ne: "<>", eq: '=', le: '<=', lt: '<', ge: '>=', gt: '>' }
    },

    // Table definitions, all tables form all modules eventually end up here with all columns merged
    tables: {
        // Configuration store, same parameters as in the commandline or config file, can be placed in separate config groups
        // to be used by different backends or workers
        bk_config: { name: { primary: 1 },                      // name of the parameter
                     type: { primary: 1 },                      // config type or tag
                     value: {},                                 // the value
                     mtime: { type: "bigint", now: 1 } },

        // General purpose properties, can be used to store arbitrary values
        bk_property: { name: { primary: 1 },
                       value: {},
                       mtime: { type: "bigint", now: 1 } },

    }, // tables

    // Computed primary keys and indexes from the table definitons
    keys: {},
    indexes: {},
};

module.exports = db;

// None database driver
db.modules.push({ name: "none", createPool: function(opts) { return new db.Pool(opts) } });

// Initialize all database pools. the options may containt the following properties:
//  - localTables - only initialize default, local and config db pools, other pools are ignored, if not given
//     global value is used. Currently it can be set globally from the app only, no config parameter.
//  - createTables - if true then create new tables or upgrade tables with new columns
db.init = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = lib.empty;

    // Important parameters that can persist until cleared
    ["localTables","createTables"].forEach(function(x) {
        if (options && typeof options[x] != "undefined") this["_" + x] = options[x];
    });

    // Merge all tables from all modules
    for (var p in core.modules) {
        if (p != this.name && lib.isObject(core.modules[p].tables)) this.describeTables(core.modules[p].tables);
    }

    logger.debug("init:", core.role, Object.keys(this.poolParams), Object.keys(this.pools));

    // Periodic columns refresh
    var interval = this.cacheColumnsInterval ? this.cacheColumnsInterval * 60000 + lib.randomShort() : 0;
    lib.deferInterval(this, interval, "columns", this.refreshColumns.bind(this));

    // Configured pools for supported databases
    lib.forEachSeries(Object.keys(this.poolParams), function(name, next) {
        if (self._localTables && name != self.pool && name != self.local && name != self.config) return next();

        var params = self.poolParams[name];
        params.pool = name;
        params.type = name.replace(/[0-9]/, "");

        // Do not re-create the pool if not forced, just update the properties
        if (self.pools[name] && !options.force && (!params.url || params.url == self.pools[name].url)) {
            self.pools[name].configure(params);
            return next();
        }

        // Create a new pool for the given database driver
        var mod = self.modules.filter(function(x) { return x.name == params.type } ).pop();
        if (!mod) {
            logger.error("init:", core.role, name, "invalid pool type");
            return next();
        }
        var old = self.pools[name];
        var pool = mod.createPool(params);
        self.pools[name] = pool;
        if (old) old.shutdown();

        logger.debug('init:', core.role, params);

        if (self._createTables || pool.poolOptions.createTables) return self.createTables(name, function() { next() });
        if (pool.poolOptions.cacheColumns) return self.cacheColumns(name, function() { next() });
        next();
    }, callback);
}

// Load configuration from the config database, must be configured with `db-config-type` pointing to the database pool where bk_config table contains
// configuration parameters.
//
// The priority of the paramaters is fixed and goes form the most broad to the most specific, most specific always wins, this allows
// for very flexible configuration policies defined by the app or place where instances running and separated by the run mode.
//
// The following list of properties will be queried from the config database and the sorting order is very important, the last values
// will override values received for the earlier properties, for example, if two properties defined in the `bk_config` table with the
// types `myapp` and `prod-myapp`, then the last value will be used only.
//
// All attributes will be added multiple times in the following order, `name` being the attribute listed below:
//    `name`, runMode-`name`, appName-`name`, runMode-appName-`name`
//
// The priority of the attributes is the following:
//  - the run mode specified in the command line `-run-mode`: `prod`
//  - the application name: `myapp`
//  - the application name and major version specified in the package.json: `-1`
//  - the application name and version specified in the package.json: `-1.0`
//  - the process role: `-worker`
//  - the network where the instance is running, first 2 octets from the current IP address: `-192.168`
//  - the region where the instance is running, AWS region or other name: `us-east-1`
//  - the network where the instance is running, first 3 octets from the current IP address: `-192.168.1`
//  - the zone where the instance is running, AWS availability zone or other name: `-us-east-1a`
//  - current instance tag or a custom tag for ad-hoc queries: `-nat`
//
// The options takes the following properties:
//  - force - if true then force to refresh and reopen all db pools
//  - delta - if true then pull only records updated since the last config pull using the max mtime from received records.
//  - table - a table where to read the config parameters, default is bk_config
//
// On return, the callback second argument will receive all parameters received form the database as a list: -name value ...
db.initConfig = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = lib.empty;
    if (typeof callback != "function") callback = lib.noop;
    if (!options) options = lib.empty;

    // The order of the types here defines the priority of the parameters, most specific at the end always wins
    var types = [], argv = [], ver = core.appVersion.split(".");

    // All other entries in order of priority with all common prefixes
    var items = [ core.runMode,
                  core.appName,
                  core.appName + "-" + ver[0] + "." + ver[1],
                  core.appName + "-" + ver[0],
                  core.role,
                  options.network || core.network,
                  options.region || core.instance.region,
                  options.subnet || core.subnet,
                  options.zone || core.instance.zone,
                  options.tag || core.instance.tag ];

    items.forEach(function(x) {
        if (!x) return;
        x = String(x).trim();
        if (!x) return;
        types.push(x);
        var m = x.substr(0, core.runMode.length);
        var v = x.substr(0, core.appName.length);
        if (m != core.runMode) types.push(core.runMode + "-" + x);
        if (v != core.appName) types.push(core.appName + "-" + x);
        if (m != core.runMode && v != core.appName) types.push(core.runMode + "-" + core.appName + "-" + x);
    });
    // Make sure we have only unique items in the list, skip empty or incomplete items
    types = lib.strSplitUnique(types);

    logger.info("initConfig:", core.role, this.config, types, this._configMtime || 0, options);

    // Refresh from time to time with new or modified parameters, randomize a little to spread across all servers.
    // Do not create/upgrade tables and indexes when reloading the config, this is to
    // avoid situations when maintenance is being done and any process reloading the config may
    // create indexes/columns which are not missing but being provisioned or changed.
    var interval = self.configInterval ? self.configInterval * 60000 + lib.randomShort() : 0;
    lib.deferInterval(this, interval, "config", this.initConfig.bind(this, interval ? options : null));

    var query = { type: types, mtime: options.delta ? this._configMtime : 0 };
    var opts = { ops: { type: "in", mtime: "gt" }, pool: this.config };
    self.select(options.table || "bk_config", query, opts, function(err, rows) {
        if (err) return callback(err, []);

        // Sort inside to be persistent across databases
        rows.sort(function(a,b) { return types.indexOf(b.type) - types.indexOf(a.type); });
        logger.dev("initConfig:", core.role, rows);

        // Testing mode just return all retrieved sorted rows
        if (options.test) return callback(null, rows)

        // Only keep the most specific value, it is sorted in descendent order most specific at the top
        var args = {};
        rows.forEach(function(x) {
            self._configMtime = Math.max(self._configMtime || 0, x.mtime);
            if (args[x.name]) return;
            args[x.name] = 1;
            argv.push('-' + x.name);
            if (x.value) argv.push(x.value);
        });
        core.parseArgs(argv);

        // Init more db pools
        self.init(options, function(err) {
            callback(err, argv);
        });
    });
}

// Create or upgrade the tables for the given pool
db.createTables = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (typeof options == "string") options = { pool: options };

    var pool = self.getPool('', options);
    var changed = [];
    logger.debug("createTables:", pool.name, pool.poolOptions);

    lib.series([
      function(next) {
          self.cacheColumns(pool.name, next);
      },
      function(next) {
          lib.forEachSeries(Object.keys(self.tables), function(table, next2) {
              // We if have columns, SQL table must be checked for missing columns and indexes
              var cols = pool.dbcolumns[table];
              if (!cols) {
                  self.create(table, self.tables[table], options, function(err, rows, info) {
                      if (!err && info.affected_rows) changed.push(table);
                      next2();
                  });
              } else {
                  // Refreshing columns after an upgrade is only required by the driver which depends on
                  // the actual db schema, in any case all columns are merged so no need to re-read just the columns,
                  // the case can be to read new indexes used in searches, this is true for DynamoDB.
                  self.upgrade(table, self.tables[table], options, function(err, rows, info) {
                      if (!err && info.affected_rows) changed.push(table);
                      next2();
                  });
              }
          }, next);
      },
      function(next) {
          if (!changed.length) return next();
          logger.info('createTables:', pool.name, 'changed:', changed);
          if (pool.poolOptions.cacheColumns) return self.cacheColumns({ pool: pool.name, tables: changed }, next);
          next();
      },
    ], callback);
}

// Delete all specified tables from the pool, if `name` is empty then default pool will be used, `tables` is an object with table names as
// properties, same table definition format as for create table method
db.dropTables = function(tables, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;

    var pool = self.getPool('', options);
    lib.forEachSeries(Object.keys(tables || lib.empty), function(table, next) {
        self.drop(table, options, function() { next() });
    }, callback);
}

// Execute query using native database driver, the query is passed directly to the driver.
// - req - can be a string or an object with the following properties:
//   - text - SQL statement or other query in the format of the native driver, can be a list of statements
//   - values - parameter values for SQL bindings or other driver specific data
//   - op - operations to be performed, used by non-SQL drivers
//   - obj - actual object with data for non-SQL drivers
//   - table - table name for the operation
// - options may have the following properties:
//     - pool - name of the database pool where to execute this query.
//       The difference with the high level functions that take a table name as their firt argument, this function must use pool
//       explicitely if it is different from the default. Other functions can resolve
//       the pool by table name if some tables are assigned to any specific pool by configuration parameters `db-pool-tables`.
//     - unique - perform sorting the result and eliminate any duplicate rows by the column name specified in the `unique` property
//     - filter - function to filter rows not to be included in the result, return false to skip row, args are: function(req, row, options)
//     - silence_error - do not report about the error in the log, still the error is returned to the caller
//     - ignore_error and quiet - same as silence_error
//     - noprocessrows - if true then skip post processing result rows, return the data as is, this will result in returning combined columns as it is
//     - noconvertrows - if true skip converting the data from the database format into Javascript data types, it uses column definitions
//       for the table to convert values returned from the db into the the format defined by the column
//     - cached - if true perform cache invalidation for the operations that resulted in modification of the table record(s)
//     - total - if true then it is supposed to return only one record with property `count`, skip all post processing and convertion
// - callback(err, rows, info) where
//    - info is an object with information about the last query: inserted_oid,affected_rows,next_token,consumed_capacity
//    - rows is always returned as a list, even in case of error it is an empty list
//
//  Example with SQL driver
//
//          db.query({ text: "SELECT a.id,c.type FROM bk_account a,bk_connection c WHERE a.id=c.id and a.id=?", values: ['123'] }, { pool: 'pgsql' }, function(err, rows, info) {
//          });
//
db.query = function(req, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!lib.isObject(req)) return typeof callback == "function" && callback(lib.newError("invalid request"));

    req.table = req.table || "";
    var pool = this.getPool(req.table, options);
    // For postprocess callbacks
    req.pool = pool.name;

    // Metrics collection
    req.timer = pool.metrics.Timer('que').start();
    pool.metrics.Histogram('req').update(pool.metrics.Counter('count').inc());
    pool.metrics.Counter('req_0').inc();

    pool.acquire(function(err, client) {
        if (err) return self.queryEnd(err, req, null, options, callback);
        try {
            self.queryRun(pool, client, req, options, callback);
        } catch(e) {
            self.queryEnd(e, req, null, options, callback);
        }
    });
}

db.queryRun = function(pool, client, req, options, callback)
{
    var self = this;
    req.client = client;
    pool.query(client, req, options, function(err, rows, info) {
        req.info = info || {};
        rows = rows || [];
        if (!err) {
            if (!req.info.affected_rows) req.info.affected_rows = client.affected_rows || 0;
            if (!req.info.inserted_oid) req.info.inserted_oid = client.inserted_oid || null;
            if (!req.info.next_token) req.info.next_token = pool.nextToken(client, req, rows, options);
            if (!req.info.consumed_capacity) req.info.consumed_capacity = client.consumed_capacity || 0;

            pool.release(client);
            delete req.client;

            rows = self.queryResult(err, req, rows, options);
        }
        self.queryEnd(err, req, rows, options, callback);
    });
}

db.queryEnd = function(err, req, rows, options, callback)
{
    var pool = this.pools[req.pool];
    pool.metrics.Counter('count').dec();
    req.elapsed = req.timer.end();
    delete req.timer;

    if (req.client) {
        pool.release(req.client);
        delete req.client;
    }
    if (!Array.isArray(rows)) rows = [];

    if (err && (!options || !(options.silence_error || options.ignore_error || options.quiet))) {
        pool.metrics.Counter("err_0").inc();
        logger.error("query:", req.pool, err, 'REQ:', req.op, req.table, req.obj, req.values, 'OPTS:', options, lib.traceError(err));
    } else {
        logger.debug("query:", req.pool, req.elapsed, 'ms', rows.length, 'rows', 'REQ:', req.op, req.table, req.obj, req.values, 'OPTS:', options, err);
    }
    if (err) err = this.convertError(pool, req.table, req.op || "", err, options);

    var info = req.info;
    for (var p in req) delete req[p];

    if (typeof callback == "function") {
        lib.tryCatch(callback, err, rows, info);
    }
}

db.queryResult = function(err, req, rows, options)
{
    options = options || lib.empty;
    // With total we only have one property 'count'
    if (options.total) return rows;

    // Cache notification in case of updates, we must have the request prepared by the db.prepare
    var cached = options.cached || this.cacheTables.indexOf(req.table) > -1;
    if (cached && req.table && req.obj && req.op && ['put','update','incr','del'].indexOf(req.op) > -1) {
        this.delCache(req.table, req.obj, options);
    }

    // Make sure no duplicates
    if (options.unique) {
        rows = lib.arrayUnique(rows, options.unique);
    }

    // Convert from db types into javascript, deal with json and joined columns
    if (rows.length && !options.noconvertrows) {
        this.convertRows(req.pool, req, rows, options);
    }

    // Convert values if we have custom column callback
    if (!options.noprocessrows) {
        rows = this.runProcessRows("post", req.table, req, rows, options);
    }
    // Always run global hooks
    rows = this.runProcessRows("post", "*", req, rows, options);

    // Custom filter to return the final result set
    if (typeof options.filter == "function" && rows.length) {
        rows = rows.filter(function(row) {
            return options.filter(req, row, options);
        });
    }
    return rows;
}

// Insert new object into the database
// - obj - an JavaScript object with properties for the record, primary key properties must be supplied
// - options may contain the following properties:
//      - no_columns - do not check for actual columns defined in the pool tables and add all properties from the obj, only will work for NoSQL dbs,
//        by default all properties in the obj not described in the table definition for the given table will be ignored.
//      - skip_columns - ignore properties by name listed in the this array
//      - mtime - if set, mtime column will be added automatically with the current timestamp, if mtime is a
//        string then it is used as a name of the column instead of default mtime name
//      - skip_null - if set, all null values will be skipped, otherwise will be written into the DB as NULLs
//
// On return the `obj` will contain all new columns generated before adding the record
//
// Note: SQL, DynamoDB, MongoDB, Redis drivers are fully atomic but other drivers may be subject to race conditions
//
// Example
//
//       db.add("bk_account", { id: '123', name: 'test', gender: 'm' }, function(err, rows, info) {
//       });
//
db.add = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    var req = this.prepare("add", table, obj, options);
    this.query(req, req.options, callback);
}

// Add/update an object in the database, if object already exists it will be replaced with all new properties from the obj
// - obj - an object with record properties, primary key properties must be specified
// - options - same properties as for `db.add` method
//
// Example
//
//       db.put("bk_account", { id: '123', name: 'test', gender: 'm' }, function(err, rows, info) {
//       });
//
db.put = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;

    // Custom handler for the operation
    var pool = this.getPool(table, options);
    if (pool.put) return pool.put(table, obj, options, callback);

    var req = this.prepare("put", table, obj, options);
    this.query(req, req.options, callback);
}

// Update existing object in the database.
// - obj - is an actual record to be updated, primary key properties must be specified
// - options - same properties as for `db.add` method with the following additional properties:
//     - ops - object for comparison operators for primary key, default is equal operator
//     - opsMap - operator mapping into supported by the database
//     - typesMap - type mapping for properties to be used in the condition
//     - expected - an object with the condition for the update, it is used in addition to the primary keys condition from the `obj`
//     - join - how to join all expressions, default is AND
//     - upsert - create a new record if it does not exist
//     - updateOps - an object with column names and operations to be performed on the named column
//        - incr - increment by given value
//        - concat - concatenate given value, for strings if the database supports it
//        - append - appended to the list of values, only for lists if the database supports it
//        - not_exists - only update if not exists or null
//
// Note: not all database drivers support atomic update with conditions, all drivers for SQL, DynamoDB, MongoDB, Redis fully atomic, but other drivers
// perform get before put and so subject to race conditions
//
// Example
//
//          db.update("bk_account", { id: '123', gender: 'm' }, function(err, rows, info) {
//              console.log('updated:', info.affected_rows);
//          });
//
//          db.update("bk_account", { id: '123', gender: 'm', prefix: 'Mr' }, { pool: pgsql' }, function(err, rows, info) {
//              console.log('updated:', info.affected_rows);
//          });
//
//          db.update("bk_account", { id: '123', gender: 'm', prefix: 'Mr' }, { expected: { gender: "f" } }, function(err, rows, info) {
//              console.log('updated:', info.affected_rows);
//          });
//
db.update = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    var req = this.prepare("update", table, obj, options);
    this.query(req, req.options, callback);
}

// Update all records that match given condition in the `query`, one by one, the input is the same as for `db.select` and every record
// returned will be updated using `db.update` call by the primary key, so make sure options.select include the primary key for every row found by the select.
//
// All properties from the `obj` will be set in every matched record.
//
// The callback will receive on completion the err and all rows found and updated. This is mostly for non-SQL databases and for very large range it may take a long time
// to finish due to sequential update every record one by one.
// Special properties that can be in the options for this call:
//   - updateOptions - options to be passed to the db.update if needed, this is useful so select and update options will not be mixed up
//   - factorCapacity - write capcity factor for update operations, default is 0.25
//   - concurrency - how many update queries to execute at the same time, default is 1, this is done by using lib.forEachLimit.
//   - process - a function callback that will be called for each row before updating it, this is for some transformations of the record properties
//      in case of complex columns that may contain concatenated values as in the case of using DynamoDB. The callback will be called
//      as `options.process(row, options)`
//
// Example, update birthday format if not null
//
//          db.updateAll("bk_account",
//                      { birthday: 1 },
//                      { mtime: Date.now() },
//                      { ops: { birthday: "not null" },
//                        concurrency: 2,
//                        process: function(r, o) {
//                              r.birthday = lib.strftime(new Date(r.birthday, "%Y-%m-D"));
//                        } },
//                        function(err, rows) {
//          });
//
db.updateAll = function(table, query, obj, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;

    var pool = this.getPool(table, options);
    var uoptions = options && options.updateOptions;
    var process = options && typeof options.process == "function" ? options.process : null;
    if (typeof pool.updateAll == "function" && !process) return pool.updateAll(table, query, obj, options, callback);

    var cap = db.getCapacity(table, { useCapacity: "write", factorCapacity: options && options.factorCapacity || 0.25 });
    this.select(table, query, options, function(err, rows) {
        if (err) return callback(err);

        lib.forEachLimit(rows, options && options.concurrency || 1, function(row, next) {
            if (process) process(row, options);
            for (var p in obj) row[p] = obj[p];
            self.update(table, row, uoptions, function(err) {
                if (err) return next(err);
                db.checkCapacity(cap, next);
            })
        }, function(err) {
            callback(err, rows);
        });
    });
}

// Counter operation, increase or decrease column values, similar to update but all specified columns except primary
// key will be incremented, use negative value to decrease the value.
//
// If no `options.updateOps` object specified or no 'incr' operations are provided then
// all columns with type 'counter' will be used for the action `incr`
//
// *Note: The record must exist already for SQL databases, for DynamoDB and Cassandra a new record will be created
// if does not exist yet.*
//
// Example
//
//       db.incr("bk_counter", { id: '123', like0: 1, invite0: 1 }, function(err, rows, info) {
//       });
//
db.incr = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;

    if (options && !lib.searchObj(options.updateOps, { value: "incr", count: 1 })) {
        if (!lib.isObject(options.updateOps)) options.updateOps = {};
        var cols = this.getColumns(table, options);
        for (var p in cols) {
            if (cols[p].type == "counter" && typeof obj[p] != "undefined") options.updateOps[p] = "incr";
        }
    }

    var req = this.prepare("incr", table, obj, options);
    this.query(req, req.options, callback);
}

// Delete an object in the database, no error if the object does not exist
// - obj - an object with primary key properties only, other properties will be ignored
// - options - same properties as for `db.update` method
//
// Example
//
//       db.del("bk_account", { id: '123' }, function(err, rows, info) {
//           console.log('updated:', info.affected_rows);
//       });
//
db.del = function(table, obj, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    var req = this.prepare("del", table, obj, options);
    this.query(req, req.options, callback);
}

// Delete all records that match given condition, one by one, the input is the same as for `db.select` and every record
// returned will be deleted using `db.del` call. The callback will receive on completion the err and all rows found and deleted.
// Special properties that can be in the options for this call:
//  - delOptions - options to be passed to the db.del if needed, this is useful so select and del options will not be mixed up
//  - factorCapacity - write capcity factor for delete operations, default is 0.35
//  - concurrency - how many delete requests to execute at the same time by using lib.forEachLimit.
//  - ignore_error - continue deleting records even after an error
//  - process - a function callback that will be called for each row before deleting it, this is for some transformations of the record properties
//    in case of complex columns that may contain concatenated values as in the case of using DynamoDB. The callback will be called
//    as `options.process(row, options)`
db.delAll = function(table, query, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;

    var pool = this.getPool(table, options);
    var doptions = options && options.delOptions;
    var process = options && typeof options.process == "function" ? options.process : null;
    if (typeof pool.delAll == "function" && !process) return pool.delAll(table, query, options, callback);

    var ignore_error = options && options.ignore_error;
    var cap = db.getCapacity(table, { useCapacity: "write", factorCapacity: options && options.factorCapacity || 0.35 });

    this.select(table, query, options, function(err, rows) {
        if (err) return callback(err);

        lib.forEachLimit(rows, options && options.concurrency || 1, function(row, next) {
            if (process) process(row, options);
            self.del(table, row, doptions, function(err) {
                if (err && !ignore_error) return next(err);
                db.checkCapacity(cap, next);
            });
        }, function(err) {
            callback(err, rows);
        });
    });
}

// Add/update the object, check existence by the primary key. This is not equivalent of REPLACE INTO, it does `db.get`
// to check if the object exists in the database and performs `db.add` or `db.update` depending on the existence.
// - obj is a JavaScript object with properties that correspond to the table columns
// - options define additional flags that may
//      - check_mtime - defines a column name to be used for checking modification time and skip if not modified, must be a date value
//      - check_data - verify every value in the given object with actual value in the database and skip update if the record is the same,
//        if it is an array then check only specified columns
//
// Example: updates record 123 only if gender is not 'm' or adds new record
//
//          db.replace("bk_account", { id: '123', gender: 'm' }, { check_data: true });
//
// Example: updates record 123 only if mtime of the record is less or equal yesterday
//
//          db.replace("bk_account", { id: '123', mtime: Date.now() - 86400000 }, { check_mtime: 'mtime' });
//
db.replace = function(table, obj, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;

    var keys = this.getKeys(table, options);
    var select = keys[0];
    // Use mtime to check if we need to update this record
    if (options && options.check_mtime && obj[options.check_mtime]) {
        select = options.check_mtime;
    } else
    // Check if values are different from existing value, skip if the records are the same by comparing every field
    if (options && options.check_data) {
        var cols = this.getColumns(table, options);
        var list = Array.isArray(options.check_data) ? options.check_data : Object.keys(obj);
        select = list.filter(function(x) { return x[0] != "_"  && x != 'mtime' && keys.indexOf(x) == -1 && (x in cols); }).join(',');
        if (!select) select = keys[0];
    }

    var req = this.prepare("get", table, obj, { select: select, pool: options && options.pool });
    if (!req) {
        if (options && options.put_only) return callback(null, []);
        return this.add(table, obj, options, callback);
    }

    // Create deep copy of the object so we have it complete inside the callback
    obj = lib.cloneObj(obj);

    this.query(req, req.options, function(err, rows) {
        if (err) return callback(err, []);

        logger.debug('db.replace:', req, rows.length);
        if (rows.length) {
            if (options) {
                // Skip update if specified or mtime is less or equal
                if (options.add_only || (select == options.check_mtime && lib.toDate(rows[0][options.check_mtime]) >= lib.toDate(obj[options.check_mtime]))) {
                    return callback(null, []);
                }
                // Verify all fields by value
                if (options.check_data) {
                    var same = select == "1" || Object.keys(rows[0]).every(function(x) { return String(rows[0][x]) == String(obj[x]) });
                    // Nothing has changed
                    if (same) return callback(null, []);
                }
            }
            self.update(table, obj, options, callback);
        } else {
            if (options && options.put_only) return callback(null, []);
            self.add(table, obj, options, callback);
        }
    });
}

// Convenient helper to retrieve all records by primary key, the obj must be a list with key property or a string with list of primary key column
// Example
//
//      db.list("bk_account", ["id1", "id2"], function(err, rows) { console.log(err, rows) });
//      db.list("bk_account", "id1,id2", function(err, rows) { console.log(err, rows) });
//
db.list = function(table, query, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;

    switch (lib.typeName(query)) {
    case "string":
    case "array":
        query = lib.strSplit(query);
        if (typeof query[0] == "string") {
            var keys = this.getKeys(table, options);
            if (!keys.length) return callback(lib.newError("invalid keys"), []);
            query = query.map(function(x) { return lib.newObj(keys[0], x) });
        }
        break;

    default:
        return callback(lib.newError("invalid list"), []);
    }
    if (!query.length) return callback(null, []);
    this.select(table, query, options, callback);
}

// Perform a batch of operations at the same time.
// - op - is one of add, incr, put, update, del
// - objs a list of objects to put/delete from the database
// - options can have the follwoing:
//   - concurrency - number of how many operations to run at the same time, 1 means sequential
//   - ignore_error - will run all operations without stopping on error, the callback will have third argument which is an array of arrays with failed operations
//   - factorCapacity - a capacity factor to apply to the write capacity if present, by default it is used write capacity at 100%
//
//  Example:
//
//          db.batch("bc_counter", "add", [{id:1",like0:1}, {id:"2",like0:2}], lib.log)
//
//
db.batch = function(table, op, objs, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;

    // Custom handler for the operation
    var pool = this.getPool(table, options);
    if (pool.batch) return pool.batch(table, op, objs, options, callback);
    var info = [];

    var cap = db.getCapacity(table, options);
    lib.forEachLimit(objs, options && options.concurrency || 1, function(obj, next) {
        db[op](table, obj, lib.cloneObj(options), function(err) {
            if (err) {
                if (!options || !options.ignore_error) return next(err);
                info.push([ err, obj ]);
            }
            db.checkCapacity(cap, next);
        });
    }, function(err) {
        callback(err, [], info);
    });
}

// Convenient helper for scanning a table for some processing, rows are retrieved in batches and passed to the callback until there are no more
// records matching given criteria. The obj is the same as passed to the `db.select` method which defined a condition which records to get.
// The rowCallback must be present and is called for every row or batch retrieved and second parameter which is the function to be called
// once the processing is complete. At the end, the callback will be called just with 1 argument, err, this indicates end of scan operation.
// Basically, db.scan is the same as db.select but can be used to retrieve large number of records in batches and allows async processing of such records.
// To hint a driver that scanning is in progress the `options.scanning` will be set to true.
//
// Parameters:
//  - table - table to scan
//  - query - an object with query conditions, same as in `db.select`
//  - options - same as in `db.select`, with the following additions:
//    - count - size of every batch, default is 100
//    - limit - total number of records to scan
//    - batch - if true rowCallback will be called with all rows from the batch, not every row individually, batch size is defined by the count property
//    - noscan - if 1 no scan will be performed if no prmary keys are specified
//    - fullscan - if 1 force to scan full table without using any primary key conditons, use all query properties for all records (DynamoDB)
//    - useCapacity - triggers to use specific capacity, default is `read`
//    - factorCapacity - a factor to apply for the read capacity limit and triggers the capacity check usage, default is `0.9`
//    - tableCapacity - use a different table for capacity throttling instead of the `table`, useful for cases when the row callback performs
//       writes into that other table and capacity is different
//    - capacity - a full capacity object to pass to select calls
//  - rowCallback - process records when called like this `callback(rows, next)
//  - endCallback - end of scan when called like this: `callback(err)
//
//  Example:
//
//          db.scan("bk_account", {}, { count: 10, pool: "dynamodb" }, function(row, next) {
//              // Copy all accounts from one db into another
//              db.add("bk_account", row, { pool: "pgsql" }, next);
//          }, function(err) { });
//
db.scan = function(table, query, options, rowCallback, endCallback)
{
    if (typeof options == "function") endCallback = rowCallback, rowCallback = options, options = null;

    options = lib.cloneObj(options);
    if (!options.count) options.count = 100;
    if (options.useCapacity || options.factorCapacity) {
        options.capacity = db.getCapacity(options.tableCapacity || table, { useCapacity: options.useCapacity || "read", factorCapacity: options.factorCapacity || 0.9 });
    }
    options.start = "";
    options.nrows = 0;
    options.scanning = true;

    lib.whilst(
      function() {
          if (options.limit > 0 && options.nrows >= options.limit) return false;
          return options.start != null;
      },
      function(next) {
          if (options.limit > 0) options.count = Math.min(options.limit - options.nrows, options.count);
          db.select(table, query, options, function(err, rows, info) {
              if (err) return next(err);
              options.start = info.next_token;
              options.nrows += rows.length;
              if (options.batch) {
                  rowCallback(rows, next);
              } else {
                  lib.forEachSeries(rows, function(row, next2) {
                      rowCallback(row, next2);
                  }, next);
              }
          });
      }, endCallback);
}

// Migrate a table via temporary table, copies all records into a temp table, then re-create the table with up-to-date definitions and copies all records back into the new table.
// The following options can be used:
// - preprocess - a callback function(row, options, next) that is called for every row on the original table, next must be called to move to the next row, if err is returned as first arg then the processing will stop
// - postprocess - a callback function(row, options, next) that is called for every row on the destination table, same rules as for preprocess
// - tmppool - the db pool to be used for temporary table
// - tpmdrop - if 1 then the temporary table will be dropped at the end in case of success, by default it is kept
// - delay - number of milliseconds to wait between the steps
db.migrate = function(table, options, callback)
{
    if (typeof callback != "function") callback = lib.noop;
    options = lib.cloneObj(options);
    if (!options.preprocess) options.preprocess = function(row, options, next) { next() }
    if (!options.postprocess) options.postprocess = function(row, options, next) { next() }
    if (!options.delay) options.delay = 1000;
    var pool = db.getPool(table, options);
    var cols = db.getColumns(table, options);
    var tmptable = table + "_tmp";
    var schema = this.tables[table];
    var cap = db.getCapacity(table);
    options.readCapacity = cap.readCapacity;
    options.writeCapacity = cap.writeCapacity;

    lib.series([
        function(next) {
            db.cacheColumns(options, next);
        },
        function(next) {
            if (!pool.dbcolumns[tmptable]) return next();
            db.drop(tmptable, { pool: options.tmppool }, next);
        },
        function(next) {
            if (!pool.dbcolumns[tmptable]) return next();
            setTimeout(next, options.delay || 0);
        },
        function(next) {
            pool.dbcolumns[tmptable] = schema;
            db.create(tmptable, schema, { pool: options.tmppool }, next);
        },
        function(next) {
            setTimeout(next, options.delay || 0);
        },
        function(next) {
            db.scan(table, {}, options, function(row, next2) {
                options.preprocess(row, options, function(err) {
                    if (err) return next2(err);
                    db.add(tmptable, row, { pool: options.tmppool }, function() {
                        db.checkCapacity(cap, next2);
                    });
                });
            }, next);
        },
        function(next) {
            db.drop(table, options, next);
        },
        function(next) {
            setTimeout(next, options.delay || 0);
        },
        function(next) {
            db.create(table, schema, options, next);
        },
        function(next) {
            setTimeout(next, options.delay || 0);
        },
        function(next) {
            db.cacheColumns(options, next);
        },
        function(next) {
            db.scan(tmptable, {}, { pool: options.tmppool, capacity: cap }, function(row, next2) {
                options.postprocess(row, options, function(err) {
                    if (err) return next2(err);
                    db.add(table, row, options, function() {
                        db.checkCapacity(cap, next2);
                    });
                });
            }, next);
        },
        function(next) {
            if (!options.tmpdrop) return next();
            db.drop(tmptable, options, next);
        }],
        function(err) {
            callback(err);
    });
}

// Perform full text search on the given table, the database implementation may ignore table name completely
// in case of global text index.
//
// Query in general is a text string with the format that is supported by the underlying driver, the db module DOES NOT PARSE the query at all.
// Options make take the same properties as in the select method.
//
// A special query property `q` may be used for generic search in all fields.
//
// Without full text search support in the driver this may return nothing or an error.
//
//  Example
//            db.search("bk_account", { type: "admin", q: "john*" }, { pool: "elasticsearch" }, lib.log);
//            db.search("bk_account", "john*", { pool: "elasticsearch" }, lib.log);
//
db.search = function(table, query, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    var req = this.prepare("search", table, query, options);
    this.query(req, req.options, callback);
}

// Join the given list of records with the records from other table by primary key.
// The properties from the joined table will be merged with the original rows preserving the existing properties
//
// - options.keys defines custom primary key to use instead of table's primary key
// - options.keysMap - an object that defines which property should be used for a key in the given rows, this is
//   for cases when actual primary keys in the table are different from the rows properties.
// - options.existing is 1 then return only joined records.
// - options.override - joined table properties will replace the original table existing properties
// - options.attach - specifies a property name which will be used to attach joined record to the original record, no merging will occur, for
//    non-existing records an empty object will be attached
// - options.incr can be a list of property names that need to be summed up with each other, not overriden
//
// A special case when table is empty `db.join` just returns same rows to the callback, this is
// for convenience of doing joins on some conditions and trigger it by setting the table name or skip the join completely.
//
// Example:
//
//          db.join("bk_account", [{id:"123",key1:1},{id:"234",key1:2}], lib.log)
//          db.join("bk_account", [{aid:"123",key1:1},{aid:"234",key1:2}], { keysMap: { id: "aid" }}, lib.log)
//
db.join = function(table, rows, options, callback)
{
    if (!table) return callback(null, rows);
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = lib.empty;

    var self = this;
    var map = {}, ids = [];
    var keys = options.keys || self.getKeys(table, options);
    var mkeys = options.keysMap ? keys.map(function(x) { return options.keysMap[x] || x }) : keys;
    var rkeys = options.keysMap ? Object.keys(options.keysMap).reduce(function(x,y) { x[options.keysMap[y]] = y; return x }, {}) : null;
    rows.forEach(function(x) {
        var key = self.getQueryForKeys(mkeys, x, { keysMap: rkeys });
        var k = Object.keys(key).map(function(y) { return key[y]}).join(self.separator);
        if (!map[k]) map[k] = [];
        map[k].push(x);
        ids.push(key);
    });
    db.list(table, ids, options, function(err, list, info) {
        if (err) return callback(err, []);

        list.forEach(function(x) {
            var key = self.getQueryForKeys(keys, x);
            var k = Object.keys(key).map(function(y) { return key[y]}).join(self.separator);
            map[k].forEach(function(row) {
                if (options.attach) {
                    row[options.attach] = x;
                } else {
                    for (var p in x) {
                        if (Array.isArray(options.incr) && options.incr.indexOf(p) > -1) {
                            row[p] = (row[p] || 0) + x[p];
                        } else
                        if (options.override || !row[p]) row[p] = x[p];
                    }
                }
                if (options.existing || options.attach) row.__1 = 1;
            });
        });
        // Remove not joined rows
        if (options.existing) {
            rows = rows.filter(function(x) { return x.__1; }).map(function(x) { delete x.__1; return x; });
        } else
        // Always attach even if empty
        if (options.attach) {
            for (var i in rows) {
                if (!rows[i].__1) rows[i][options.attach] = {};
                delete rows[i].__1;
            }
        }
        callback(null, rows, info);
    });
}

// Geo locations search, paginate all results until the end.
// table must be defined with the following required columns:
//  - geohash - location as primary key hash column
//  - id or other column name to be used as a RANGE key for DynamoDB/Cassandra or part of the compsoite primary key for SQL, the result will be sorted by this column for all databases
//  - latitude and longitude as floating numbers to store the actual location
//
//  When defining the table for location searches the begining of the table must be defined as the following:
//
//          db.describeTables({
//                  geo: { geohash: { primary: 1 },
//                         id: { primary: 1 },
//                         latitude: { type: "real", projections: 1 },
//                         longitude: { type: "real", projections: 1 },
//                  }
//          });
//  the rest of the columns can be defined as needed, no special requirements.
//
//  *`id` can be any property, it is used for sorting only. For DynamoDB if geohash is an index then lat/long properties must
//   use projections: 1 in order to be included in the index projection.*
//
// `query` must contain the following:
//  - latitude
//  - longitude
//
// other properties:
//  - distance - in km, the radius around the point, if not given the `options.minDistance` will be used
//
// all other properties will be used as additional conditions
//
// `options` optional properties:
//  - top - number of first 'top'th records from each neighboring area, to be used with sorting by the range key to take
//     only highest/lowest matches, useful for trending/statistics, count still defines the total number of locations
//  - geokey - name of the geohash primary key column, by default it is `geohash`, it is possible to keep several different
//     geohash indexes within the same table with different geohash length which will allow to perform
//     searches more precisely depending on the distance given
//  - round - a number that defines the "precision" of  the distance, it rounds the distance to the nearest
//    round number and uses decimal point of the round number to limit decimals in the distance
//  - sort - sorting order, by default the RANGE key is used for DynamoDB, it is possible to specify any Index as well,
//    in case of SQL this is the second part of the primary key
//
// On first call, query must contain latitude and longitude of the center and optionally distance for the radius. On subsequent calls options must be the
// the next_token returned by the previous call and query will be ignored
//
// On return, the callback's third argument contains the object with next_token that must be provided for subsequent searches until rows array is empty.
//
//  Example
//
//          var query = { latitude: -118, longitude: 30, distance: 10 };
//          db.getLocations("bk_location", query, { round: 5 }, function(err, rows, info) {
//              ...
//              // Get next page using previous info object
//              db.getLocations("bk_location", query, info.next_token, function(err, rows, info) {
//                  ...
//              });
//          });
//
db.getLocations = function(table, query, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;

    options = lib.cloneObj(options);
    var cols = db.getColumns(table, options);
    var keys = db.getKeys(table, options);
    var lcols =  ["geohash", "latitude", "longitude"];
    var rows = [];

    // New location search
    if (!options.geohash) {
        options.count = options.gcount = lib.toNumber(options.count, { float: 0, dflt: 10, min: 0, max: 50 });
        options.geokey = lcols[0] = options.geokey && cols[options.geokey] ? options.geokey : 'geohash';
        options.distance = lib.toNumber(query.distance, { float: 0, dflt: options.minDistance || 1, min: 0, max: 999 });
        options.start = null;
        // Have to maintain sorting order for pagination
        if (!options.sort && keys.length > 1) options.sort = keys[1];
        var geo = lib.geoHash(query.latitude, query.longitude, { distance: options.distance, minDistance: options.minDistance });
        for (var p in geo) options[p] = geo[p];
        query[options.geokey] = geo.geohash;
        options.gquery = query;
        ['latitude', 'longitude', 'distance' ].forEach(function(x) { delete query[x]; });
    } else {
        // Original query
        query = options.gquery;
    }
    if (options.top) options.count = options.top;

    logger.debug('getLocations:', table, 'OBJ:', query, 'GEO:', options.geokey, options.geohash, options.distance, 'km', 'START:', options.start, 'COUNT:', options.count, 'NEIGHBORS:', options.neighbors);

    // Collect all matching records until specified count
    lib.doWhilst(
      function(next) {
          db.select(table, query, options, function(err, items, info) {
              if (err) return next(err);

              // Next page if any or go to the next neighbor
              options.start = info.next_token;

              items.forEach(function(row) {
                  row.distance = lib.geoDistance(options.latitude, options.longitude, row.latitude, row.longitude, options);
                  if (row.distance == null) return;
                  // Limit the distance within the allowed range
                  if (options.round > 0 && row.distance - options.distance > options.round) return;
                  // Limit by exact distance
                  if (row.distance > options.distance) return;
                  // If we have selected columns list then clear the columns we dont want
                  if (options.select) Object.keys(row).forEach(function(p) { if (options.select.indexOf(p) == -1) delete row[p]; });
                  rows.push(row);
                  options.count--;
              });
              next(err);
          });
      },
      function() {
          // We have all rows requested
          if (rows.length >= options.gcount) return false;
          // No more in the current geo box, try the next neighbor
          if (!options.start || (options.top && options.count <= 0)) {
              if (!options.neighbors.length) return false;
              query[options.geokey] = options.neighbors.shift();
              if (options.top) options.count = options.top;
              options.start = null;
          }
          return true;
      },
      function(err) {
          // Build next token if we have more rows to search
          var info = {};
          if (options.start || options.neighbors.length > 0) {
              // If we have no start it means this geo box is empty so we need to advance to the next geohash
              // for the next round in order to avoid endless loop
              if (!options.start) query[options.geokey] = options.neighbors.shift();
              // Restore the original count
              options.count = options.gcount;
              // Set most recent query for the next round
              options.gquery = query;
              info.next_token = {};
              ["count","top","geohash","geokey","distance","latitude","longitude","start","neighbors","gquery","gcount"].forEach(function(x) {
                  if (typeof options[x] != "undefined") info.next_token[x] = options[x];
              });
          }
          callback(err, rows, info);
    });
}

// Select objects from the database that match supplied conditions.
// - query - can be an object with properties for the condition, all matching records will be returned,
//   also can be a list where each item is an object with primary key condition. Only records specified in the list must be returned.
// - options can use the following special properties:
//    - ops - operators to use for comparison for properties, an object with column name and operator. The following operators are available:
//       `>, gt, <, lt, =, !=, <>, >=, ge, <=, le, in, between, regexp, iregexp, begins_with, like%, ilike%`
//    - opsMap - operator mapping between supplied operators and actual operators supported by the db
//    - typesMap - type mapping between supplied and actual column types, an object
//    - select - a list of columns or expressions to return or all columns if not specified
//    - start - start records with this primary key, this is the next_token passed by the previous query
//    - count - how many records to return
//    - join - how to join condition expressions, default is AND
//    - sort - sort by this column. if null then no sorting must be done at all, records will be returned in the order they are kept in the DB.
//       _NOTE: For DynamoDB this may affect the results if columns requsted are not projected in the index, with sort
//        `select` property might be used to get all required properties. For Elasticsearch if sort is null then scrolling scan will be used,
//        if no `timeout` or `scroll` are given the default is 1m._
//    - sort_timeout - for pagination how long to keep internal state in millisecons, depends on the DB, for example for Elasticsearch it corresponds
//       to the scroll param and defaults to 60000 (1m)
//    - desc - if sorting, do in descending order
//    - page - starting page number for pagination, uses count to find actual record to start, for SQL databases mostly
//    - unique - specified the column name to be used in determining unique records, if for some reasons there are multiple records in the location
//       table for the same id only one instance will be returned
//    - cacheKey - exlicit key for caching, return from the cche or from the DB and then cache it with this key, works the same as `get`
//    - nocache - do not use cache even if cche key is given
//
// On return, the callback can check third argument which is an object with some predefined properties along with driver specific state returned by the query:
// - affected_rows - how many records this operation affected, for add/put/update
// - inserted_oid - last created auto generated id
// - next_token - next primary key or offset for pagination by passing it as .start property in the options, if null it means there are no more pages availabe for this query
//
// Example: get by primary key, refer above for default table definitions
//
//        db.select("bk_message", { id: '123' }, { count: 2 }, function(err, rows) {
//
//        });
//
// Example: get all icons with type greater or equal to 2
//
//        db.select("bk_icon", { id: '123', type: '2' }, { select: 'id,type', ops: { type: 'ge' } }, function(err, rows) {
//
//        });
//
// Example: get unread msgs sorted by time, recent first
//
//        db.select("bk_message", { id: '123', status: 'N:' }, { sort: "status", desc: 1, ops: { status: "begins_with" } }, function(err, rows) {
//
//        });
//
// Example: allow all accounts icons to be visible
//
//        db.select("bk_account", {}, function(err, rows) {
//            rows.forEach(function(row) {
//                row.acl_allow = 'auth';
//                db.update("bk_icon", row);
//            });
//        });
//
// Example: scan accounts with custom filter, not by primary key: all females
//
//        db.select("bk_account", { gender: 'f' }, function(err, rows) {
//
//        });
//
// Example: select connections using primary key and other filter columns: all likes for the last day
//
//        db.select("bk_connection", { id: '123', type: 'like', mtime: Date.now()-86400000 }, { ops: { type: "begins_with", mtime: "gt" } }, function(err, rows) {
//
//        });
//
db.select = function(table, query, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    if (options && !options.__cached && !options.nocache && options.cacheKey) {
        return this.getCached("select", table, query, options, callback);
    }
    var req = this.prepare(Array.isArray(query) ? "list" : "select", table, query, options);
    this.query(req, req.options, callback);
}

// Retrieve one record from the database by primary key, returns found record or null if not found
// Options can use the following special properties:
//  - select - a list of columns or expressions to return, default is to return all columns
//  - ops - operators to use for comparison for properties, see `db.select`
//  - cached - if specified it runs getCached version
//  - nocache - disable caching even if configured for the table
//
// Example
//
//          db.get("bk_account", { id: '12345' }, function(err, row) {
//             if (row) console.log(row.name);
//          });
//
db.get = function(table, query, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;
    if (!options) options = lib.empty;
    if (!options.__cached && !options.nocache && (options.cached || this.cacheTables.indexOf(table) > -1)) {
        return this.getCached("get", table, query, options, callback);
    }
    var req = this.prepare("get", table, query, options);
    this.query(req, req.options, function(err, rows) {
        callback(err, rows.length ? rows[0] : null);
    });
}

// Create a table using column definitions represented as a list of objects. Each column definition can
// contain the following properties:
// - `name` - column name
// - `type` - column type: int, bigint, real, string, counter or other supported type
// - `primary` - column is part of the primary key
// - `unique` - column is part of an unique key
// - `index` - column is part of an index
// - `value` - default value for the column
// - `len` - column length
// - `pub` - columns is public, *this is very important property because it allows anybody to see it when used in the default API functions, i.e. anybody with valid
//    credentials can retrieve all public columns from all other tables, and if one of the other tables is account table this may expose some personal infoamtion,
//    so by default only a few columns are marked as public in the bk_account table*
// - `secure` - an opposite for the pub property, if defined this property should never be returned to the client by the API handlers
// - `admin` - if defined this property can only be updated an admin account
// - `admins` - if defined this property can be visible by the owner and an admin if result is returned by `api.sendJSON`
// - `hidden` - completely ignored by all update operations but could be used by the public columns cleaning procedure, if it is computed and not stored in the db
//    it can contain pub property to be returned to the client
// - `readonly` - only add/put operations will use the value, incr/update will not affect the value
// - `writeonly` - only incr/update can change this value, add/put will ignore it
// - `noresult` - delete this property from the result, mostly for joined artificial columns which used for indexes only
// - `now` - means on every add/put/update set this column with current time as Date.now()
// - `lower' - make string value lowercase
// - `upper' - make string value uppercase
// - `autoincr` - for counter tables, mark the column to be auto-incremented by the connection API if the connection type has the same name as the column name
// - `join` - a list with porperty names that must be joined together before performing a db operation, it will use the given record to produce new property,
//     this will work both ways, to the db and when reading a record from the db it will split joined property and assign individual
//     properties the value from the joined value.
// - `joinOps` - an array with operations for which perform join only, if not specified applies for all operation, allowed values: add, put, incr, update, del, get, select
//
// *Some properties may be defined multiple times with number suffixes like: unique1, unique2, index1, index2 to create more than one index for the table, same
// properties define a composite key in the order of definition or sorted by the property value, for example: `{ a: { index:2 }, b: { index:1 } }` will create index (b,a)
// because of the `index:` property value being not the same. If all index properties are set to 1 then a composite index will use the order of the properties.*
//
// NOTE: Index creation is not required and all index properties can be omitted, it can be done more effectively using native tools for any specific database,
// this format is for simple and common use cases without using any other tools but it does not cover all possible variations for every database. But all indexes and
// primary keys created outside of the backend application will be detected properly by `db.cacheColumns` and by each pool `cacheIndexes` methods.
//
// Each database pool also can support native options that are passed directly to the driver in the options, these properties are
// defined in the object with the same name as the db driver, all properties are combined, for example to define provisioned throughput for the DynamoDB index:
//
//          db.create("test_table", { id: { primary: 1, type: "int", index: 1, dynamodb: { readCapacity: 50, writeCapacity: 50 } },
//                                    type: { primary: 1, pub: 1, projection: 1 },
//                                    name: { index: 1, pub: 1 } }
//                                  });
//
// Create DynamoDB table with global secondary index, the first index property if not the same as primary key hash defines global index, if it is the same then local,
// below we create global secondary index on property 'name' only, in the example above it was local secondary index for id and name. Also a local secondary index is
// created on `id,title`.
//
// DynamoDB projection is defined by a `projection` property, it can be suffixed with a number to signify which index it must belong to or if it must belong to
// all indexes it can be specified as `projections`
//
//          db.create("test_table", { id: { primary: 1, type: "int", index1: 1 },
//                                    type: { primary: 1, projection: 1 },
//                                    name: { index: 1, projections: 1 }
//                                    title: { index1: 1, projection1: 1 } }
//                                  });
//  When using real DynamoDB creating a table may take some time, for such cases if `options.waitTimeout` is not specified it defaults to 1min,
//  so the callback is called as soon as the table is active or after the timeout whichever comes first.
//
//
// Pass MongoDB options directly:
//        db.create("test_table", { id: { primary: 1, type: "int", mongodb: { w: 1, capped: true, max: 100, size: 100 } },
//                                  type: { primary: 1, pub: 1 },
//                                  name: { index: 1, pub: 1, mongodb: { sparse: true, min: 2, max: 5 } }
//                                });
db.create = function(table, columns, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    var req = this.prepare("create", table, columns, options);
    this.query(req, options, callback);
}

// Upgrade a table with missing columns from the definition list, if after the upgrade new columns must be re-read from the database
// then `info.affected_rows` must be non zero.
db.upgrade = function(table, columns, options, callback)
{
    if (typeof options == "function") callback = options,options = null;
    var req = this.prepare("upgrade", table, columns, options);
    this.query(req, req.options, callback);
}

// Drop a table
db.drop = function(table, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;
    var req = this.prepare("drop", table, {}, options);
    this.query(req, req.options, function(err, rows, info) {
        // Clear the table cache
        if (!err) {
            var pool = self.getPool(table, options);
            delete pool.dbcolumns[table];
            delete pool.dbkeys[table];
            delete pool.dbindexes[table];
        }
        callback(err, rows, info);
    });
}

// Convert native database error in some generic human readable string
db.convertError = function(pool, table, op, err, options)
{
    if (!err || !util.isError(err)) return err;
    if (typeof pool == "string") pool = this.pools[pool];
    err = pool.convertError(table, op, err, options);
    if (util.isError(err)) {
        switch (err.code) {
        case "AlreadyExists":
            return { message: lib.__("Record already exists"), status: 409 };

        case "NotFound":
            return { message: lib.__("Record could not be found"), status: 404 };
        }
    }
    return err;
}

// Define new tables or extend/customize existing tables. Table definitions are used with every database operation,
// on startup, the backend read all existing table columns from the database and cache them in the memory but some properties
// like public columns are only specific to the backend so to mark such columns the table with such properties must be described
// using this method. Only columns with changed properties need to be specified, other columns will be left as it is.
//
// Example
//
//          db.describeTables({ bk_account: { name: { pub: 1 } },
//                              test: { id: { primary: 1, type: "int" },
//                                      name: { pub: 1, index: 1 } });
//
db.describeTables = function(tables, callback)
{
    var changed = false;
    for (var p in tables) {
        var table1 = this.tables[p];
        if (!table1) this.tables[p] = table1 = {};
        var table2 = tables[p];
        for (var c in table2) {
            if (!table1[c]) table1[c] = {};
            // Merge columns
            for (var k in table2[c]) {
                table1[c][k] = table2[c][k];
            }
        }
        // Produce keys and indexes
        this.keys[p] = [];
        var indexes = {};
        for (var c in table1) {
            if (table1[c].primary) this.keys[p].push(c);
            ["","1","2","3","4","5"].forEach(function(n) {
                if (!table1[c]["index" + n]) return;
                if (!indexes[n]) indexes[n] = [];
                indexes[n].push(c);
            });
        }
        this.indexes[p] = {};
        this.keys[p].sort(function(a, b) { return table1[a].primary - table1[b].primary });
        for (var n in indexes) {
            var name = [];
            indexes[n].sort(function(a, b) { return table1[a]["index" + n] - table1[b]["index" + n] });
            this.indexes[p][indexes[n].join("_")] = indexes[n];
        }
    }
    if (typeof callback == "function") callback();
}

// Refresh columns for all polls which need it
db.refreshColumns = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    var pools = this.getPools();
    lib.forEachLimit(pools, pools.length, function(pool, next) {
        if (!pool.poolOptions.cacheColumns) return next();
        self.cacheColumns(pool.name, next);
    }, callback);
}

// Reload all columns into the cache for the pool, options can be a pool name or an object like `{ pool: name }`.
// if `tables` property is an arary it asks to refresh only specified tables if that is possible.
db.cacheColumns = function(options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (typeof options == "string") options = { pool: options };

    var pool = this.getPool('', options);
    pool.cacheColumns.call(pool, options, function(err) {
        if (err) logger.error('cacheColumns:', pool.name, lib.traceError(err));
        pool.cacheIndexes.call(pool, options, function(err) {
            if (err) logger.error('cacheIndexes:', pool.name, err);
            // Allow other modules to handle just cached columns for post processing
            if (Array.isArray(self.processColumns)) {
                self.processColumns.forEach(function(x) {
                    if (typeof x == "function") x.call(pool, options);
                });
            }
            if (typeof callback == "function") callback(err);
        });
    });
}

// Prepare for execution for the given operation: add, del, put, update,...
// Returns prepared object to be passed to the driver's .query method. This method is a part of the driver
// helpers and is not used directly in the applications.
db.prepare = function(op, table, obj, options)
{
    var pool = this.getPool(table, options);

    // Check for table name, it can be determined in the real time
    table = pool.resolveTable(op, table || "", obj, options).toLowerCase();

    // Prepare row properties
    var req = { op: op, table: table, text: "", obj: obj, options: options };
    this.prepareRow(pool, req);
    pool.prepare(req);
    return req;
}

// Preprocess an object for a given operation, convert types, assign defaults...
db.prepareRow = function(pool, req)
{
    if (!pool) pool = this.getPool(req.table, req.options);

    // Keep an object in the format we support
    switch (lib.typeName(req.obj)) {
    case "object":
    case "string":
    case "array":
        break;
    default:
        req.obj = {};
    }

    // Cache table columns
    req.columns = this.getColumns(req.table, req.options);

    // Pre-process input properties before sending it to the database, make a shallow copy of the
    // object to preserve the original properties in the parent
    if (!req.options || !req.options.noprocessrows) {
        switch (req.op) {
        case "create":
        case "upgrade":
            break;

        default:
            if (this.getProcessRows('pre', req.table, req.options)) req.obj = lib.cloneObj(req.obj);
            this.runProcessRows("pre", req.table, req, req.obj, req.options);
        }
        // Always run the global hook, keep the original object
        this.runProcessRows("pre", "*", req, req.obj, req.options);
    }

    var col, orig = {};
    // Original record before the prepare processing
    for (var p in req.obj) orig[p] = req.obj[p];

    switch (req.op) {
    case "add":
    case "put":
    case "incr":
    case "update":
        this.prepareForUpdate(pool, req, orig);
        break;

    case "del":
        this.prepareForDelete(pool, req, orig);
        break;

    case "get":
    case "select":
        this.prepareForSelect(pool, req, orig);
        break;

    case "list":
        this.prepareForList(pool, req, orig);
        break;
    }
}

// Keep only columns from the table definition if we have it
// Go over all properties in the object and makes sure the types of the values correspond to the column definition types,
// this is for those databases which are very sensitive on the types like DynamoDB.
db.prepareForUpdate = function(pool, req, orig)
{
    var o = {}, v, col;
    for (var p in req.obj) {
        v = req.obj[p];
        if (this.skipColumn(p, v, req.options, req.columns)) continue;
        col = req.columns[p];
        if (col) {
            // Skip artificial join columns
            if (pool.poolOptions.noJoinColumns && Array.isArray(col.join) && col.join.indexOf(p) == -1) continue;
            // Convert into native data type
            if (v !== null) {
                if (pool.poolOptions.strictTypes) {
                    if (col.primary || col.index || col.type) v = lib.toValue(v, col.type);
                } else {
                    // Handle json separately in sync with convertRows
                    if (pool.poolOptions.noJson && col.type == "json") v = JSON.stringify(v);
                }
            }
            // Verify against allowed values
            if (Array.isArray(col.values) && col.values.indexOf(String(v)) == -1) continue;
            // Max length limit for text fields
            if (col.maxlength && typeof v == "string" && !col.type && v.length > col.maxlength) v = v.substr(0, col.maxlength);
        }
        if ((v == null || v === "") && pool.poolOptions.skipNull && pool.poolOptions.skipNull[req.op]) continue;
        o[p] = v;
    }
    req.obj = o;
    for (var p in req.columns) {
        col = req.columns[p];
        // Restrictions
        if (col.hidden || (col.readonly && (req.op == "incr" || req.op == "update")) || (col.writeonly && (req.op == "add" || req.op == "put"))) {
            delete req.obj[p];
            continue;
        }
        if (req.op == "add" || req.op == "put") {
            if (typeof col.value != "undefined" && typeof req.obj[p] == "undefined") req.obj[p] = col.value;
            if (typeof req.obj[p] == "undefined") {
                if (col.type == "counter") req.obj[p] = 0;
                if (col.type == "uuid") req.obj[p] = lib.uuid();
            }
        }
        if (col.now && !req.obj[p] && (!col.primary || req.op == "add")) req.obj[p] = Date.now();
        if (col.lower && typeof req.obj[p] == "string") req.obj[p] = req.obj[p].toLowerCase();
        if (col.upper && typeof req.obj[p] == "string") req.obj[p] = req.obj[p].toUpperCase();
        if (typeof req.obj[p] != "undefined" && col.type == "counter") req.obj[p] = lib.toNumber(req.obj[p]);
        this.joinColumn(req.op, req.obj, p, col, req.options, orig);
    }
}

db.prepareForDelete = function(pool, req, orig)
{
    var o = {}, v, col;
    for (var p in req.obj) {
        v = req.obj[p];
        col = req.columns[p];
        if (this.skipColumn(p, v, req.options, req.columns)) continue;
        // Convert into native data type
        if (pool.poolOptions.strictTypes && (col.primary || col.type) && typeof v != "undefined") v = lib.toValue(v, col.type);
        o[p] = v;
    }
    req.obj = o;
    for (var p in req.columns) {
        this.joinColumn(req.op, req.obj, p, req.columns[p], req.options, orig);
    }
}

db.prepareForSelect = function(pool, req, orig)
{
    // Keep only columns, non existent properties cannot be used
    var o = {}, col;
    for (var p in req.obj) {
        if (!this.skipColumn(p, req.obj[p], req.options, req.columns)) o[p] = req.obj[p];
    }
    req.obj = o;

    // Convert simple types into the native according to the table definition, some query parameters are not
    // that strict and can be arrays which we should not convert due to options.ops
    for (var p in req.columns) {
        col = req.columns[p];
        if (pool.poolOptions.strictTypes) {
            var type = typeof req.obj[p];
            if (lib.isNumericType(col.type)) {
                if (type == "string" && req.obj[p]) req.obj[p] = lib.toNumber(req.obj[p]);
            } else {
                switch (col.type) {
                case "bool":
                case "boolean":
                    if (type == "number") req.obj[p] = lib.toBool(req.obj[p]); else
                    if (type == "string" && req.obj[p]) req.obj[p] = lib.toBool(req.obj[p]);
                    break;
                default:
                    if (type == "number") req.obj[p] = String(req.obj[p]);
                }
            }
        }
        // Case conversion
        if (col.lower && typeof req.obj[p] == "string") req.obj[p] = req.obj[p].toLowerCase();
        if (col.upper && typeof req.obj[p] == "string") req.obj[p] = req.obj[p].toUpperCase();

        // Default search op, for primary key cases
        var ops = req.options && req.options.ops || lib.empty;
        if (col.ops && col.ops[req.op] && !ops[p]) {
            req.options = lib.cloneObj(req.options);
            lib.objSet(req.options, ["ops", p], col.ops[req.op]);
        }

        switch (ops[p]) {
        case "in":
        case "between":
            if (!Array.isArray(req.obj[p])) {
                if (req.obj[p]) {
                    req.obj[p] = lib.strSplit(req.obj[p], null, col.type);
                } else {
                    delete req.obj[p];
                }
            }
            break;
        }

        // Joined values for queries, if nothing joined or only one field is present keep the original value
        this.joinColumn(req.op, req.obj, p, col, req.options, orig);
    }
}

db.prepareForList = function(pool, req, orig)
{
    var col;
    for (var i = 0; i < req.obj.length; i++) {
        for (var p in req.columns) {
            col = req.columns[p];
            if (pool.poolOptions.strictTypes) {
                if (lib.isNumericType(col.type)) {
                    if (typeof req.obj[i][p] == "string") req.obj[i][p] = lib.toNumber(req.obj[i][p]);
                } else {
                    if (typeof req.obj[i][p] == "number") req.obj[i][p] = String(req.obj[i][p]);
                }
            }
            // Joined values for queries, if nothing joined or only one field is present keep the original value
            this.joinColumn(req.op, req.obj[i], p, col, req.options, orig);
            // Delete at the end to give a chance some joined columns to be created
            if (!col.primary) delete req.obj[i][p];
        }
    }
}

// Convert rows returned by the database into the Javascript format or into the format
// defined by the table columns.
// The following special properties in the column definition chnage the format:
//  - type = json - if a column type is json and the value is a string returned will be converted into a Javascript object
//  - dflt property is defined for a json type and record does not have a value it will be set to specified default value
//  - list - split the value into array
//  - unjoin - a list of names, it produces new properties by splitting the value by a separator and assigning pieces to
//      separate properties using names from the list, this is the opposite of the `join` property and is used separately if
//      splitting is required, if joined properties already in the record then no need to split it
//
//      Example:
//              db.describeTables([ { user: { id: {}, name: {}, pair: { join: ["left","right"], split: ["left", "right"] } } ]);
//
//              db.put("test", { id: "1", type: "user", name: "Test", left: "123", right: "000" })
//              db.select("test", {}, lib.log)
//
db.convertRows = function(pool, req, rows, options)
{
    var self = this;
    if (typeof pool == "string") pool = this.pools[pool];
    if (!pool) pool = this.getPool(req.table, options);
    var col, cols = req.columns || this.getColumns(req.table, options || req.options);

    for (var p in cols) {
        col = cols[p];
        // Convert from JSON type
        if (pool.poolOptions.noJson && col.type == "json") {
            for (var i = 0; i < rows.length; i++) {
                if (typeof rows[i][p] == "string" && rows[i][p]) rows[i][p] = lib.jsonParse(rows[i][p], { logger: "error" });
            }
        }

        // Split into a list
        if (col.list) {
            for (var i = 0; i < rows.length; i++) {
                rows[i][p] = lib.strSplit(rows[i][p]);
            }
        }
        // Extract joined values and place into separate columns
        this.unjoinColumns(rows, p, col, options);

        // Default value on return
        if (cols[p].dflt) {
            for (var i = 0; i < rows.length; i++) {
                if (!rows[i][p]) rows[i][p] = cols[p].dflt;
            }
        }

        // Do not return
        if (col.noresult) {
            for (var i = 0; i < rows.length; i++) delete row[p];
        }
    }
    return rows;
}

// Add a callback to be called after each cache columns event, it will be called for each pool separately.
// The callback to be called may take options argument and it is called in the context of the pool.
//
// The primary goal for this hook is to allow management of the existing tables which are not own by the
// backendjs application. For such tables, because we have not created them, we need to define column properties
// after the fact and to keep column definitions in the app for such cases is not realistic. This callback will
// allow to handle such situations and can be used to set necessary propeties to the table columns.
//
// Example, a few public columns, allow an admin to see all the columns
//
//         db.setProcessColumns(function() {
//             var cols = db.getColumns("users", { pool: this.name });
//             for (var p in  cols) {
//                 if (["id","name"].indexOf(p) > -1) cols[p].pub = 1; else cols[p].admin = 1;
//             }
//         })
db.setProcessColumns = function(callback)
{
    if (typeof callback != "function") return;
    this.processColumns.push(callback);
}

// Returns a list of hooks to be used for processing rows for the given table
db.getProcessRows = function(type, table, options)
{
    if (!type || !table || !this.processRows[type]) return null;
    var hooks = this.processRows[type][table];
    return Array.isArray(hooks) && hooks.length ? hooks : null;
}

// Run registered pre- or post- process callbacks.
// - `type` is one of the `pre` or 'post`
// - `table` - the table to run the hooks for, usually the same as req.table but can be '*' for global hooks
// - `req` is the original db request object with the following required properties: `op, table, obj, options, info`,
// - `rows` is the result rows for post callbacks and the same request object for pre callbacks.
// - `options` is the same object passed to a db operation or some other with different flags to use
db.runProcessRows = function(type, table, req, rows, options)
{
    if (!req) return rows;
    var hooks = this.getProcessRows(type, table, options || req.options);
    if (!hooks) return rows;

    // Stop on the first hook returning true to remove this row from the list
    function processRow(row) {
        for (var i = 0; i < hooks.length; i++) {
            if (hooks[i].call(row, req, row, options || req.options) === true) return false;
        }
        return true;
    }
    if (Array.isArray(rows)) {
        rows = rows.filter(processRow);
    } else {
        processRow(rows);
    }
    return rows;
}

// Assign a processRow callback for a table, this callback will be called for every row on every result being retrieved from the
// specified table thus providing an opportunity to customize the result.
//
// type defines at what time the callback will be called:
//  - `pre` - making a request to the db on the query record
//  - `post` - after the request finished to be called on the result rows
//
// All assigned callback to this table will be called in the order of the assignment.
//
// The callback accepts 3 arguments: function(req, row, options)
//   where:
//  - `req` - the original request for a db operation with required
//      - `op` - current db operation, like add, put, ....
//      - `table` -  current table being updated
//      - `obj` - the record with data
//      - `pool` - current request db pool name
//      - `info` - an object returned with special properties like affected_rows, next_token, only passed to the `post` callbacks
//  - `row` - a row from the result
//  - `options` - the obj passed to the original db called
//
// When producing complex properties by combining other properties it needs to be synchronized using both pre and post
// callbacks to keep the record consistent.
//
// **For queries returning rows, if the callback returns true for a row it will be filtered out and not included in the final result set.**
//
//
//  Example
//
//      db.setProcessRow("post", "bk_account", function(req, row, opts) {
//          if (row.birthday) row.age = Math.floor((Date.now() - lib.toDate(row.birthday))/(86400000*365));
//      });
//
//      db.setProcessRow("post", "bk_icon", function(req, row, opts) {
//          if (row.type == "private" && row.id != opts.account.id) return true;
//      });
//
db.setProcessRow = function(type, table, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (!table || typeof callback != "function") return;
    if (!this.processRows[type]) this.processRows[type] = {};
    if (!this.processRows[type][table]) this.processRows[type][table] = [];
    this.processRows[type][table].push(callback);
}

// Returns true if a pool exists
db.existsPool = function(name)
{
    return !!this.pools[name];
}

// Returns true if a table exists
db.existsTable = function(table, options)
{
    return this.getPool(table, options).dbcolumns[(table || "").toLowerCase()] ? true : false;
}

// Return database pool by table name or default pool, options can be a pool name or an object with { pool: name } to return
// the pool by given name. This call always return valid pool object, in case no requiested pool found it returns
// default pool. A special pool `none` always return empty result and no errors.
db.getPool = function(table, options)
{
    var pool = options ? (typeof options == "string" ? this.pools[options] : options.pool ? this.pools[options.pool] : null) : null;
    if (!pool && this.poolTables[table]) pool = this.pools[this.poolTables[table]];
    if (!pool) pool = this.pools[this.pool];
    return pool || this.pools.none;
}

// Return all tables know to the given pool, returned tables are in the object with
// column information merged from cached columns from the database with description columns
// given by the application. If `options.names` is 1 then return just table names as a list.
db.getPoolTables = function(name, options)
{
    var pool = this.getPool('', name);
    var tables = pool.poolOptions.cacheColumns ? pool.dbcolumns : this.tables;
    if (options && options.names) tables = Object.keys(tables);
    return tables;
}

// Return a list of all active database pools, returns list of objects with name: and type: properties
db.getPools = function()
{
    var rc = [];
    for (var p in this.pools)  {
        if (p != "none") rc.push({ name: this.pools[p].name, type: this.pools[p].type });
    }
    return rc;
}

// Return columns for a table or null, columns is an object with column names and objects for definition.
db.getColumns = function(table, options)
{
    return this.tables[(table || "").toLowerCase()] || lib.empty;
}

// Return the column definition for a table
db.getColumn = function(table, name, options)
{
    return this.getColumns(table, options)[(name || "").toLowerCase()];
}

// Check if the given index name corresponds to a real table column, for compound indexes the convention is to
// concatenate all columns with underscore, if the index is not a column name check the last part if it is a column name
// that can be used in sorting the results. This is for databases that do not support compound indexes.
db.getSortingColumn = function(table, options)
{
    if (!options || !options.sort) return "";
    var cols = this.getColumns(table, options);
    if (cols[options.sort]) return options.sort;
    var sort = options.sort.split("_").pop();
    if (cols[sort]) return sort;
    return "";
}

// Return an object with capacity property which is the max write capacity for the table, for DynamoDB only.
// By default it checks `writeCapacity` property of all table columns and picks the max.
//
// The options can specify the capacity explicitely:
// - useCapacity - what to use for capacity rating, can be `write`, `read` or a number with max capacity to use
// - factorCapacity - a number between 0 and 1 to multiple the rate capacity
// - rateCapacity - if set it will be used for rate capacity limit
// - maxCapacity - if set it will be used as the max burst capacity limit
db.getCapacity = function(table, options)
{
    if (!options) options = lib.empty;
    var capacity = this.getPool(table, options).dbcapacity[table] || lib.empty;
    capacity = capacity[options.sort] || capacity[table] || lib.empty;
    var cap = { table: table, writeCapacity: capacity.read || 0, readCapacity: capacity.write || 0, unitCapacity: 1 };
    var use = options.useCapacity;
    var factor = options.factorCapacity > 0 && options.factorCapacity <= 1 ? options.factorCapacity : 1;
    cap.maxCapacity = Math.max(1, typeof use == "number" ? use : use == "read" ? cap.readCapacity : cap.writeCapacity);
    cap.rateCapacity =  Math.max(1, cap.maxCapacity*factor);
    for (var p in options) cap[p] = options[p];
    if (cap.rateCapacity > 0) cap._tokenBucket = new metrics.TokenBucket(cap.rateCapacity, cap.maxCapacity);
    return cap;
}

// Check if number of requests exceeds the capacity per second, delay if necessary, for DynamoDB only but can be used for pacing
// requests with any database or can be used generically. The `cap` must be initialized with `db.getCapacity` call.
db.checkCapacity = function(cap, consumed, callback)
{
    if (typeof consumed == "function") callback = consumed, consumed = 1;
    if (!cap || !cap._tokenBucket || typeof cap._tokenBucket.consume != "function") return callback();

    if (cap._tokenBucket.consume(consumed)) return callback();
    logger.debug("checkCapacity:", consumed, cap);
    setTimeout(callback, cap._tokenBucket.delay(consumed));
}

// Return list of selected or allowed only columns, empty list if no `options.select` is specified
db.getSelectedColumns = function(table, options)
{
    var self = this;
    if (options && options.select && options.select.length) {
        var cols = this.getColumns(table, options);
        var list = lib.strSplitUnique(options.select);
        var select = Object.keys(cols).filter(function(x) { return !self.skipColumn(x, "", options, cols) && list.indexOf(x) > -1; });
        if (select.length) return select;
    } else
    if (options && options.skip_columns) {
        var cols = this.getColumns(table, options);
        var select = Object.keys(cols).filter(function(x) { return !self.skipColumn(x, "", options, cols); });
        if (select.length) return select;
    }
    return null;
}

// Join several columns to produce a combined property if configured, given a column description and an object record
// it replaces the column value with joined value if needed. Empty properties will be still joined as empty strings.
// It always uses the original value even if one of the properties has been joined already.
//
// Checks for `join` and `joinOps` properties in the column definition.
//
// The `options.skip_join` can be used to restrict joins, it is a list with columns that should not be joined
//
// The `options.strict_join` can be used to perform join only if all columns in the list are not empty, so the join
// is for all columns or none
//
db.joinColumn = function(op, obj, name, col, options, orig)
{
    if (col &&
        Array.isArray(col.join) &&
        !(options && options.noJoinColumns) &&
        (!Array.isArray(col.joinOps) || col.joinOps.indexOf(op) > -1) &&
        (!options || !Array.isArray(options.skip_join) || options.skip_join.indexOf(name) == -1)) {
        var separator = col.separator || this.separator;
        if (typeof obj[name] != "string" || obj[name].indexOf(separator) == -1) {
            var c, d, v = "", n = 0;
            for (var i = 0; i < col.join.length; i++) {
                c = col.join[i];
                d = (orig && orig[c]) || obj[c] || "";
                if (d) {
                    n++;
                } else {
                    if (col.strict_join || (options && options.strict_join)) return;
                }
                v += (i ? separator : "") + d;
            }
            if (v && n) obj[name] = v;
        }
    }
}

// Split joined columns for all rows
db.unjoinColumns = function(rows, name, col, options)
{
    if (Array.isArray(col.unjoin)) {
        var row, separator = col.separator || this.separator;
        for (var i = 0; i < rows.length; i++) {
            row = rows[i];
            if (typeof row[name] == "string" && row[name].indexOf(separator) > -1) {
                var v = row[name].split(separator);
                if (v.length >= col.unjoin.length) {
                    for (var j = 0; j < col.unjoin.length; j++) row[col.unjoin[j]] = v[j];
                }
            }
        }
    }
}

// Verify column against common options for inclusion/exclusion into the operation, returns 1 if the column must be skipped
//  - to enable all properties to be saved in the record without column definition set `options.no_columns=1`
//  - to skip all null values set `options.skip_null=1`
//  - to skip specific columns define `options.skip_columns=["a","b"]`
//  - to restrict to specific columns only define `options.allow_columns=["a","b"]`
db.skipColumn = function(name, val, options, columns)
{
    if (!name || name[0] == '_' || typeof val == "undefined") return true;
    if (options) {
        if (!options.no_columns && (!columns || !columns[name])) return true;
        if (options.skip_null && val === null) return true;
        if (Array.isArray(options.allow_columns) && options.allow_columns.indexOf(name) == -1) return true;
        if (Array.isArray(options.skip_columns) && options.skip_columns.indexOf(name) > -1) return true;
    }
    return false;
}

// Given object with data and list of keys perform comparison in memory for all rows, return only rows that match all keys. This method is used
// by custom filters in `db.select` by the drivers which cannot perform comparisons with non-indexes columns like DynamoDb, Cassandra.
// The rows that satisfy primary key conditions are returned and then called this function to eliminate the records that do not satisfy non-indexed column conditions.
//
// Options support the following propertis:
// - keys - list of columns to check, these may or may not be the primary keys, any columns to be compared
// - cols - an object with columns definition
// - ops - operations for columns
// - typesMap - types for the columns if different from the actual Javascript type
db.filterRows = function(obj, rows, options)
{
    if (!options) options = lib.empty;
    var ops = options.ops || lib.empty;
    var typesMap = options.typesMap || lib.empty;
    var cols = options.cols || lib.empty;
    var keys = options.keys || [];
    // Keep rows which satisfy all conditions
    return rows.filter(function(row) {
        return keys.every(function(name) {
            return lib.isTrue(row[name], obj[name], ops[name], typesMap[name] || (cols[name] || lib.empty).type);
        });
    });
}

// Return cached primary keys for a table or empty array
db.getKeys = function(table, options)
{
    table = (table || "").toLowerCase();
    return this.getPool(table, options).dbkeys[table] || this.keys[table] || lib.emptylist;
}

// Return keys for the table search, if options.keys provided and not empty it will be used otherwise
// table's primary keys will be returned. This is a wrapper that makes sure that valid keys are used and
// deals with input errors like empty keys list to be consistent between different databases.
// This function always returns an Array even if it is empty.
db.getSearchKeys = function(table, options)
{
    var keys = options && options.keys ? options.keys : null;
    if (!Array.isArray(keys) || !keys.length) keys = this.getKeys(table, options);
    return keys;
}

// Return query object based on the keys specified in the options or primary keys for the table, only search properties
// will be returned in the query object
db.getSearchQuery = function(table, obj, options)
{
    return this.getQueryForKeys(this.getSearchKeys(table, options), obj, options);
}

// Returns an object based on the list of keys, basically returns a subset of properties.
// `options.keysMap` defines an object to map record properties with the actual names to be returned.
db.getQueryForKeys = function(keys, obj, options)
{
    var self = this;
    return (keys || lib.emptylist).
            filter(function(x) { return !self.skipColumn(x, obj[x]) }).
            map(function(x) { return [ options && options.keysMap ? (options.keysMap[x] || x) : x, obj[x] ] }).
            reduce(function(x,y) { x[y[0]] = y[1]; return x; }, {});
}

// Return possibly converted value to be used for inserting/updating values in the database,
// is used for SQL parameterized statements
//
// Parameters:
//  - options - standard pool parameters with pool: property for specific pool
//  - val - the JavaScript value to convert into bind parameter
//  - info - column definition for the value from the cached columns
db.getBindValue = function(table, options, val, info)
{
    return this.getPool(table, options).bindValue(val, info, options);
}

// Return transformed value for the column value returned by the database, same parameters as for getBindValue
db.getColumnValue = function(table, options, val, info)
{
    var cb = this.getPool(table, options).columnValue;
    return typeof cb == "function" ? cb(val, info) : val;
}

// Retrieve cached result or put a record into the cache prefixed with table:key[:key...]
// Options accept the same parameters as for the usual get action but it is very important that all the options
// be the same for every call, especially `select` parameters which tells which columns to retrieve and cache.
// Additional options:
// - prefix - prefix to be used for the key instead of table name
//
//  Example:
//
//      db.getCached("get", "bk_account", { id: req.query.id }, { select: "latitude,longitude" }, function(err, row) {
//          var distance = lib.geoDistance(req.query.latitude, req.query.longitude, row.latitude, row.longitudde);
//      });
//
db.getCached = function(op, table, query, options, callback)
{
    var self = this;
    if (typeof options == "function") callback = options,options = null;
    if (typeof callback != "function") callback = lib.noop;
    options = lib.cloneObj(options, "__cached", true);
    // Always get the full record
    delete options.select;
    var pool = this.getPool(table, options);
    table = pool.resolveTable(op, table, query, options).toLowerCase();
    var req = { op: op, table: table, obj: query, options: options };
    this.prepareRow(pool, req);
    var m = pool.metrics.Timer('cache').start();
    this.getCache(table, req.obj, options, function(data) {
        m.end();
        // Cached value retrieved
        if (data) data = lib.jsonParse(data);
        // Parse errors treated as miss
        if (data) {
            pool.metrics.Counter("hits").inc();
            return callback(null, data, {});
        }
        pool.metrics.Counter("misses").inc();
        // Retrieve account from the database, use the parameters like in Select function
        self[op](table, query, options, function(err, data, info) {
            // Store in cache if no error
            if (data && !err) self.putCache(table, data, options);
            callback(err, data, info);
        });
    });
}

// Retrieve an object from the cache by key, sets `cacheKey` in the options for later use
db.getCache = function(table, query, options, callback)
{
    var key = this.getCacheKey(table, query, options);
    if (!key) return callback();
    if (options) options.cacheKey = key;
    var ttl2 = this.getCache2Ttl(table, options);
    if (ttl2 > 0) {
        var val = bkcache.lruGet(key, Date.now());
        if (val) {
            logger.debug("getCache2:", key, options, 'ttl2:', ttl2);
            return callback(val);
        }
    }
    var opts = this.getCacheOptions(table, options);
    ipc.get(key, opts, function(val) {
        if (!val) return callback();
        if (ttl2 > 0) bkcache.lruPut(key, val, Date.now() + ttl2);
        logger.debug("getCache:", key, opts, 'ttl2:', ttl2);
        callback(val);
    });
}

// Store a record in the cache
db.putCache = function(table, query, options)
{
    var key = options && options.cacheKey ? options.cacheKey : this.getCacheKey(table, query, options);
    if (!key) return;
    var opts = this.getCacheOptions(table, options);
    var val = lib.stringify(query);
    var ttl2 = this.getCache2Ttl(table, options);
    if (ttl2 > 0) bkcache.lruPut(key, val, Date.now() + ttl2);
    ipc.put(key, val, opts);
    logger.debug("putCache:", key, opts, 'ttl2:', ttl2);
}

// Notify or clear cached record, this is called after del/update operation to clear cached version by primary keys
db.delCache = function(table, query, options)
{
    var key = options && options.cacheKey ? options.cacheKey : this.getCacheKey(table, query, options);
    if (!key) return;
    var opts = this.getCacheOptions(table, options);
    var ttl2 = this.getCache2Ttl(table, options);
    if (ttl2 > 0) bkcache.lruDel(key);
    ipc.del(key, opts);
    logger.debug("delCache:", key, opts, 'ttl2:', ttl2);
}

// Returns concatenated values for the primary keys, this is used for caching records by primary key
db.getCacheKey = function(table, query, options)
{
    if (options && options.cacheKey) return options.cacheKey;
    var keys = this.getKeys(table, options).filter(function(x) { return query[x] }).map(function(x) { return query[x] }).join(this.separator);
    if (keys) keys = (options && options.cachePrefix ? options.cachePrefix : table) + this.separator + keys;
    return keys;
}

// Setup common cache properties
db.getCacheOptions = function(table, options)
{
    var ttl = this.cacheTtl[table] || this.cacheTtl.default;
    var cacheName = (options && options.pool ? this.cacheName[options.pool + "." + table] : "") || this.cacheName[table];
    if (ttl || cacheName) return { cacheName: cacheName, ttl: ttl };
    return null;
}

// Return TTL for level 2 cache
db.getCache2Ttl = function(table, options)
{
    var pool = this.getPool(table, options);
    return options.cache2Ttl || this.cache2[pool.name + "-" + table] || this.cache2[table];
}

// Create a new database pool with default methods and properties
// - options - an object with default pool properties
//    - type - pool type, this is the db driver name
//    - pool or name - pool name
//    - watchfile - file path to be watched for changes, all clients will be destroyed gracefully
//    - min - min number of open database connections
//    - max - max number of open database connections, all attempts to run more will result in clients waiting for the next available db connection, if set to 0 no
//            pooling will be enabled and will result in the unlimited connections, this is default for DynamoDB
//    - max_queue - how many db requests can be in the waiting queue, above that all requests will be denied instead of putting in the waiting queue
//
// The db methods cover most use cases but in case native driver needs to be used this is how to get the client and use it with its native API,
// it is required to call `pool.release` at the end to return the connection back to the connection pool.
//
//          var pool = db.getPool("", { pool: "mongodb" });
//          pool.get(function(err, client) {
//              var collection = client.collection('bk_account');
//              collection.findOne({ id: '123' }, function() {
//                  pool.release(client);
//              });
//          });
//
db.Pool = function(options)
{
    // Methods for db client allocations and release
    if (lib.isPositive(options.max)) {
        var methods = {
            create: function(callback) {
                try {
                    this.open.call(this, callback);
                } catch(e) {
                    logger.error('pool.create:', this.name, e);
                    callback(e);
                }
            },
            reset: function(client) {
                if (typeof client.reset == "function") client.reset();
            },
            destroy: function(client, callback) {
                try {
                    this.close.call(this, client, callback);
                } catch(e) {
                    logger.error("pool.destroy:", this.name, e);
                    if (typeof callback == "function") callback(e);
                }
            },
        };
        lib.Pool.call(this, methods);
    } else {
        lib.Pool.call(this);
    }
    this.type = options.type || "none";
    this.name = options.pool || options.name || options.type;
    this.url = options.url || "default";
    this.metrics = new metrics.Metrics('name', this.name);
    this.poolOptions = {};
    this.connectOptions = {};
    this.dbcolumns = {};
    this.dbkeys = {};
    this.dbindexes = {};
    this.dbcapacity = {};
    this.configure(options);
}

util.inherits(db.Pool, lib.Pool);

// Reconfigure properties, only subset of properties are allowed here so it is safe to apply all of them directly,
// this is called during realtime config update
db.Pool.prototype.configure = function(options)
{
    this.init(options);
    if (options.url) this.url = options.url;
    if (lib.isObject(options.poolOptions)) this.poolOptions = lib.mergeObj(this.poolOptions, options.poolOptions);
    if (lib.isObject(options.connectOptions)) this.connectOptions = lib.mergeObj(this.connectOptions, options.connectOptions);
    logger.debug("pool.configure:", this.name, this.type, options);
}

db.Pool.prototype.shutdown = function(callback, maxtime)
{
    var self = this;
    lib.Pool.prototype.shutdown.call(this, function() {
        self.metrics = new metrics.Metrics();
        self.dbcolumns = self.dbkeys = self.dbindexes = {};
        self.poolOptions = self.connectOptions = {};
        if (typeof callback == "function") callback();
    }, maxtime);
}

// Open a connection to the database, default is to return an empty object as a client
db.Pool.prototype.open = function(callback)
{
    if (typeof cb == "function") callback(null, {});
};

// Close a connection, default is do nothing
db.Pool.prototype.close = function(client, callback)
{
    if (typeof callback == "function") callback();
}

// Query the database, always return an array as a result (i.e. the second argument for the callback)
db.Pool.prototype.query = function(client, req, options, callback)
{
    if (typeof callback == "function") callback(null, []);
};

// Cache columns for all tables
db.Pool.prototype.cacheColumns = function(options, callback)
{
    if (typeof callback == "function") callback();
}

// Cache indexes for all tables
db.Pool.prototype.cacheIndexes = function(options, callback)
{
    if (typeof callback == "function") callback();
};

// Return next token from the client object
db.Pool.prototype.nextToken = function(client, req, rows, options)
{
    return client.next_token || null;
};

// Default prepare is to return all parameters in an object
db.Pool.prototype.prepare = function(req)
{
}

// Return the value to be used in binding, mostly for SQL drivers, on input value and col info are passed, this callback
// may convert the value into something different depending on the DB driver requirements, like timestamp as string into milliseconds
db.Pool.prototype.bindValue = function(value, info, options)
{
    return value;
}

// Converts native DB driver error into other human readable format
db.Pool.prototype.convertError = function(table, op, err, options)
{
    return err;
}

// that is called after this pool cached columms from the database, it is called sychnroniously inside the `db.cacheColumns` method.
db.Pool.prototype.processColumns = function(pool)
{
}

// Return possible different table at the time of the query, it is called by the `db.prepare` method
// and if exist it must return the same or new table name for the given query parameters.
db.Pool.prototype.resolveTable = function(op, table, obj, options)
{
    return table;
}

// Create a database pool for SQL like databases
// - options - an object defining the pool, the following properties define the pool:
//    - pool - pool name/type, if not specified the SQLite is used
//    - max - max number of clients to be allocated in the pool
//    - idle - after how many milliseconds an idle client will be destroyed
db.SqlPool = function(options)
{
    // SQL databases cannot support unlimited connections, keep reasonable default to keep it from overloading
    if (!lib.isPositive(options.max)) options.max = 25;

    db.Pool.call(this, options);
    this.poolOptions = lib.mergeObj(this.poolOptions, db.sqlPoolOptions);
}
util.inherits(db.SqlPool, db.Pool);

// Call column caching callback with our pool name
db.SqlPool.prototype.cacheColumns = function(options, callback)
{
    db.sqlCacheColumns(this, options, callback);
}

// Prepare for execution, return an object with formatted or transformed SQL query for the database driver of this pool
db.SqlPool.prototype.prepare = function(req)
{
    db.sqlPrepare(this, req);
}

// Execute a query or if req.text is an Array then run all queries in sequence
db.SqlPool.prototype.query = function(client, req, options, callback)
{
    db.sqlQuery(this, client, req, options, callback);
}

// Support for pagination, for SQL this is the OFFSET for the next request
db.SqlPool.prototype.nextToken = function(client, req, rows, options)
{
    return options && options.count && rows.length == options.count ? lib.toNumber(options.start) + lib.toNumber(options.count) : null;
}

db.SqlPool.prototype.updateAll = function(table, query, obj, options, callback)
{
    var req = db.prepare("update", table, query, obj, lib.extendObj(options, "keys", Object.keys(obj)));
    db.query(req, req.options, callback);
}

db.SqlPool.prototype.delAll = function(table, query, options, callback)
{
    var req = db.prepare("del", table, query, lib.extendObj(options, "keys", Object.keys(query)));
    db.query(req, req.options, callback);
}
