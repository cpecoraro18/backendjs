/*!
 * Modified by vlad
 *
 * Popup dialog boxes for Bootstrap - http://www.bootpopup.tk
 * Copyright (C) 2016  rigon<ricardompgoncalves@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


var INPUT_SHORTCUT_TYPES = [ "text", "color", "url", "password", "hidden", "file", "number", "email", "reset", "date", "checkbox", "radio" ];


function bootpopup(options)
{
    // Create a new instance if this is not
    if (!(this instanceof bootpopup)) return new bootpopup(Array.prototype.slice.call(arguments));

    var self = this;
    // Create a global random ID for the form
    this.formid = "bootpopup-form" + String(Math.random()).substr(2);

    this.options = {
        id: "",
        self: self,
        title: document.title,
        show_close: true,
        show_header: true,
        show_footer: true,
        size: "normal",
        size_label: "col-sm-4",
        size_input: "col-sm-8",
        content: [],
        footer: [],
        onsubmit: "close",
        buttons: ["close"],
        class_modal: "modal fade",
        class_dialog: "modal-dialog",
        class_title: "modal-title",
        class_content: "modal-content",
        class_body: "modal-body",
        class_header: "modal-header",
        class_footer: "modal-footer",
        class_group: "form-group",
        class_options: "options text-center text-md-right",
        class_alert: "alert alert-danger collapse",
        class_x: "",
        class_form: "",
        class_label: "",
        class_ok: "btn btn-primary",
        class_yes: "btn btn-primary",
        class_no: "btn btn-primary",
        class_agree: "btn btn-primary",
        class_cancel: "btn btn-default btn-secondary",
        class_close: "btn btn-primary",
        class_button1: "btn btn-primary",
        class_button2: "btn btn-primary",
        text_ok: "OK",
        text_yes: "Yes",
        text_no: "No",
        text_agree: "Agree",
        text_cancel: "Cancel",
        text_close: "Close",
        text_button1: "",
        text_button2: "",
        icon_ok: "",
        icon_yes: "",
        icon_no: "",
        icon_cancel: "",
        icon_close: "",
        icon_agree: "",
        icon_button1: "",
        icon_button2: "",
        center: false,
        scroll: false,
        horizontal: true,
        alert: false,
        data: "",

        before: function() {},
        dismiss: function() {},
        close: function() {},
        ok: function() {},
        cancel: function() {},
        yes: function() {},
        no: function() {},
        agree: function() {},
        button1: function() {},
        button2: function() {},
        show: function() {},
        shown: function() {},
        complete: function() {},
        submit: function(e) {
            self.callback(self.options.onsubmit, e);
            return false;    // Cancel form submision
        }
    }

    this.addOptions = function(options) {
        if (Array.isArray(options)) {
            options = options.reduce(function(x, y) {
                for (var p in y) x[p] = y[p];
                return x;
            }, {});
        }
        for (var key in options) {
            if (key in this.options) this.options[key] = options[key];
        }
        // Determine what is the best action if none is given
        if (typeof options.onsubmit !== "string") {
            if (this.options.buttons.indexOf("close") > 0) this.options.onsubmit = "close"; else
            if (this.options.buttons.indexOf("ok") > 0) this.options.onsubmit = "ok"; else
            if (this.options.buttons.indexOf("yes") > 0) this.options.onsubmit = "yes";
        }
        return this.options;
    }

    this.create = function() {
        var bs4 = window.bootstrap;
        // Option for modal dialog size
        var class_dialog = this.options.class_dialog;
        if (this.options.size == "xlarge") class_dialog += " modal-xl";
        if (this.options.size == "large") class_dialog += " modal-lg";
        if (this.options.size == "small") class_dialog += " modal-sm";
        if (this.options.center) class_dialog += " modal-dialog-centered";
        if (this.options.scroll) class_dialog += " modal-dialog-scrollable";

        // Create HTML elements for modal dialog
        this.modal = $('<div></div>', { class: this.options.class_modal, id: this.options.id || "", tabindex: "-1", role: "dialog", "aria-labelledby": "bootpopup-title", "aria-hidden": true });
        this.dialog = $('<div></div>', { class: class_dialog, role: "document" });
        this.content = $('<div></div>', { class: this.options.class_content });
        this.dialog.append(this.content);
        this.modal.append(this.dialog);

        // Header
        if (this.options.show_header && this.options.title) {
            this.header = $('<div></div>', { class: this.options.class_header });
            var title = $('<h5></h5>', { class: this.options.class_title, id: "bootpopup-title" });
            title.append(this.options.title);
            this.header.append(title);

            if (this.options.show_close) {
                var close = $('<button type="button" class="close" data-dismiss="modal" aria-label="Close"></button>');
                $('<span></span>', { class: this.options.class_x, "aria-hidden": "true" }).append("&times;").appendTo(close);
                if (bs4) this.header.append(close); else close.insertBefore(title);
            }
            this.content.append(this.header);
        }

        // Body
        var class_form = this.options.class_form;
        if (!class_form && this.options.horizontal) class_form = "form-horizontal";
        this.body = $('<div></div>', { class: this.options.class_body });
        this.form = $("<form></form>", { id: this.formid, class: class_form, role: "form", submit: function(e) { return self.options.submit(e); } });
        this.body.append(this.form);
        this.content.append(this.body);

        if (this.options.data) {
            this.form.data("form-data", this.options.data);
        }
        if (this.options.alert) {
            this.alert = $("<div></div>", { class: this.options.class_alert }).appendTo(this.form);
        }

        // Iterate over entries
        for (var c in this.options.content) {
            var entry = this.options.content[c];
            switch(typeof entry) {
                case "string":
                    // HTML string
                    this.form.append(entry);
                    break;

                case "object":
                    for (var type in entry) {
                        var opts = {}, children = [], attrs = {}, label, elem = null, group = null, title;

                        if (typeof entry[type] == "string") {
                            opts.label = entry[type];
                        } else {
                            for (var p in entry[type]) opts[p] = entry[type][p];
                        }
                        for (var p in opts) {
                            if (!/^(attrs_|click_|list_|class_|text_|icon_|size_|label|for)/.test(p)) attrs[p] = opts[p];
                        }

                        // Convert functions to string to be used as callback
                        for (var attribute in attrs) {
                            if (typeof attrs[attribute] === "function") {
                                attrs[attribute] = "return (" + attrs[attribute] + ")(this)";
                            }
                        }

                        // Check if type is a shortcut for input
                        if (INPUT_SHORTCUT_TYPES.indexOf(type) >= 0) {
                            attrs.type = type;  // Add attribute for type
                            type = "input";     // Continue to input
                        }

                        switch (type) {
                        case "input":
                        case "textarea":
                        case "button":
                        case "submit":
                            attrs.type = (typeof attrs.type === "undefined" ? "text" : attrs.type);

                        case "select":
                            // Create a random id for the input if none provided
                            attrs.id = (typeof attrs.id === "undefined" ? "bootpopup-input" + String(Math.random()).substr(2) : attrs.id);

                            if (type == "select" && Array.isArray(attrs.options)) {
                                for (var j in attrs.options) {
                                    var option = {}, opt = attrs.options[j];
                                    if (typeof opt == "string") {
                                        if (attrs.value && attrs.value == opt) option.selected = true;
                                        children.push($("<option></option>", option).append(opt));
                                    } else
                                    if (opt.name) {
                                        option.value = attrs.options[j].value || "";
                                        option.selected = typeof opt.selected == "boolean" ? opt.selected : attrs.value && attrs.value == option.value ? true : false;
                                        if (opt.label) option.label = opt.label;
                                        if (typeof opt.disabled == "boolean") option.disabled = opt.disabled;
                                        children.push($("<option></option>", option).append(opt.name));
                                    }
                                }
                                delete attrs.options;
                                delete attrs.value;
                            }
                            title = attrs.title;
                            delete attrs.title;

                            // Special case for checkbox
                            if (/radio|checkbox/.test(attrs.type)) {
                                if (bs4) {
                                    attrs.class = attrs.class || (opts.switch ? "custom-control-input": "form-check-input");
                                    label = $('<label></label>', { class: opts.class_label || (opts.switch ? "custom-control-label" : "form-check-label"), for: opts.for || attrs.id }).append(opts.label);
                                    elem = $('<div></div>', { class: opts.class_check || (opts.switch ? "custom-control custom-switch" : "form-check") }).
                                            append($("<" + type + "/>", attrs)).
                                            append(label);

                                } else {
                                    attrs.class = attrs.class || "";
                                    label = $('<label></label>').append($("<" + type + "/>", attrs)).append(opts.label);
                                    elem = $('<div></div>', { class: attrs.type }).append(label);
                                }
                                if (opts.class_append || opts.text_append) {
                                    label.append($("<span></span>", { class: opts.class_append || "" }).append(opts.text_append || ""));
                                }
                                // Clear label to not add as header, it was added before
                                delete opts.label;
                            } else {
                                attrs.class = attrs.class || "form-control";
                                if (type == "textarea") {
                                    delete attrs.value;
                                    elem = $("<" + type + "/>", attrs);
                                    if (opts.value) elem.append(opts.value);
                                } else {
                                    elem = $("<" + type + "/>", attrs);
                                }
                                if (opts.class_append || opts.text_append) {
                                    elem.append($("<span></span>", { class: opts.class_append || "" }).append(opts.text_append || ""));
                                }
                                if (opts.text_input_button) {
                                    elem = $('<div></div>', { class: 'input-group ' + (opts.class_input_group || "") }).append(elem);
                                    var append = $('<div></div>"', { class: "input-group-append" }).appendTo(elem);
                                    if (opts.list_input_button) {
                                        $('<button></button>', { class: "btn dropdown-toggle " + (opts.class_input_button || ""),
                                                                 type: "button",
                                                                 'data-toggle': "dropdown",
                                                                 'aria-haspopup': "true",
                                                                 'aria-expanded': "false"
                                                             }).append(opts.text_input_button).appendTo(append);

                                        var menu = $('<div></div>', { class: "dropdown-menu " + (opts.class_input_menu || "") }).appendTo(append);
                                        for (var l in opts.list_input_button) {
                                            var n = opts.list_input_button[l], v = n;
                                            if (typeof n == "object") v = n.value, n = n.name;
                                            if (n == "-") {
                                                $('<div></div>', { class: "dropdown-divider" }).appendTo(menu);
                                            } else {
                                                $('<a></a>', { class: "dropdown-item " + (opts.class_list_input_item || ""),
                                                               role: "button",
                                                               'data-value': v || n,
                                                               'data-form': this.formid,
                                                               onclick: "(" + opts.click_input_button + ")(this)"
                                                           }).append(n).appendTo(menu);
                                            }
                                        }
                                    } else {
                                        var bopts = { class: "btn " + (opts.class_input_button || ""), type: "button", 'data-form': this.formid };
                                        if (opts.click_input_button) bopts.onclick = "(" + opts.click_input_button + ")(this)";
                                        for (var b in opts.attrs_input_button) bopts[b] = opts.attrs_input_button[b];
                                        $('<button></button>', bopts).append(opts.text_input_button).appendTo(append);
                                    }
                                }
                            }
                            for (var k in children) elem.append(children[k]);

                            var class_group = opts.class_group || this.options.class_group;
                            var class_label = (opts.class_label || this.options.class_label) + " " + (attrs.value ? "active" : "");
                            group = $('<div></div>', { class: class_group, title: title }).appendTo(this.form);
                            if (opts.class_prefix || opts.text_prefix) {
                                group.append($("<span></span>", { class: opts.class_prefix || "" }).append(opts.text_prefix || ""));
                            }
                            if (bs4) {
                                if (this.options.horizontal) {
                                    group.addClass("row");
                                    class_label += " col-form-label " + (opts.size_label || this.options.size_label);
                                    group.append($("<label></label>", { for: opts.for || attrs.id, class: class_label, text: opts.label }));
                                    group.append($('<div></div>', { class: opts.size_input || this.options.size_input }).append(elem));
                                } else {
                                    if (opts.label) group.append($("<label></label>", { for: opts.for || attrs.id, class: class_label, text: opts.label }));
                                    group.append(elem);
                                }
                            } else {
                                class_label += " control-label";
                                if (this.options.horizontal) {
                                    class_label += " " + (opts.size_label || this.options.size_label);
                                    group.append($("<label></label>", { for: opts.for || attrs.id, class: class_label, text: opts.label }));
                                    group.append($('<div></div>', { class: opts.size_input || this.options.size_input }).append(elem));
                                } else {
                                    if (opts.label) group.append($("<label></label>", { for: opts.for || attrs.id, class: class_label, text: opts.label }));
                                    group.append(elem);
                                }
                            }
                            if (opts.class_suffix || opts.text_suffix) {
                                group.append($("<div></div>", { class: opts.class_suffix || "" }).append(opts.text_suffix || ""));
                            }
                            if (opts.autofocus) this.autofocus = elem;
                            break;

                        case "alert":
                            this.alert = elem = $("<div></div>", attrs).appendTo(this.form);

                        default:
                            if (!elem) elem = $("<" + type + "></" + type + ">", attrs).appendTo(this.form);
                            if (opts.class_append || opts.text_append) {
                                elem.append($("<span></span>", { class: opts.class_append || "" }).append(opts.text_append || ""));
                            }
                        }
                    }
                    break;
            }
        }

        // Footer
        this.footer = $('<div></div>', { class: this.options.class_footer });
        if (this.options.show_footer) this.content.append(this.footer);

        for (var i in this.options.footer) {
            var entry = this.options.footer[i], div;
            switch(typeof entry) {
            case "string":
                this.footer.append(entry);
                break;

            case "object":
                div = $('<div></div>', { class: this.options.class_options }).appendTo(this.footer);
                for (var type in entry) {
                    var opts = entry[type], attrs = {};
                    if (typeof opts == "string") opts = { text: opts };
                    for (var p in opts) {
                        if (!/^(type|[0-9]+)$|^(class|text|icon|size)_/.test(p)) attrs[p] = opts[p];
                    }
                    for (var attribute in attrs) {
                        if (typeof attrs[attribute] === "function") {
                            attrs[attribute] = "(" + attrs[attribute] + ")(this)";
                        }
                    }
                    type = opts.type || type;
                    div.append($("<" + type + "></" + type + ">", attrs));
                }
                break;
            }
        }

        for (var i in this.options.buttons) {
            var item = this.options.buttons[i];
            if (!item) continue;
            this["btn_" + item] = $("<button></button>", {
                type: "button",
                text: this.options["text_" + item],
                class: this.options["class_" + item],
                "data-callback": item,
                "data-form": this.formid,
                click: function(event) { self.callback($(event.target).data("callback"), event) }
            }).appendTo(this.footer);
            if (this.options["icon_" + item]) {
                this["btn_" + item].append($("<i></i>", { class: this.options["icon_" + item] }));
            }
        }

        // Setup events for dismiss and complete
        this.modal.on('show.bs.modal', function(e) {
            self.options.show.call(self.options.self, e);
        });
        this.modal.on('shown.bs.modal', function(e) {
            var focus = self.autofocus || self.form.find("input,select,textarea").filter(":not([readonly='readonly']):not([disabled='disabled']):not([type='hidden'])").first();
            if (focus) focus.focus();
            self.options.shown.call(self.options.self, e);
        });
        this.modal.on('hide.bs.modal', function(e) {
            e.bootpopupButton = self._callback;
            self.options.dismiss.call(self.options.self, e);
        });
        this.modal.on('hidden.bs.modal', function(e) {
            e.bootpopupButton = self._callback;
            self.options.complete.call(self.options.self, e);
            self.modal.remove();    // Delete window after complete
        });

        // Add window to body
        $(document.body).append(this.modal);
    }

    this.show = function() {
        // Call before event
        this.options.before(this);

        // Fire the modal window
        this.modal.modal();
    }

    this.showAlert = function(text) {
        if (!this.alert) return;
        if (text && text.message) text = text.message;
        $(this.alert).empty().append("<p>" + String(text).replace(/\n/g, "<br>") + "</p>").fadeIn(1000).delay(10000).fadeOut(1000, function () { $(this).hide() });
        return null;
    }

    this.data = function() {
        var keyval = {};
        var array = this.form.serializeArray();
        for (var i in array) {
            keyval[array[i].name] = array[i].value;
        }
        return keyval;
    };

    this.callback = function(name, event) {
        var func = this.options[name];        // Get function to call
        if (typeof func !== "function") return;
        this._callback = name;
        // Perform callback
        var array = this.form.serializeArray();
        var ret = func.call(this.options.self, this.data(), array, event);
        // Hide window
        if (ret !== null) this.modal.modal("hide");
        return ret;
    }

    this.shown = function() { return this.callback("shown"); }
    this.dismiss = function() { return this.callback("dismiss"); }
    this.submit = function() { return this.callback("submit"); }
    this.close = function() { return this.callback("close"); }
    this.ok = function() { return this.callback("ok"); }
    this.cancel = function() { return this.callback("cancel"); }
    this.yes = function() { return this.callback("yes"); }
    this.no = function() { return this.callback("no"); }
    this.agree = function() { return this.callback("agree"); }
    this.button1 = function() { return this.callback("button1"); }
    this.button2 = function() { return this.callback("button2"); }

    this.addOptions(Array.isArray(options) ? options: Array.prototype.slice.call(arguments));
    this.create();
    this.show();
}


bootpopup.alert = function(message, title, callback)
{
    if (typeof title === "function") callback = title;
    if (typeof title !== "string") title = document.title;
    if (typeof callback !== "function") callback = function() {};

    return bootpopup({
        self: this,
        title: title,
        content: [{ p: { html: message } }],
        dismiss: callback,
    });
}

bootpopup.confirm = function(message, title, callback)
{
    if (typeof title === "function") callback = title;
    if (typeof title !== "string") title = document.title;
    if (typeof callback !== "function") callback = function() {};

    return bootpopup({
        self: this,
        title: title,
        show_close: false,
        content: [{ p: { html: message } }],
        buttons: ["yes", "no"],
        dismiss: function(e) {
            callback.call(this, e.bootpopupButton == "yes")
        },
    });
}

bootpopup.prompt = function(label, type, message, title, callback)
{
    // Callback can be in any position, except label
    var callback_function = function() {};
    if (typeof type === "function") callback_function = type;
    if (typeof message === "function") callback_function = message;
    if (typeof title === "function") callback_function = title;
    if (typeof callback === "function") callback_function = callback;

    // If a list of values is provided, then the parameters are shifted
    // because type should be ignored
    if (typeof label === "object") {
        title = message;
        message = type;
        type = null;
    }

    // Sanitize message and title
    if (typeof message !== "string") message = "";
    if (title !== null && typeof title !== "string") title = document.title;

    // Add message to the window
    var content = [{ p: { text: message } }];

    // If label is a list of values to be asked to input
    if (typeof label === "object") {
        label.forEach(function(entry) {
            // Name in lower case and dashes instead spaces
            if (typeof entry.name !== "string") entry.name = entry.label.toLowerCase().replace(/\s+/g, "-");
            if (typeof entry.type !== "string") entry.type = "text";
            content.push({ input: entry });
        });
    }
    else {
        if (typeof type !== "string") type = "text";
        content.push({ input: { type: type, name: "value", label: label } });
        var callback_tmp = callback_function;   // Overload callback function to return "data.value"
        callback_function = function(data) { return callback_tmp.call(this, data.value); };
    }

    return bootpopup({
        self: this,
        title: title,
        content: content,
        buttons: ["cancel", "ok"],
        ok: callback_function,
    });
}

if (typeof define === "function") {
    define(["jquery", "bootstrap"], function() {
        return bootpopup;
    });
}
