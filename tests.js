//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//
// Unit tests
// To run a test execute for example: node tests.js -cmd account ....
//

var fs = require("fs");
var cluster = require('cluster');
var util = require('util');
var path = require('path');
var async = require('async');
var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;
var backend = require('backendjs')
core = backend.core;
ipc = backend.ipc;
api = backend.api;
db = backend.db;
aws = backend.aws;
server = backend.server;
logger = backend.logger;
bn = backend.backend;

var females = [ "mary", "patricia", "linda", "barbara", "elizabeth", "jennifer", "maria", "susan",
                "carol", "ruth", "sharon", "michelle", "laura", "sarah", "kimberly", "deborah", "jessica",
                "heather", "teresa", "doris", "gloria", "evelyn", "jean", "cheryl", "mildred",
                "katherine", "joan", "ashley", "judith"];

var males = [ "james", "john", "robert", "michael", "william", "david", "richard", "charles", "joseph",
              "thomas", "christopher", "daniel", "paul", "mark", "donald", "george", "kenneth", "steven",
              "justin", "terry", "gerald", "keith", "samuel", "willie", "ralph", "lawrence", "nicholas",
              "roy", "benjamin"];

var location = "Los Angeles";
var bbox = [ 33.60503975233155, -117.72825045393661, 34.50336024766845, -118.75374954606342 ]; // Los Angeles 34.05420, -118.24100

// Test object with function for different ares to be tested
var tests = {
    name: 'tests',
    start_time: 0,
};

// check(next, err, rc.length!=1, 'err1:', rc)
tests.check = function()
{
    var next = arguments[0];
    if (arguments[1] || arguments[2]) {
        var args = [ 'ERROR:', arguments[1] ? arguments[1] : new Error("failed condition") ];
        for (var i = 3; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
        return next(args[1]);
    }
    next();
}

tests.start = function(type)
{
	var self = this;
	if (type == "start" || type == "check" || !this[type]) {
		logger.error(this.name, 'no such test:', type);
		process.exit(1);
	}

	if (cluster.isMaster) {
	    setTimeout(function() {
	        var workers = core.getArgInt("-workers", 0);
	        for (var i = 0; i < workers; i++) cluster.fork();
	    }, core.getArgInt("-delay", 500));
	}

	switch (core.getArg("-bbox")) {
	case "DC":
	    location = "Washingtn, DC";
	    bbox = [ 30.10, -77.5, 38.60, -76.5 ];
	    break;
	case "SF":
		location = "San Francisco, CA";
		bbox = [ 37.32833975233156, -122.86154379633437, 38.22666024766845, -121.96045620366564 ];  // San Francisco 37.77750, -122.41100
		break;
	case "SD":
		location = "San Diego, CA";
		bbox = [ 32.26553975233155, -118.8279466261797, 33.163860247668445, -115.4840533738203 ]; // San Diego 32.71470, -117.15600
		break;
	}

    this.start_time = Date.now();
    var count = core.getArgInt("-iterations", 1);
	logger.log(self.name, "started:", type);
	async.whilst(
	    function () { return count > 0; },
	    function (next) {
	    	count--;
	    	self[type](next);
	    },
	    function(err) {
	    	if (err) {
	    	    logger.error(self.name, "failed:", type, err);
	    	    process.exit(1);
	    	}
	    	logger.log(self.name, "stopped:", type, Date.now() - self.start_time, "ms");
	    	process.exit(0);
	    });
};

tests.account = function(callback)
{
    var myid, otherid;
    var id = core.random();
    var login = id;
	var secret = id;
    var gender = ['m','f'][core.randomInt(0,1)];
    var bday = new Date(core.randomInt(Date.now() - 50*365*86400000, Date.now() - 20*365*86400000));
    var latitude = core.randomNum(bbox[0], bbox[2]);
    var longitude = core.randomNum(bbox[1], bbox[3]);
    var name = core.toTitle(gender == 'm' ? males[core.randomInt(0, males.length - 1)] : females[core.randomInt(0, females.length - 1)]);
    var icon = "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAJCAYAAAD+WDajAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwgAADsIBFShKgAAAABp0RVh0U29mdHdhcmUAUGFpbnQuTkVUIHYzLjUuMTAw9HKhAAAAPElEQVQoU2NggIL6+npjIN4NxIIwMTANFFAC4rtA/B+kAC6JJgGSRCgAcs5ABWASMHoVw////3HigZAEACKmlTwMfriZAAAAAElFTkSuQmCC";
    var msgs = null, icons = [];

    async.series([
        function(next) {
            var query = { login: login, secret: secret, name: name, gender: gender, birthday: core.strftime(bday, "%Y-%m-%d") }
            core.sendRequest("/account/add", { sign: false, query: query }, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret }
            core.sendRequest("/account/del", options, function(err, params) {
                next(err || !params.obj || params.obj.name != name ? ("err1:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var query = { login: login + 'other', secret: secret, name: name + ' Other', gender: gender, birthday: core.strftime(bday, "%Y-%m-%d") }
            core.sendRequest("/account/add", { sign: false, query: query }, function(err, params) {
                otherid = params.obj.id;
                next(err);
            });
        },
        function(next) {
            var query = { login: login, secret: secret, name: name, gender: gender, birthday: core.strftime(bday, "%Y-%m-%d") }
            for (var i = 1; i < process.argv.length - 1; i++) {
                var d = process.argv[i].match(/^\-account\-(.+)$/);
                if (!d) continue;
                if (d[1] == "icon") {
                    icons.push(process.argv[++i]);
                } else {
                    query[d[1]] = process.argv[++i];
                }
            }
            core.sendRequest("/account/add", { sign: false, query: query }, function(err, params) {
                myid = params.obj.id;
                next(err);
            });
        },
        function(next) {
            if (!icons.length) return next();
            // Add all icons from the files
            var type = 0;
            async.forEachSeries(icons, function(icon, next2) {
                icon = fs.readFileSync(icon).toString("base64");
                var options = { login: login, secret: secret, method: "POST", postdata: { icon: icon, type: type++, acl_allow: "allow" }  }
                core.sendRequest("/account/put/icon", options, function(err, params) {
                    next2(err);
                });
            }, next);
        },
        function(next) {
            var options = { login: login, secret: secret, query: { latitude: latitude, longitude: longitude, location: location } };
            core.sendRequest("/location/put", options, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { alias: "test" + name } };
            core.sendRequest("/account/update", options, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { secret: "test" } };
            core.sendRequest("/account/put/secret", options, function(err, params) {
                secret = "test";
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret }
            core.sendRequest("/account/get", options, function(err, params) {
                next(err || !params.obj || params.obj.name != name || params.obj.alias != "test" + name || params.obj.latitude != latitude ? ("err1:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { icon: icon, type: 98, acl_allow: "all" }  }
            core.sendRequest("/account/put/icon", options, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, method: "POST", postdata: { icon: icon, type: 99, _width: 128, _height: 128, acl_allow: "auth" }  }
            core.sendRequest("/account/put/icon", options, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { _consistent: 1 } }
            core.sendRequest("/account/select/icon", options, function(err, params) {
                next(err || !params.obj || params.obj.length!=2+icons.length || !params.obj[0].acl_allow ? ("err2:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { id: id, type: "like" }  }
            core.sendRequest("/connection/add", options, function(err, params) {
                options = { login: login, secret: secret, query: { id: core.random(), type: "like" }  }
                core.sendRequest("/connection/add", options, function(err, params) {
                    next(err);
                });
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { type: "like" } }
            core.sendRequest("/connection/get", options, function(err, params) {
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=2 ? ("err3:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret }
            core.sendRequest("/counter/get", options, function(err, params) {
                next(err || !params.obj || params.obj.like0!=2 ? ("err4:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { id: id, type: "like" }  }
            core.sendRequest("/connection/del", options, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { type: "like" } }
            core.sendRequest("/connection/get", options, function(err, params) {
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=1 ? ("err5:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret }
            core.sendRequest("/counter/get", options, function(err, params) {
                next(err || !params.obj || params.obj.like0!=1 || params.obj.ping!=0? ("err6:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: {} }
            core.sendRequest("/connection/del", options, function(err, params) {
                next(err ? ("err5:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { } }
            core.sendRequest("/connection/get", options, function(err, params) {
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=0 ? ("err5-1:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { ping: "1" } }
            core.sendRequest("/counter/incr", options, function(err, params) {
                next(err);
            });
        },
        function(next) {
            var options = { login: login, secret: secret }
            core.sendRequest("/counter/get", options, function(err, params) {
                next(err || !params.obj || params.obj.like0!=0 || params.obj.ping!=1? ("err66:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { id: otherid, msg: "text message" }  }
            core.sendRequest("/message/add", options, function(err, params) {
                next(err || !params.obj ? ("err7:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { id: myid, icon: icon }  }
            core.sendRequest("/message/add", options, function(err, params) {
                next(err || !params.obj ? ("err8:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { } }
            core.sendRequest("/message/get", options, function(err, params) {
                msgs = params.obj;
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=1 ? ("err9:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { sender: myid } }
            core.sendRequest("/message/get", options, function(err, params) {
                msgs = params.obj;
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=1 ? ("err9-1:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { } }
            core.sendRequest("/message/get/unread", options, function(err, params) {
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=1 ? ("err10:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { sender: msgs.data[0].sender, mtime: msgs.data[0].mtime } }
            core.sendRequest("/message/read", options, function(err, params) {
                next(err || !params.obj ? ("err11:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { sender: msgs.data[0].sender, mtime: msgs.data[0].mtime } }
            core.sendRequest("/message/image", options, function(err, params) {
                next(err ? ("err12:" + err) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { _read: 1 } }
            core.sendRequest("/message/get/unread", options, function(err, params) {
                msgs = params.obj;
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=0 ? ("err13:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { } }
            core.sendRequest("/message/get/unread", options, function(err, params) {
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=0 ? ("err14:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { id: otherid } }
            core.sendRequest("/message/get", options, function(err, params) {
                msgs = params.obj;
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=1 || params.obj.data[0].sender!=myid? ("err14-1:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { sender: myid } }
            core.sendRequest("/message/del", options, function(err, params) {
                next(err ? ("err14-2:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret, query: { sender: myid } }
            core.sendRequest("/message/get", options, function(err, params) {
                next(err || !params.obj || !params.obj.data || params.obj.data.length!=0 ? ("err14-3:" + err + util.inspect(params.obj)) : 0);
            });
        },
        function(next) {
            var options = { login: login, secret: secret }
            core.sendRequest("/counter/get", options, function(err, params) {
                next(err || !params.obj || params.obj.msg_count!=1 || params.obj.msg_read!=1 ? ("err15:" + err + util.inspect(params.obj)) : 0);
            });
        },
    ],
    function(err) {
        callback(err);
    });
}

tests.s3icon = function(callback)
{
	var id = core.getArg("-id", "1");
	api.putIconS3("../web/img/loading.gif", id, { prefix: "account" }, function(err) {
		var icon = core.iconPath(id, { prefix: "account" });
		aws.queryS3(api.imagesS3, icon, { file: "tmp/" + path.basename(icon) }, function(err, params) {
			console.log('icon:', core.statSync(params.file));
			callback(err);
		});
	});
}

tests.icon = function(callback)
{
    api.putIcon({ body: {}, files: { 1: { path: __dirname + "/web/img/loading.gif" } } }, 1, { prefix: "account", width: 100, height: 100 }, function(err) {
        callback(err);
    });
}

tests.cookie = function(callback)
{
	core.httpGet('http://www.google.com', { cookies: true }, function(err, params) {
		console.log('COOKIES:', params.cookies);
		callback(err);
	});
}

tests.location = function(callback)
{
	var self = this;
	var tables = {
			geo: { geohash: { primary: 1, index: 1 },
			       id: { primary: 1, pub: 1 },
                   latitude: { type: "real" },
                   longitude: { type: "real" },
                   distance: { type: "real" },
                   rank: { type: 'int', index: 1, dynamodb: { projection: ["status"] } },
                   status: { value: 'good' },
			       mtime: { type: "bigint", now: 1 }
			},
	};
    var rows = core.getArgInt("-rows", 10);
    var distance = core.getArgInt("-distance", 25)
    var round = core.getArgInt("-round", 0)

    var latitude = core.randomNum(bbox[0], bbox[2])
    var longitude = core.randomNum(bbox[1], bbox[3])
    var token = { more: 1 }, rc = [], bad = 0, good = 0, count = rows/2;
    var ghash, gcount = Math.floor(count/2);
    bbox = backend.backend.geoBoundingBox(latitude, longitude, distance);

    async.series([
        function(next) {
            async.forEachSeries(Object.keys(tables), function(t, next2) {
                db.drop(t, function() { next2() });
            }, next);
        },
        function(next) {
        	db.initTables(tables, next);
        },
        function(next) {
        	async.whilst(
        		function () { return good < rows + count; },
        		function (next2) {
        		    var lat = core.randomNum(bbox[0], bbox[2]);
        		    var lon = core.randomNum(bbox[1], bbox[3]);
        		    var obj = core.geoHash(lat, lon);
                    obj.distance = core.geoDistance(latitude, longitude, lat, lon, { round: round });
                    if (obj.distance > distance) return next2();
                    if (good > rows && ghash != obj.geohash) return next2();
                    good++;
        		    obj.id = String(good);
        		    obj.rank = good;
                    ghash = obj.geohash;
        		    db.add("geo", obj, function(err) {
        		        if (err) good--;
        		        next2();
        		    });
        		},
        		function(err) {
        		    next(err);
        		});
        },
        function(next) {
            async.whilst(
                function () { return bad < count; },
                function (next2) {
                    var lat = core.randomNum(bbox[0], bbox[2]);
                    var lon = core.randomNum(bbox[1], bbox[3]);
                    var obj = core.geoHash(lat, lon);
                    obj.distance = core.geoDistance(latitude, longitude, lat, lon, { round: round });
                    if (obj.distance <= distance || obj.distance > distance*2) return next2();
                    bad++;
                    obj.id = String(bad);
                    obj.rank = bad;
                    obj.status = "bad";
                    db.add("geo", obj, function(err) {
                        if (err) bad--;
                        next2();
                    });
                },
                function(err) {
                    next(err);
                });
        },
        function(next) {
            var query = { latitude: latitude, longitude: longitude, distance: distance };
            var options = { count: gcount, round: round };
            async.whilst(
                function() { return token.more },
                function(next2) {
                    db.getLocations("geo", query, token, function(err, rows, info) {
                        token = info;
                        rows.forEach(function(x) { rc.push(x.geohash + ':'+ x.id + ':' + x.status) })
                        next2();
                    });
                }, function(err) {
                    self.check(next, err, rc.length!=good, "err1: ", rc.length, good, 'RC:', rc, 'TOKEN:', token);
                });
        },
        function(next) {
            var query = { latitude: latitude, longitude: longitude, distance: distance, status: "good", rank: 9 };
            var options = { round: round, keys: ["geohash", "status", "rank"], ops: { rank: 'gt' } };
            db.getLocations("geo", query, options, function(err, rows, info) {
                var isok = rows.every(function(x) { return x.status == 'good' && x.rank > 9 })
                self.check(next, err, rows.length!=good-9 || !isok, "err2:", rows.length, isok, good, rows);
            });
        },
        function(next) {
            var query = { latitude: latitude, longitude: longitude, distance: distance*2, status: "bad", rank: bad - 2 };
            var options = { round: round, keys: ["geohash", "status", "rank"], ops: { rank: 'gt' }, sort: "rank", desc: true };
            db.getLocations("geo", query, options, function(err, rows, info) {
                var isok = rows.every(function(x) { return x.status == 'bad' && x.rank > bad - 2 })
                self.check(next, err, rows.length!=2 || !isok, "err3:", rows.length, isok, bad, rows);
            });
        }
    ],
    function(err) {
        callback(err);
    });
}

tests.db = function(callback)
{
	var self = this;
	var tables = {
	        test1: { id: { primary: 1, pub: 1 },
	                 email: {} },
			test2: { id: { primary: 1, pub: 1, index: 1 },
			         id2: { primary: 1 },
			         email: {},
			         alias: { pub: 1 },
			         birthday: { semipub: 1 },
			         json: { type: "json" },
			         num: { type: "int", index: 1, dynamodb: { projection: ['num','id2','email'] } },
			         num2: { type: "real" },
			         mtime: { type: "int" } },
			test3: { id : { primary: 1, pub: 1 },
			         num: { type: "counter", value: 0, pub: 1 } },
	};
	var now = core.now();
	var id = core.random(64);
	var id2 = core.random(128);
    var num2 = core.randomNum(bbox[0], bbox[2]);
	var next_token = null;
	logger.log('db: test', db.pool);

	async.series([
	    function(next) {
	         logger.log('TEST: drop');
	         async.forEachSeries(Object.keys(tables), function(t, next2) {
	             db.drop(t, function() { next2() });
	         }, next);
	    },
	    function(next) {
	        logger.log('TEST: create');
	    	db.initTables(tables, next);
	    },
	    function(next) {
            logger.log('TEST: add1');
            db.add("test1", { id: id, email: id }, function(err) {
                if (err) return next(err);
                db.put("test1", { id: id2, email: id2 }, function(err) {
                    if (err) return next(err);
                    db.put("test3", { id: id, num: 0 }, next);
                });
            });
        },
        function(next) {
            logger.log('TEST: get add3');
            db.get("test3", { id: id }, function(err, row) {
                self.check(next, err, !row || row.id != id, "err1:", row);
            });
        },
        function(next) {
            logger.log('TEST: get add:', id);
            db.get("test1", { id: id }, function(err, row) {
                self.check(next, err, !row || row.id != id, "err2:", row);
            });
        },
        function(next) {
            logger.log('TEST: list');
            db.list("test1", String([id,id2]),  function(err, rows) {
                self.check(next, err, rows.length!=2, "err4:", rows);
            });
        },
	    function(next) {
	        logger.log('TEST: add2');
	    	db.add("test2", { id: id, id2: '1', email: id, alias: id, birthday: id, num: 0, num2: num2, mtime: now }, next);
	    },
	    function(next) {
	        logger.log('TEST: add3');
	    	db.add("test2", { id: id2, id2: '2', email: id, alias: id, birthday: id, num: 0, num2: num2, mtime: now }, next);
	    },
	    function(next) {
	        logger.log('TEST: add4');
	    	db.put("test2", { id: id2, id2: '1', email: id2, alias: id2, birthday: id2, num: 0, num2: num2, mtime: now }, next);
	    },
	    function(next) {
            logger.log('TEST: custom filter');
            db.select("test2", { id: id2 }, { filter: function(row, o) { return row.id2 == '1' } }, function(err, rows) {
                self.check(next, err, rows.length!=1 || rows[0].id2 != '1' || rows[0].num2 != num2 , "err5:", rows);
            });
        },
        function(next) {
            logger.log('TEST: custom async filter');
            db.select("test2", { id: id2 }, { async_filter: function(rows, opts, cb) {
                    cb(null, rows.filter(function(r) { return r.id2 == '1' }));
                }
            }, function(err, rows) {
                self.check(next, err, rows.length!=1 || rows[0].id2 != '1' || rows[0].num2 != num2, "err5-1:", rows);
            });
        },
        function(next) {
            logger.log('TEST: list2');
            db.list("test1", String([id,id2]), { check_public: id }, function(err, rows) {
                var row1 = rows.filter(function(x) { return x.id==id}).pop();
                var row2 = rows.filter(function(x) { return x.id==id2}).pop();
                self.check(next, err, rows.length!=2 || !row1.email || row2.email, "err6:", rows);
            });
        },
	    function(next) {
	        logger.log('TEST: incr');
	    	db.incr("test3", { id: id, num: 1 }, { mtime: 1 }, function(err) {
	    	    if (err) return next(err);
	    		db.incr("test3", { id: id, num: 1 }, function(err) {
	    		    if (err) return next(err);
	    		    db.incr("test3", { id: id, num: -1 }, next);
	    		});
	    	});
	    },
	    function(next) {
	        logger.log('TEST: get after incr');
	    	db.get("test3", { id: id }, function(err, row) {
	    		self.check(next, err, !row || row.id != id && row.num != 1, "err7:", row);
	    	});
	    },
	    function(next) {
	        logger.log('TEST: select columns');
	    	db.select("test2", { id: id2, id2: '1' }, { ops: { id2: 'gt' }, select: 'id,id2,num2,mtime' }, function(err, rows) {
	    		self.check(next, err, rows.length!=1 || rows[0].email || rows[0].id2 != '2' || rows[0].num2 != num2, "err8:", rows);
	    	});
	    },
	    function(next) {
            logger.log('TEST: select columns2');
            db.select("test2", { id: id2, id2: '1' }, { ops: { id2: 'begins_with' }, select: 'id,id2,num2,mtime' }, function(err, rows) {
                self.check(next, err, rows.length!=1 || rows[0].email || rows[0].id2 != '1' || rows[0].num2 != num2, "err8-1:", rows);
            });
        },
	    function(next) {
	        logger.log('TEST: update');
	    	db.update("test2", { id: id, id2: '1', email: id + "@test", json: [1, 9], mtime: now }, function(err) {
	    	    if (err) return next(err);
	    	    logger.log('TEST: replace after update');
	    		db.replace("test2", { id: id, id2: '1', email: id + "@test", num: 9, mtime: now }, { check_mtime: 'mtime' }, next);
	    	});
	    },
	    function(next) {
	        logger.log('TEST: get after update');
	    	db.get("test2", { id: id, id2: '1' }, { consistent: true }, function(err, row) {
	    		self.check(next, err, !row || row.id != id  || row.email != id+"@test" || row.num == 9 || !Array.isArray(row.json), "err9:", row);
	    	});
	    },
	    function(next) {
	        logger.log('TEST: replace');
	    	now = core.now();
	    	db.replace("test2", { id: id, id2: '1', email: id + "@test", num: 9, json: { a: 1, b: 2 }, mtime: now }, { check_data: 1 }, next);
	    },
	    function(next) {
	        logger.log('TEST: get after replace');
	    	db.get("test2", { id: id, id2: '1' }, { skip_columns: ['alias'], consistent: true }, function(err, row) {
	    		self.check(next, err, !row || row.id != id || row.alias || row.email != id+"@test" || row.num!=9 || core.typeName(row.json)!="object" || row.json.a!=1, "err10:", row);
	    	});
	    },
	    function(next) {
	        logger.log('TEST: del');
	    	db.del("test2", { id: id2, id2: '1' }, next);
	    },
	    function(next) {
	        logger.log('TEST: get after del');
	    	db.get("test2", { id: id2, id2: '1' }, { consistent: true }, function(err, row) {
	    		self.check(next, err, row, "del:", row);
	    	});
	    },
	    function(next) {
	        logger.log('TEST: put series');
	    	async.forEachSeries([1,2,3,4,5,6,7,8,9], function(i, next2) {
	    		db.put("test2", { id: id2, id2: String(i), email: id, alias: id, birthday: id, mtime: now }, next2);
	    	}, function(err) {
	    		next(err);
	    	});
	    },
	    function(next) {
	        logger.log('TEST: select id2');
	    	db.select("test2", { id: id2, id2: '0' }, { ops: { id2: 'gt' }, count: 5, select: 'id,id2' }, function(err, rows, info) {
	    		next_token = info.next_token;
	    		self.check(next, err, rows.length!=5 || !info.next_token, "err11:", rows, info);
	    	});
	    },
        function(next) {
            logger.log('TEST: next page: next_token=', next_token);
            db.select("test2", { id: id2, id2: '0' }, { ops: { id2: 'gt' }, start: next_token, count: 5, select: 'id,id2' }, function(err, rows, info) {
                next_token = info.next_token;
                var isok = rows.every(function(x) { return x.id2 > '0' });
                self.check(next, err, rows.length!=4 || !isok, "err12:", isok, rows, info);
            });
        },
	    function(next) {
	        logger.log('TEST: end page: next_token=', next_token);
	        next(next_token ? ("err13:" + util.inspect(next_token)) : 0);
	    },
        function(next) {
            logger.log('TEST: add more');
            db.add("test2", { id: id, id2: '2', email: id, alias: id, birthday: id, num: 2, num2: 1, mtime: now }, next);
        },
	    function(next) {
            logger.log('TEST: query with custom filter');
            db.select("test2", { id: id, num: 9 }, { keys: ['id','num'], ops: { num: 'ge' } }, function(err, rows, info) {
                self.check(next, err, rows.length==0 || rows[0].num!=9 , "err13:", rows, info);
            });
        },
        function(next) {
            logger.log('TEST: scan');
            db.select("test2", { num: 9 }, { keys: ['num'], ops: { num: 'ge' } }, function(err, rows, info) {
                self.check(next, err, rows.length==0 || rows[0].num!=9, "err14:", rows, info);
            });
        },
        function(next) {
            logger.log('TEST: sort');
            db.select("test2", { id: id, num: 0 }, { ops: { num: 'ge' }, sort: "num" }, function(err, rows, info) {
                self.check(next, err, rows.length==0 || rows[0].num!=2 , "err15:", rows, info);
            });
        },
	],
	function(err) {
		callback(err);
	});
}

tests.ldb = function(callback)
{
    var db = null, env;
    var type = core.getArg("-type", "lmdb");
    async.series([
        function(next) {
            if (type != "leveldb") return next();
            new bn.LevelDB(core.path.spool + "/ldb", { create_if_missing: true }, function(err) {
                db = this;
                next(err);
            });
        },
        function(next) {
            if (type != "lmdb") return next();
            env = new bn.LMDBEnv({ path: core.path.spool, dbs: 1 });
            next();
        },
        function(next) {
            if (type != "lmdb") return next();
            env = new bn.LMDB(env, { name: "lmdb", flags: bn.MDB_CREATE }, function(err) {
                db = this;
                next(err);
            });
        },
        function(next) {
            for (var i = 0; i < 100; i++) {
                db.put(String(i), String(i));
            }
            next();
        },
        function(next) {
            async.forEachSeries([100,101,102,103], function(i, next) {
                db.put(String(i), String(i), next);
            }, function(err) {
                next(err);
            });
        },
        function(next) {
            db.get("1", function(err, val) {
                next(err || val != "1" ? ("err1:" + err + util.inspect(val)) : 0);
            });
        },
        function(next) {
            db.all("100", "104", function(err, list) {
                next(err || list.length != 4 ? ("err2:" + err + util.inspect(list)) : 0);
            });
        },
        function(next) {
            db.incr("1", 1, function(err, val) {
                next(err);
            });
        },
        function(next) {
            db.get("1", function(err, val) {
                next(err || val != "2" ? ("err3:" + val) : 0);
            });
        },
    ],
    function(err) {
        callback(err);
    });
}

tests.ldbpool = function(callback)
{
    var type = core.getArg("-type", "lmdb");
    var pool;

    async.series([
        function(next) {
            if (type != "leveldb") return next();
            pool = db.leveldbInitPool({ db: "stats" });
            next(err);
        },
        function(next) {
            if (type != "lmdb") return next();
            pool = db.lmdbInitPool({ db: "stats", flags: backend.MDB_CREATE | backend.MDB_NOSYNC | backend.MDB_MAPASYNC, mapsize: 1024*1024*500 });
            next();
        },
        function(next) {
            db.put("stats", { name: "1", value: "1" }, { pool: type }, next);
        },
    ],
    function(err) {
        console.log(pool)
        callback(err);
    });
}

tests.nnpubsub = function(callback)
{
    if (cluster.isMaster) {
        var count = 0;
        var addr = "tcp://127.0.0.1:1234 tcp://127.0.0.1:1235";
        var sock = new bn.NNSocket(bn.AF_SP, bn.NN_SUB);
        sock.connect(addr);
        sock.subscribe("");
        sock.setCallback(function(err, data) {
            logger.log('subscribe:', err, this.socket, data, 'count:', count++);
            if (data == "exit") process.exit(0);
        });
    } else {
        var count = core.getArgInt("-count", 10);
        var addr = "tcp://127.0.0.1:" + (cluster.worker.id % 2 == 0 ? 1234 : 1235);
        var sock = new bn.NNSocket(bn.AF_SP, bn.NN_PUB);
        sock.bind(addr);

        async.whilst(
           function () { return count > 0; },
           function (next) {
               count--;
               sock.send(addr + ':' + core.random());
               logger.log('publish:', sock, addr, count);
               setTimeout(next, core.randomInt(1000));
           },
           function(err) {
               logger.log('sockets1:', bn.nnSockets())
               sock.send("exit");
               sock = null;
               logger.log('sockets2:', bn.nnSockets())
               callback(err);
           });
    }
}

tests.nncache = function(callback)
{
    var slave = core.getArgInt("-slave", 0);
    core.cacheHost = "127.0.0.1:20194,127.0.0.1:20197";

    if (cluster.isMaster) {
        if (!slave) {
            main = 1;
            var args = process.argv.slice(1).concat(["-cache-port", "20197", "-msg-port", "20198", "-slave", "1"]);
            var pid = execFile(process.argv[0], args, {}, function(err, stdout, stderr) {
                if (err) console.log(err);
                if (stderr) console.log(stderr);
                if (stdout) console.log(stdout);
                pid = null;
                if (!Object.keys(cluster.workers).length) process.exit(0);
            });
        }
        ipc.initServer();
        cluster.on('exit', function(worker, code, signal) {
            if (Object.keys(cluster.workers).length) return;
            if (slave) process.exit(0);
            if (!pid) process.exit(0);
        });
    } else {
        ipc.initClient();
        async.series([
           function(next) {
               logger.log("step 1");
               setTimeout(next, 1000);
           },
           function(next) {
               if (slave) return next();
               logger.log("set 1");
               db.put("bk_counter", { id: "1", ping: 1 }, { cached: 1 }, next);
           },
           function(next) {
               logger.log("step 2");
               setTimeout(next, 1000);
           },
           function(next) {
               db.getCached("bk_counter", { id: "1" }, { select: ["id", "ping"] }, function(err, row) {
                   logger.log("get ", row.ping);
                   next();
               });
           },
           function(next) {
               if (slave) return next();
               logger.log("set 2");
               db.put("bk_counter", { id: "1", ping: 2 }, { cached: 1 }, next);
           },
           function(next) {
               logger.log("step 3");
               setTimeout(next, 1000);
           }],
           function(err) {
                db.getCached("bk_counter", { id: "1" }, { select: ["id", "ping"] }, function(err, row) {
                    logger.log("end ", row.ping);
                    callback(err);
                });
        });
    }
}

tests.pubsub = function(callback)
{

}

tests.nndb = function(callback)
{
    var bind = core.getArg("-bind", "ipc://var/nndb.sock");
    var socket = core.getArg("-socket", "NN_PULL");
    var type = core.getArg("-type", "lmdb"), pool;

    if (cluster.isMaster) {
        switch (type) {
        case "leveldb":
            pool = db.leveldbInitPool({ db: "stats" });
            break;

        case "lmdb":
            pool = db.lmdbInitPool({ db: "stats" });
            break;

        default:
            logger.log("invalid type", type);
            process.exit(1);
        }
        db.query({ op: "server" }, { pool: type, bind: bind, socket: socket }, function(err) {
            if (err) logger.error(err);
        });

    } else {
        pool = db.nndbInitPool({ db: bind, socket: socket == "NN_REP" ? "NN_REQ" : "NN_PUSH" });
        async.series([
           function(next) {
               db.put("", { name: "1", value: 1 }, { pool: pool.name }, next);
           },
           function(next) {
               db.get("", "1", { pool: pool.name }, function(err, row) {
                   logger.log("get ", row);
                   next(err);
               });
           },
           function(next) {
               db.incr("", { name: "1", value: 2 }, { pool: pool.name }, next);
           },
           function(next) {
               db.get("", { name: "1" }, { pool: pool.name }, function(err, row) {
                   logger.log("get ", row);
                   next(err);
               });
           }],callback);
    }
}

tests.pool = function(callback)
{
    var options = { min: core.getArgInt("-min", 1),
                    max: core.getArgInt("-max", 5),
                    idle: core.getArgInt("-idle", 0),
                    create: function(cb) { cb(null,{ id:Date.now()}) }
    }
    var list = [];
    var pool = core.createPool(options)
    async.series([
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

backend.run(function() {
    tests.start(core.getArg("-cmd"));
});


