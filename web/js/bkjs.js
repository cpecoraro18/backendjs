/*!
 *  backend.js client
 *  Vlad Seryakov vseryakov@gmail.com 2018
 */

var bkjs = {

    // True if current credentials are good
    loggedIn: false,

    // Support sessions by storing wildcard signature in the cookies
    session: 1,

    // Save credentials in the local storage, by default keep only in memory
    persistent: false,

    // Scramble the secret, use HMAC for the secret instead of the actual value, a user still
    // needs to enter the real values but the browser will never store them, only hashes.
    // The value is: 0 - no scramble, 1 - scramble secret as HMAC_SHA256(secret, login)
    scramble: 1,

    // Signature header name and version
    signatureVersion: 4,
    signatureName: "bk-signature",
    accessTokenName: "bk-access-token",
    tzHeaderName: "bk-tz",
    langHeaderName: "bk-lang",
    appHeaderName: "bk-app",
    versionHeaderName: "bk-version",
    // HTTP headers to be sent with every request
    headers: {},

    // For urls without host this will be used to make a full absolute URL, can be used for CORS
    locationUrl: "",

    // Current account record
    account: {},

    // Websockets
    wsconf: { host: null, port: 8000, errors: 0 },

    // Secret policy for plain text passwords
    passwordPolicy: {
        '[a-z]+': 'requires at least one lower case letter',
        '[A-Z]+': 'requires at least one upper case letter',
        '[0-9]+': 'requires at least one digit',
        '.{8,}': 'requires at least 8 characters',
    },
    // Trim these symbols from login/secret, all whitespace is default
    trimCredentials: " \"\r\n\t\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000\u008D\u009F\u0080\u0090\u009B\u0010\u0009\u0000\u0003\u0004\u0017\u0019\u0011\u0012\u0013\u0014\u2028\u2029\u2060\u202C",

    // i18n locales by 2-letter code, uses account.lang to resolve the translation
    locales: {},
};

var Bkjs = bkjs;

// Try to authenticate with the supplied credentials, it uses login and secret to sign the request, if not specified it uses
// already saved credentials
bkjs.login = function(options, callback)
{
    if (typeof options == "function") callback = options, options = null;
    if (options && typeof options.login =="string" && typeof options.secret == "string") this.setCredentials(options);

    this.send({ url: "/auth?_session=" + this.session, jsonType: "obj" }, function(data) {
        bkjs.loggedIn = true;
        for (var p in data) bkjs.account[p] = data[p];
        // Clear credentials from the memory if we use sessions
        if (bkjs.session) bkjs.setCredentials();
        if (typeof callback == "function") callback();
    }, function(err, xhr) {
        bkjs.loggedIn = false;
        for (var p in bkjs.account) delete bkjs.account[p];
        bkjs.setCredentials();
        if (typeof callback == "function") callback(err, null, xhr);
    });
}

// Logout and clear all cookies and local credentials
bkjs.logout = function(callback)
{
    this.loggedIn = false;
    for (var p in bkjs.account) delete bkjs.account[p];
    this.sendRequest("/logout", function(err, data, xhr) {
        bkjs.setCredentials();
        if (typeof callback == "function") callback(err, data, xhr);
    });
}

// Create a signature for the request, the url can be an absolute url or just a path, query can be a form data, an object or a string with already
// encoded parameters, if not given the parameters in the url will be used.
// Returns an object with HTTP headers to be sent to the server with the request.
bkjs.createSignature = function(method, url, query, options)
{
    var rc = {};
    var creds = this.getCredentials();
    if (!creds.login || !creds.secret) return rc;
    var now = Date.now(), str, hmac;
    var host = window.location.hostname.toLowerCase();
    if (url.indexOf('://') > -1) {
        var u = url.split('/');
        host = (u[2] || "").split(":")[0].toLowerCase();
        url = '/' + u.slice(3).join('/');
    }
    if (!options) options = {};
    if (!method) method = "GET";
    var tag = options.tag || "";
    var checksum = options.checksum || "";
    var expires = options.expires || 0;
    if (!expires || typeof expires != "number") expires = now + 60000;
    if (expires < now) expires += now;
    var ctype = String(options.contentType || "").toLowerCase();
    if (!ctype && method == "POST") ctype = "application/x-www-form-urlencoded; charset=utf-8";
    var q = String(url || "/").split("?");
    url = q[0];
    if (url[0] != "/") url = "/" + url;
    if (!query) query = q[1] || "";
    if (query instanceof FormData) query = "";
    if (typeof query == "object") query = jQuery.param(query);
    query = query.split("&").sort().filter(function(x) { return x != ""; }).join("&");
    switch (this.signatureVersion) {
    case 1:
        str = method + "\n" + host + "\n" + url + "\n" + query + "\n" + expires + "\n" + ctype + "\n" + checksum + "\n";
        hmac = b64_hmac_sha1(creds.secret, str);
        break;
    case 2:
    case 3:
        str = this.signatureVersion + '\n' + tag + '\n' + creds.login + "\n*\n" + this.domainName(host) + "\n/\n*\n" + expires + "\n*\n*\n";
        hmac = b64_hmac_sha1(creds.secret, str);
        break;
    default:
        str = this.signatureVersion + "\n" + tag + "\n" + creds.login + "\n" + method + "\n" + host + "\n" + url + "\n" + query + "\n" + expires + "\n" + ctype + "\n" + checksum + "\n";
        hmac = b64_hmac_sha256(creds.secret, str);
    }
    rc[this.signatureName] = this.signatureVersion + '|' + tag + '|' + creds.login + '|' + hmac + '|' + expires + '|' + checksum + '|';
    if (this.debug) this.log('sign:', creds, str);
    return rc;
}

// Produce signed URL to be used in embeded cases or with expiration so the url can be passed and be valid for longer time.
bkjs.signUrl = function(url, expires)
{
    var hdrs = this.createSignature("GET", url, "", { expires: expires });
    if (!hdrs[this.signatureName]) return url;
    return url + (url.indexOf("?") == -1 ? "?" : "") + "&" + this.signatureName + "=" + encodeURIComponent(hdrs[this.signatureName]);
}

// Return current credentials
bkjs.getCredentials = function()
{
    var obj = this.persistent ? localStorage : this;
    return { login: obj.bkjsLogin || "", secret: obj.bkjsSecret || "" };
}

// Process credentials, cleanup, scramble... and return as an object
bkjs.checkCredentials = function(options)
{
    var rc = {
        scramble: options && options.scramble || this.scramble,
        login: options && options.login ? String(options.login) : "",
        secret: options && options.secret ? String(options.secret) : "",
    };
    if (this.trimCredentials) {
        if (!this._trimC) this._trimC = new RegExp("(^[" + this.trimCredentials + "]+)|([" + this.trimCredentials + "]+$)", "gi");
        rc.login = rc.login.replace(this._trimC, "");
        rc.secret = rc.secret.replace(this._trimC, "");
    }
    if (rc.login && rc.secret) this.scrambleCredentials(rc);
    return rc;
}

// Scramble credentials if needed
bkjs.scrambleCredentials = function(options)
{
    if (options.scramble) options.secret = b64_hmac_sha256(options.secret, options.login);
}

// Set new credentials, save in memory or local storage
bkjs.setCredentials = function(options)
{
    var obj = this.persistent ? localStorage : this;
    var creds = this.checkCredentials(options);
    obj.bkjsLogin = creds.login;
    obj.bkjsSecret = creds.secret;
    if (this.debug) this.log('setCredentials:', creds, options);
}

// Verify account secret against the policy
bkjs.checkPassword = function(secret)
{
    secret = secret || "";
    for (var p in this.passwordPolicy) {
        if (!secret.match(p)) {
            return {
                status: 400,
                message: this.__(this.passwordPolicy[p]),
                policy: Object.keys(this.passwordPolicy).map(function(x) {
                    return bkjs.__(bkjs.passwordPolicy[x])
                }).join(", ")
            };
        }
    }
    return "";
}

// Retrieve current account record, call the callback with the object or error
bkjs.getAccount = function(callback)
{
    this.sendRequest({ url: "/account/get", jsonType: "obj" }, function(err, data, xhr) {
        for (var p in data) bkjs.account[p] = data[p];
        if (typeof callback == "function") callback(err, data, xhr);
    });
}

// Register new account record, call the callback with the object or error
bkjs.addAccount = function(obj, callback)
{
    // Replace the actual credentials from the storage in case of scrambling in the client
    if (!obj._scramble) {
        var creds = this.checkCredentials(obj.login, obj.secret);
        obj.login = creds.login;
        obj.secret = creds.secret;
    }
    delete obj.secret2;
    this.sendRequest({ type: "POST", url: "/account/add", data: obj, jsonType: "obj", nosignature: 1 }, callback);
}

// Update current account
bkjs.updateAccount = function(obj, callback)
{
    // Scramble here if we did not ask the server to do it with _scramble option
    if (obj.secret && !obj._scramble) {
        var creds = this.checkCredentials(obj.login || this.account.login, obj.secret);
        obj.login = creds.login;
        obj.secret = creds.secret;
    }
    delete obj.secret2;
    this.sendRequest({ url: '/account/update', data: obj, type: "POST", jsonType: "obj" }, callback);
}

// Return true if the account contains the given type
bkjs.checkAccountType = function(account, type)
{
    if (!account || !account.type) return false;
    account._types = Array.isArray(account._types) ? account._types : String(account.type).split(",").map(function(x) { return x.trim() });
    if (Array.isArray(type)) return type.some(function(x) { return account._types.indexOf(x) > -1 });
    return account._types.indexOf(type) > -1;
}

// Wait for events and call the callback, this runs until Backend.unsubscribe is set to true
bkjs.subscribeAccount = function(callback)
{
    var errors = 0;
    (function poll() {
        bkjs.send({ url: "/account/subscribe", complete: bkjs.unsubscribe ? null : poll }, function(data, xhr) {
            callback(data, xhr);
        }, function(err) {
            if (errors++ > 3) bkjs.unsubscribe = true;
        });
    })();
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
    if (!options.dataType) options.dataType = 'json';
    if (this.locationUrl && !options.url.match(/^https?:/)) options.url = this.locationUrl + options.url;

    // Success callback but if it throws exception we call error handler instead
    options.success = function(json, statusText, xhr) {
        bkjs.loading("hide");
        // Make sure json is of type we requested
        switch (options.jsonType) {
        case 'list':
            if (!json || !Array.isArray(json)) json = [];
            break;

        case 'object':
            if (!json || typeof json != "object") json = {};
            break;
        }
        if (typeof onsuccess == "function") onsuccess(json, xhr);
    }
    // Parse error message
    options.error = function(xhr, statusText, errorText) {
        bkjs.loading("hide");
        var err = xhr.responseText;
        try { err = JSON.parse(xhr.responseText) } catch(e) {}
        bkjs.log('send:', xhr.status, err, statusText, errorText, options);
        if (typeof onerror == "function") onerror(err || errorText || statusText, xhr, statusText, errorText);
    }
    if (!options.nosignature) {
        var hdrs = this.createSignature(options.type, options.url, options.data, { expires: options.expires, checksum: options.checksum });
        for (var p in hdrs) options.headers[p] = hdrs[p];
        // Optional timezone offset for ptoper datetime related operations
        options.headers[this.tzHeaderName] = (new Date()).getTimezoneOffset();
        if (this.language) options.headers[this.langHeaderName] = this.language;
    }
    for (var h in this.headers) options.headers[h] = this.headers[h];
    for (var p in options.data) if (typeof options.data[p] == "undefined") delete options.data[p];
    this.loading("show");
    $.ajax(options);
}

// Make a request and use single callback with error as the first argument or null if no error
bkjs.sendRequest = function(options, callback)
{
    this.send(options, function(data, xhr) {
        if (typeof callback == "function") callback(null, data, xhr);
    }, function(err, xhr) {
        var data = options.jsonType == "list" ? [] : options.jsonType == "obj" ? {} : null;
        if (typeof callback == "function") callback(err, data, xhr);
    });
}

// Send a file as multi-part upload, uses `options.name` or "data" for file namne. Additional files can be passed in the `options.files` object. Optional form inputs
// can be specified in the `options.data` object.
bkjs.sendFile = function(options, callback)
{
    var n = 0, form = new FormData(), files = {};
    if (options.file) files[options.name || "data"] = options.file;
    for (var p in options.files) files[p] = options.files[p];
    for (var p in files) {
        var f = this.getFileInput(files[p]);
        if (!f) continue;
        form.append(p, f);
        n++;
    }
    if (!n) return callback && callback();

    for (var p in options.data) {
        if (typeof options.data[p] != "undefined") form.append(p, options.data[p])
    }
    // Send within the session, multipart is not supported by signature
    var rc = { url: options.url, type: "POST", processData: false, data: form, contentType: false, nosignature: true };
    this.sendRequest(rc, callback);
}

// Return a file object for the selector
bkjs.getFileInput = function(file)
{
    if (typeof file == "string") file = $(file);
    if (file instanceof jQuery && file.length) file = file[0];
    if (typeof file == "object") {
        if (file.files && file.files.length) return file.files[0];
        if (file.name && file.size) return file;
    }
    return "";
}

// WebSockets helper functions
bkjs.wsConnect = function(url, options, onmessage, onerror)
{
    if (typeof options == "function") onmessage = options, onerror = onmessage, options = {};
    if (!url) url = "ws://" + (this.wsconf.host || window.location.hostname) + ":" + this.wsconf.port;
    this.wsconf.errors = 0;
    this.ws = new WebSocket(url);
    this.ws.onopen = function() {
        bkjs.ws.onmessage = function(msg) { if (onmessage) return onmessage(msg.data); console.log('ws:', msg) };
    }
    this.ws.onerror = function(err) {
        bkjs.log('ws:', bkjs.wsconf.errors++, err);
        if (typeof onerror == "function") onerror(err);
    }
    this.ws.onclose = function() { bkjs.ws = null; }
}

bkjs.wsClose = function()
{
    if (!this.ws) return;
    this.ws.close();
}

bkjs.wsSend = function(url)
{
    if (this.ws) this.ws.send(this.signUrl(url));
}

// Show/hide loading animation
bkjs.loading = function(op)
{
    var img = $(this.loadingElement || '.loading');
    if (!img.length) return;

    if (!this._loading) this._loading = { count: 0 };
    var state = this._loading;
    switch (op) {
    case "hide":
        if (--state.count > 0) break;
        state.count = 0;
        if (state.display == "none") img.hide(); else img.css("visibility", "hidden");
        break;

    case "show":
        if (state.count++ > 0) break;
        if (!state.display) state.display = img.css("display");
        if (state.display == "none") img.show(); else img.css("visibility", "visible");
        break;
    }
}


