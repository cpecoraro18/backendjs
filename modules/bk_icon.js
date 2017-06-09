//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  Sep 2013
//

var path = require('path');
var util = require('util');
var fs = require('fs');
var url = require('url');
var qs = require('qs');
var http = require('http');
var bkjs = require('backendjs');
var db = bkjs.db;
var api = bkjs.api;
var app = bkjs.app;
var ipc = bkjs.ipc;
var msg = bkjs.msg;
var core = bkjs.core;
var lib = bkjs.lib;
var logger = bkjs.logger;

// Icons management
var mod = {
    name: "bk_icon",
    tables: {
        bk_icon: {
            id: { primary: 1 },                         // account id
            type: {                                     // prefix:type
                primary: 1,
                pub: 1,
                join: [ "prefix", "type" ],
                unjoin: 1,
                separator: ":",
                ops: { select: "begins_with" }
            },
            prefix: {},                                 // icon prefix/namespace
            acl_allow: {},                              // Who can see it: all, auth, id:id...
            ext: {},                                    // Saved image extension
            tags: { type: "list" },                     // detected or attached tags
            width: { type: "int" },
            height: { type: "int" },
            rotation: { type: "int" },                  // angle
            descr: {},
            geohash: {},                                // Location associated with the icon
            latitude: { type: "real" },
            longitude: { type: "real" },
            mtime: { type: "now" },                     // Last time added/updated
        },

        // Metrics
        bk_collect: {
            url_icon_get_rmean: { type: "real" },
            url_icon_get_hmean: { type: "real" },
            url_icon_get_0: { type: "real" },
            url_icon_get_bad_0: { type: "real" },
            url_icon_get_err_0: { type: "real" },
        },
    },
    limit: { "*": 0 },
    controls: {
        width: { type: "number" },
        height: { type: "number" },
        rotate: { type: "number" },
        quality: { type: "number" },
        brightness: { type: "number" },
        contrast: { type: "number" },
        bgcolor: { type: "string" },
    }
};
module.exports = mod;

// Initialize the module
mod.init = function(options)
{
    core.describeArgs("icons", [
         { name: "limit", type: "map", datatype: "int", descr: "Set the limit of how many icons by type can be uploaded by an account, type:N,type:N..., type * means global limit for any icon type" },
    ]);
}

mod.configureMiddleware = function(options, callback)
{
    api.registerControlParams(mod.controls);
    callback();
}

// Create API endpoints and routes
mod.configureWeb = function(options, callback)
{
    this.configureIconsAPI();
    callback()
}

// Generic icon management
mod.configureIconsAPI = function()
{
    api.app.all(/^\/icon\/([a-z]+)$/, function(req, res) {
        var options = api.getOptions(req);

        if (!req.query.prefix) return api.sendReply(res, 400, "prefix is required");
        if (!req.query.id) req.query.id = req.account.id;
        if (!req.query.type) req.query.type = "";
        switch (req.params[0]) {
        case "get":
            mod.getIcon(req, res, req.query.id, options);
            break;

        case "select":
            mod.selectIcon(req, options, function(err, rows) {
                api.sendJSON(req, err, rows);
            });
            break;

        case "upload":
            options.type = req.query.type;
            options.prefix = req.query.prefix;
            options.name = req.query.name;
            options.autodel = 1;
            api.putIcon(req, req.account.id, options, function(err, icon, info) {
                if (info) {
                    info.id = req.account.id;
                    info.prefix = req.query.prefix;
                    info.type = req.query.type;
                    info.url = api.iconUrl(info, options);
                }
                api.sendJSON(req, err, info);
            });
            break;

        case "del":
        case "put":
            options.op = req.params[0];
            mod.handleIconRequest(req, options, function(err, rows) {
                api.sendJSON(req, err, rows);
            });
            break;

        default:
            api.sendReply(res, 400, "Invalid command");
        }
    });

    db.setProcessRow("post", "bk_icon", api.checkIcon);

}

// Process icon request, put or del, update table and deal with the actual image data, always overwrite the icon file
// Verify icon limits before adding new icons
mod.handleIconRequest = function(req, options, callback)
{
    var op = options.op || "put";

    options.type = req.query.type || "";
    options.prefix = req.query.prefix || "account";
    if (!req.query.id) req.query.id = req.account.id;
    if (typeof options.autodel == "undefined") options.autodel = 1;

    // Max number of allowed icons per type or globally
    var limit = mod.limit[options.type] || mod.limit['*'];
    var icons = [], info;

    lib.series([
       function(next) {
           db.select("bk_icon", { id: req.query.id, type: options.prefix }, options, function(err, rows) {
               if (err) return next(err);
               switch (op) {
               case "put":
                   // We can override existing icon but not add a new one
                   if (limit > 0 && rows.length >= limit && !rows.some(function(x) { return x.type == options.type })) {
                       return next({ status: 403, message: "No more icons allowed" });
                   }
                   break;
               }
               icons = rows;
               next();
           });
       },

       function(next) {
           options.ops = {};
           req.query.type = options.type;
           req.query.prefix = options.prefix;
           if (options.ext) req.query.ext = options.ext;
           if (req.query.latitude && req.query.longitude) req.query.geohash = lib.geoHash(req.query.latitude, req.query.longitude);

           switch (op) {
           case "put":
               api.putIcon(req, options.name || "icon", req.query.id, options, function(err, icon, meta) {
                   if (err || !icon) return next(err || { status: 400, message: "Upload error" });
                   info = meta;
                   for (var p in info) req.query[p] = info[p];
                   // Add new icons to the list which will be returned back to the client
                   if (!icons.some(function(x) { return x.type == options.type })) {
                       req.query.url = api.iconUrl(req.query, options);
                       icons.push(req.query);
                   }
                   db.put("bk_icon", req.query, options, next);
               });
               break;

           case "del":
               db.del("bk_icon", req.query, options, function(err, rows) {
                   api.delIcon(req.query.id, options, function() {
                       icons = icons.filter(function(x) { return x.type != options.type });
                       next();
                   });
               });
               break;

           default:
               next({ status: 400, message: "invalid op" });
           }
       }], function(err) {
           lib.tryCall(callback, err, icons, info);
    });
}

// Return list of icons for the account, used in /icon/get API call
mod.selectIcon = function(req, options, callback)
{
    db.select("bk_icon", { id: req.query.id, type: req.query.type, prefix: req.query.prefix }, options, callback);
}

// Return icon to the client, checks the bk_icon table for existence and permissions
mod.getIcon = function(req, res, id, options)
{
    db.get("bk_icon", { id: id, type: req.query.type, prefix: req.query.prefix }, options, function(err, row) {
        if (err) return api.sendReply(res, err);
        if (!row) return api.sendReply(res, 404, "Not found or not allowed");
        if (row.ext) options.ext = row.ext;
        options.prefix = req.query.prefix;
        options.type = req.query.type;
        api.sendIcon(req, id, options);
    });
}

mod.bkDeleteAccount  = function(req, callback)
{
    if (req.options.keep_all || req.options.keep_icon) return callback();
    db.delAll("bk_icon", { id: req.account.id }, { delCollect: 1 }, function(err, rows) {
        if (req.options.keep_images) return callback();
        // Delete all image files
        lib.forEachSeries(rows, function(row, next) {
            api.delIcon(req.account.id, row, function() { next() });
        }, callback);
    });
}
