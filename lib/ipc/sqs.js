//
//  Author: Vlad Seryakov vseryakov@gmail.com
//  backendjs 2018
//

const util = require('util');
const logger = require(__dirname + '/../logger');
const core = require(__dirname + '/../core');
const lib = require(__dirname + '/../lib');
const aws = require(__dirname + '/../aws');
const ipc = require(__dirname + "/../ipc");
const Client = require(__dirname + "/client");

// Queue client using AWS SQS, full queue url can be used or just the name as sqs://queuename
//
// The `count` config property specifies how messages to process at the same time, default is 1.
//
// The `interval` config property defines in ms how often to check for new messages after processing a message, i.e. after a messages processed
// it can poll immediately or after this amount of time, default is 1000 milliseconds.
//
// The `retryInterval` config property defines in ms how often to check for new messages after an error or no data, i.e. on empty
// pool when no messages are processed it can poll immediately or after this amount of time, default is 5000 mulliseconds.
//
// The `visibilityTimeout` property specifies how long the messages being processed stay hidden, in milliseconds.
//
// The `timeout` property defines how long to wait for new messages, i.e. the long poll, in milliseconds
//
// The `retryCount` and `retryTimeout` define how many times to retry failed AWS HTTP requests, default is 5 times starting
//  with the backoff starting at 500 milliseconds.
//
// For messages that have `startTime` property which is the time in the future when a message must be actually processed there
// is a parameter `maxTimeout` which defines in milliseconds the max time a messsage can stay invisible while waiting for its scheduled date,
// default is 6 hours, the AWS max is 12 hours. The scheduling is implemented using AWS `visibilityTimeout` feature, keep
// scheduled messages hidden until the actual time.
//
// Examples:
//
//      ipc-queue=sqs://messages?bk-interval=60000
//      ipc-queue=https://sqs.us-east-1.amazonaws.com/123456/messages?bk-visibilityTimeout=300&bk-count=2
//

const client = {
    name: "sqs",
};
module.exports = client;

ipc.modules.push(client);

client.createClient = function(url, options)
{
    if (/^sqs:\/\/|^https:\/\/sqs/.test(url)) return new IpcSQSClient(url, options);
}

function IpcSQSClient(url, options)
{
    Client.call(this, url, options);
    this.applyOptions();
    this.metrics = new core.modules.metrics.Metrics();

    if (this.url.match(/^sqs:/)) {
        this.url = "";
        aws.querySQS("GetQueueUrl", { QueueName: this.hostname }, this.options, (err, data) => {
            if (err) return;
            this.url = lib.objGet(data, "GetQueueUrlResponse.GetQueueUrlResult.QueueUrl");
            this.emit("ready");
        });
    } else {
        this.emit("ready");
    }
}
util.inherits(IpcSQSClient, Client);

IpcSQSClient.prototype.applyOptions = function()
{
    this.options.timeout = lib.toNumber(this.options.timeout, { dflt: 20000, min: 0 });
    this.options.visibilityTimeout = lib.toNumber(this.options.visibilityTimeout, { min: 0 });
    if (this.options.visibilityTimeout < 1000) this.options.visibilityTimeout *= 1000;
    this.options.count = lib.toNumber(this.options.count, { dflt: 0, min: 1, max: 10 });
    this.options.interval = lib.toNumber(this.options.interval, { dflt: 1000, min: 0 });
    this.options.retryInterval = lib.toNumber(this.options.retryInterval, { dflt: 5000, min: 0 });
    this.options.maxTimeout = lib.toNumber(this.options.maxTimeout, { dflt: 3600000*6, min: 60000 });
    this.options.retryCount = lib.toNumber(this.options.retryCount, { dflt: 5, min: 0 });
    this.options.retryTimeout = lib.toNumber(this.options.retryTimeout, { dflt: 250, min: 0 });
    this.options.retryOnError = lib.toBool(this.options.retryOnError, { dflt: 1 });
}

IpcSQSClient.prototype.stats = function(options, callback)
{
    aws.querySQS("GetQueueAttributes", { QueueUrl: this.url, 'AttributeName.1': "All" }, this.options, (err, rc) => {
        if (!err) {
            rc = { attributes: lib.objGet(rc, "GetQueueAttributesResponse.GetQueueAttributesResult.Attribute", { list: 1 }) };
            rc.queueCount = lib.toNumber(rc.attributes.filter((x) => (x.Name == "ApproximateNumberOfMessages")).map((x) => (x.Value)).pop());
            rc.queueRunning = lib.toNumber(rc.attributes.filter((x) => (x.Name == "ApproximateNumberOfMessagesNotVisible")).map((x) => (x.Value)).pop());
        }
        lib.tryCall(callback, err, rc);
    });
}

IpcSQSClient.prototype.pollQueue = function(options)
{
    var self = this;
    if (!this.url) return;

    var url = this.url;
    var chan = this.channel(options);
    var metrics = this.metrics, mtimer;

    aws.sqsReceiveMessage(url, this.options, (err, items) => {
        if (err) return this.schedulePollQueue(options, this.options.retyInterval);

        mtimer = metrics.Timer('timer').start(items.length);

        var processed = 0;
        lib.forEach(items, (item, next) => {
            let vtimer, done, body = item.Body || "";
            // JSON is assumed in the body, if not send it as is
            if (body[0] != "{") body = Buffer.from(body, "base64").toString();
            var msg = lib.jsonParse(body, { url: url, datatype: "obj", logger: "error", handle: item.ReceiptHandle }) || body;
            logger.debug("pollQueue:", self.name, chan, "MSG:", msg, "ITEM:", item);

            // Check message timestamps if not ready yet then keep it hidden
            if (msg.endTime > 0 && msg.endTime < Date.now()) {
                logger.info("pollQueue:", this.name, chan, "expired", item.MessageId, msg);
                aws.querySQS("DeleteMessage", { QueueUrl: url, ReceiptHandle: item.ReceiptHandle }, self.options, () => { next() });
                return;
            }
            if (msg.startTime > 0 && msg.startTime - Date.now() > self.options.interval) {
                let timeout = msg.startTime - Date.now();
                if (timeout > self.options.maxTimeout) timeout = self.options.maxTimeout;
                logger.info("pollQueue:", self.name, chan, timeout, "scheduled", item.MessageId, msg);
                const req = { QueueUrl: url, ReceiptHandle: item.ReceiptHandle, VisibilityTimeout: Math.round(timeout/1000) };
                aws.querySQS("ChangeMessageVisibility", req, self.options, () => { next() });
                return;
            }
            // Delete immediately, this is a one-off message not to be handled or repeated
            if (msg.noWait) {
                aws.querySQS("DeleteMessage", { QueueUrl: url, ReceiptHandle: item.ReceiptHandle }, self.options);
            } else
            // Delay deletion in case checks need to be done for uniqueness or something else
            if (msg.noWaitTimeout > 0) {
                setTimeout(() => {
                    if (done) return;
                    msg.noWait = 1;
                    aws.querySQS("DeleteMessage", { QueueUrl: url, ReceiptHandle: item.ReceiptHandle }, self.options);
                }, msg.noWaitTimeout * 1000);
            } else {
                // Update visibility now and while the job is running
                const vtimeout = msg.visibilityTimeout > 0 ? msg.visibilityTimeout : self.options.visibilityTimeout;
                if (vtimeout) {
                    Object.defineProperty(msg, "__receiptHandle", { enumerable: false, value: item.ReceiptHandle });
                    const req = { QueueUrl: url, ReceiptHandle: item.ReceiptHandle, VisibilityTimeout: Math.round(vtimeout * 1.1 / 1000) };
                    if (msg.visibilityTimeout > 0) aws.querySQS("ChangeMessageVisibility", req, self.options);
                    vtimer = setInterval(() => {
                        if (done) return;
                        aws.querySQS("ChangeMessageVisibility", req, self.options, (err) => {
                            logger.debug("pollQueue:", self.name, chan, "keepalive", item.MessageId, msg);
                            if (err) clearInterval(vtimer);
                        });
                    }, vtimeout * 0.8);
                }
            }
            processed++;
            // Not processed events will be back in the queue after visibility timeout automatically
            if (!self.emit(chan, msg, (err) => {
                if (done) return;
                done = 1;
                clearInterval(vtimer);
                logger.debug("pollQueue:", self.name, chan, item.MessageId, err, msg);
                // Retain the message only in case of known fatal errors, otherwise delete it after processing, any other error
                // is considered as undeliverable due to corruption or invalid message format...
                if (!msg.noVisibility && (err?.status >= 500 || msg.noWait)) {
                    const timeout = lib.toNumber(msg.retryVisibilityTimeout && msg.retryVisibilityTimeout[err?.status]);
                    if (err && timeout > 0) {
                        const req = { QueueUrl: url, ReceiptHandle: item.ReceiptHandle, VisibilityTimeout: Math.round(timeout/1000) };
                        return aws.querySQS("ChangeMessageVisibility", req, self.options, () => { next() });
                    }
                    return next();
                }
                aws.querySQS("DeleteMessage", { QueueUrl: url, ReceiptHandle: item.ReceiptHandle }, self.options, () => { next() });
            })) {
                done = 1;
                clearInterval(vtimer);
                next();
            }
        }, function() {
            mtimer.end();
            self.schedulePollQueue(options, processed ? self.options.interval : self.options.retryInterval);
        });
    });
}

IpcSQSClient.prototype.publishQueue = function(job, options, callback)
{
    logger.dev("publishQueue:", this.url, job, options);
    var opts = this.options;
    if (options.region || options.delay) {
        opts = lib.objClone(this.options, "region", options.region, "delay", options.delay);
    }
    if (/\.fifo$/.test(this.url)) {
        if (opts === this.options) opts = lib.objClone(this.options);
        opts.group = options.group || this.queueName;
        opts.unique = options.unique;
    }
    aws.sqsSendMessage(this.url, Buffer.from(job).toString("base64"), opts, callback);
}

IpcSQSClient.prototype.unpublishQueue = function(msg, options, callback)
{
    if (!msg.__receiptHandle) return lib.tryCall(callback);
    aws.querySQS("DeleteMessage", { QueueUrl: this.url, ReceiptHandle: msg.__receiptHandle }, this.options, callback);
}

