//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var util = require('util');
var fs = require('fs');
var repl = require('repl');
var path = require('path');
var crypto = require('crypto');
var url = require('url');
var http = require('http');
var https = require('https');
var exec = require('child_process').exec;
var backend = require(__dirname + '/build/backend');
var logger = require(__dirname + '/logger');
var cluster = require('cluster');
var printf = require('printf');
var async = require('async');
var os = require('os');
var emailjs = require('emailjs');
var memcached = require('memcached');
var redis = require("redis");

// The primary object containing all config options and common functions
var core = {
    name: 'backend',
    version: '2013.10.20.0', 

    // Process and config parameters
    argv: [],

    // Server role, used by API server, for provisioning must include backend
    role: '',

    // Local domain
    domain: '',

    // Instance mode, remote jobs
    instance: false,

    // Home directory, current by default, must be absolute path
    home: process.env.HOME + '/.backend',

    // Various folders, by default relative paths are used
    path: { etc: "etc", spool: "var", images: "images", tmp: "tmp", web: "web", log: "log" },

    // Log file for debug and other output from the modules, error or info messages, default is stdout
    logfile: null,

    // HTTP port of the server
    port: 80,
    bind: '0.0.0.0',

    // Number of parallel tasks running at the same time, can be used by various modules
    concurrency: 2,
    ipaddr: '',
    hostname: '',

    // Unix user/group privileges to set after opening port 80 and if running as root, in most cases this is ec2-user on Amazon cloud,
    // for manual installations rc.backend setup will create a user with this id
    uid: 777,
    gid: 0,
    umask: '0002',

    // Watched source files for changes, restartes the process if any file has chaged
    watchdirs: [],
    timers: {},

    // Log watcher config, watch for server restarts as well
    logwatcherMax: 1000000,
    logwatcherInterval: 3600,
    logwatcherIgnore: "NOTICE: |DEBUG: |DEV: ",
    logwatcherFiles: [ { file: "/var/log/messages", match: /\[[0-9]+\]: (ERROR|WARNING): |message":"ERROR:|queryAWS:.+Errors:|startServer:|startFrontend:/ },
                       { name: "logfile", match: /\[[0-9]+\]: ERROR: |message":"ERROR:|queryAWS:.+Errors:|startServer:|startFrontend:/ } ],

    // User agent
    userAgent: ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.8; rv:18.0) Gecko/20100101 Firefox/18.0",
                 "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.8; rv:21.0) Gecko/20100101 Firefox/21.0",
                 "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.7; rv:20.0) Gecko/20100101 Firefox/20.0",
                 "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_3) AppleWebKit/536.29.13 (KHTML, like Gecko) Version/6.0.4 Safari/536.29.13",
                 "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_3) AppleWebKit/537.31 (KHTML, like Gecko) Chrome/26.0.1410.65 Safari/537.31",
                 "Mozilla/5.0 (X11; Linux i686) AppleWebKit/534.34 (KHTML, like Gecko) Safari/534.34",
                 "Opera/9.80 (Macintosh; Intel Mac OS X 10.7.5) Presto/2.12.388 Version/12.15",
                 "Mozilla/5.0 (Windows NT 6.1; WOW64; rv:21.0) Gecko/20100101 Firefox/21.0",
                 "Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.1; WOW64; Trident/6.0; SLCC2; .NET CLR 2.0.50727",
                 "Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.1; WOW64; Trident/6.0; SLCC2; .NET CLR 3.5.30729; .NET CLR 3.0.30729; Media Center PC 6.0; .NET4.0C; InfoPath.2; BRI/2",
                 ],

    // Config parameters
    args: [ { name: "help", type: "callback", value: function() { core.help() }, descr: "Print help and exit" },
            { name: "debug", type: "callback", value: function() { logger.setDebug('debug'); }, descr: "Enable debuggng messages", pass: 1 },
            { name: "log", type: "callback", value: function(v) { logger.setDebug(v); }, descr: "Set debugging level: none, log, debug, dev", pass: 1 },
            { name: "logfile", type: "callback", value: function(v) { logger.setFile(v); }, descr: "File where to write logging messages", pass: 1 },
            { name: "syslog", type: "callback", value: function(v) { logger.setSyslog(v ? this.toBool(v) : true); }, descr: "Write all logging messages to syslog", pass: 1 },
            { name: "console", type: "callback", value: function() { core.logfile = null; logger.setFile(null);}, descr: "All logging goes to the console", pass: 1 },
            { name: "home", type: "callback", value: "setHome", descr: "Specify home directory for the server, current dir if not specified", pass: 1 },
            { name: "concurrency", type:"number", min: 1, max: 4, descr: "How many simultaneous tasks to run att he same time inside one process" },
            { name: "umask", descr: "Filesystem mask" },
            { name: "uid", type: "number", min: 0, max: 9999, descr: "User id to switch after start if running as root" },
            { name: "gid", type: "number", min: 0, max: 9999, descr: "Group id to switch after start if running to root" },
            { name: "port", type: "number", min: 0, max: 99999, descr: "HTTP port to listen for the servers, this is global default" },
            { name: "bind", descr: "Bind to this address only, if not specified listen on all interfaces" },
            { name: "daemon", type: "none", descr: "Daemonize the process, go to the background" },
            { name: "shell", type: "none", descr: "Run command line shell, load the backend into the memory and prompt for the commands" },
            { name: "repl", type: "none", descr: "Initialize REPL interface to be accesed via TCP port" },
            { name: "watch", type: "none", descr: "For development, while the server is running restart it if any of the source files got changed" },
            { name: "monitor", type: "none", descr: "For production, monitor the server processes and restart if crashed or exited" },
            { name: "master", type: "none", descr: "Start the master server" },
            { name: "proxy", type: "none", descr: "Start the HTTP proxy server, uses etc/proxy config file" },
            { name: "proxy-port", type: "none", descr: "Proxy server port" },
            { name: "proxy-bind", type: "none", descr: "Proxy server listen address" },
            { name: "web", type: "none", descr: "Start Web server processes, spawn workers that listen on the same port" },
            { name: "web-port", type: "none", descr: "Web server port" },
            { name: "web-bind", type: "none", descr: "Web server listen address" },
            { name: "web-repl-port", type: "none", descr: "Web server REPL port" },
            { name: "web-repl-bind", type: "none", descr: "Web server REPL listen address" },
            { name: "repl-port", type: "number", min: 0, max: 99999, descr: "Port for REPL interface server, global default" },
            { name: "repl-bind", descr: "Listen only on specified address for REPL server, global default" },
            { name: "repl-file", descr: "User specified file for REPL history" },
            { name: "lru-max", type: "number", descr: "Max number of items in the LRU cache" },
            { name: "lru-server", descr: "LRU server that acts as a NNBUS node to brosadcast cache messages to all connected backends" },
            { name: "lru-host", descr: "Address of NNBUS servers for cache broadcasts: ipc:///path,tcp://IP:port..." },
            { name: "memcache-host", type: "list", descr: "List of memcached servers for cache messages: IP:port,IP:port..." },
            { name: "memcache-options", type: "json", descr: "JSON object with options to the Memcached client, see npm doc memcached" },
            { name: "redis-host", descr: "Address to Redis server for cache messages" },
            { name: "redis-options", type: "json", descr: "JSON object with options to the Redis client, see npm doc redis" },
            { name: "cache-type", descr: "One of the redis or memcache to use for caching in API requests" },
            { name: "no-cache", type:" bool", descr: "Do not use LRU server, all gets will result in miss and puts will have no effect" },
            { name: "worker", type:" bool", descr: "Set this process as a worker even it is actually a master, this skips some initializations" },
            { name: "logwatcher-email", descr: "Email for the logwatcher notifications" },
            { name: "logwatcher-from", descr: "Email to send logwatcher notifications from" },
            { name: "logwatcher-ignore", descr: "Regexp with patterns that needs to be ignored by logwatcher process" },
            { name: "logwatcher-match", descr: "Regexp patterns that match conditions for logwatcher notifications" },
            { name: "logwatcher-interval", type: "number", min: 300, max: 86400 },
            { name: "user-agent", type: "push", descr: "Add HTTP user-agent header to be used in HTTP requests, for scrapers" },
            { name: "backend-host", descr: "Host of the master backend" },
            { name: "backend-key", descr: "Credentials key for the master backend access" },
            { name: "backend-secret", descr: "Credentials secret for the master backend access" },
            { name: "domain", descr: "Domain to use for communications, default is current domain of the host machine" },
            { name: "max-distance", type: "number", min: 0.1, max: 999, descr: "Max searchable distance(radius)" },
            { name: "min-distance", type: "number", min: 0.1, max: 999, descr: "Radius for the smallest bounding box in km containing single location, radius searches will combine neighboring boxes of this size to cover the whole area with the given distance request" },
            { name: "instance", type: "bool", descr: "enables instance mode, means the backend is runnin on remote instance" },
            { name: "backtrace", type: "callback", value: function() { backend.setbacktrace(); }, descr: "Enable backtrace fcility, trap crashes and report the backtrace stack" },
            { name: "watch", type: "callback", value: function(v) { this.watch = true; this.watchdirs.push(v ? v : __dirname); }, descr: "Watch sources directory for file changes to restart the server, for development" }
    ],
        
    // Geo min distance for the hash key, km
    minDistance: 5,
    // Max searchable distance, km
    maxDistance: 50,
    
    // Inter-process messages
    ipcs: {},
    ipcId: 1,
    ipcTimeout: 500,
    lruMax: 1000,

    // REPL port for server
    replPort: 2080,
    replBind: '0.0.0.0',
    replFile: '.history',
    context: {},
}

module.exports = core;

// Main intialization, must be called prior to perform any actions
core.init = function(callback) 
{
    var self = this;
    // Default home as absolute path
    self.setHome(self.home);
    
    // Find our IP address
    var intf = os.networkInterfaces();
    Object.keys(intf).forEach(function(x) {
        if (!self.ipaddr && x.substr(0, 2) != 'lo') {
            intf[x].forEach(function(y) { if (y.family == 'IPv4' && y.address) self.ipaddr = y.address; });
        }
    });
    // Default domain from local host name
    var host = os.hostname().split('.');
    self.hostname = host[0];
    self.domain = host.length > 2 ? host.slice(1).join('.') : self.hostname;

    var db = self.context.db;
    
    // Serialize initialization procedure, run each function one after another
    async.series([
        function(next) {
        	// Initial args to run before the config file
        	self.processArgs("core", self, process.argv, 1);
            self.loadConfig(next);
        },

        // Create all directories, only master should do it once but we resolve absolute paths in any mode
        function(next) {
            // Redirect system logging to stderr
            logger.setChannel("stderr");
            
            // Process all other arguments
            self.parseArgs(process.argv);
            
            try { process.umask(self.umask); } catch(e) { logger.error("umask:", self.umask, e) }

            // Resolve to absolute paths
            var files = [];
            Object.keys(self.path).forEach(function(p) {
                self[p] = path.resolve(self.path[p]);
                files.push(self[p]);
            });
            
            if (!cluster.isWorker && !self.worker) {
                // Create all subfolders
                files.forEach(function(dir) { self.mkdirSync(dir); });

                // Make sure created files are owned by regular user, not the root
                if (process.getuid() == 0) {
                    files.push(path.join(self.path.spool, self.name + ".db"));
                    files.forEach(function(f) { self.chownSync(f) });
                }
            }
            db.init(next);
        },

        function(next) {
            // Watch config directory for changes
            fs.watch(self.etc, function (event, filename) {
                logger.debug('watcher:', event, filename);
                switch (filename) {
                case "config":
                    self.setTimeout(filename, function() { self.loadConfig(); }, 5000);
                    break;
                }
            });
            next();
        }],
        // Final callbacks
        function(err) {
            logger.debug("core: init:", err || "");
            if (callback) setImmediate(function() { 
                callback.call(self, err); 
            });
    });
}

// Run any backend function after environment has been intialized, this is to be used in shell scripts,
// core.init will parse all command line arguments, the simplest case to run from /data directory and it will use
// default environment or pass -home dir so the script will reuse same config and paths as the server
// context can be specified for the callback, if no then it run in the core context
// - require('backend').run(function() {}) is one example where this call is used as a shortcut for ad-hoc scripting
core.run = function(callback) 
{
    var self = this;
    if (!callback) return logger.error('run:', 'callback is required');
    this.init(function(err) {
        callback.call(self, err);
    });
}

// Switch to new home directory, exit if we cannot, this is important for relative paths to work if used,
// no need to do this in worker because we already switched to home diretory in the master and all child processes
// inherit current directory
// Important note: If run with combined server or as a daemon then this MUST be an absolute path, otherwise calling 
// it in the spawned web master will fail due to the fact that we already set the home and relative path will not work after that. 
core.setHome = function(home) 
{
	var self = this;
    if ((home || self.home) && cluster.isMaster) {
        if (home) self.home = path.resolve(home);
        try {
            self.makePath(self.home);
            process.chdir(self.home);
        } catch(e) {
            logger.error('setHome: cannot set home directory', self.home, e);
            process.exit(1);
        }
        logger.dev('setHome:', self.home);
    }
    self.home = process.cwd();
}

// Parse command line arguments
core.parseArgs = function(argv) 
{
    var self = this;
    if (!argv || !argv.length) return;

    // Append all process arguments into internal list
    self.argv = this.argv.concat(argv);

    // Convert spaces if passed via command line
    argv = argv.map(function(x) { return x.replace(/%20/g, ' ') });
    logger.dev('parseArgs:', argv.join(' '));
    
   // Core parameters
    self.processArgs("core", self, argv);
    
    // Run registered handlers for each module
    for (var n in this.context) {
        var ctx = this.context[n];
        if (ctx.parseArgs) ctx.parseArgs.call(ctx, argv);
        self.processArgs(n, ctx, argv);
    }
}

// Config parameters defined in a module as a list of parameter names prefixed with module name, a parameters can be
// a string which defines text parameter or an object with the properties: name, type, value, decimals, min, max, separator
// type can be bool, number, list, json
core.processArgs = function(name, ctx, argv, pass) 
{
    var self = this;
    if (!ctx) return;
    if (!Array.isArray(ctx.args)) return;
    ctx.args.forEach(function(x) {
    	// Process only equal to the given pass phase
    	if (pass && x.pass != pass) return;
        if (typeof x == "string") x = { name: x };
        if (!x.name) return;
        // Core sets global parameters, all others by module
        var cname = (name == "core" ? "" : "-" + name) + '-' + x.name;
        if (argv.indexOf(cname) == -1) return;
        var key = self.toCamel(x.name);
        var val = self.getArg(cname, null, argv);
        if (val == null && x.type != "bool" && x.type != "callback") return;
        // Ignore the value if it is a parameter
        if (val && val[0] == '-') val = ""; 
        logger.dev("processArgs:", name, ":", key, "=", val);
        switch (x.type || "") {
        case "none":
            break;
        case "bool":
            ctx[key] = !val ? true : self.toBool(val);
            break;
        case "number":
            ctx[key] = self.toNumber(val, x.decimals, x.value, x.min, x.max);
            break;
        case "list":
            ctx[key] = self.strSplitUnique(val, x.separator);
            break;
        case "regexp":
            ctx[key] = new RegExp(val);
            break;
        case "json":
            ctx[key] = JSON.parse(val);
            break;
        case "path":
            ctx[key] = path.resolve(val);
            break;
        case "push":
            if (!Array.isArray(ctx[key])) ctx[key] = [];
            ctx[key].push(val);
            break;
        case "callback":
            if (typeof x.value == "string") {
                ctx[x.value](val);
            } else
            if (typeof x.value == "function") {
                x.value.call(ctx, val);
            }
            break;
        default:
            ctx[key] = val;
        }
    });
}

// Print help about command line arguments and exit
core.help = function() 
{
    var self = this;
    var args = [ [ '', core.args ] ];
    Object.keys(this.context).forEach(function(n) { if (self.context[n].args) args.push([n, self.context[n].args]); })
    args.forEach(function(x) { x[1].forEach(function(y) { if (y.name && y.descr) console.log(printf("%-40s", (x[0] ? x[0] + '-' : '') + y.name), y.descr); }); });
    process.exit(0);
}

// Parse local config file
core.loadConfig = function(callback) 
{
    var self = this;

    fs.readFile(path.join(self.path.etc, "config"), function(err, data) {
        if (!err && data) {
            var argv = [], lines = data.toString().split("\n");
            for (var i = 0; i < lines.length; i++) {
                var line = lines[i].split("=");
                if (line[0]) argv.push('-' + line[0]);
                if (line[1]) argv.push(line.slice(1).join('='));
            }
            self.parseArgs(argv);
        }
        if (callback) callback();
    });
}

// Setup 2-way IPC channel between master and worker.
// Cache management signaling, all servers maintain local cache per process of account, any server in the cluster
// that modifies an account record sends 'del' command to clear local caches so the actual record will be re-read from 
// the database, all servers share the same database and update it directly. The eviction is done in 2 phases, first local process cache
// is cleared and then it sends a broadcast to all servers in the cluster using nanomsg socket, other servers all subscribed to that
// socket and listen for messages.
core.ipcInitServer = function() 
{
    var self = this;

    // Attach our message handler to all workers, process requests from workers
    backend.lruInit(self.lruMax);
    
    // Run LRU cache server, receive cache refreshes from the socket, clears/puts cache entry and broadcasts 
    // it to other connected servers via the same BUS socket
    if (self.lruServer) {
        var sock = backend.nnCreate(backend.AF_SP_RAW, backend.NN_BUS);
        backend.nnBind(sock, self.lruServer);
        backend.lruServer(0, sock, sock);
    }
    
    // Send cache requests to the LRU host to be broadcasted to all other servers
    if (self.lruHost) {
        self.lruSocket = backend.nnCreate(backend.AF_SP, backend.NN_BUS);
        backend.nnConnect(self.lruSocket, self.lruHost);
    }
    
    cluster.on('fork', function(worker) {
        // Handle cache request from a worker, send back cached value if exists, this method is called inside worker context
        worker.on('message', function(msg) {
            if (!msg) return false;
            logger.debug('LRU:', msg);
            switch (msg.cmd) {
            case 'keys':
                msg.value = backend.lruKeys();
                worker.send(msg);
                break;
                
            case 'get':
                if (msg.key) msg.value = backend.lruGet(msg.key);
                worker.send(msg);
                break;

            case 'put':
                if (msg.key && msg.value) backend.lruSet(msg.key, msg.value);
                if (msg.reply) worker.send({});
                if (self.lruSocket) backend.nnSend(self.lruSocket, msg.key + "\1" + msg.value);
                break;

            case 'incr':
                if (msg.key && msg.value) backend.lruIncr(msg.key, msg.value);
                if (msg.reply) worker.send({});
                if (self.lruSocket) backend.nnSend(self.lruSocket, msg.key + "\2" + msg.value);
                break;
                
            case 'del':
                if (msg.key) backend.lruDel(msg.key);
                if (msg.reply) worker.send({});
                if (self.lruSocket) backend.nnSend(self.lruSocket, msg.key);
                break;
                
            case 'clear':
                backend.lruClear();
                if (msg.reply) worker.send({});
                break;
            }
        });
    });
}

core.ipcInitClient = function() 
{
    var self = this;

    switch (this.cacheType || "") {
    case "memcache":
        self.memcacheClient = new memcached(self.memcacheHost, self.memcacheOptions || {});
        self.ipcPutCache = function(k, v) { self.memcacheClient.set(k, v, 0); }
        self.ipcIncrCache = function(k, v) { self.memcacheClient.incr(k, v, 0); }
        self.ipcDelCache = function(k) { self.memcacheClient.del(k); }
        self.ipcGetCache = function(k, cb) { self.memcacheClient.get(k, function(e,v) { cb(v) }); }
        break;
        
    case "redis":
        self.redisClient = redis.createClient(null, self.redisHost, self.redisOptions || {});
        self.ipcPutCache = function(k, v) { self.redisClient.set(k, v, function() {}); }
        self.ipcIncrCache = function(k, v) { self.redisClient.incr(k, v, function() {}); }
        self.ipcDelCache = function(k) { self.redisClient.del(k, function() {}); }
        self.ipcGetCache = function(k, cb) { self.redisClient.get(k, function(e,v) { cb(v) }); }
        break;
    }
    // Event handler for the worker to process response and fire callback
    process.on("message", function(msg) {
        if (!msg.id) return;
        if (self.ipcs[msg.id]) setImmediate(function() { 
            self.ipcs[msg.id].callback(msg); 
            delete self.ipcs[msg.id];
        });
            
        switch (msg.cmd) {
        case "heapsnapshot":
            backend.heapSnapshot("tmp/" + process.pid + ".heapsnapshot");
            break;
        }
    });
}

// Send cache command to the master process via IPC messages, callback is used for commands that return value back
core.ipcSend = function(cmd, key, value, callback) 
{
    var self = this;
    if (typeof value == "function") callback = value, value = '';
    var msg = { cmd: cmd, key: key, value: value };
    if (typeof callback == "function") {
        msg.reply = true;
        msg.id = self.ipcId++;
        self.ipcs[msg.id] = { timeout: setTimeout(function() { delete self.ipcs[msg.id]; callback(); }, self.ipcTimeout),
                              callback: function(m) { clearTimeout(self.ipcs[msg.id].timeout); callback(m.value); } };
    }
    process.send(msg);
}

core.ipcGetCache = function(key, callback) 
{ 
    if (this.noCache) return callback ? callback() : null;
    this.ipcSend("get", key, callback); 
}

core.ipcDelCache = function(key)
{ 
    if (this.noCache) return;
    this.ipcSend("del", key); 
}

core.ipcPutCache = function(key, val) 
{ 
    if (this.noCache) return;
    this.ipcSend("put", key, val); 
}

core.ipcIncrCache = function(key, val) 
{ 
    if (this.noCache) return;
    this.ipcSend("incr", key, val); 
}

// Encode with additional symbols
core.encodeURIComponent = function(str) 
{
    return encodeURIComponent(str || "").replace("!","%21","g").replace("*","%2A","g").replace("'","%27","g").replace("(","%28","g").replace(")","%29","g");
}

// Convert text into captalized words
core.toTitle = function(name)
{
    return (name || "").replace(/_/g, " ").split(/[ ]+/).reduce(function(x,y) { return x + y[0].toUpperCase() + y.substr(1) + " "; }, "").trim();
}

// Convert into camelized form
core.toCamel = function(name) 
{
    return (name || "").replace(/(?:[-_])(\w)/g, function (_, c) { return c ? c.toUpperCase () : ''; });
}

// Safe version, use 0 instead of NaN, handle booleans, if decimals specified, returns float
core.toNumber = function(str, decimals, dflt, min, max) 
{
    str = String(str);
    // Autodetect floating number
    if (typeof decimals == "undefined" || decimals == null) decimals = /^[0-9-]+\.[0-9]+$/.test(str);
    if (typeof dflt == "undefined") dflt = 0;
    var n = str[0] == 't' ? 1 : str[0] == 'f' ? 0 : (decimals ? parseFloat(str,10) : parseInt(str,10));
    n = isNaN(n) ? dflt : n;
    if (typeof min != "undefined" && n < min) n = min;
    if (typeof max != "undefined" && n > max) n = max;
    return n;
}

// Return true if value represents true condition
core.toBool = function(val) 
{
    return !val || val == "false" || val == "FALSE" || val == "f" || val == "F" || val == "0" ? false : true;
}

// Return Date object for given text or numeric date represantation, for invalid date returns 1969
core.toDate = function(val) 
{
    var d = null;
    // Assume it is seconds which we use for most mtime columns, convert to milliseconds
    if (typeof val == "number" && val < 2147483647) val *= 1000;
    try { d = new Date(val); } catch(e) {}
    return d || new Date(0);
}

// Convert value to the proper type
core.toValue = function(val, type) 
{
    switch ((type || this.typeName(val))) {
    case 'array':
        return Array.isArray(val) ? val : String(val).split(/[,\|]/);
        
    case "expr":
    case "buffer":
        return val;

    case "real":
    case "float":
    case "double":
        return core.toNumber(val, true);

    case "int":
    case "integer":
    case "number":
        return core.toNumber(val);

    case "bool":
    case "boolean":
        return core.toBool(val);

    case "date":
    case "time":
        return this.toDate(val);

    case "mtime":
        return /^[0-9\.]+$/.test(value) ? this.toNumber(val) : (new Date(val));

    default:
        return val;
    }
}

// Evaluate expr, compare 2 values with optional type and opertion
core.isTrue = function(val1, val2, op, type) 
{
    switch ((op ||"").toLowerCase()) {
    case 'null':
        if (v) return false;
        break;
        
    case 'not null':
        if (!v) return false;
        break;
        
    case ">":
    case "gt":
        if (this.toValue(val1, type) <= this.toValue(val2, type)) return false;
        break;
        
    case "<":
    case "lt":
        if (this.toValue(val1, type) >= this.toValue(val2, type)) return false;
        break;

    case ">=":
    case "ge":
        if (this.toValue(val1, type) < this.toValue(val2, type)) return false;
        break;
        
    case "<=":
    case "le":
        if (this.toValue(val1, type) > this.toValue(val2, type)) return false;
        break;
        
    case "between":
    case "not between":
        // If we cannot parse out 2 values, treat this as exact operator
        var list = [];
        switch (core.typeName(val2)) {
        case "array":
            list = val2;
            break;

        case "string":
            // For number array allow to be separated by comma as well, either one but not to be mixed
            if ((type == "number" || type == "int") && val2.indexOf(',') > -1) {
                list = val2.split(',');
                break;
            } else
            if (value.indexOf('|') > -1) {
                list = val2.split('|');
                break;
            }
        }
        if (list.length > 1) {
            if (this.toValue(val1, type) < this.toValue(list[0], type) || this.toValue(val1, type) > this.toValue(list[1], type)) return false;
        } else {
            if (this.toValue(val1, type) != this.toValue(val2, type)) return false;
        }
        break;
        
    case '~* any':
    case '!~* any':
        break;

    case 'like%':
    case "ilike%":
    case "not like%":
    case "not ilike%":
        break;
        
    case "!~":
    case "!~*":
    case "iregexp":
    case "not iregexp":
        break;
        
    case "in":
    case "not in":
        break;
        
    case "~":
    case "~*":
    case "regexp":
    case "not regexp":
        break;
        
    case "!=":
    case "<>":
        if (this.toValue(val1, type) == this.toValue(val2, type)) return false;
        break;
        
    default:
        if (this.toValue(val1, type) != this.toValue(val2, type)) return false;
    }
    return true;
}

// Downloads file using HTTP and pass it to the callback if provided
// - uri can be full URL or an object with parts of the url, same format as in url.format
// - params can contain the following options:
//   - method - GET, POST
//   - headers - object with headers to pass to HTTP request, properties must be all lower case
//   - cookies - a list with cookies or a boolean to load cookies from the db
//   - file - file name where to save response, in case of error response the error body will be saved as well
//   - postdata - data to be sent with the request in the body
//   - postfile - file to be uploaded in the POST body, not as multipart
//   - query - aditional query parameters to be added to the url as an object or as encoded string
//   - sign - sign request with provided email/secret properties
// - callback will be called with the arguments:
//     first argument is error object if any
//     second is params object itself with updted fields
//     third is HTTP response object
// On end, the object params will contains the following updated properties:
//  - data if file was not specified, data eill contain collected response body as string
//  - status - HTTP response status code
//  - mtime - Date object with the last modified time of the requested file
//  - size - size of the response body or file
// Note: SIDE EFFECT: params object is modified in place so many options will be changed/removed or added
core.httpGet = function(uri, params, callback) 
{
    var self = this;
    if (typeof params == "function") callback = params, params = null;
    if (!params) params = {};

    // Aditional query parameters as an object
    var qtype = this.typeName(params.query);
    switch (this.typeName(uri)) {
    case "object":
        uri = url.format(uri);
        break;
        
    case "string":
        var q = url.format({ query: qtype == "object" ? params.query: null, search: qtype == "string" ? params.query: null });
        uri += uri.indexOf("?") == -1 ? q : q.substr(1);
        break;
        
    default:
        return callback ? callback(new Error("invalid url: " + uri)) : null;
    }
    
    var options = url.parse(uri);
    options.method = params.method || 'GET';
    options.headers = params.headers || {};
    options.agent = params.agent || null;
    options.rejectUnauthorized = false;
    
    // Make sure required headers are set
    if (!options.headers['user-agent']) {
        options.headers['user-agent'] = this.userAgent[this.randomInt(0, this.userAgent.length-1)];
    }
    if (options.method == "POST" && !options.headers["content-type"]) {
        options.headers["content-type"] = "application/x-www-form-urlencoded";
    }
    
    // Load matched cookies and restart with the cookie list in the params
    if (params.cookies) {
        if (typeof params.cookies == "boolean" && options.hostname) {
            this.cookieGet(options.hostname, function(cookies) {
                params.cookies = cookies;
                self.httpGet(uri, params, callback);
            });
            return;
        }
        // Cookie list already provided, just use it
        if (Array.isArray(params.cookies)) {
            options.headers["cookie"] = params.cookies.map(function(c) { return c.name+"="+c.value; }).join("; ");
            logger.debug('httpGet:', uri, options.headers);
        }
    }
    if (!options.headers['accept']) {
        options.headers['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }
    options.headers['accept-language'] = 'en-US,en;q=0.5';
    
    // Data to be sent over in the body
    if (params.postdata) {
        if (options.method == "GET") options.method = "POST";
        switch (this.typeName(params.postdata)) {
        case "string":
        case "buffer":
            break;
        case "object":
            params.postdata = JSON.stringify(params.postdata);
            options.headers['content-type'] = "application/json";
            break;
        default:
            params.postdata = String(params.postdata);
        }
        options.headers['content-length'] = params.postdata.length; 
    } else
    if (params.postfile) {
        if (options.method == "GET") options.method = "POST";
        options.headers['transfer-encoding'] = 'chunked';
        params.poststream = fs.createReadableStream(params.postfile);
        params.poststream.on("error", function(err) { logger.error('httpGet: stream:', params.postfile, err) });
    }

    // Make sure our data is not corrupted
    if (params.checksum) options.checksum = params.postdata ? this.hash(params.postdata) : null;
    
    // Sign request using internal backend credentials
    if (params.sign) {
        var headers = this.signRequest(params.email, params.secret, options.method, options.hostname, options.path, 0, options.checksum);
        for (var p in headers) options.headers[p] = headers[p];
    }
    
    // Runtime properties
    if (!params.retries) params.retries = 0;
    if (!params.redirects) params.redirects = 0;
    if (!params.httpTimeout) params.httpTimeout = 300000;
    if (!params.ignoreredirect) params.ignoreredirect = {};
    params.size = 0, params.err = null, params.fd = 0, params.status = 0, params.data = '', params.poststream = null;
    params.href = options.href, params.pathname = options.pathname, params.hostname = options.hostname;
    var req = null;
    var mod = uri.indexOf("https://") == 0 ? https : http;

    req = mod.request(options, function(res) {
      logger.dev("httpGet: started", options.method, 'headers:', options.headers, params)
      
      res.on("data", function(chunk) {
          logger.dev("httpGet: data", 'size:', chunk.length, '/', params.size, "status:", res.statusCode, 'file:', params.file || '');

          if (params.stream) {
              try {
                  params.stream.write(chunk);
              } catch(e) {
                  if (!params.quiet) logger.error('httpGet:', "stream:", e);
                  params.err = e;
                  req.abort();
              }
          } else
          if (params.file) {
              try {
                  if (!params.fd && res.statusCode >= 200 && res.statusCode < 300) {
                      params.fd = fs.openSync(params.file, 'w');
                  }
                  if (params.fd) {
                      fs.writeSync(params.fd, chunk, 0, chunk.length, null);
                  }
              } catch(e) {
                  if (!params.quiet) logger.error('httpGet:', "file:", params.file, e);
                  params.err = e;
                  req.abort();
              }
          } else {
              params.data += chunk.toString();
          }
          params.size += chunk.length
      });

      res.on("end", function() {
          // Array means we wanted to use cookies just did not have existing before the request, now we can save the ones we received
          if (Array.isArray(params.cookies)) {
              self.cookieSave(params.cookies, res.headers["set-cookie"], params.hostname);
          }
          params.headers = res.headers;
          params.status = res.statusCode;
          params.type = (res.headers['content-type'] || '').split(';')[0];
          params.mtime = res.headers.date ? new Date(res.headers.date) : null;
          if (!params.size) params.size = self.toNumber(res.headers['content-length'] || 0);
          if (params.fd) try { fs.closeSync(params.fd); } catch(e) {}
          if (params.stream) try { params.stream.end(params.onfinish); } catch(e) {}
          params.fd = 0;

          logger.dev("httpGet: end", options.method, "url:", uri, "size:", params.size, "status:", params.status, 'type:', params.type, 'location:', res.headers.location || '');

          // Retry the same request
          if (params.retries && (res.statusCode < 200 || res.statusCode >= 400)) {
              params.retries--;
              setTimeout(function() { self.httpGet(uri, params, callback); }, params.retryTimeout || 500);
              return;
          }
          // Redirection
          if (res.statusCode >= 301 && res.statusCode <= 307 && !params.noredirects) {
              params.redirects += 1;
              if (params.redirects < 10) {
                  var uri2 = res.headers.location;
                  if (uri2.indexOf("://") == -1) {
                      uri2 = options.protocol + "//" + options.host + uri2;
                  }
                  logger.dev('httpGet:', 'redirect', uri2);

                  // Ignore redirects we dont want and return data recieved
                  if (!params.ignoreredirect[uri2]) {
                      ['method','query','headers','postdata','postfile','poststream','sign','checksum'].forEach(function(x) { delete params[x] });
                      if (params.cookies) params.cookies = true;
                      return self.httpGet(uri2, params, callback);
                  }
              }
          }
          logger.debug("httpGet: done", options.method, "url:", uri, "size:", params.size, "status:", res.statusCode, 'type:', params.type, 'location:', res.headers.location || '');

          if (callback) callback(params.err, params, res);
      });

    }).on('error', function(err) {
        if (!params.quiet) logger.error("httpGet:", "onerror:", uri, 'file:', params.file || "", 'retries:', params.retries, 'timeout:', params.httpTimeout, 'size;', params.size, err);
        // Keep trying if asked for it
        if (params.retries) {
            params.retries--;
            setTimeout(function() { self.httpGet(uri, params, callback); }, params.retryTimeout || 500);
            return;
        }
        if (callback) callback(err, params, {});
    });
    if (params.httpTimeout) {
        req.setTimeout(params.httpTimeout, function() {
            if (!params.quiet) logger.error("httpGet:", "timeout:", uri, 'file:', params.file || "", 'retries:', params.retries, 'timeout:', params.httpTimeout);
            req.abort();
        });
    }
    if (params.postdata) {
        req.write(params.postdata);
    } else
    if (params.poststream) {
        params.poststream.pipe(req);
        return req;
    }
    req.end();
    return req;
}

// Produce signed URL to be used in embeded cases or with expiration so the url can be passed and be valid for longer time.
// Host passed here must be the actual host where the request will be sent
core.signUrl = function(accesskey, secret, host, uri, expires) 
{
    var hdrs = this.signRequest(accesskey, secret, "GET", host, uri, "", expires);
    return uri + (uri.indexOf("?") == -1 ? "?" : "") + "&b-signature=" + encodeURIComponent(hdrs['b-signature']);
}

// Sign HTTP request for the API server:
// url must include all query parametetrs already encoded and ready to be sent
// expires is absolute time in milliseconds when this request will expire, default is 30 seconds from now
// checksum is SHA1 digest of the POST content, optional
core.signRequest = function(id, secret, method, host, uri, expires, checksum) 
{
    var now = Date.now();
    if (!expires) expires = now + 30000;
    if (expires < now) expires += now;
    var q = String(uri || "/").split("?");
    var qpath = q[0];
    var query = (q[1] || "").split("&").sort().filter(function(x) { return x != ""; }).join("&");
    var str = String(method) + "\n" + String(host) + "\n" + String(qpath) + "\n" + String(query) + "\n" + String(expires) + "\n" + String(checksum || "");
    return { 'b-signature': '1;;' + String(id) + ';' + this.sign(String(secret), str) + ';' + expires + ';' + String(checksum || "") + ';;' };
}

// Parse incomomg request for signature and return all pieces wrapped in an object, this object
// will be used by checkSignature function for verification against an account
core.parseSignature = function(req) 
{
    var rc = { version: 1, expires: 0, checksum: "", password: "" };
    // Input parameters, convert to empty string if not present
    rc.url = req.originalUrl || req.url || "/";
    rc.method = req.method || "";
    rc.host = (req.headers.host || "").split(':')[0];
    rc.signature = req.query['b-signature'] || req.headers['b-signature'] || "";
    var d = String(rc.signature).match(/([^;]+);([^;]*);([^;]+);([^;]+);([^;]+);([^;]*);([^;]*);/);
    if (!d) return rc;
    rc.mode = this.toNumber(d[1]);
    rc.version = d[2] || "";
    rc.id = d[3];
    rc.signature = d[4];
    rc.expires = this.toNumber(d[5]);
    rc.checksum = d[6] || "";
    rc.url = req.url.replace(/b-signature=([^& ]+)/g, "");
    return rc;
}

// Verify signature with given account, signature is an object reurned by parseSignature
core.checkSignature = function(sig, account) 
{
    var q = sig.url.split("?");
    var qpath = q[0];
    var query = (q[1] || "").split("&").sort().filter(function(x) { return x != ""; }).join("&");
    sig.str = sig.method + "\n" + sig.host + "\n" + qpath + "\n" + query + "\n" + sig.expires + "\n" + sig.checksum;
    switch (sig.mode) {
    case 1:
        sig.hash = this.sign(account.secret, sig.str);
        return sig.signature == sig.hash;
        
    case 2:
        // Verify against digest of the account and and secret, this way a client stores not the 
        // actual secret in local storage but sha1 digest to prevent exposing the real password
        sig.hash = this.sign(this.sign(account.secret, account.email), sig.str);
        return sig.signature == sig.hash;
    }
    return false;
}

// Make a request to the backend endpoint, save data in the queue in case of error, if data specified,
// POST request is made, if data is an object, it is converted into string.
// Returns params as in httpGet with .json property assigned with an object from parsed JSON response
// Special parameters for options:
// - email - email to use for access credentials insted of global credentials
// - secret - secret to use for access intead of global credentials
// - proxy - used as a proxy to backend, handles all errors and returns .status and .json to be passed back to API client
// - queue - perform queue management, save in queue if cannot send right now, delete from queue if sent
// - rowid - unique record id to be used in case of queue management
// - checksum - calculate checksum from the data
core.sendRequest = function(uri, options, callback) 
{
    var self = this;
    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};
    options.sign = true;
    
    // Nothing to do without credentials
    if (!options.email) options.email = self.backendKey;
    if (!options.secret) options.secret = self.backendSecret;
    if (!options.email || !options.secret) {
        logger.debug('sendRequest:', 'no backend credentials', uri, options);
        return callback ? callback(null, { status: 200, message: "", json: { status: 200 } }) : null;
    }
    // Relative urls resolve against global backend host
    if (uri.indexOf("://") == -1) uri = self.backendHost + uri; 
    
    var db = self.context.db;
    self.httpGet(uri, options, function(err, params, res) {
        // Queue management, insert on failure or delete on success
        if (options.queue) {
            if (params.status == 200) {
                if (options.id) {
                    db.del("backend_queue", { id: options.id });
                }
            } else {
                if (!options.id) options.id = core.hash(uri + (options.postdata || ""));
                options.mtime = self.now();
                options.counter = (options.counter || 0) + 1;
                if (options.counter > 10) {
                    db.del("backend_queue", { id: options.id });
                } else {
                    db.put("backend_queue", options);
                }
            }
        }
        // If the contents are encrypted, decrypt before processing content type
        if ((options.headers || {})['content-encoding'] == "encrypted") {
            params.data = self.decrypt(options.secret, params.data);
        }
        // Parse JSON and store in the params, set error if cannot be parsed, the caller will deal with it
        if (params.data && params.type == "application/json") {
            try {
                params.obj = JSON.parse(params.data);
            } catch(e) {
                err = e;
            }
        }
        if (params.status != 200) err = new Error("HTTP error: " + params.status);
        if (callback) callback(err, params, res);
    });
}

// Send all pending updates from the queue table
core.processQueue = function(callback) 
{
    var self = this;
    var db = self.context.db;
    
    db.select("backend_queue", {}, { sort: "mtime" } , function(err, rows) {
        async.forEachSeries(rows, function(row, next) {
            self.sendRequest(row.url, self.extendObj(row, "queue", true), function(err2) { next(); });
        }, function(err3) {
            if (rows.length) logger.log('processQueue:', 'sent', rows.length);
            if (callback) callback();
        });
    });
}

// Return argument value by name
core.getArg = function(name, dflt, argv) 
{
    argv = argv || this.argv;
    var idx = argv.indexOf(name);
    return idx > -1 && idx + 1 < argv.length ? argv[idx + 1] : (typeof dflt == "undefined" ? "" : dflt);
}

core.getArgFlag = function(name, dflt) 
{
    return this.argv.indexOf(name) > -1 ? true : (typeof dflt != "undefined" ? dflt : false);
}

core.getArgInt = function(name, dflt) 
{
    return this.toNumber(this.getArg(name, dflt));
}

// Send email
core.sendmail = function(from, to, subject, text, callback) 
{
    var server = emailjs.server.connect();
    server.send({ text: text || '', from: from, to: to + ",", subject: subject || ''}, function(err, message) {
         if (err) logger.error('sendmail:', err);
         if (message) logger.debug('sendmail:', message);
         if (callback) callback(err);
     });
}

// Call callback for each line in the file
// options may specify the following parameters:
// - sync - read file synchorously and call callback for every line
// - abort - signal to stop processing
// - limit - number of lines to process and exit
// - progress - if > 0 report how many lines processed so far evert specified lines
// - until - skip lines until this regexp matches
core.forEachLine = function(file, options, lineCallback, endCallback) 
{
    if (!options) options = {};
    var buffer = new Buffer(4096);
    var data = '';
    options.lines = 0;

    function readData(fd, pos, finish) {
        fs.read(fd, buffer, 0, buffer.length, pos, function(err, nread, buf) {
            data += buffer.slice(0, nread).toString(options.encoding || 'utf8');
            var lines = data.split("\n");
            data = lines.pop();
            async.forEachSeries(lines, function(line, next) {
                options.lines++;
                if (options.progress && options.lines % options.progress == 0) logger.log('forEachLine:', file, 'lines:', options.lines);
                // Skip lines until we see our pattern
                if (options.until && !options.until_seen) {
                    options.until_seen = line.match(options.until);
                    return next();
                }
                lineCallback(line.trim(), next);
            }, function(err2) {
                // Stop on reaching limit or end of file
                if (options.abort || (options.limit && options.lines >= options.limit) || nread < buffer.length) return finish(err2);
                setImmediate(function() { readData(fd, null, finish); });
            });
        });
    }

    fs.open(file, 'r', function(err, fd) {
        if (err) {
            logger.error('forEachLine:', file, err);
            return (endCallback ? endCallback(err) : null);
        }
        // Synchronous version, read every line and call callback which may not do any async operations
        // because they will not be executed right away buty only after all lines processed
        if (options.sync) {
            while (!options.abort) {
                var nread = fs.readSync(fd, buffer, 0, buffer.length, options.lines == 0 ? options.start : null);
                data += buffer.slice(0, nread).toString(options.encoding || 'utf8');
                var lines = data.split("\n");
                data = lines.pop();
                for (var i = 0; i < lines.length; i++) {
                    options.lines++;
                    if (options.progress && options.lines % options.progress == 0) logger.log('forEachLine:', file, 'lines:', options.lines);
                    // Skip lines until we see our pattern
                    if (options.until && !options.until_seen) {
                        options.until_seen = lines[i].match(options.until);
                        continue;
                    }
                    lineCallback(lines[i].trim());
                }
                // Stop on reaching limit or end of file
                if (nread < buffer.length) break;
                if (options.limit && options.lines >= options.limit) break;
            }
            fs.close(fd, function() {});
            return (endCallback ? endCallback() : null);
        }

        // Start reding data from the optional position or from the beginning
        readData(fd, options.start, function(err2) {
            fs.close(fd, function() {});
            return (endCallback ? endCallback() : null);
        });
    });
}

// Return object with geohash for given coordinates to be used for location search
// options may contain the follwong properties:
//   - distance - limit the range key with the closest range smaller than then distance, required for search but for updates may be omitted
core.geoHash = function(latitude, longitude, options)
{
    var self = this;
	if (!options) options = {};
	if (options.distance && options.distance < this.minDistance) options.distance = this.minDistance;
	
	// Geohash ranges for different lenghts in km
	var range = [ [12, 0], [8, 0.019], [7, 0.076], [6, 0.61], [5, 2.4], [4, 20.0], [3, 78.0], [2, 630.0], [1, 2500.0], [1, 99999]];
	var size = range.filter(function(x) { return x[1] > self.minDistance })[0];
	var geohash = backend.geoHashEncode(latitude, longitude);
	return { geohash: geohash.substr(0, size[0]), 
			 neighbors: options.distance ? backend.geoHashGrid(geohash.substr(0, size[0]), Math.floor(options.distance / size[1])).slice(1) : [],
			 latitude: latitude, 
			 longitude: longitude, 
			 distance: options.distance || 0 };
}

// Encrypt data with the given key code
core.encrypt = function(key, data, algorithm)
{
    if (!key || !data) return '';
    var encrypt = crypto.createCipher(algorithm || 'aes192', key);
    var b64 = encrypt.update(String(data), 'utf8', 'base64');
    try { b64 += encrypt.final('base64'); } catch(e) { b64 = ''; logger.error('encrypt:', e); }
    return b64;
}

// Decrypt data with the given key code
core.decrypt = function(key, data, algorithm) 
{
    if (!key || !data) return '';
    var decrypt = crypto.createDecipher(algorithm || 'aes192', key);
    var msg = decrypt.update(String(data), 'base64', 'utf8');
    try { msg += decrypt.final('utf8'); } catch(e) { msg = ''; logger.error('decrypt:', e); };
    return msg;
}

// HMAC signing and base64 encoded, default algorithm is sha1
core.sign = function (key, data, algorithm, encode) 
{
    return crypto.createHmac(algorithm || "sha1", key).update(String(data), "utf8").digest(encode || "base64");
}

// Hash and base64 encoded, default algorithm is sha1
core.hash = function (data, algorithm, encode) 
{
    return crypto.createHash(algorithm || "sha1").update(String(data), "utf8").digest(encode || "base64");
}

// Generate random key, size if specified defines how many random bits to generate
core.random = function(size) 
{
    return this.sign(crypto.randomBytes(64), crypto.randomBytes(size || 256), 'sha256').replace(/[=+%]/g, '');
}

// Return random integer between min and max inclusive
core.randomInt = function(min, max) 
{
    return min + (0 | Math.random() * (max - min + 1));
}

// Return number between min and max inclusive
core.randomNum = function(min, max) 
{
    return min + (Math.random() * (max - min));
}

// Return number of seconds for current time
core.now = function() 
{
    return Math.round((new Date()).getTime()/1000);
}

// Shortcut for current time in milliseconds
core.mnow = function()
{
    return (new Date()).getTime();
}

// Format date object
core.strftime = function(date, fmt, utc) 
{
    if (typeof date == "string") try { date = new Date(date); } catch(e) {}
    if (!date || isNaN(date)) return "";
    function zeropad(n) { return n > 9 ? n : '0' + n; }
    var handlers = {
        a: function(t) { return [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ][utc ? t.getUTCDay() : t.getDay()] },
        A: function(t) { return [ 'Sunday', 'Monday', 'Tuedsay', 'Wednesday', 'Thursday', 'Friday', 'Saturday' ][utc ? t.getUTCDay() : t.getDay()] },
        b: function(t) { return [ 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec' ][utc ? t.getUTCMonth() : t.getMonth()] },
        B: function(t) { return [ 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December' ][utc ? t.getUTCMonth() : t.getMonth()] },
        c: function(t) { return utc ? t.toUTCString() : t.toString() },
        d: function(t) { return zeropad(utc ? t.getUTCDate() : t.getDate()) },
        H: function(t) { return zeropad(utc ? t.getUTCHours() : t.getHours()) },
        I: function(t) { return zeropad(((utc ? t.getUTCHours() : t.getHours()) + 12) % 12) },
        m: function(t) { return zeropad((utc ? t.getUTCMonth() : t.getMonth()) + 1) }, // month-1
        M: function(t) { return zeropad(utc ? t.getUTCMinutes() : t.getMinutes()) },
        p: function(t) { return this.H(t) < 12 ? 'AM' : 'PM'; },
        S: function(t) { return zeropad(utc ? t.getUTCSeconds() : t.getSeconds()) },
        w: function(t) { return utc ? t.getUTCDay() : t.getDay() }, // 0..6 == sun..sat
        W: function(t) { var d = utc ? Date.UTC(utc ? t.getUTCFullYear() : t.getFullYear(), 0, 1) : new Date(t.getFullYear(), 0, 1); return Math.ceil((((t - d) / 86400000) + d.getDay() + 1) / 7); },
        y: function(t) { return zeropad(this.Y(t) % 100); },
        Y: function(t) { return utc ? t.getUTCFullYear() : t.getFullYear() },
        t: function(t) { return t.getTime() },
        u: function(t) { return Math.floor(t.getTime()/1000) },
        '%': function(t) { return '%' },
    };
    for (var h in handlers) {
        fmt = fmt.replace('%' + h, handlers[h](date));
    }
    return fmt;
}

// Split string into array, ignore empty items
core.strSplit = function(str, sep) 
{
    if (!str) return [];
    return (Array.isArray(str) ? str : String(str).split(sep || /[,\|]/)).map(function(x) { return x.trim() }).filter(function(x) { return x != '' });
}

// Split as above but keep only unique items
core.strSplitUnique = function(str, sep) 
{
    var rc = [];
    this.strSplit(str, sep).forEach(function(x) { if (!rc.some(function(y) { return x.toLowerCase() == y.toLowerCase() })) rc.push(x)});
    return rc;
}

// Stringify JSON into base64 string
core.toBase64 = function(data) 
{
	return new Buffer(JSON.stringify(data)).toString("base64");	
}

// Parse base64 JSON into Javascript object
core.toJson = function(data) 
{
	var rc = "";
	try { rc = JSON.parse(new Buffer(data, "base64").toString()); } catch(e) {}
	return rc;
}

// Copy file and then remove the source, do not overwrite existing file
core.moveFile = function(src, dst, overwrite, callback) 
{
    var self = this;
    if (typeof overwrite == "function") callback = overwrite, overwrite = false;

    function copyIfFailed(err) {
        if (!err) return (callback ? callback(null) : null);
        self.copyFile(src, dst, overwrite, function(err2) {
            if (!err2) {
                fs.unlink(src, callback);
            } else {
                if (callback) callback(err2);
            }
        });
    }

    logger.debug('moveFile:', src, dst, overwrite);
    fs.stat(dst, function (err) {
        if (!err && !overwrite) return cb(new Error("File " + dst + " exists."));
        fs.rename(src, dst, copyIfFailed);
    });
}

// Copy file, overwrite is optional flag, by default do not overwrite
core.copyFile = function(src, dst, overwrite, callback) 
{
    if (typeof overwrite == "function") callback = overwrite, overwrite = false;

    function copy(err) {
        var ist, ost;
        if (!err && !overwrite) return (callback ? callback(new Error("File " + dst + " exists.")) : null);
        fs.stat(src, function (err2) {
            if (err2) return (callback ? callback(err2) : null);
            ist = fs.createReadStream(src);
            ost = fs.createWriteStream(dst);
            util.pump(ist, ost, callback);
        });
    }
    logger.debug('copyFile:', src, dst, overwrite);
    fs.stat(dst, copy);
}

// Run theprocess and return all output to the callback
core.runProcess = function(cmd, callback) 
{
    exec(cmd, function (err, stdout, stderr) {
        if (err) logger.error('getProcessOutput:', cmd, err);
        if (callback) callback(stdout, stderr);
    });
}

// Kill all backend processes that match name and not the current process
core.killBackend = function(name, callback)
{
    var self = this;
    self.runProcess("ps agx", function(stdout) {
        stdout.split("\n").
               filter(function(x) { return x.match("backend:") && (!name || x.match(name)); }).
               map(function(x) { return self.toNumber(x) }).
               filter(function(x) { return x != process.pid }).
               forEach(function(x) { process.kill(x) });
        if (callback) callback();
    });
}

// Shutdown the machine now
core.shutdown = function() 
{
    exec("/sbin/halt", function(err, stdout, stderr) {
        logger.log('shutdown:', stdout || "", stderr || "", err || "");
    });
}

// Non-exception version, returns empty object,
// mtime is 0 in case file does not exist or number of seconds of last modified time
// mdate is a Date object with last modified time
core.statSync = function(file)
{
    var stat = { size: 0, mtime: 0, mdate: "", isFile: function() {return false}, isDirectory: function() {return false} }
    try {
        stat = fs.statSync(file);
        stat.mdate = stat.mtime.toISOString();
        stat.mtime = stat.mtime.getTime()/1000;
    } catch(e) {
        if (e.code != "ENOENT") logger.error('statSync:', e);
    }
    return stat;
}

// Return list of files than match filter recursively starting with given path
core.findFileSync = function(file, filter) 
{
    var list = [];
    try {
        var stat = this.statSync(file);
        if (stat.isFile()) {
            if (file != "." && file != ".." && (!filter || filter(file, stat))) {
                list.push(file);
            }
        } else
        if (stat.isDirectory()) {
            if (file != "." && file != ".." && (!filter || filter(file, stat))) {
                list.push(file);
            }
            var files = fs.readdirSync(file);
            for (var i in files) {
                list = list.concat(this.findFileSync(path.join(file, files[i]), filter));
            }
        }
    } catch(e) {
        logger.error('findFileSync:', file, e);
    }
    return list;
}

// Recursively create all directories, return 1 if created
core.makePathSync = function(dir) 
{
    var list = path.normalize(dir).split("/");
    for (var i = 0, dir = ''; i < list.length; i++) {
        dir += list[i] + '/';
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        }
        catch(e) {
            logger.error('makePath:', e)
            return 0;
        }
    }
    return 1;
}

// Async version, stops on first error
core.makePath = function(dir, callback) 
{
    var list = path.normalize(dir).split("/");
    var full = "";
    async.forEachSeries(list, function(d, next) {
        full += d + '/';
        fs.exists(full, function(yes) {
            if (yes) return next();
            fs.mkdir(full, function(err) {
                next(err && err.code != 'EEXIST' && err.code != 'EISDIR' ? err : null);
            });
        });
    }, function(err) {
        if (err) logger.error('makePath:', err);
        if (callback) callback(err);
    });
}

// Change file owner do not report errors about non existent files
core.chownSync = function(file)
{
    try {
        fs.chownSync(file, this.uid, this.gid);
    } catch(e) {
        if (e.code != 'ENOENT') logger.error('chownSync:', this.uid, this.gid, file, e);
    }
}

// Create a directory if does not exist
core.mkdirSync = function(dir) 
{
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir) } catch(e) { logger.error('mkdirSync:', dir, e); }
    }
}

// Drop root privileges and switch to regular user
core.dropPrivileges = function() 
{
    if (process.getuid() == 0) {
        logger.debug('init: switching to', core.uid, core.gid);
        try { process.setgid(core.gid); } catch(e) { logger.error('setgid:', core.gid, e); }
        try { process.setuid(core.uid); } catch(e) { logger.error('setuid:', core.uid, e); }
    }
}

// Set or reset a timer
core.setTimeout = function(name, callback, timeout) 
{
    if (this.timers[name]) clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(callback, timeout);    
}

// Full path to the icon, perform necessary hashing and sharding, id can be a number or any string
core.iconPath = function(id, options) 
{
    if (!options) options = {};
    // Convert into string and remove all chars except numbers, this will support UUIDs as well as regulat integers
    id = String(id).replace(/[^0-9]/g, '');
    return path.join(this.path.images, options.prefix || "", id.substr(-2), id.substr(-4, 2), (options.type ? String(options.type)[0] : "") + id + "." + (options.ext || "jpg"));
}

// Download image and convert into JPG, store under core.path.images
// Options may be controlled using the properties:
// - force - force rescaling for all types even if already exists
// - type - type for the icon, prepended to the icon id
// - prefix - where to store all scaled icons
// - verify - check if the original icon is the same as at the source
core.getIcon = function(uri, id, options, callback) 
{
    var self = this;

    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};
    logger.debug('getIcon:', uri, options);

    if (!uri || !id) return (callback ? callback(new Error("wrong args")) : null);

    // Verify image size and skip download if the same
    if (options.verify) {
        var imgfile = this.iconPath(id, options);
        fs.stat(imgfile, function(err, stats) {
            logger.debug('getIcon:', id, imgfile, 'stats:', stats, err);
            // No image, get a new one
            if (err) return self.getIcon(uri, id, self.delObj(options, 'verify'), callback);

            self.httpGet(uri, { method: 'HEAD' }, function(err2, params) {
                logger.edebug(err2, 'getIcon:', id, imgfile, 'size1:', stats.size, 'size2:', params.size);
                // Not the same, get a new one
                if (params.size !== stats.size) return self.getIcon(uri, id, self.delObj(options, 'verify'), callback);
                // Same, just verify types
                self.putIcon(imgfile, id, options, callback);
            });
        });
        return;
    }

    // Download into temp file, make sure dir exists
    var opts = url.parse(uri);
    var tmpfile = path.join(this.path.tmp, core.random().replace(/[\/=]/g,'') + path.extname(opts.pathname));
    self.httpGet(uri, { file: tmpfile }, function(err, params) {
        // Error in downloading
        if (err || params.status != 200) {
            fs.unlink(tmpfile, function() {});
            logger.edebug(err, 'getIcon:', id, uri, 'not found', 'status:', params.status);
            return (callback ? callback(err || new Error('Status ' + params.status)) : null);
        }
        // Store in the proper location
        self.putIcon(tmpfile, id, options, function(err2) {
            fs.unlink(tmpfile, function() {});
            if (callback) callback(err2);
        });
    });
}

// Put original or just downloaded file in the proper location according to the types for given id,
// this function is used after downloading new image or when moving images from other places
// Rescale all required icons by setting force to true in the options
// Valid properties in the options:
// - type - icon type, this will be prepended to the name of the icon
// - prefix - top level subdirectory under images/
// - force - to rescale even if it already exists
// - width, height, filter, ext, quality for backend.resizeImage function
core.putIcon = function(file, id, options, callback) 
{
    var self = this;
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};
    logger.debug('putIcon:', id, file, options);

    var icon = self.iconPath(id, options);
    
    // Filesystem based icon storage, verify local disk
    fs.exists(icon, function(yes) {
        // Exists and we do not need to rescale
        if (yes && !options.force) return callback();
        // Make new scaled icon
        self.scaleIcon(file, icon, options, function(err) {
            logger.edebug(err, "putIcon:", id, file, 'path:', icon, options);
            if (callback) callback(err, icon);
        });
    });
}

// Scale image using ImageMagick into a file, return err if failed
// - infile can be a string with file name or a Buffer with actual image data
// - outfle is not empty is a file naem where to store scaled image or if empty the new image contents will be returned in the callback
// - options can specify image extension in .ext, width/height/filter/quality
core.scaleIcon = function(infile, outfile, options, callback) 
{
    if (typeof options == "function") callback = options, options = {};
    if (!options) options = {};
    backend.resizeImage(infile, options.width || 0, options.height || 0, options.ext || "jpg", options.filter || "lanczos", options.quality || 99, outfile, function(err, data) {
        logger.edebug(err, 'scaleIcon:', typeof infile == "object" ? infile.length : infile, outfile, options);
        if (callback) callback(err, data);
    });
}

// Return object type, try to detect any distinguished type
core.typeName = function(v) 
{
    var t = typeof(v);
    if (v === null) return "null";
    if (t !== "object") return t;
    if (Array.isArray(v)) return "array";
    if (Buffer.isBuffer(v)) return "buffer";
    if (v.constructor == (new Date).constructor) return "date";
    if (v.constructor == (new RegExp).constructor) return "regex";
    return "object";
}

// Return true of the given value considered empty
core.isEmpty = function(val) 
{
    switch (this.typeName(val)) {
    case "null":
    case "undefined": 
        return true;
    case "buffer":
    case "array": 
        return val.length == 0;
    case "number":
    case "regex":
    case "boolean":
        return false;
    case "date":
        return isNaN(val);
    default:
        return val ? false: true;
    }
}

// Deep copy of an object,
// - first argument is the object to clone
// - second argument can be an object that acts as a filter to skip properties by name, 
//   if filter's value is boolean, skip, if integer then skip if greater in length for string properties
//     - _skip_null - to skip all null properties
//     - _empty_to_null - convert empty strings into null objects
//     - _skip_cb - a callback that returns true to skip a property, argumnets are property name and value
//   if the second arg is not an object then it is assumed that filter is not given and the argument is treated as additional property
// - all additional arguments are treated as name value pairs and added to the cloned object as additional properties
// Example: core.cloneObj({ 1: 2 }, { 1: 1 }, "3", 3, "4", 4)
//          core.cloneObj({1 : 2 }, "3", 3, "4", 4)
core.cloneObj = function() 
{
    var obj = arguments[0];
    var filter = {}, idx = 1;
    if (this.typeName(arguments[1]) == "object") {
        idx = 2;
        filter = arguments[1];
    }
    var rc = {};
    switch (this.typeName(obj)) {
    case "object":
        break;
    case "array":
        rc = [];
        break;
    case "buffer":
        return new Buffer(this);
    case "date":
        return new Date(obj.getTime());
    case "regex":
        return new Regexp(this);
    case "string":
        if (filter._empty_to_null && obj === "") return null;
        return obj;
    default:
        return obj;
    }
    for (var p in obj) {
        switch (this.typeName(filter[p])) {
        case "undefined":
            break;
        case "number":
            if (typeof obj[p] == "string" && obj[p].length < filter[p]) break;
            continue;
        default:     
           continue;
        }
        if ((obj[p] == null || typeof obj[p] == "undefined") && filter._skip_null) continue;
        if (filter._skip_cb && filter._skip_cb(p, obj[p])) continue;
        rc[p] = this.cloneObj(obj[p], filter);
    }
    for (var i = idx; i < arguments.length - 1; i += 2) rc[arguments[i]] = arguments[i + 1];
    return rc;
}

// Return new object using arguments as name value pairs for new object properties
core.newObj = function() 
{
    var obj = {};
    for (var i = 0; i < arguments.length - 1; i += 2) obj[arguments[i]] = arguments[i + 1];
    return obj;
}

// Add properties to existing object, first arg is the object, the rest are pairs: name, value,....
core.extendObj = function() 
{
    if (!arguments[0]) arguments[0] = {}
    for (var i = 1; i < arguments.length - 1; i += 2) arguments[0][arguments[i]] = arguments[i + 1];
    return arguments[0];
}

// Delete properties from the object, first arg is an object, the rest are properties to be deleted
core.delObj = function() 
{
    if (!arguments[0] || typeof arguments[0] != "object") return;
    for (var i = 1; i < arguments.length; i++) delete arguments[0][arguments[i]];
    return arguments[0];
}

// Merge obj with the options, all options properties override existing in the obj
core.mergeObj = function(obj, options) 
{
    if (!options) options = {};
    for (var p in obj) {
        var val = obj[p];
        switch (core.typeName(val)) {
        case "object":
            if (!options[p]) options[p] = {};
            for (var c in val) {
                if (!options[p][c]) options[p][c] = val[c];
            }
            break;
        case "null":
        case "undefined":
            break;
        default:
            if (!options[p]) options[p] = val;
        }
    }
    return options;
}

// JSON stringify without empty properties
core.stringify = function(obj) 
{
    return JSON.stringify(this.cloneObj(obj, { _skip_null: 1, _skip_cb: function(n,v) { return v == "" } }));
}

// Return cookies that match given domain
core.cookieGet = function(domain, callback) 
{
    this.context.db.select("backend_cookies", {}, function(err, rows) {
        var cookies = [];
        rows.forEach(function(cookie) {
            if (cookie.expires <= Date.now()) return;
            if (cookie.domain == domain) {
                cookies.push(cookie);
            } else
            if (cookie.domain.charAt(0) == "." && (cookie.domain.substr(1) == domain || domain.match(cookie.domain.replace(/\./g,'\\.') + '$'))) {
                cookies.push(cookie);
            }
        });
        logger.debug('cookieGet:', domain, cookies);
        if (callback) callback(cookies);
    });
}

// Save new cookies arrived in the request, 
// merge with existing cookies from the jar which is a list of cookies before the request
core.cookieSave = function(cookiejar, setcookies, hostname, callback) 
{
    var self = this;
    var cookies = !setcookies ? [] : Array.isArray(setcookies) ? setcookies : String(setcookies).split(/[:](?=\s*[a-zA-Z0-9_\-]+\s*[=])/g);
    logger.debug('cookieSave:', cookiejar, 'SET:', cookies);
    cookies.forEach(function(cookie) {
        var parts = cookie.split(";");
        var pair = parts[0].match(/([^=]+)=((?:.|\n)*)/);
        if (!pair) return;
        var obj = { name: pair[1], value: pair[2], path: "", domain: "", secure: false, expires: Infinity };
        for (var i = 1; i < parts.length; i++) {
            pair = parts[i].match(/([^=]+)(?:=((?:.|\n)*))?/);
            if (!pair) continue;
            var key = pair[1].trim().toLowerCase();
            var value = pair[2];
            switch(key) {
            case "expires":
                obj.expires = value ? Number(self.toDate(value)) : Infinity;
                break;

            case "path":
                obj.path = value ? value.trim() : "";
                break;

            case "domain":
                obj.domain = value ? value.trim() : "";
                break;

            case "secure":
                obj.secure = true;
                break;
            }
        }
        if (!obj.domain) obj.domain = hostname || "";
        var found = false;
        cookiejar.forEach(function(x, j) {
            if (x.path == obj.path && x.domain == obj.domain && x.name == obj.name) {
                if (obj.expires <= Date.now()) {
                    cookiejar[j] = null;
                } else {
                    cookiejar[j] = obj;
                }
                found = true;
            }
        });
        if (!found) cookiejar.push(obj);
    });
    async.forEachSeries(cookiejar, function(rec, next) {
        if (!rec) return next();
        self.context.db.put("backend_cookies", rec, function() { next() });
    }, function() {
        if (callback) callback();
    });
}

// Adds reference to the objects in the core for further access, specify module name, module reference pairs
core.addContext = function() 
{
	for (var i = 0; i < arguments.length - 1; i+= 2) {
		this.context[arguments[i]] = arguments[i + 1];
	}
}

// Create REPL interface with all modules available
core.createRepl = function(options) 
{
    var self = this;
    var r = repl.start(options || {});
    r.context.core = this;
    r.context.logger = logger;
    r.context.backend = backend;
    r.context.fs = fs;
    r.context.os = os;
    r.context.util = util;
    r.rli.historyIndex = 0;
    r.rli.history = [];
    // Expose all modules as top level objects
    for (var p in this.context) r.context[p] = this.context[p];

    // Support history
    if (this.replFile) {
        try {
            r.rli.history = fs.readFileSync(this.replFile, 'utf-8').split('\n').reverse();
        } catch (e) {}

        r.rli.addListener('line', function(code) {
            if (code) {
                fs.appendFile(self.replFile, code + '\n', function() {});
            } else {
                r.rli.historyIndex++;
                r.rli.history.pop();
            }
      });
    }
    return r;
}
// Watch temp files and remove files that are older than given number of seconds since now, remove only files that match pattern if given
// This function is not async-safe, it uses sync calls
core.watchTmp = function(dirs, secs, pattern) 
{
    var self = this;
    var now = core.now();
    (dirs || []).forEach(function(dir) {
        self.findFileSync(dir, function(f, s) {
            if (pattern && !f.match(patern)) return false;
            if (!s.mtime || now - s.mtime < secs || s.isDirectory()) return false;
            logger.log('watchTmp: delete', dir, f, (now - s.mtime)/60, 'mins old');
            return true;
        }).forEach(function(file) {
            fs.unlink(file, function(err) {
                if (err) logger.error('watchTmp:', file, err);
            });
        });
    });
}

// Watch files in a dir for changes and call the callback
core.watchFiles = function(dir, pattern, callback) 
{
    logger.debug('watchFiles:', dir, pattern);
    fs.readdirSync(dir).filter(function(file) { 
        return file.match(pattern);
    }).map(function(file) {
        file = path.join(dir, file);
        return ({ name: file, stat: core.statSync(file) });
    }).forEach(function(file) {
        logger.debug('watchFiles:', file.name, file.stat.size);
        fs.watch(file.name, function(event, filename) {
            // Check stat if no file name, Mac OSX does not provide it
            if (!filename && core.statSync(file.name).size == file.stat.size) return;
            logger.log('watchFiles:', event, filename || file.name); 
            callback(file);
        });
    });     
}

// Watch log files for errors and report via email
core.watchLogs = function(callback) 
{
    var self = this;

    // Need email to send
    if (!self.logwatcherEmail) return (callback ? callback() : false);

    // From address, use current hostname
    if (!self.logwatcherFrom) self.logwatcherFrom = "logwatcher@" + (self.domain || os.hostname());

    // Check interval
    var now = new Date();
    if (self.logwatcherMtime && (now.getTime() - self.logwatcherMtime.getTime())/1000 < self.logwatcherInterval) return;
    self.logwatcherMtime = now;

    var match = null;
    if (self.logwatcherMatch) {
        try { match = new RegExp(self.logwatcherIgnore); } catch(e) {}
    }
    var ignore = null
    if (self.logwatcherIgnore) {
        try { ignore = new RegExp(self.logwatcherIgnore); } catch(e) {}
    }
    var db = self.context.db;
    
    // Load all previous positions for every log file, we start parsing file from the previous last stop
    db.query("SELECT * FROM backend_property WHERE name LIKE 'logwatcher:%'", function(err, rows) {
        var lastpos = {};
        for (var i = 0; i < rows.length; i++) {
            lastpos[rows[i].name] = rows[i].value;
        }
        var errors = "";

        // For every log file
        async.forEachSeries(self.logwatcherFiles, function(log, next) {
            var file = log.file;
            if (!file && self[log.name]) file = self[log.name];
            if (!file) return next();

            fs.stat(file, function(err2, st) {
               if (err2) return next();
               // Last saved position, start from the end if the log file is too big or got rotated
               var pos = core.toNumber(lastpos['logwatcher:' + file] || 0);
               if (st.size - pos > self.logwatcherMax || pos > st.size) pos = st.size - self.logwatcherMax;

               fs.open(file, "r", function(err3, fd) {
                   if (err3) return next();
                   var buf = new Buffer(self.logwatcherMax);
                   fs.read(fd, buf, 0, buf.length, Math.max(0, pos), function(err4, nread, buffer) {
                       fs.close(fd, function() {});
                       if (err4 || !nread) {
                           fs.close(fd, function() {});
                           return next();
                       }
                       var lines = buffer.slice(0, nread).toString().split("\n");
                       for (var i in lines) {
                           // Skip global ignore list first
                           if (ignore && ignore.test(lines[i])) continue;
                           // Match either global or local filter
                           if (!log.match || log.match.test(lines[i]) || (match && match.test(lines[i]))) {
                               errors += lines[i] + "\n";
                           }
                       }
                       // Separator between log files
                       if (errors.length > 1) errors += "\n\n";
                       // Save current size to start next time from
                       db.query({ text: "REPLACE INTO backend_property VALUES(?,?,?)", values: ['logwatcher:' + file, st.size, self.logwatcherMtime.toISOString()] }, function(e) {
                           if (e) logger.error('watchLogs:', file, e);
                           fs.close(fd, function() {});
                           next();
                       });
                   });
               });
            });
        }, function(err2) {
            // Ignore possibly empty lines or cut off text
            if (errors.length > 10) {
                logger.log('logwatcher:', 'found errors, send report to', self.logwatcherEmail);
                self.sendmail(self.logwatcherFrom, self.logwatcherEmail, "logwatcher: " + os.hostname() + "/" + self.ipaddr + " errors", errors, function() {
                    if (callback) callback();
                });
            } else {
                if (callback) callback();
            }
        });
    });
}

