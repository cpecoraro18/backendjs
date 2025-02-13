//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const url = require("url");
const util = require('util');
const fs = require('fs');
const os = require("os");
const syslog = require(__dirname + "/logger/syslog");

// Simple logger utility for debugging
var logger = {
    name: "logger",
    level: process.env.BKJS_LOGLEVEL || 1,
    levels: { test: 5, dev: 4, debug: 3, info: 2, notice: 1, log: 1, warn: 0, error: -1, none: -2 },
    file: null,
    stream: process.stdout,
    writable: true,
    filters: null,
    oneline: true,
    separator: " ",
    inspectArgs: { showHidden: true, depth: 10, breakLength: Infinity, maxStringLength: 512 },
    // Registered custom levels
    modules: {},
}

module.exports = logger;

// Logger labels
for (const p in logger.levels) logger[p.toUpperCase()] = logger.levels[p];

// Register a custom level handler, must be invoked via `logger.logger` only, if no handler registered for given level
// the whole message will be logger as an error. The custom hadnler is called in the context of the module which means
// the options are available inside the handler.
//
// The following properties are supported automatically:
// - format - if 1 then all arguments will be formatted into one line as for the regular levels and passed
//    the handler as one argument, this is to support different transport and preserve the same standard logging format
//
logger.registerLevel = function(level, callback, options)
{
    if (typeof callback != "function") return;
    this.modules[level] = { name: level, callback: callback, options: options || {} };
}

logger.pad = function(n)
{
    if (n >= 0 && n < 10) return "0" + n
    return n
}

logger.prefix = function(level)
{
    var d = new Date()
    return d.getFullYear() + "-" +
           this.pad(d.getMonth()+1) + "-" +
           this.pad(d.getDate()) + "T" +
           this.pad(d.getHours()) + ":" +
           this.pad(d.getMinutes()) + ":" +
           this.pad(d.getSeconds()) + "." +
           this.pad(d.getMilliseconds()) +
           " [" + process.pid + "]: " +
           level + ": "
}

// Set or close syslog mode
logger.setSyslog = function(facility, tag)
{
    if (facility == 1 || typeof facility == "string" && facility.indexOf(":/") > 0) {
        var opts = { tag: tag };
        if (facility != 1) {
            var h = url.parse(facility);
            if (h.protocol == "udp:") opts.udp = 1;
            if (h.pathname) opts.path = h.pathname;
            if (h.hostname) opts.host = h.hostname;
            if (h.port) opts.port = h.port;
            if (h.query) opts.facility = h.query;
        } else {
            // Use defaults per platform
            if (os.platform() == "linux") {
                opts.udp = 1;
                opts.path = "/dev/log";
            }
        }
        if (!opts.port && !opts.path) opts.port = 514;
        if (this.syslog) {
            if (this.syslog.udp == opts.udp && this.syslog.path == opts.path &&
                this.syslog.host == opts.host && this.syslog.port == opts.port) return;
            this.syslog.close();
        }
        this.syslog = new syslog.Syslog(opts);
        this.print = this.printSyslog;
        this.syslog.open();
    } else {
        this.print = this.printStream;
        if (this.syslog) this.syslog.close();
        delete this.syslog;
    }
}

// Redirect logging into file
logger.setFile = function(file, options)
{
    if (this.stream && this.stream != process.stdout) {
        this.stream.destroySoon();
    }
    this.file = file;
    if (this.file) {
        this.stream = fs.createWriteStream(this.file, { flags: 'a' });
        this.stream.on('error', function(err) {
            process.stderr.write(String(err));
            logger.stream = process.stderr;
        });
        // Make sure the log file is owned by regular user to avoid crashes due to no permission of the log file
        if (options && options.uid) {
            fs.chown(file, options.uid, options.gid || 0, (err) => { logger.error(file, err) });
        }
    } else {
        this.stream = process.stdout;
    }
    this.setSyslog(0);
}

// Set the output level, it can be a number or one of the supported level names
logger.setLevel = function(level)
{
    this.level = typeof this.levels[level] != "undefined" ? this.levels[level] : isNaN(parseInt(level)) ? 0 : parseInt(level);
}

// Enable debugging level for this label, if used with the same debugging level it will be printed regardless of the global level,
// a label is first argument to the `logger.debug` methods, it is used as is, usually the fist argument is
// the current function name with comma, like `logger.debug("select:", name, args)`
logger.setDebugFilter = function(str)
{
    String(str).split(",").forEach(function(x) {
        x = x.trim();
        if (x == "null") {
            logger.filters = null;
        } else
        if (x[0] == "!" || x[0] == "-") {
            if (logger.filters) {
                delete logger.filters[x.substr(1)];
                if (!Object.keys(logger.filters).length) logger.filters = null;
            }
        } else {
            if (x[0] == '+') x = x.substr(1);
            if (!logger.filters) logger.filters = {};
            logger.filters[x] = 1;
        }
    });
}

logger.printSyslog = function(level, msg)
{
    this.syslog.log(0, level + ": " + msg);
}

logger.printStream = function(level, msg)
{
    this.stream.write(this.prefix(level) + msg + "\n");
}

logger.print = logger.printStream.bind(logger);

logger.printError = function()
{
    process.stderr.write(this.prefix("ERROR") + this.format(arguments) + "\n");
}

logger.log = function()
{
    if (this.level < this.NOTICE) return;
    this.print('NOTICE', this.format(arguments));
}
logger.notice = logger.log;

logger.info = function()
{
    if (this.level < this.INFO) return;
    this.print('INFO', this.format(arguments));
}

logger.warn = function()
{
    if (this.level < this.WARN) return;
    this.print('WARN', this.format(arguments));
}

logger.debug = function()
{
    if (this.level < this.DEBUG && !(this.filters && (this.filters[arguments[0]] || this.filters[arguments[1]]))) return;
    this.print('DEBUG', this.format(arguments));
}

logger.dev = function()
{
    if (this.level < this.DEV && !(this.filters && (this.filters[arguments[0]] || this.filters[arguments[1]]))) return;
    this.print('DEV', this.format(arguments));
}

logger.error = function()
{
    this.print('ERROR', this.format(arguments));
}

logger.none = function()
{
}

// Prints the given error and the rest of the arguments, the logger level to be used is determined for the given error by code,
// uses `options` or `options.logger_error` as the level if a string,
// - if `options.logger_error` is an object, extract the level by `err.code` or use `*` as the default level for not matched codes,
// the default is to use the `error` level.
// - In case the level is notice or info the error will only show status/code/message properties in order not to print stack trace
// - Merge `options.logger_inspect` if present with the current inspect options to log the rest of arguments.
logger.errorWithOptions = function(err, options)
{
    if (err && options) {
        var log = typeof options == "string" ? options:
                  options.quiet ? "debug" :
                  typeof options.logger_error == "string" ? options.logger_error :
                  typeof options.logger_error == "object" ? options.logger_error[err.code] || options.logger_error["*"] :
                  err.status >= 200 && err.status < 300 ? "info" :
                  "error";
        var e = log == "notice" || log == "info" ? { status: err.status, code: err.code, message: err.message } : err;
        if (options.logger_inspect) this.setInspectOptions(options.logger_inspect);
        (this[log] || this.error).apply(this, Array.prototype.slice.apply(arguments).slice(2).map((x) => (x === err ? e : x)));
        delete this._inspectArgs;
    } else {
        this.print('ERROR', this.format(arguments));
    }
}

logger.dump = function()
{
    this.stream.write(util.format.apply(this, arguments).replace(/[ \r\n\t]+/g, " ") + "\n");
}

logger.inspect = function(obj, options)
{
    var str = util.inspect(obj, options || this.inspectArgs);
    return this.oneline ? str.replace(/\\n/g,' ').replace(/[ \\\r\n\t]+/g, " ") : str.replace(/\\n/g, "\n");
}

// Merge with existing inspect options temporarily, calling without options will reset to previous values
logger.setInspectOptions = function(options)
{
    if (options) {
        this._inspectArgs = {};
        for (const p in this.inspectArgs) this._inspectArgs[p] = this.inspectArgs[p];
        for (const p in options) this._inspectArgs[p] = options[p];
    } else {
        delete this._inspectArgs;
    }
}

logger.format = function(args, options)
{
    var str = "";
    for (const p in args) {
        if (typeof args[p] == "undefined") continue;
        str += this.inspect(args[p], options || this._inspectArgs) + this.separator;
    }
    return str;
}

// Print stack backtrace as error
logger.trace = function()
{
    var err = new Error('');
    err.name = 'Trace';
    Error.captureStackTrace(err, logger.trace);
    this.error(util.format.apply(this, arguments), err.stack);
}

// A generic logger method, safe, first arg is supposed to be a logging level, if not valid the error level is used
logger.logger = function(level, ...args)
{
    if (typeof level == "string") level = level.trim().toLowerCase();
    var mod = this.modules[level];
    if (mod) {
        mod.callback.apply(mod, mod.options.format ? this.format(args) : args);
    } else {
        (this[level] || this.error).apply(this, args);
    }
}

// Stream emulation
logger.write = function(str)
{
    if (str) this.log(str);
    return true;
}

logger.end = function(str)
{
    if (str) this.log(str);
}
