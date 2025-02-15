//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const fs = require("fs");
const core = require(__dirname + '/core');
const lib = require(__dirname + '/lib');
const db = require(__dirname + '/db');
const api = require(__dirname + '/api');
const logger = require(__dirname + '/logger');
const crypto = require('crypto');
const util = require("util");

const mod = {
    name: "auth",
    args: [
        { name: "table", descr: "Table to use for user accounts" },
        { name: "err-(.+)", descr: "Error messages for various cases" },
        { name: "admin-roles", type: "list", descr: "List of special super admin roles" },
        { name: "sigversion", type: "int", descr: "Signature version for secrets" },
        { name: "hash", descr: "Hashing method to use by default: bcrypt, argon2, none" },
        { name: "bcrypt", type: "int", min: 12, descr: "Number of iterations for bcrypt" },
        { name: "argon2", type: "map", datatype: "auto", nocamel: 1, descr: "Argon2 parameteres, ex: type:2,memoryCost:1,hashLength:32" },
        { name: "max-length", type: "int", descr: "Max login and name length" },
        { name: "users", type: "json", logger: "error", descr: "An object with users" },
        { name: "users-file", descr: "A JSON file with a list of users" },
    ],
    table: "bk_user",
    sigversion: -1,
    hash: "bcrypt",
    bcrypt: 12,
    argon2: {},
    maxLength: 140,
    users: {},
    adminRoles: ["root", "admin"],
    errInvalidSecret: "Invalid user name or password",
    errInvalidUser: "The username is required",
    errInvalidPasswd: "The password is required",
    errInvalidName: "The name is required",
    errInvalidParams: "No username or id provided",
    errInvalidId: "Invalid id provided",
    errInvalidLogin: "No username or password provided",

    srp: {
        hexN: 'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D' +
              'CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74' +
              '7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D' +
              '5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6' +
              '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73',
        hexG: '02',
    },
};
module.exports = mod;

mod.configure = function(options, callback)
{
    this.tables = {
        [this.table]: {
            login: { primary: 1, max: mod.maxLength },                  // Account login/username
            id: { type: "uuid", prefix: "u_", unique: 1 },              // Autogenerated ID
            name: { type: "text", max: mod.maxLength },                 // Account name
            status: { type: "text", max: mod.maxLength },               // Status of the account
            secret: { priv: 1, max: mod.maxLength },                    // Signature secret or password
            type: { type: "list", list: 1, lower: 1, internal: 1 },     // Account roles: admin, ....
            flags: { type: "list", list: 1, max: mod.maxLength },       // Tags/flags about the account
            expires: { type: "bigint", internal: 1, priv: 1 },          // Deny access to the account if this value is before current date, ms
            ctime: { type: "now", readonly: 1 },                        // Create time
            mtime: { type: "now" }
        },
    };

    this.loadUsers((err) => {
        if (err) return;
        fs.watch(this.usersFile, () => {
            core.setTimeout(this.usersFile, () => { this.loadUsers() }, lib.randomInt(1000, 5000));
        });
    });

    callback();
}

// Load users from a JSON file, only add or update records
mod.loadUsers = function(callback)
{
    if (!this.usersFile) return;
    lib.readFile(this.usersFile, { json: 1, logger: "error" }, (err, users) => {
        if (!err) {
            for (const p in users) {
                if (users[p].login && users[p].id && users[p].secret && users[p].name) {
                    this.users[users[p].login] = users[p];
                    logger.debug("loadUsers:", users[p]);
                }
            }
        }
        lib.tryCall(callback, err);
    });
}

mod.configureWeb = function(options, callback)
{
    // For health checks
    api.app.all("/ping", (req, res) => {
        api.sendStatus(res, { contentType: "text/plain" });
    });

    // Authentication check without accounts module
    api.app.post("/auth", (req, res) => {
        if (!req.account || !req.account.id) {
            return api.sendReply(res, { status: 417, message: mod.errInvalidLogin, code: "NOLOGIN" });
        }
        api.handleSessionSignature(req, () => {
            req.options.cleanup = mod.table;
            req.options.cleanup_strict = 1;
            api.sendJSON(req, null, req.account);
        });
    });

    // Login with just the secret without signature
    api.app.post("/login", (req, res) => {
        if (!req.query.login || !req.query.secret) {
            return api.sendReply(res, { status: 417, message: api.checkErrmsg(req, null, mod.errInvalidLogin), code: "NOLOGIN" });
        }
        // Create internal signature from the login data
        req.signature = api.newSignature(req, "version", mod.sigversion, "source", "l", "login", req.query.login, "secret", req.query.secret);
        delete req.query.login;
        delete req.query.secret;
        api.checkRequestSignature(req, (err) => {
            if (!req.account || !req.account.id) {
                return api.sendJSON(req, err || { status: 417, message: mod.errInvalidLogin, code: "NOLOGIN" });
            }
            api.handleSessionSignature(req, () => {
                req.options.cleanup = mod.table;
                req.options.cleanup_strict = 1;
                api.sendJSON(req, null, req.account);
            });
        });
    });

    // Clear sessions and access tokens
    api.app.post("/logout", (req, res) => {
        api.clearSessionSignature(req);
        api.sendJSON(req);
    });

    callback();
}

// If specified in the options, prepare credentials to be stored in the db, if no error occurred return null, otherwise an error object
//  - hash - use bcrypt or argon2 explicitely, otherwise use the config
mod.prepareSecret = function(query, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (!options) options = {};

    if (!query.secret) delete query.secret;
    var hash = options.hash || mod.hash;

    lib.series([
        function(next) {
            if (!query.secret || hash != "bcrypt") return next();
            if (!mod.bcryptMod) mod.bcryptMod = require('bcrypt');
            mod.bcryptMod.hash(query.secret, mod.bcrypt, (err, enc) => {
                if (!err) query.secret = enc;
                next(err);
            });
        },
        function(next) {
            if (!query.secret || hash != "argon2") return next();
            if (!mod.argon2Mod) mod.argon2Mod = require("argon2");
            mod.argon2Mod.hash(query.secret, mod.argon2).then((enc) => {
                query.secret = enc;
                next();
            }).catch(next);
        },
        function(next) {
            var hooks = api.findHook('secret', '', query.login);
            if (!hooks.length) return next();
            lib.forEachSeries(hooks, function(hook, next2) {
                hook.callback.call(api, query, options, next2);
            }, next, true);
        },
    ], callback);
}

// Verify an existing user record with given password,
//  - user - if a string it is a hashed secret from an existing user record, otherwise must be an user object
//  - password - plain text password or other secret passed to be verified
mod.checkSecret = function(user, password, callback)
{
    if (typeof user == "string") user = { secret: user };
    if (!user || !user.secret || !password) {
        return callback({ status: 400, message: this.errInvalidSecret });
    }

    // Exact
    if (user.secret == password) return callback();

    // Legacy scrambled mode
    var scrambled = user.login ? lib.sign(password, user.login, "sha256") : NaN;
    if (user.secret == scrambled) return callback();

    lib.series([
        function(next) {
            if (!/^\$2b\$/.test(user.secret)) return next();
            if (!mod.bcryptMod) mod.bcryptMod = require('bcrypt');
            mod.bcryptMod.compare(password, user.secret, (err, rc) => {
                if (rc) return callback();
                next();
            });
        },
        function(next) {
            if (!/^\$2b\$/.test(user.secret)) return next();
            if (!scrambled) return next();
            if (!mod.bcryptMod) mod.bcryptMod = require('bcrypt');
            mod.bcryptMod.compare(scrambled, user.secret, (err, rc) => {
                if (rc) return callback();
                next();
            });
        },
        function(next) {
            if (!/^\$argon/.test(user.secret)) return next();
            if (!mod.argon2Mod) mod.argon2Mod = require("argon2");
            mod.argon2Mod.verify(user.secret, password).then((rc) => {
                if (rc) return callback();
                next();
            }).catch(() => (next()));
        },
        function(next) {
            if (!/^\$argon/.test(user.secret)) return next();
            if (!scrambled) return next();
            if (!mod.argon2Mod) mod.argon2Mod = require("argon2");
            mod.argon2Mod.verify(user.secret, scrambled).then((rc) => {
                if (rc) return callback();
                next();
            }).catch(() => (next()));
        },
    ], () => {
        callback({ status: 401, message: this.errInvalidSecret });
    });
}

mod.isUid = function(id)
{
    return lib.isUuid(id, this.tables[this.table].id.prefix);
}

// Returns an account record by login or id, to make use of a cache add to the config `db-cache-keys-bk_user-id=id`
mod.get = function(query, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (typeof query == "string") {
        query = { [lib.isUuid(query) ? "id" : "login"]: query };
    }
    if (query.login) {
        var user = this.users[query.login];
        if (user) return callback(null, user);
        db.get(this.table, query, callback);
    } else
    if (query.id) {
        for (const p in this.users) {
            if (this.users[p].id == query.id) return callback(null, this.users[p]);
        }
        var opts = { noscan: 1, cacheKeyName: "id", ops: { id: "eq" }, count: 1, first: 1 };
        db.select(this.table, { id: query.id }, opts, (err, row, info) => {
            if (!row) return callback(err);
            // For databases that do not support all columns with indexes(DynamoDB) we have to re-read by the primary key
            if (row.name && row.mtime) return callback(null, row, info);
            db.get(this.table, { login: row.login }, callback);
        });
    } else {
        callback();
    }
}
mod.aget = util.promisify(mod.get.bind(mod));

mod.checkWriteAccess = function(query, options)
{
}

// Registers a new account, returns new record in the callback, when `options.isInternal` is true then allow to set all properties
// otherwise internal properties will not be added
mod.add = function(query, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (!query.login) return lib.tryCall(callback, { status: 400, message: this.errInvalidUser });
    if (!query.secret) return lib.tryCall(callback, { status: 400, message: this.errInvalidPasswd });
    if (!query.name) return lib.tryCall(callback, { status: 400, message: this.errInvalidName });
    options = lib.objClone(options, "result_obj", 1, "first", 1);
    this.prepareSecret(query, options, (err) => {
        if (err) return lib.tryCall(callback, err);
        if (!(options.isInternal || api.checkAccountType(options.account, this.adminRoles))) {
            api.clearQuery(this.table, query, "internal");
        }
        delete query.id;
        db.add(this.table, query, options, (err, row, info) => {
            if (!err) {
                for (const p in row) query[p] = row[p];
            }
            lib.tryCall(callback, err, query, info);
        });
    });
}
mod.aadd = util.promisify(mod.add.bind(mod));

// Updates an existing account by login or id, if `options.isInternal` is true then allow to update all properties, returns a new record in the callback
mod.update = function(query, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    options = lib.objClone(options, "returning", "*", "first", 1);
    this.prepareSecret(query, options, (err) => {
        if (err) return lib.tryCall(callback, err);
        if (!(options.isInternal || api.checkAccountType(options.account, this.adminRoles))) {
            api.clearQuery(this.table, query, "internal");
            if (query.login) delete query.id;
        }
        if (!query.name) delete query.name;
        if (!this.isUid(query.id)) delete query.id;
        if (query.login) {
            db.update(this.table, query, options, callback);
        } else
        if (query.id) {
            db.select(this.table, { id: query.id }, { cacheKeyName: "id", count: 1, first: 1 }, (err, row) => {
                if (!row) return callback(err, { status: 404, message: this.errInvalidId });
                query.login = row.login;
                db.update(this.table, query, options, callback);
            });
        } else {
            lib.tryCall(callback, { status: 400, message: this.errInvalidParams });
        }
    });
}
mod.aupdate = util.promisify(mod.update.bind(mod));

// Deletes an existing account by login or id, no admin checks, returns the old record in the callback
mod.del = function(query, options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (typeof query == "string") {
        query = { [this.isUid(query) ? "id" : "login"]: query };
    }
    options = lib.objClone(options, "returning", "old", "first", 1);
    if (query.login) {
        db.del(this.table, query, options, callback);
    } else
    if (query.id) {
        db.select(this.table, { id: query.id }, { cacheKeyName: "id", count: 1, first: 1 }, (err, row) => {
            if (!row) return callback(err, { status: 404, message: this.errInvalidId });
            query.login = row.login;
            db.del(this.table, query, options, callback);
        });
    } else {
        lib.tryCall(callback, { status: 400, message: this.errInvalidParams });
    }
}
mod.adel = util.promisify(mod.del.bind(mod));

mod.srp.init = function()
{
    if (!this._) {
        this.BigInteger = require("jsbn").BigInteger;
        this.N = this.toInt(this.hexN);
        this.g = this.toInt(this.hexG);
        this.k = this.hash(this.N, this.g);
        this._ = 1;
    }
}

mod.srp.toInt = function(n)
{
    return n instanceof this.BigInteger ? n : typeof n == "string" ? new this.BigInteger(n, 16) : this.rand();
}

mod.srp.hash = function(...args)
{
    const h = crypto.createHash('sha256');
    for (const i in args) {
        if (args[i] instanceof this.BigInteger) {
            h.update(Buffer.from(args[i].toString(16).padStart(512, "0"), "hex"));
        } else {
            h.update(args[i]);
        }
    }
    return new this.BigInteger(h.digest("hex"), 16);
}

mod.srp.rand = function()
{
    return new this.BigInteger(crypto.randomBytes(32).toString('hex'), 16);
}

mod.srp.x = function(user, secret, salt)
{
    return this.hash(Buffer.from(this.toInt(salt).toString(16).padStart(64, "0"), "hex"), crypto.createHash('sha256').update(user).update(":").update(secret).digest());
}

mod.srp.verifier = function(user, secret, salt)
{
    this.init();
    const s = this.toInt(salt);
    const x = this.x(user, secret, s);
    const v = this.g.modPow(x, this.N);
    return [s.toString(16), v.toString(16), x.toString(16)];
}

mod.srp.client1 = function(salt)
{
    this.init();
    const a = this.toInt(salt);
    const A = this.g.modPow(a, this.N);
    return [a.toString(16), A.toString(16)];
}

mod.srp.client2 = function(user, secret, salt, a, B)
{
    this.init();
    B = this.toInt(B);
    if (B.mod(this.N).toString() == "0") return null;
    a = this.toInt(a);
    const x = this.x(user, secret, salt);
    const A = this.g.modPow(a, this.N);
    const u = this.hash(A, B);
    const S = B.subtract(this.k.multiply(this.g.modPow(x, this.N))).modPow(a.add(u.multiply(x)), this.N).mod(this.N);
    const K = this.hash(S);
    const M = this.hash(A, B, S);
    return [K.toString(16), M.toString(16), S.toString(16), u.toString(16), x.toString(16), A.toString(16)];
}

mod.srp.client3 = function(A, M1, K, M2)
{
    const M = this.hash(this.toInt(A), this.toInt(M1), this.toInt(K));
    return [M.equals(this.toInt(M2)), M.toString(16)];
}

mod.srp.server1 = function(verifier, salt)
{
    this.init();
    const b = this.toInt(salt);
    const v = this.toInt(verifier);
    const B = this.k.multiply(v).add(this.g.modPow(b, this.N)).mod(this.N);
    return [b.toString(16), B.toString(16)];
}

mod.srp.server2 = function(user, verifier, b, A, M1)
{
    this.init();
    A = this.toInt(A);
    if (A.mod(this.N).toString() == '0') return [];

    b = this.toInt(b);
    const v = this.toInt(verifier);
    const B = this.k.multiply(v).add(this.g.modPow(b, this.N)).mod(this.N);
    if (B.mod(this.N).toString() == '0') return [];

    M1 = this.toInt(M1);
    const u = this.hash(A, B);
    const S = A.multiply(v.modPow(u, this.N)).modPow(b, this.N).mod(this.N);
    const M = this.hash(A, B, S);
    if (!M.equals(M1)) return [];
    const K = this.hash(S);
    const M2 = this.hash(A, M1, K);
    return [M2.toString(16), S.toString(16), u.toString(16)];
}

