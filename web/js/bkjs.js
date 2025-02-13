/*!
 *  backend.js client
 *  Vlad Seryakov vseryakov@gmail.com 2018
 */

var bkjs = {

    // True if current credentials are good
    loggedIn: false,

    // Support sessions by storing wildcard signature in the cookies
    session: 1,

    // Signature header name and version
    hver: 4,
    hsig: "bk-signature",
    htz: "bk-tz",
    hcsrf: "bk-csrf",

    // HTTP headers to be sent with every request
    headers: {},

    // For urls without host this will be used to make a full absolute URL, can be used for CORS
    locationUrl: "",

    // Current account record
    account: {},

    // Websockets
    wsconf: {
        host: null,
        port: 0,
        path: "/",
        query: null,
        max_timeout: 30000,
        retry_timeout: 500,
        retry_mod: 2,
        max_retries: 100,
        retries: 0,
        pending: [],
    },

    // i18n locales by 2-letter code, uses account.lang to resolve the translation
    locales: {},
};

// Try to authenticate with the supplied credentials, it uses login and secret to sign the request, if not specified it uses
// already saved credentials. if url is passed then it sends data in POST request to the specified url without any signature.
bkjs.login = function(options, callback)
{
    if (typeof options == "function") callback = options, options = {};
    options = this.objClone(options, "jsonType", "obj", "type", "POST");
    if (!options.data) options.data = {};
    if (!options.url) options.url = "/auth";
    options.data._session = this.session;

    this.send(options, (data) => {
        bkjs.loggedIn = true;
        for (const p in data) bkjs.account[p] = data[p];
        // Clear credentials from the memory if we use sessions
        if (typeof callback == "function") callback.call(options.self || bkjs);
    }, (err, xhr) => {
        bkjs.loggedIn = false;
        for (const p in bkjs.account) delete bkjs.account[p];
        if (typeof callback == "function") callback.call(options.self || bkjs, err, null, xhr);
    });
}

// Logout and clear all cookies and local credentials
bkjs.logout = function(options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    options = this.objClone(options, "jsonType", "obj", "type", "POST");
    if (!options.url) options.url = "/logout";
    this.loggedIn = false;
    for (const p in bkjs.account) delete bkjs.account[p];
    this.sendRequest(options, (err, data, xhr) => {
        if (typeof callback == "function") callback.call(options.self || bkjs, err, data, xhr);
    });
}

// Send signed AJAX request using jQuery, call callbacks onsuccess or onerror on successful or error response accordingly.
// - options can be a string with url or an object with options.url, options.data and options.type properties,
// - for POST set options.type to POST and provide options.data
//
// If options.nosignature is given the request is sent as is, no credentials and signature will be used.
bkjs.send = function(options, onsuccess, onerror)
{
    if (typeof options == "string") options = { url: options };

    if (!options.headers) options.headers = {};
    if (!options.type) options.type = 'POST';
    if (!options.dataType) options.dataType = 'json';
    if (this.locationUrl && !/^https?:/.test(options.url)) options.url = this.locationUrl + options.url;

    // Success callback but if it throws exception we call error handler instead
    options.success = function(json, statusText, xhr) {
        var h = xhr.getResponseHeader(bkjs.hcsrf);
        if (h) bkjs.headers[bkjs.hcsrf] = h;
        $(bkjs).trigger("bkjs.loading", "hide");
        // Make sure json is of type we requested
        switch (options.jsonType) {
        case 'list':
            if (!json || !Array.isArray(json)) json = [];
            break;

        case 'object':
            if (!json || typeof json != "object") json = {};
            break;
        }

        if (options.info_msg || options.success_msg) {
            $(bkjs).trigger("bkjs.alert", [options.info_msg ? "info" : "success", options.info_msg || options.success_msg]);
        }
        if (typeof onsuccess == "function") onsuccess.call(options.self || bkjs, json, xhr);
        if (options.trigger) bkjs.trigger(options.trigger, { url: options.url, query: options.data, data: json });
    }
    // Parse error message
    options.error = function(xhr, statusText, errorText) {
        var h = xhr.getResponseHeader(bkjs.hcsrf);
        if (h) bkjs.headers[bkjs.hcsrf] = h;
        $(bkjs).trigger("bkjs.loading", "hide");
        var err = xhr.responseText;
        try { err = JSON.parse(xhr.responseText) } catch (e) {}
        if (!options.quiet) bkjs.log('send:', xhr.status, err, statusText, errorText, options);
        if (options.alert) {
            $(bkjs).trigger("bkjs.alert", ["error", (typeof options.alert == "string" && options.alert) || err || errorText || statusText]);
        }
        if (typeof onerror == "function") onerror.call(options.self || bkjs, err || errorText || statusText, xhr, statusText, errorText);
        if (options.trigger) bkjs.trigger(options.trigger, { url: options.url, query: options.data, err: err });
    }

    options.headers[this.htz] = (new Date()).getTimezoneOffset();
    if (options.login && options.secret) options.headers[this.hsig] = this.createSignature(options);
    for (const p in this.headers) if (typeof options.headers[p] == "undefined") options.headers[p] = this.headers[p];
    for (const p in options.data) if (typeof options.data[p] == "undefined") delete options.data[p];
    $(bkjs).trigger("bkjs.loading", "show");
    return $.ajax(options);
}

bkjs.get = function(options, callback)
{
    bkjs.sendRequest($.extend(options, { type: "GET" }), callback);
}

// Make a request and use single callback with error as the first argument or null if no error
bkjs.sendRequest = function(options, callback)
{
    return bkjs.send(options, (data, xhr) => {
        if (typeof callback == "function") callback.call(options.self || bkjs, null, data, xhr);
    }, (err, xhr) => {
        var data = options.jsonType == "list" ? [] : options.jsonType == "obj" ? {} : null;
        if (typeof callback == "function") callback.call(options.self || bkjs, err, data, xhr);
    });
}

// Send a file as multi-part upload, uses `options.name` or "data" for file namne. Additional files can be passed in the `options.files` object. Optional form inputs
// can be specified in the `options.data` object.
bkjs.sendFile = function(options, callback)
{
    var n = 0, form = new FormData(), files = {};
    if (options.file) files[options.name || "data"] = options.file;
    for (const p in options.files) files[p] = options.files[p];
    for (const p in files) {
        var f = this.getFileInput(files[p]);
        if (!f) continue;
        form.append(p, f);
        n++;
    }
    if (!n) return callback && callback.call(options.self || bkjs);

    for (const p in options.data) {
        switch (typeof options.data[p]) {
        case "undefined":
            break;
        case "object":
            for (const k in options.data[p]) {
                if (options.data[p][k] !== undefined) form.append(`${p}[${k}]`, options.data[p][k]);
            }
            break;
        default:
            form.append(p, options.data[p]);
        }
    }
    // Send within the session, multipart is not supported by signature
    var rc = { url: options.url, type: "POST", processData: false, data: form, contentType: false, nosignature: true };
    for (const p in options) if (typeof rc[p] == "undefined") rc[p] = options[p];
    this.sendRequest(rc, callback);
}

// Return a file object for the selector
bkjs.getFileInput = function(file)
{
    if (typeof file == "string") file = $(file);
    if (file instanceof jQuery && file.length) file = file[0];
    if (typeof file == "object") {
        if (file.files && file.files.length) return file.files[0];
        if (file.name && file.size && (file.type || file.lastModified)) return file;
    }
    return "";
}

// WebSockets helper functions
bkjs.wsConnect = function(options)
{
    var conf = bkjs.wsconf;
    if (conf.timer) {
        clearTimeout(conf.timer);
        delete conf.timer;
    }
    if (conf.bye) return;

    for (const p in options) conf[p] = options[p];
    var url = (conf.protocol || window.location.protocol.replace("http", "ws")) + "//" +
              (conf.host || (conf.hostname ? conf.hostname + "." + this.domainName(window.location.hostname) : "") || window.location.hostname) + ":" +
              (conf.port || window.location.port) +
              conf.path +
              (conf.query ? "?" + jQuery.param(conf.query) : "");

    this.ws = new WebSocket(url);
    this.ws.onopen = function() {
        if (conf.debug) bkjs.log("ws.open:", this.url);
        conf.ctime = Date.now();
        conf.timeout = bkjs.wsconf.retry_timeout;
        conf.retries = 0;
        while (conf.pending.length) {
            bkjs.wsSend(conf.pending.shift());
        }
        $(bkjs).trigger("bkjs.ws.opened");
    }
    this.ws.onerror = function(err) {
        if (conf.debug) bkjs.log('ws.error:', this.url, err);
    }
    this.ws.onclose = function() {
        if (conf.debug) bkjs.log("ws.closed:", this.url, bkjs.wsconf.timeout);
        bkjs.ws = null;
        if (!conf.bye && ++conf.retries < conf.max_retries) {
            conf.timer = setTimeout(bkjs.wsConnect.bind(bkjs), conf.timeout);
            conf.timeout *= conf.timeout == conf.max_timeout ? 0 : conf.retry_mod;
            conf.timeout = bkjs.toClamp(conf.timeout, conf.retry_timeout, conf.max_timeout);
        }
        $(bkjs).trigger("bkjs.ws.closed");
    }
    this.ws.onmessage = function(msg) {
        var data = msg.data;
        if (data === "bye") bkjs.wsClose(1);
        if (typeof data == "string" && (data[0] == "{" || data[0] == "[")) data = JSON.parse(data);
        if (bkjs.wsconf.debug) bkjs.log('ws.message:', data);
        $(bkjs).trigger("bkjs.ws.message", data);
    }
}

bkjs.wsClose = function(bye)
{
    this.wsconf.bye = 1;
    if (this.ws) this.ws.close();
}

// Send a string data or an object in jQuery ajax format { url:.., data:.. } or as an object to be stringified
bkjs.wsSend = function(data)
{
    if (this.ws?.readyState != WebSocket.OPEN) {
        this.wsconf.pending.push(data);
        return;
    }
    if (typeof data == "object" && data) {
        if (data.url && data.url[0] == "/") {
            data = data.url + (data.data ? "?" + $.param(data.data) : "");
        } else {
            data = JSON.stringified(data);
        }
    }
    this.ws.send(data);
}

bkjs.domainName = function(host)
{
    if (typeof host != "string" || !host) return "";
    var name = host.split('.');
    return (name.length > 2 ? name.slice(1).join('.') : host).toLowerCase();
}

// Return value of the query parameter by name
bkjs.param = function(name, dflt, num)
{
    var d = location.search.match(new RegExp(name + "=(.*?)($|&)", "i"));
    d = d ? decodeURIComponent(d[1]) : (dflt || "");
    if (num) {
        d = parseInt(d);
        if (isNaN(d)) d = 0;
    }
    return d;
}

// Percent encode with special symbols in addition
bkjs.encode = function(str)
{
    if (typeof str == "undefined") return "";
    return encodeURIComponent(str).replace(/[!'()*]/g, function(m) {
        return m == '!' ? '%21' : m == "'" ? '%27' : m == '(' ? '%28' : m == ')' ? '%29' : m == '*' ? '%2A' : m;
    });
}

// Return a cookie value by name
bkjs.cookie = function(name)
{
    if (!document.cookie) return "";
    var cookies = document.cookie.split(';');
    for (var i = 0; i < cookies.length; i++) {
        var cookie = cookies[i].trim();
        if (cookie.substr(0, name.length) == name && cookie[name.length] == '=') {
            return decodeURIComponent(cookie.substr(name.length + 1));
        }
    }
    return "";
}

// Create a signature for the request, the url can be an absolute url or just a path, query can be a form data, an object or a string with already
// encoded parameters, if not given the parameters in the url will be used.
bkjs.createSignature = function(options)
{
    var url = options.url || "", query = options.data;
    var host = window.location.hostname.toLowerCase();
    if (url.indexOf('://') > -1) {
        var u = url.split('/');
        host = (u[2] || "").split(":")[0].toLowerCase();
        url = '/' + u.slice(3).join('/');
    }
    var now = Date.now();
    var tag = options.tag || "";
    var checksum = options.checksum || "";
    var expires = options.expires || 0;
    if (!expires || typeof expires != "number") expires = now + 60000;
    if (expires < now) expires += now;
    var ctype = String(options.contentType || "").toLowerCase();
    if (!ctype && options.type == "POST") ctype = "application/x-www-form-urlencoded; charset=utf-8";
    var q = url.split("?");
    url = q[0];
    if (url[0] != "/") url = "/" + url;
    if (!query) query = q[1] || "";
    if (query instanceof FormData) query = "";
    if (typeof query == "object") query = jQuery.param(query);
    query = query.split("&").sort().filter(function(x) { return x != ""; }).join("&");
    var str = this.hver + "\n" + tag + "\n" + options.login + "\n" + options.type + "\n" + host + "\n" + url + "\n" + query + "\n" + expires + "\n" + ctype + "\n" + checksum + "\n";
    var hmac = this.crypto.hmacSha256(options.secret, str, "base64");
    if (this.debug) this.log('sign:', str);
    return this.hver + '|' + tag + '|' + options.login + '|' + hmac + '|' + expires + '|' + checksum + '|';
}

// Simple debugging function that outputs arguments in the error console each argument on a separate line
bkjs.log = function()
{
    if (console?.log) console.log.apply(console, arguments);
}

$(function() {
    var h = $(`meta[name="${bkjs.hcsrf}"]`).attr('content');
    if (h) bkjs.headers[bkjs.hcsrf] = h;
});


