//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//
// Unit tests
// To run a test execute for example: bksh -run-test db ....
//

const fs = require("fs");
const cluster = require('cluster');
const path = require('path');
const bkjs = require('backendjs')
const core = bkjs.core;
const lib = bkjs.lib;
const ipc = bkjs.ipc;
const api = bkjs.api;
const db = bkjs.db;
const aws = bkjs.aws;
const auth = bkjs.auth;
const logger = bkjs.logger;
const metrics = bkjs.metrics;
const tests = bkjs.core.modules.tests;

tests.resetTables = function(tables, callback)
{
    db.dropTables(tables, db.pool, function() {
        db.createTables(db.pool, callback);
    });
}

tests.test_db_basic = function(callback)
{
    var self = this;
    var tables = {
            test1: { id: { primary: 1, pub: 1 },
                     num: { type: "int" },
                     num2: { type: "int" },
                     num3: { type: "text", join: ["id","num"], join_strict: 1 },
                     email: {},
                     anum: { join: ["anum","num"], unjoin: 1 },
                     jnum: { join: ["num2","num4"], unjoin: ["num2","num4"], join_strict: 1, keepjoined: 1 },
                     num4: { hidden: 1 },
                     mtime: { type: "now" },
            },
    };
    var id = lib.random(64);
    var id2 = lib.random(64);

    db.describeTables(tables);

    lib.series([
        function(next) {
             self.resetTables(tables, next);
        },
        function(next) {
            db.add("test1", { id: id, email: id, num: '1', num3: 1, num4: 1, anum: 1 }, function(err) {
                if (err) return next(err);
                db.put("test1", { id: id2, email: id2, num2: "2", num3: 2, num4: "2", anum: 2 }, next);
            });
        },
        function(next) {
            db.get("test1", { id: id }, function(err, row) {
                tests.assert(err || !row || row.id != id || row.num != 1 || row.num3 != row.id+"|"+row.num || row.anum != "1" || row.jnum || !row.mtime, "err1:", row);
                next();
            });
        },
        function(next) {
            db.get("test1", { id: id2 }, function(err, row) {
                tests.assert(err || !row || row.num4 != "2" || row.jnum != row.num2 + "|" + row.num4, "err2:", row);
                next();
            });
        },
        function(next) {
            // Type conversion for strictTypes
            db.get("test1", { id: id, num: '1' }, function(err, row) {
                tests.assert(err || !row || row.id != id || row.num!=1, "err4:", row);
                next();
            });
        },
        function(next) {
            db.list("test1", String([id,id2]), {}, function(err, rows) {
                tests.assert(err || rows.length!=2, "err5:", rows.length, rows);
                next();
            });
        },
        function(next) {
            db.select("test1", { id: id, fake: 1 }, function(err, rows) {
                tests.assert(err || rows.length!=1, "err6:", rows);
                next();
            });
        },
        function(next) {
            db.delAll("test1", { id: id }, next);
        },
        function(next) {
            db.get("test1", { id: id }, function(err, row) {
                tests.assert(err || row, "err7:", row);
                next();
            });
        },
        function(next) {
            db.put("test1", { id: id, email: id, num: 1 }, function(err) {
                tests.assert(err || 0, "err8:");
                next();
            });
        },
        function(next) {
            db.update("test1", { id: id, email: "test", num: 2, mtime: 123 }, function(err, rc, info) {
                tests.assert(err || info.affected_rows!=1, "err9:", info);
                next();
            });
        },
        function(next) {
            db.incr("test1", { id: id, num2: 2, mtime: 123 }, function(err, rc, info) {
                tests.assert(err || info.affected_rows!=1, "err10:", info);
                next();
            });
        },
        function(next) {
            db.get("test1", { id: id }, (err, row) => {
                tests.assert(err || !row || row.email != "test" || row.num != 2 || row.num2 != 2 || !row.mtime || row.mtime == 123, "err11:", row);
                next();
            });
        },
    ], callback, true);
}

tests.test_db = function(callback)
{
    var self = this;
    var tables = {
        test1: {
            id: { primary: 1, pub: 1 },
            num: { type: "int" },
            num2: {},
            num3: { join: ["id","num"] },
            email: {},
            anum: { join: ["anum","num"], unjoin: ["anum","num"] },
            jnum: { join: ["num2","num4"], unjoin: ["num2","num4"], join_strict: 1 },
            num4: { hidden: 1 },
            mnum: { join: ["num","mtime"] },
            mtime: { type: "now" },
        },
        test2: {
            id: { primary: 1, pub: 1, index: 1 },
            id2: { primary: 1, projections: 1 },
            email: { projections: 1 },
            name: { pub: 1 },
            birthday: { semipub: 1 },
            group: {},
            json: { type: "json" },
            num: { type: "bigint", index: 2, projections: 1 },
            num2: { type: "real" },
            mtime: { type: "bigint" }
        },
        test3: {
            id: { primary: 1, pub: 1 },
            num: { type: "counter", value: 0, pub: 1 }
        },
        test4: {
            id: { primary: 1, pub: 1 },
            type: { pub: 1 },
            notempty: { notempty: 1 },
        },
        test5: {
            id: { primary: 1, pub: 1 },
            hkey: { primary: 1, join: ["type","peer"], ops: { select: "begins_with" } },
            type: { pub: 1 },
            peer: { pub: 1 },
            skipcol: { pub: 1, allow_pools: ["elasticsearch"] },
            skipjoin: { pub: 1, join: ["id","type"], join_pools: ["elasticsearch"] },
            nojoin: { pub: 1, join: ["id","type"], nojoin_pools: ["elasticsearch"] },
        },
        test6: {
            id: { primary: 1, pub: 1, trim: 1 },
            mtime: { type: "now", pub: 1 },
            num: {},
            obj: { type: "obj" },
            list: { type: "array" },
            tags: { type: "list" },
            text: {}
        },
    };
    var now = Date.now();
    var id = lib.random(64);
    var id2 = lib.random(128);
    var num2 = lib.randomNum(1, 1000);
    var next_token = null;
    var ids = [], rec;
    var configOptions = db.getPool(db.pool).configOptions;

    db.setProcessRow("post", "test4", function(op, row) {
        var type = (row.type || "").split(":");
        row.type = type[0];
        row.mtime = type[1];
        return row;
    });

    db.customColumn.test6 = { "action[0-9]+": "counter" };

    db.describeTables(tables);

    lib.series([
        function(next) {
             self.resetTables(tables, next);
        },
        function(next) {
            db.add("test1", { id: id, email: id, num: '1', num2: null, num3: 1, num4: 1, anum: 1 }, function(err) {
                if (err) return next(err);
                db.put("test1", { id: id2, email: id2, num: '2', num2: "2", num3: 1, num4: "4", anum: 1 }, function(err) {
                    if (err) return next(err);
                    db.put("test3", { id: id, num: 0, email: id, anum: 1 }, next);
                });
            });
        },
        function(next) {
            db.get("test1", { id: id }, function(err, row) {
                tests.assert(err || !row || row.id != id || row.num != 1 || row.num3 != row.id+"|"+row.num || row.anum != "1" || row.jnum, "err1:", row);
                next();
            });
        },
        function(next) {
            db.get("test1", { id: id2 }, function(err, row) {
                tests.assert(err || !row || row.num4 != "4" || row.jnum || !row.mnum || row.mnum.match(/\|$/), "err1-1:", row);
                next();
            });
        },
        function(next) {
            db.get("test3", { id: id }, function(err, row) {
                tests.assert(err || !row || row.id != id, "err1-2:", row);
                next();
            });
        },
        function(next) {
            // Type conversion for strictTypes
            db.get("test1", { id: id, num: '1' }, function(err, row) {
                tests.assert(err || !row || row.id != id || row.num!=1, "err2:", row);
                next();
            });
        },
        function(next) {
            // Type conversion for strictTypes
            db.join("test1", [{ id: id }, { id: id2 }, { id: "" }], { existing: 1 }, function(err, rows) {
                tests.assert(err || rows.length != 2 || rows[0].id != id || rows[1].id != id2, "err2-1:", rows);
                next();
            });
        },
        function(next) {
            db.list("test1", String([id,id2,""]), {}, function(err, rows) {
                var isok = rows.every(function(x) { return x.id==id || x.id==id2});
                tests.assert(err || rows.length!=2 || !isok, "err3:", rows.length, isok, rows);
                next();
            });
        },
        function(next) {
            db.add("test2", { id: id, id2: '1', email: id, name: id, birthday: id, num: 0, num2: num2, mtime: now }, next);
        },
        function(next) {
            db.add("test2", { id: id2, id2: '2', email: id, name: id, birthday: id, group: id, num: 2, num2: num2, mtime: now }, next);
        },
        function(next) {
            db.put("test2", { id: id2, id2: '1', email: id2, name: id2, birthday: id2, group: id2, num: 1, num2: num2, mtime: now }, next);
        },
        function(next) {
            db.put("test3", { id: id2, num: 2, emai: id2 }, next);
        },
        function(next) {
            db.put("test4", { id: id, type: "like:" + Date.now(), fake: 1, notempty: "1" }, next);
        },
        function(next) {
            db.select("test4", { id: id }, function(err, rows) {
                tests.assert(err || rows.length!=1 || rows[0].id != id || rows[0].type!="like" || rows[0].fake, "err4:", rows);
                next();
            });
        },
        function(next) {
            db.delAll("test1", { id: id, fake: 1 }, { skip_join: ["num3"] }, next);
        },
        function(next) {
            db.get("test1", { id: id }, function(err, row) {
                tests.assert(err || row, "err4-1:", row);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2 }, { filterrows: function(req, rows, o) { return rows.filter((x) => (x.id2 == '1')) } }, function(err, rows) {
                tests.assert(err || rows.length!=1 || rows[0].id2 != '1' || rows[0].num2 != num2 , "err5:", num2, rows);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2, id2: ["2"] }, { ops: { id2: "in" } }, function(err, rows) {
                tests.assert(err || rows.length!=1 || rows[0].id2!='2', "err5-1:", rows.length, rows);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2, id2: "" }, { ops: { id2: "in" }, select: ["id","name"] }, function(err, rows) {
                tests.assert(err || rows.length!=2, "err5-2:", rows.length, rows);
                next();
            });
        },
        function(next) {
            db.list("test3", String([id,id2]), function(err, rows) {
                tests.assert(err || rows.length!=2, "err6:", rows);
                next();
            });
        },
        function(next) {
            db.incr("test3", { id: id, num: 3 }, { mtime: 1 }, function(err) {
                if (err) return next(err);
                db.incr("test3", { id: id, num: 1 }, function(err) {
                    if (err) return next(err);
                    db.incr("test3", { id: id, num: -2 }, next);
                });
            });
        },
        function(next) {
            db.cacheTables.push("test3");
            db.cache2.test3 = 30000;
            tests.test.delay = 100;
            db.get("test3", { id: id }, { cached: 1 }, function(err, row) {
                tests.assert(err || !row || row.id != id || row.num != 2, "err7:", row);
                next();
            });
        },
        function(next) {
            db.getCache("test3", { id: id }, {}, function(data) {
                var row = lib.jsonParse(data);
                tests.assert(!data || row.num != 2, "err7-lru-cache:", row);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2, id2: '1' }, { ops: { id2: 'gt' }, select: 'id,id2,num2,mtime' }, function(err, rows) {
                tests.assert(err || rows.length!=1 || rows[0].email || rows[0].id2 != '2' || rows[0].num2 != num2, "err8:", rows);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2, id2: '1' }, { ops: { id2: 'begins_with' }, select: 'id,id2,num2,mtime' }, function(err, rows) {
                tests.assert(err || rows.length!=1 || rows[0].email || rows[0].id2 != '1' || rows[0].num2 != num2, "err8-1:", rows);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2, id2: "1,2" }, { ops: { id2: 'between' } }, function(err, rows) {
                tests.assert(err || rows.length!=2, "err8-2:", rows);
                next();
            });
        },
        function(next) {
            db.select("test2", { id: id2, num: "1,2" }, { ops: { num: 'between' } }, function(err, rows) {
                tests.assert(err || rows.length!=2, "err8-3:", rows);
                next();
            });
        },
        function(next) {
            db.update("test2", { id: id, id2: '1', email: id + "@test", num: 9, num2: 9, json: { a: 1, b: 2 }, mtime: now }, next);
        },
        function(next) {
            db.get("test2", { id: id, id2: '1' }, { consistent: true }, function(err, row) {
                tests.assert(err || !row || row.id != id || row.email != id+"@test" || row.num != 9, "err9-2:", row);
                next();
            });
        },
        function(next) {
            db.del("test2", { id: id2, id2: '1', fake: 1 }, next);
        },
        function(next) {
            db.get("test2", { id: id2, id2: '1' }, { consistent: true }, function(err, row) {
                tests.assert(err || row, "del:", row);
                next();
            });
        },
        function(next) {
            lib.forEachSeries([1,2,3,4,5,6,7,8,9], function(i, next2) {
                db.put("test2", { id: id2, id2: String(i), email: id, name: id, birthday: id, num: i, num2: i, mtime: now }, next2);
            }, function(err) {
                next(err);
            });
        },
        function(next) {
            // Check pagination
            next_token = null;
            var rc = [];
            lib.forEachSeries([2, 3], function(n, next2) {
                db.select("test2", { id: id2 }, { sort: "id2", start: next_token, count: n, select: 'id,id2' }, function(err, rows, info) {
                    next_token = info.next_token;
                    rc.push.apply(rc, rows);
                    next2(err);
                });
            }, function(err) {
                // Redis cannot sort due to hash implementation, known bug
                var isok = db.pool == "redis" ? rc.length>=5 : rc.length==5 && (rc[0].id2 == 1 && rc[rc.length-1].id2 == 5);
                tests.assert(err || !isok, "err10:", rc.length, isok, rc, next_token);
                next();
            })
        },
        function(next) {
            // Check pagination with small page size with condition on the range key
            next_token = null;
            lib.forEachSeries([2, 3], function(n, next2) {
                db.select("test2", { id: id2, id2: '0' }, { sort: "id2", ops: { id2: 'gt' }, start: next_token, count: n, select: 'id,id2' }, function(err, rows, info) {
                    next_token = info.next_token;
                    var isok = db.pool == "redis" ? rows.length>=n : rows.length==n;
                    tests.assert(err || !isok || !info.next_token, "err11:", rows.length, n, info, rows);
                    next2();
                });
            },
            function(err) {
                if (err) return next(err);
                db.select("test2", { id: id2, id2: '0' }, { ops: { id2: 'gt' }, start: next_token, count: 5, select: 'id,id2' }, function(err, rows, info) {
                    next_token = info.next_token;
                    var isnum = db.pool == "redis" ? rows.length>=3 : rows.length==4;
                    var isok = rows.every(function(x) { return x.id2 > '0' });
                    tests.assert(err || !isnum || !isok, "err12:", isok, rows.length, rows, info);
                    next();
                });
            });
        },
        function(next) {
            tests.assert(null, next_token, "err13: next_token must be null", next_token);
            next();
        },
        function(next) {
            db.add("test2", { id: id, id2: '2', email: id, name: id, birthday: id, num: 2, num2: 1, mtime: now }, next);
        },
        function(next) {
            // Select by primary key and other filter
            db.select("test2", { id: id, num: 9, num2: 9 }, { ops: { num: 'ge', num2: 'ge' } }, function(err, rows, info) {
                tests.assert(err || rows.length==0 || rows[0].num!=9 || rows[0].num2!=9, "err13:", rows, info);
                next();
            });
        },
        function(next) {
            // Wrong query property and non-existent value
            db.select("test2", { id: id, num: 9, num2: 9, email: 'fake' }, { sort: "id_num", ops: { num: 'ge' } }, function(err, rows, info) {
                tests.assert(err || rows.length!=0, "err14:", rows, info);
                next();
            });
        },
        function(next) {
            // Scan the whole table with custom filter
            db.select("test2", { num: 9 }, { ops: { num: 'ge' } }, function(err, rows, info) {
                var isok = rows.every(function(x) { return x.num >= 9 });
                tests.assert(err || rows.length==0 || !isok, "err15:", isok, rows, info);
                next();
            });
        },
        function(next) {
            // Scan the whole table with custom filter and sorting
            db.select("test2", { id: id2, num: 1 }, { ops: { num: 'gt' }, sort: "num" }, function(err, rows, info) {
                var isok = rows.every(function(x) { return x.num > 1 });
                tests.assert(err || rows.length==0 || !isok , "err16:", isok, rows, info);
                next();
            });
        },
        function(next) {
            // Query with sorting with composite key
            db.select("test2", { id: id2 }, { desc: true, sort: "id2" }, function(err, rows, info) {
                tests.assert(err || rows.length==0 || rows[0].id2!='9' , "err17:", rows, info);
                next();
            });
        },
        function(next) {
            // Query with sorting by another column/index
            db.select("test2", { id: id2 }, { desc: true, sort: "num" }, function(err, rows, info) {
                tests.assert(err || rows.length==0 || rows[0].num!=9 , "err18:", rows, info);
                next();
            });
        },
        function(next) {
            // Scan all records
            var rows = [];
            db.scan("test2", {}, { count: 2 }, function(row, next2) {
                rows.push(row);
                next2();
            }, function(err) {
                tests.assert(err || rows.length!=11, "err19:", rows.length);
                next();
            });
        },
        function(next) {
            lib.forEachSeries([1,2,3], function(i, next2) {
                db.put("test5", { id: id, type: "like", peer: i, skipcol: "skip" }, next2);
            }, function(err) {
                next(err);
            });
        },
        function(next) {
            db.select("test5", { id: id }, {}, function(err, rows) {
                tests.assert(err || rows.length!=3 , "err20:", rows);
                next();
            });
        },
        function(next) {
            db.select("test5", { id: id, type: "like" }, {}, function(err, rows) {
                tests.assert(err || rows.length!=3 , "err21:", rows);
                // New hkey must be created in the list
                ids = rows.map(function(x) { delete x.hkey; return x });
                next();
            });
        },
        function(next) {
            db.list("test5", ids, {}, function(err, rows) {
                tests.assert(err || rows.length!=3 , "err22:", rows);
                next();
            });
        },
        function(next) {
            db.get("test5", { id: id, type: "like", peer: 2 }, {}, function(err, row) {
                tests.assert(err || !row || row.skipcol || row.skipjoin || !row.nojoin, "err23:", row);
                next();
            });
        },
        function(next) {
            db.put("test1", { id: id, email: id, num: 1 }, { info_obj: 1 }, function(err, rows, info) {
                rec = info.obj;
                tests.assert(err || 0, "err24:");
                next();
            });
        },
        function(next) {
            db.update("test1", { id: id, email: "test", num: 1 }, { expected: { id: id, email: id }, skip_columns: ["mtime"], updateOps: { num: "incr" } }, function(err, rc, info) {
                tests.assert(err || info.affected_rows!=1, "err25:", info);
                next();
            });
        },
        function(next) {
            db.get("test1", { id: id }, {}, function(err, row) {
                tests.assert(err || !row || row.mtime != rec.mtime, "err25-1:", row, rec);
                next();
            });
        },
        function(next) {
            db.update("test1", { id: id, email: "test", num: 1 }, { expected: { id: id, email: "test" }, updateOps: { num: "incr" } }, function(err, rc, info) {
                tests.assert(err || info.affected_rows!=1, "err26:", info);
                next();
            });
        },
        function(next) {
            db.update("test1", { id: id, email: "test" }, { expected: { id: id, email: id } }, function(err, rc, info) {
                tests.assert(err || info.affected_rows, "err27:", info);
                next();
            });
        },
        function(next) {
            db.update("test1", { id: id, email: "test", num: 2 }, { expected: { id: id, num: 1 }, ops: { num: "gt" } }, function(err, rc, info) {
                tests.assert(err || !info.affected_rows, "err28:", info);
                next();
            });
        },
        function(next) {
            db.get("test1", { id: id }, {}, function(err, row) {
                tests.assert(err || !row || row.num != 2, "err29:", row);
                next();
            });
        },
        function(next) {
            db.put("test4", { id: id, type: "1", notempty: "" }, { quiet: 1 }, function(err, rc, info) {
                tests.assert(configOptions.noNulls ? err : !err, "err30:", err, info);
                next();
            });
        },
        function(next) {
            db.put("test4", { id: id, type: "2", notempty: "notempty" }, function(err, rc, info) {
                tests.assert(err, "err31:", info);
                next();
            });
        },
        function(next) {
            db.update("test4", { id: id, type: "3", notempty: null }, function(err, rc, info) {
                tests.assert(err || !info.affected_rows, "err32:", info);
                next();
            });
        },
        function(next) {
            db.get("test4", { id: id }, {}, function(err, row) {
                tests.assert(err || !row || row.notempty != "notempty", "err33:", row);
                next();
            });
        },
        function(next) {
            db.put("test6", { id: id, num: 1, obj: { n: 1, v: 2 }, list: [{ n: 1 },{ n: 2 }], tags: "1,2,3", text: "123" }, { info_obj: 1 }, function(err, rc, info) {
                rec = info.obj;
                tests.assert(err, "err34:", info);
                next();
            });
        },
        function(next) {
            db.update("test6", { id: id, num: 2, mtime: rec.mtime, obj: "1", action1: 1 }, function(err, rc, info) {
                tests.assert(err || !info.affected_rows, "err35:", info);
                next();
            });
        },
        function(next) {
            db.get("test6", { id: id + " " }, {}, function(err, row) {
                tests.assert(err || !row || row.num != 2 || !row.obj || row.obj.n != 1 ||
                             !row.list || !row.list[0] || row.list[0].n != 1 ||
                             !row.tags || row.tags.length != 3 ||
                             !row.text, "err36:", row);
                next();
            });
        },
        function(next) {
            db.incr("test6", { id: id + " ", action1: 2 }, function(err, rc, info) {
                tests.assert(err || !info.affected_rows, "err37:", info);
                next();
            });
        },
        function(next) {
            db.get("test6", { id: id }, {}, function(err, row) {
                tests.assert(err || !row || (!configOptions.noCustomColumns && row.action1 != 3), "err38:", row, db.customColumn);
                next();
            });
        },
        function(next) {
            db.list("test6", [id + " "], {}, function(err, rows) {
                tests.assert(err || rows.length != 1, "must return 1 row:", rows, db.customColumn);
                next();
            });
        },
        function(next) {
            configOptions.maxSize = configOptions.maxList = 50;
            var str = "", list = [];
            for (let i = 0; i < 128; i++) list.push((str += i));
            db.update("test6", { id: id, obj: { test: str }, tags: list, list: list, text: str }, function(err, rc, info) {
                tests.expect(!err && info.affected_rows, "update failed:", info);
                next();
            });
        },
        function(next) {
            db.get("test6", { id: id }, {}, function(err, row) {
                tests.assert(err ||
                             row?.text != "123" ||
                             row?.tags?.length != 3 ||
                             row?.list?.length != 2 ||
                             row?.obj?.n != 1, "max size limits failed:", row);
                next();
            });
        },
    ], callback, true);
}

tests.test_s3icon = function(callback)
{
    var id = lib.getArg("-id", "1");
    api.saveIcon(core.cwd + "/web/img/loading.gif", id, { prefix: "account", images: api.imagesS3 }, function(err) {
        var icon = api.iconPath(id, { prefix: "account" });
        aws.queryS3(api.imagesS3, icon, { file: "tmp/" + path.basename(icon) }, function(err, params) {
            console.log('icon:', lib.statSync(params.file));
            callback(err);
        });
    });
}

tests.test_icon = function(callback)
{
    api.putIcon({ body: {}, files: { 1: { path: __dirname + "/../web/img/loading.gif" } } }, "icon", 1, { prefix: "account", width: 100, height: 100 }, function(err) {
        callback(err);
    });
}

tests.test_limiter = function(callback)
{
    var opts = {
        name: lib.getArg("-name", "test"),
        rate: lib.getArgInt("-rate", 1),
        max: lib.getArgInt("-max", 1),
        interval: lib.getArgInt("-interval", 1000),
        queueName: lib.getArg("-queue"),
        pace: lib.getArgInt("-pace", 5),
        count: lib.getArgInt("-count", 5),
        delays: lib.getArgInt("-delays", 4),
    };
    var list = [], delays = 0;
    for (var i = 0; i < opts.count; i++) list.push(i);

    ipc.initServer();
    setTimeout(function() {
        lib.forEachSeries(list, function(i, next) {
            lib.doWhilst(
              function(next2) {
                  ipc.limiter(opts, function(delay) {
                      opts.delay = delay;
                      logger.log("limiter:", opts);
                      setTimeout(next2, delay);
                  });
              },
              function() {
                  if (opts.delay) delays++;
                  return opts.delay;
              },
              function() {
                  setTimeout(next, opts.pace);
              });
        }, () => {
            callback(delays != opts.delays ? `delays mismatch: ${delays} != ${opts.delays}` : "")
        });
    }, 1000);
}

tests.test_cookie = function(callback)
{
    // Testing redirect and cookies
    core.httpGet('http://google.com', { cookies: true }, function(err, params) {
        console.log('COOKIES:', params.cookies, params.resheaders);
        callback(err);
    });
}

tests.test_cache = function(callback)
{
    console.log("testing cache:", ipc.getClient().name);

    lib.series([
      function(next) {
          lib.forEachSeries(["a","b","c"], function(key, next2) {
              ipc.put(key, "1", next2);
          }, next);
      },
      function(next) {
          ipc.get("a", function(e, val) {
              tests.assert(val!="1", "value must be a=1, got", val)
              next();
          });
      },
      function(next) {
          ipc.get(["a","b","c"], function(e, val) {
              tests.assert(!val||val.length!=3||val[0]!="1"||val[1]!="1"||val[2]!="1", "value must be [1,1,1] got", val)
              next();
          });
      },
      function(next) {
          ipc.incr("a", 1, next);
      },
      function(next) {
          ipc.get("a", function(e, val) {
              tests.assert(val!="2", "value must be a=2, got", val)
              next();
          });
      },
      function(next) {
          ipc.put("a", "3", next);
      },
      function(next) {
          ipc.put("a", "1", { setmax: 1 }, next);
      },
      function(next) {
          ipc.get("a", function(e, val) {
              tests.assert(val!="3", "value must be a=3, got", val)
              next();
          });
      },
      function(next) {
          ipc.incr("a", 1, next);
      },
      function(next) {
          ipc.put("c", { a: 1 }, next);
      },
      function(next) {
          ipc.get("c", function(e, val) {
              val = lib.jsonParse(val)
              tests.assert(!val||val.a!=1, "value must be {a:1}, got", val)
              next();
          });
      },
      function(next) {
          ipc.del("b", next);
      },
      function(next) {
          ipc.get("b", function(e, val) {
              tests.assert(val, "value must be null, got", val)
              next();
          });
      },
      function(next) {
          ipc.put("*", { a: 1, b: 2, c: 3 }, { mapName: "m" }, next);
      },
      function(next) {
          ipc.incr("c", 1, { mapName: "m" }, next);
      },
      function(next) {
          ipc.put("c", 2, { mapName: "m", setmax: 1 }, next);
      },
      function(next) {
          ipc.del("b", { mapName: "m" }, next);
      },
      function(next) {
          ipc.get("c", { mapName: "m" }, function(e, val) {
              tests.assert(val!=4, "value must be 4, got", val)
              next();
          });
      },
      function(next) {
          ipc.get("*", { mapName: "m" }, function(e, val) {
              tests.assert(!val || val.c!=4 || val.a!=1 || val.b, "value must be {a:1,c:4}, got", val)
              next();
          });
      },
    ], function(err) {
        if (!err) return callback();
        lib.forEachSeries(["a","b","c"], function(key, next) {
            ipc.get(key, function(e, val) { console.log(key, val); next(); })
        }, function() {
            callback(err);
        });
    }, true);
}

tests.test_pool = function(callback)
{
    var options = { min: lib.getArgInt("-min", 1),
                    max: lib.getArgInt("-max", 5),
                    idle: lib.getArgInt("-idle", 0),
                    create: function(cb) { cb(null,{ id: Date.now() }) }
    }
    var list = [];
    var pool = new pool(options)
    lib.series([
       function(next) {
           console.log('pool0:', pool.stats(), 'list:', list.length);
           for (var i = 0; i < 5; i++) {
               pool.acquire(function(err, obj) { list.push(obj); console.log('added:', list.length); });
           }
           console.log('pool1:', pool.stats(), 'list:', list.length);
           next();
       },
       function(next) {
           while (list.length) {
               pool.release(list.shift());
           }
           next();
       },
       function(next) {
           console.log('pool2:', pool.stats(), 'list:', list.length);
           pool.acquire(function(err, obj) { list.push(obj); console.log('added:', list.length); });
           next();
       },
       function(next) {
           console.log('pool3:', pool.stats(), 'list:', list.length);
           pool.release(list.shift());
           next();
       },
       function(next) {
           setTimeout(function() {
               console.log('pool4:', pool.stats(), 'list:', list.length);
               next();
           }, options.idle*2);
       }], callback);
}

tests.test_config = function(callback)
{
    var argv = ["-force-uid", "1,1",
                "-proxy-port", "3000",
                "-api-allow-path", "^/a",
                "-api-allow-admin", "^/a",
                "-api-allow-account-dev=^/a",
                "-api-allow-anonymous=^/a",
                "-api-redirect-url", '{ "^a/$": "a", "^b": "b" }',
                "-logwatcher-send-error", "a",
                "-logwatcher-file-error", "a",
                "-logwatcher-file", "b",
                "-logwatcher-match-error", "a",
                "-db-create-tables",
                "-db-sqlite-pool-max", "10",
                "-db-sqlite1-pool", "a",
                "-db-sqlite1-pool-max", "10",
                "-db-sqlite1-pool-options-cache-columns", "1",
                "-db-sqlite1-pool-options-test", "test",
                "-db-sqlite-pool-options-discovery-interval", "30000",
                "-db-sqlite-pool-options-map.test", "test",
                "-db-sqlite-pool-options", "arg1:1,arg2:2",
                "-ipc-queue-q", "local://queue?bk-test=10",
                "-ipc-queue-q-options", "count:10,interval:100",
                "-ipc-queue-q-options-visibilityTimeout", "1000",
                "-api-cleanup-rules-aaa", "one:1,two:2",
                "-api-cleanup-rules-aaa", "three:3",
            ];
    core.parseArgs(argv);
    logger.debug("poolParams:", db.poolParams);

    if (core.forceUid[0] != 1) return callback("invalid force-uid")
    if (core.proxy.port != 3000) return callback("invalid proxy-port");
    if (!db._createTables) return callback("invalid create-tables");

    if (db.poolParams.sqlite?.max != 10) return callback("invalid sqlite max");
    if (db.poolParams.sqlite.configOptions.arg1 != 1 || db.poolParams.sqlite.configOptions.arg2 != 2) return callback("invalid sqlite map with args");

    if (db.poolParams.sqlite1?.url != "a") return callback("invalid sqlite1 url");
    if (db.poolParams.sqlite1.max != 10) return callback("invalid sqlite1 max");
    if (!db.poolParams.sqlite1.configOptions.cacheColumns) return callback("invalid sqlite1 cache-columns");
    if (db.poolParams.sqlite.configOptions.discoveryInterval != 30000) return callback("invalid sqlite interval:" + lib.stringify(db.poolParams.sqlite));
    if (db.poolParams.sqlite.configOptions['map.test'] != "test") return callback("invalid sqlite map:" + lib.stringify(db.poolParams.sqlite));
    if (db.poolParams.sqlite1.configOptions.test != "test") return callback("invalid sqlite1 map:" + lib.stringify(db.poolParams.sqlite1));

    if (ipc.configParams.q?.count != 10 || ipc.configParams.q?.interval != 100) return callback("invalid queue options");
    if (ipc.configParams.q?.visibilityTimeout != 1000) return callback("invalid queue visibility timeout");

    for (const p in ipc.configParams) if (p != "q") delete ipc.configParams[p];
    ipc.initClients();
    var q = ipc.getQueue("q");
    this.assert(q.options.test != 10, "invalid queue url options", q)

    core.parseArgs(["-ipc-queue-q-options-visibilityTimeout", "99", "-ipc-queue-q-options", "count:99"]);
    this.assert(q.options.visibilityTimeout != 99 || q.options.count != 99, "invalid queue url options", q)

    if (core.logwatcherSend.error != "a") return callback("invalid logwatcher email:" + JSON.stringify(core.logwatcherSend));
    if (core.logwatcherMatch.error.indexOf("a") == -1) return callback("invalid logwatcher match: " + JSON.stringify(core.logwatcherMatch));
    if (!core.logwatcherFile.some(function(x) { return x.file == "a" && x.type == "error"})) return callback("invalid logwatcher file: " + JSON.stringify(core.logwatcherFile));
    if (!core.logwatcherFile.some(function(x) { return x.file == "b"})) return callback("invalid logwatcher file: " + JSON.stringify(core.logwatcherFile));
    if (!api.allow.list.some(function(x) { return x == "^/a"})) return callback("invalid allow path");
    if (!api.allowAdmin.list.some(function(x) { return x == "^/a"})) return callback("invalid allow admin");

    if (api.cleanupRules.aaa?.one != 1 || api.cleanupRules.aaa?.two != 2 || api.cleanupRules.aaa?.three != 3) return callback("invalid api cleanup rules");
    callback();
}

tests.test_logwatcher = function(callback)
{
    var email = lib.getArg("-email");
    if (!email) return callback("-email is required")

    var argv = ["-logwatcher-send-error", email,
                "-logwatcher-send-test", email,
                "-logwatcher-send-warning", email,
                "-logwatcher-send-any", email,
                "-logwatcher-match-test", "TEST: ",
                "-logwatcher-ignore-warning", "warning2",
                "-logwatcher-once-test2", "test2",
                "-logwatcher-match-any", "line:[0-9]+",
            ];
    var lines = [
                " ERROR: error1",
                " continue error1",
                "]: WARN: warning1",
                "]: WARN: warning2",
                " backtrace test line:123",
                "[] TEST: test1",
                "[] TEST: test2 shown",
                "[] TEST: test2 skipped",
                "[] TEST: test2 skipped",
                "[] ERROR: error2",
                "no error string",
                "no error string",
                "no error string",
                "no error string",
                "no error string",
                "no error string",
                " backtrace test line:456",
            ];
    core.parseArgs(argv);
    fs.appendFileSync(core.logFile, lines.join("\n"));
    core.watchLogs(function(err, rc) {
        if (!err && lib.objKeys(rc.errors).length != 4) err = "no errors matched but should";
        console.log(rc);
        callback(err);
    });
}

tests.test_dblock = function(callback)
{
    var self = this;
    var tables = {
        dbtest: { id: { primary: 1, pub: 1 },
                  mtime: { type: "bigint" },
                  status: {}, },
    };

    var id = "ID";
    var interval = lib.getArgInt("-interval", 500);
    var count = lib.getArgInt("-count", 0);

    function queueJob(name, callback) {
        var now = Date.now(), mtime;
        db.get("dbtest", { id: id }, function(err, rc) {
            if (rc) {
                mtime = rc.mtime;
                // Ignore if the period is not expired yet
                if (now - mtime < interval) return callback();
                // Try to update the record using the time we just retrieved, this must be atomic/consistent in the database
                db.update("dbtest", { id: id, mtime: now, status: "running" }, { quiet: 1, expected: { id: id, mtime: mtime } }, function(err, rc, info) {
                    if (err) return callback(err);
                    if (!info.affected_rows) return callback();
                    // We updated the record, we can start the job now
                    logger.log(name, "U: START A JOB", mtime, now);
                    return callback();
                });
            } else {
                db.add("dbtest", { id: id, mtime: now, status: "running" }, { quiet: 1 }, function(err) {
                    // Cannot create means somebody was ahead of us, ingore
                    if (err) return callback(err);
                    // We created a new record, now we can start the job now
                    logger.log(name, "A: START A JOB", now, now);
                    return callback();
                });
            }
        });
    }

    lib.series([
        function(next) {
            if (cluster.isWorker) return next();
            self.resetTables(tables, next);
        },
        function(next) {
            for (var i = 0; i < count; i++) queueJob(i, lib.noop);
            queueJob(100, function() { next() });
        },
        function(next) {
            queueJob(200, function() { setTimeout(next, interval - 1) });
        },
        function(next) {
            for (var i = 0; i < count; i++) queueJob(i + 300, lib.noop);
            queueJob(400, function() { next() });
        },
        function(next) {
            setTimeout(next, 1000)
        },
    ], callback);
}

tests.test_dynamodb = function(callback)
{
    var a = { a: 1, b: 2, c: "3", d: { 1: 1, 2: 2 }, e: [1,2], f: [{ 1: 1 }, { 2: 2 }], g: true, h: null, i: ["a","b"] };
    var b = aws.toDynamoDB(a);
    var c = aws.fromDynamoDB(b);
    logger.debug("dynamodb: from", a)
    logger.debug("dynamodb: to", b)
    logger.debug("dynamodb: to", c)
    if (JSON.stringify(a) != JSON.stringify(c)) return callback("Invalid convertion from " + JSON.stringify(c) + "to" + JSON.stringify(a));
    callback();
}

tests.test_auth = function(callback)
{
    var argv = [
        "-api-allow-admin", "^/system",
        "-api-allow-authenticated", "^/authonly",
        "-api-allow-acl-authenticated", "allow2",
        "-api-allow-account-manager", "^/manager",
        "-api-allow-acl-manager", "allow1",
        "-api-allow-account-user", "^/user",
        "-api-allow-acl-user", "allow1",
        "-api-only-acl-manager", "only1",
        "-api-only-acl-only", "only1",
        "-api-acl-allow1", "^/allow1",
        "-api-acl-allow2", "^/allow2",
        "-api-deny-account-manager", "^/useronly",
        "-api-deny-account-user", "^/manageronly",
        "-api-deny-acl-user", "deny1",
        "-api-acl-deny1", "^/deny1",
        "-api-acl-deny2", "^/deny2",
        "-api-deny-authenticated", "^/authdeny",
        "-api-deny-acl-authenticated", "deny2",
        "-api-acl-only1", "^/user/only",
        "-api-acl-errmsg-only1", "only1 allowed",
        "-api-acl-errmsg-manager", "managers only",
        "-api-path-errmsg-/allow2", "not allowed",
    ];
    api.resetAcl();
    core.parseArgs(argv);
    for (const p in api) {
        if (/^(allow|deny|acl|only)/.test(p) && !lib.isEmpty(api[p]) && typeof api[p] == "object") console.log(p, "=", api[p]);
    }

    var req = { account: {}, options: {} };
    var checks = [
        { status: 401, path: "/system" },
        { status: 401, path: "/system", type: "user" },
        { status: 401, path: "/system", type: "manager" },
        { status: 417, path: "/authonly" },
        { status: 401, path: "/allow2" },
        { status: 200, path: "/allow2", type: "user" },
        { status: 200, path: "/authonly", type: "user" },
        { status: 200, path: "/allow2", type: "user" },
        { status: 401, path: "/manager" },
        { status: 401, path: "/manager", type: "user" },
        { status: 200, path: "/manager", type: "manager" },
        { status: 200, path: "/allow1", type: "manager" },
        { status: 401, path: "/user" },
        { status: 401, path: "/allow1" },
        { status: 200, path: "/user", type: "user" },
        { status: 200, path: "/allow1", type: "user" },
        { status: 401, path: "/useronly", type: "manager" },
        { status: 401, path: "/manageronly", type: "user" },
        { status: 401, path: "/deny2", type: "user" },
        { status: 401, path: "/authdeny", type: "user" },
        { status: 401, path: "/deny1", type: "user" },
        { status: 200, path: "/deny1", type: "manager" },
        { status: 200, path: "/user/only", type: "manager" },
        { status: 401, path: "/user/only", type: "user" },
        { status: 200, path: "/user/only", type: "only" },
    ];

    lib.forEachSeries(checks, (check, next) => {
        req.account.id = req.account.type = check.type;
        req.options.path = check.path;
        api.checkAuthorization(req, { status: check.type ? 200 : 417 }, (err) => {
            if (err.status != 200) console.log(check, err);
            tests.expect(err.status == check.status, err, check);
            next();
        });
    }, callback);
}

tests.test_cleanup = function(callback)
{
    var tables = {
        cleanup: {
            pub: { pub: 1 },
            priv: { priv: 1 },
            pub_admin: { pub_admin: 1 },
            pub_staff: { pub_staff: 1 },
            internal: { internal: 1 },
            billing: { pub_admin: 1, pub_types: ["billing"] },
            nobilling: { pub_admin: 1, priv_types: ["billing"] },
            billing_staff: { pub_admin: 1, pub_types: ["billing", "staff"] },
        },
    };
    var row = { pub: "pub", priv: "priv", pub_admin: "pub_admin", pub_staff: "pub_staff",
                internal: "internal", billing: "billing",
                nobilling: "nobilling", billing_staff: "billing_staff",
                extra: "extra", extra2: "extra2" }

    db.describeTables(tables);
    var res, failed = 0;

    logger.log("internal:", res = api.cleanupResult("cleanup", lib.objClone(row), { isInternal: 1 }),
           "status=", res.internal && !res.priv ? "ok" : ++failed);

    logger.log("pub:", res = api.cleanupResult("cleanup", lib.objClone(row), {}),
           "status=", res.pub && !res.priv ? "ok" : ++failed);

    logger.log("pub_admin:", res = api.cleanupResult("cleanup", lib.objClone(row), { isAdmin: 1 }),
           "status=", res.pub_admin && !res.internal && !res.priv ? "ok" : ++failed);

    logger.log("pub_staff:", res = api.cleanupResult("cleanup", lib.objClone(row), { isStaff: 1 }),
           "status=", res.pub_staff && !res.pub_admin && !res.priv ? "ok" : ++failed);

    logger.log("pub_admin and pub_staff:", res = api.cleanupResult("cleanup", lib.objClone(row), { isAdmin: 1, isStaff: 1 }),
           "status=", res.pub_admin && res.pub_staff && !res.priv ? "ok" : ++failed);

    logger.log("billing:", res = api.cleanupResult("cleanup", lib.objClone(row), { isAdmin: 1, account: { type: ["billing"] } }),
           "status=", res.billing && !res.priv ? "ok" : ++failed);

    logger.log("nobilling:", res = api.cleanupResult("cleanup", lib.objClone(row), { isAdmin: 1, account: { type: ["billing"] } }),
           "status=", !res.nobilling && !res.priv ? "ok" : ++failed);

    logger.log("billing_staff:", res = api.cleanupResult("cleanup", lib.objClone(row), { isAdmin: 1, account: { type: ["staff"] } }),
           "status=", res.billing_staff && !res.priv ? "ok" : ++failed);

    api.cleanupStrict = 0;
    logger.log("extra nonstrict:", res = api.cleanupResult("cleanup", lib.objClone(row), {}),
           "status=", res.extra && res.extra2 ? "ok" : ++failed);

    api.cleanupStrict = 1;
    logger.log("no extras strict:", res = api.cleanupResult("cleanup", lib.objClone(row, "extra", 1), {}),
           "status=", !res.extra && !res.extra2? "ok" : ++failed);

    logger.log("no extra2 extra2 cleanup rule strict:", res = api.cleanupResult("cleanup", lib.objClone(row, "extra", 1), { cleanup_rules: { extra: 1 } }),
           "status=", res.extra && !res.extra2 ? "ok" : ++failed);

    api.cleanupRules = { '*': { extra2: 1 } };
    logger.log("no extra extra2 * rule strict:", res = api.cleanupResult("cleanup", lib.objClone(row, "extra", 1), {}),
           "status=", !res.extra && res.extra2 ? "ok" : ++failed);

    api.cleanupRules = { cleanup: { extra2: 1 } };
    logger.log("no extra extra2 table rule strict:", res = api.cleanupResult("cleanup", lib.objClone(row, "extra", 1), {}),
           "status=", !res.extra && res.extra2 ? "ok" : ++failed);

    callback(failed);
}

tests.test_speed = function(callback, test)
{
    if (!test.metrics) {
        test.metrics = new metrics.Metrics();
        test.metrics.errors = 0;
    }
    var opts = {
        headers: { 'user-agent': `${core.name}/test/${lib.tuuid()}` },
        login: tests.getArg("-login"),
        secret: tests.getArg("-secret"),
    };
    lib.strSplit(tests.getArg("-headers"), "|").forEach((x) => {
        x = lib.strSplit(x, ":");
        opts.headers[x[0]] = x.slice(1).join(":");
    });
    var urls = lib.strSplit(tests.getArg("-url"), "|");
    lib.readFileSync(tests.getArg("-speed-conf"), { list: "\n" }).forEach((x) => {
        x = lib.strSplit(x, "=");
        switch (x[0]) {
        case "url":
            urls.push(x[1]);
            break;
        case "header":
            x = lib.strSplit(x.slice(1).join("="), ":");
            opts.headers[x[0]] = x.slice(1).join(":");
            break;
        case "login":
            opts.login = x[1];
            break;
        case "secret":
            opts.secret = x[1];
            break;
        case "opt":
            x = lib.strSplit(x.slice(1).join("="), ":");
            opts[x[0]] = x.slice(1).join(":");
            break;
        }
    });

    lib.forEachSeries(urls, (url, next2) => {
        lib.forEach(lib.strSplit(url, "|"), (u, next3) => {
            const t = test.metrics.Timer("t").start();
            core.sendRequest(lib.objClone(opts, "url", u), (err, rc) => {
                if (rc.status >= 400) test.metrics.errors++;
                t.end();
                setImmediate(next3);
            });
        }, next2);
    }, callback);
}

// Vectors from https://wiki.mozilla.org/Identity/AttachedServices/KeyServerProtocol
tests.test_srp = function(callback, test)
{
    var user = lib.getArg("-user", 'andré@example.org');
    var secret = lib.getArg("-secret") || Buffer.from('00f9b71800ab5337d51177d8fbc682a3653fa6dae5b87628eeec43a18af59a9d', "hex");
    var salt = lib.getArg("-salt", '00f1000000000000000000000000000000000000000000000000000000000179');
    var a = lib.getArg("-a", "f2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d3d7");
    var b = lib.getArg("-b", "f3000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f");
    var k = lib.getArg("-k", "5b9e8ef059c6b32ea59fc1d322d37f04aa30bae5aa9003b8321e21ddb04e300");
    var v = lib.getArg("-v", "173ffa0263e63ccfd6791b8ee2a40f048ec94cd95aa8a3125726f9805e0c8283c658dc0b607fbb25db68e68e93f2658483049c68af7e8214c49fde2712a775b63e545160d64b00189a86708c69657da7a1678eda0cd79f86b8560ebdb1ffc221db360eab901d643a75bf1205070a5791230ae56466b8c3c1eb656e19b794f1ea0d2a077b3a755350208ea0118fec8c4b2ec344a05c66ae1449b32609ca7189451c259d65bd15b34d8729afdb5faff8af1f3437bbdc0c3d0b069a8ab2a959c90c5a43d42082c77490f3afcc10ef5648625c0605cdaace6c6fdc9e9a7e6635d619f50af7734522470502cab26a52a198f5b00a279858916507b0b4e9ef9524d6");
    var B = lib.getArg("-B", "22ce5a7b9d81277172caa20b0f1efb4643b3becc53566473959b07b790d3c3f08650d5531c19ad30ebb67bdb481d1d9cf61bf272f8439848fdda58a4e6abc5abb2ac496da5098d5cbf90e29b4b110e4e2c033c70af73925fa37457ee13ea3e8fde4ab516dff1c2ae8e57a6b264fb9db637eeeae9b5e43dfaba9b329d3b8770ce89888709e026270e474eef822436e6397562f284778673a1a7bc12b6883d1c21fbc27ffb3dbeb85efda279a69a19414969113f10451603065f0a012666645651dde44a52f4d8de113e2131321df1bf4369d2585364f9e536c39a4dce33221be57d50ddccb4384e3612bbfd03a268a36e4f7e01de651401e108cc247db50392");
    var A = lib.getArg("-A", "7da76cb7e77af5ab61f334dbd5a958513afcdf0f47ab99271fc5f7860fe2132e5802ca79d2e5c064bb80a38ee08771c98a937696698d878d78571568c98a1c40cc6e7cb101988a2f9ba3d65679027d4d9068cb8aad6ebff0101bab6d52b5fdfa81d2ed48bba119d4ecdb7f3f478bd236d5749f2275e9484f2d0a9259d05e49d78a23dd26c60bfba04fd346e5146469a8c3f010a627be81c58ded1caaef2363635a45f97ca0d895cc92ace1d09a99d6beb6b0dc0829535c857a419e834db12864cd6ee8a843563b0240520ff0195735cd9d316842d5d3f8ef7209a0bb4b54ad7374d73e79be2c3975632de562c596470bb27bad79c3e2fcddf194e1666cb9fc");
    var x = lib.getArg("-x", "b5200337cc3f3f926cdddae0b2d31029c069936a844aff58779a545be89d0abe");
    var K = lib.getArg("-K", "e68fd0112bfa31dcffc8e9c96a1cbadb4c3145978ff35c73e5bf8d30bbc7499a");
    var M = lib.getArg("-M", "27949ec1e0f1625633436865edb037e23eb6bf5cb91873f2a2729373c2039008");
    var S = lib.getArg("-S", "92aaf0f527906aa5e8601f5d707907a03137e1b601e04b5a1deb02a981f4be037b39829a27dba50f1b27545ff2e28729c2b79dcbdd32c9d6b20d340affab91a626a8075806c26fe39df91d0ad979f9b2ee8aad1bc783e7097407b63bfe58d9118b9b0b2a7c5c4cdebaf8e9a460f4bf6247b0da34b760a59fac891757ddedcaf08eed823b090586c63009b2d740cc9f5397be89a2c32cdcfe6d6251ce11e44e6ecbdd9b6d93f30e90896d2527564c7eb9ff70aa91acc0bac1740a11cd184ffb989554ab58117c2196b353d70c356160100ef5f4c28d19f6e59ea2508e8e8aac6001497c27f362edbafb25e0f045bfdf9fb02db9c908f10340a639fe84c31b27");
    var u = lib.getArg("-u", "b284aa1064e8775150da6b5e2147b47ca7df505bed94a6f4bb2ad873332ad732");

    auth.srp.init();
    console.log("user:", user, secret, "salt:", salt, "k:", auth.srp.k.toString(16) == k);

    var r = auth.srp.verifier(user, secret, salt);
    console.log("r:", r, "v:", r[1] == v, "x:", r[2] == x);

    var c1 = auth.srp.client1(a)
    console.log("c1:", c1, "A:", c1[1] == A);

    var s1 = auth.srp.server1(r[1], b);
    console.log("s1:", s1, "B:", s1[1] == B)

    var c2 = auth.srp.client2(user, secret, r[0], c1[0], s1[1])
    console.log("c2:", c2, "K:", c2[0] == K, "M:", c2[1] == M, "S:", c2[2] == S, "u:", c2[3] == u, "x:", c2[4] == x, "A:", c2[5] == A);

    var s2 = auth.srp.server2(user, r[1], s1[0], c1[1], c2[1])
    console.log("s2:", s2, "S:", s2[1] == S, "u:", s2[2] == u)

    var c3 = auth.srp.client3(c1[1], c2[1], c2[0], s2[0])
    console.log("c3:", c3)

    callback();
}

tests.test_flow = function(callback, test)
{
    var direct = lib.isArg("-direct");
    var t = 0;
    setInterval(() => { if (!t) callback() }, 500);

    t++;
    var c1 = 0;
    lib.forEach([ 1, 2, 3 ], (i, next) => {
        c1++; next()
    }, (err) => {
        t--;
        console.log("forEach", err, c1, c1 == 3 && !err ? "success": "FAILED")
    }, direct)

    t++;
    var c2 = 0;
    lib.forEach([ 1, 2, 3 ], (i, next) => {
        c2++; next(i == 2 ? "error" : null)
    }, (err) => {
        t--;
        console.log("forEach", err, c2, c2 == 2 && err ? "success": "FAILED")
    }, direct)

    t++;
    var c3 = 0;
    lib.forEvery([ 1, 2, 3 ], (i, next) => {
        c3++; next("ignore")
    }, (err) => {
        t--;
        console.log("forEvery", err, c3, c3 == 3 && err == "ignore" ? "success": "FAILED")
    }, direct)

    t++;
    lib.forEachSeries([ 1, 2, 3 ], (i, next, n) => {
        next(null, lib.toNumber(n) + i);
    }, (err, n) => {
        t--;
        console.log('forEachSeries', n, err, n == 6 ? "success" : "FAILED");
    }, direct);

    t++;
    lib.forEachSeries([ 1, 2, 3 ], (i, next, n) => {
        next(i == 2 ? "error" : null, lib.toNumber(n) + i);
    }, (err, n) => {
        t--;
        console.log('forEachSeries', n, err, n == 3 && err == "error" ? "success" : "FAILED");
    }, direct);

    t++;
    lib.forEverySeries([ 1, 2, 3 ], (i, next, err, n) => {
        next("ignore", lib.toNumber(n) + i);
    }, (err, n) => {
        t--;
        console.log('forEverySeries', n, err, n == 6 && err == "ignore" ? "success" : "FAILED");
    }, direct);

    t++;
    var c4 = 0;
    lib.forEachLimit([ 1, 2, 3 ], 2, (i, next) => {
        c4++; next();
    }, (err) => {
        t--;
        console.log('forEachLimit', c4, err, c4 == 3 && !err ? "success" : "FAILED");
    }, direct);

    t++;
    var c5 = 0;
    lib.forEachLimit([ 1, 2, 3 ], 2, (i, next) => {
        c5++; next(i == 2 ? "error" : null);
    }, (err) => {
        t--;
        console.log('forEachLimit', c5, err, c5 == 2 && err == "error" ? "success" : "FAILED");
    }, direct);

    t++;
    var c6 = 0;
    lib.forEveryLimit([ 1, 2, 3 ], 2, (i, next) => {
        c6++; next("ignore");
    }, (err) => {
        t--;
        console.log('forEveryLimit', c6, err, c6 == 3 && String(err) == "ignore,ignore,ignore" ? "success" : "FAILED");
    }, direct);

    t++;
    var c7 = 0;
    lib.whilst(
        function() {
            return c7 < 5;
        },
        function (next) {
            c7++;
            next(null, c7);
        },
        function (err, d) {
            t--;
            console.log('whilst', c7, d, err, c7 == 5 && !err ? "success" : "FAILED");
        }, direct);

    t++;
    var c8 = 0;
    lib.doWhilst(
        function (next) {
            c8++;
            next(null, c8);
        },
        function() {
            return c8 < 5;
        },
        function (err, d) {
            t--;
            console.log('whilst', c8, d, err, c8 == 5 && !err ? "success" : "FAILED");
        }, direct);

    t++;
    var c9 = 0;
    lib.series([
        (next) => {
            c9++
            next(null, 1)
        },
        (next, data) => {
            c9++
            next(null, data + 1)
        }
    ], (err, d) => {
        t--;
        console.log('series', c9, d, err, c9 == 2 && d === 2 && !err ? "success" : "FAILED");
    }, direct)

    t++;
    var c10 = 0;
    lib.series([
        (next) => {
            c10++
            next("error", 1);
        },
        (next, data) => {
            c10++
            next("error", data + 1)
        }
    ], (err, d) => {
        t--;
        console.log('series', c10, d, err, c10 == 1 && d == 1 && err == "error" ? "success" : "FAILED");
    }, direct)

    t++;
    var c11 = 0;
    lib.parallel([
        (next) => {
            c11++;
            next()
        },
        (next) => {
            c11++;
            next()
        }
    ], (err) => {
        t--;
        console.log('parallel', c11, err, c11 == 2 && !err ? "success" : "FAILED");
    }, direct)

    t++;
    var c12 = 0;
    lib.parallel([
        (next) => {
            c12++
            next("error");
        },
        (next) => {
            c12++;
            next();
        }
    ], (err) => {
        t--;
        console.log('parallel', c12, err, c12 >= 1 && err ? "success" : "FAILED");
    }, direct)

    t++;
    var c13 = 0;
    lib.everySeries([
        (next) => {
            c13++;
            next("ignore", 1);
        },
        (next, err, data) => {
            c13++;
            next(err, data + 1)
        }
    ], (err, d) => {
        t--;
        console.log('everySeries', c13, d, err, c13 == 2 && d === 2 && err == "ignore" ? "success" : "FAILED");
    }, direct)

    t++;
    var c14 = 0;
    lib.everyParallel([
        (next) => {
            c14++
            next("ignore")
        },
        (next) => {
            c14++
            next()
        }
    ], (err) => {
        t--;
        console.log('everyParallel', c14, err, c14 == 2 && !err ? "success" : "FAILED");
    }, direct)

}

tests.test_toparams = function(callback, test)
{
    lib.series([
        function(next) {
        },
        function(next) {
        },
    ], callback);
}
