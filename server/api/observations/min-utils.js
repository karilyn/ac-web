'use strict';
var _ = require('lodash');
var moment = require('moment');
var uuid = require('node-uuid');
var path = require('path');
var geohash = require('ngeohash');
var moment = require('moment');

var AWS = require('aws-sdk');
var DOC = require("dynamodb-doc");
AWS.config.update({region: 'us-west-2'});
var docClient = new DOC.DynamoDB();
var s3Stream = require('s3-upload-stream')(new AWS.S3());

var OBS_TABLE = process.env.MINSUB_DYNAMODB_TABLE;

function itemsToSubmissions(items) {
    var subs = _.chain(items)
        .groupBy('subid')
        .map(function (obs, subid) {
            var meta = {
                subid: subid,
                latlng: obs[0].ob.latlng,
                datetime: obs[0].ob.datetime,
                uploads: obs[0].ob.uploads
            };

            var obs = obs.map(function (ob) {
                return {
                    obtype: ob.obtype,
                    obid: ob.obid
                };
            });

            return {
                subid: subid,
                latlng: meta.latlng,
                datetime: meta.datetime,
                uploads: meta.uploads,
                obs: obs
            }
        })
        .value();

    return subs;
};

function itemToObservation(item) {
    return itemsToObservations([item])[0];
};

function itemsToObservations(items) {
    var obs = _.map(items, function (item) {
        return {
            subid: item.subid,
            obid: item.obid,
            datetime: item.datetime,
            obtype: item.obtype,
            latlng: item.ob.latlng
        }
    });

    return obs;
};

function itemToSubmission(item) {
    return itemsToSubmissions([item])[0];
};

exports.saveSubmission = function (user, form, callback) {
    var bucket = 'ac-user-uploads';
    var keyPrefix = moment().format('YYYY/MM/DD/');
    var item = {
        obid: uuid.v4(),
        subid: uuid.v4(),
        userid: user.user_id,
        acl: 'public',
        obtype: 'quick',
        ob: {
            uploads: []
        }
    };

    form.on('field', function(name, value) {
        value = value.trim();
        switch(name){
            case "location":
                item.ob.latlng = value;
                item.geohash = geohash.encode(item.ob.latlng.split(',')[0], value.split(',')[1]);
                break;
            case "datetime":
                item.ob.datetime = value;
                item.epoch = moment(item.ob.datetime).unix();
                break;
            default:
                item.ob[name] = value;
                break;
        }
    });

    form.on('part', function(part) {
        var uploadId = uuid.v4()
        var ext = path.extname(part.filename);
        var key = keyPrefix + uploadId + ext;

        console.log('uploading: ' + key);

        item.ob.uploads.push(key);

        var upload = s3Stream.upload({
          Bucket: bucket,
          Key: key,
          ACL: "private"
        });

        part.pipe(upload);

        upload.on('error', function (error) {
          console.log(error);
        });

        upload.on('uploaded', function (details) {
          console.log(details);
        });

    });

    form.on('error', function (err) {
        console.log('error accepting obs form: ' + err)
    });

    form.on('close', function (err) {
        docClient.putItem({
            TableName: OBS_TABLE,
            Item: item,
        }, function (err, data) {
            if (err) {
                callback({error: 'error saving you submission.'});
            } else {
                var sub =  itemToSubmission(item);
                callback(null, sub);
            }
        });
    });
};

exports.getSubmissions = function (filters, callback) {
    var params = {
        TableName: OBS_TABLE,
        IndexName: 'acl-epoch-index'
    };
    var startDate = moment().subtract('2', 'days');
    var endDate = moment();

    console.log('dates = %s', filters.dates)
    //todo: validate temporal query string values

    if (filters.last) {
        startDate = moment().subtract(filters.last.split(':')[0], filters.last.split(':')[1]);
    } else if (filters.dates) {

        startDate = moment(filters.dates.split(',')[0]);
        endDate = moment(filters.dates.split(',')[1]);
    }

    console.log('getting obs between start = %s and end = %s', startDate.format('YYYY-MM-DD'), endDate.format('YYYY-MM-DD'));
    
    params.KeyConditions = [
        docClient.Condition("acl", "EQ", "public"), 
        docClient.Condition("epoch", "BETWEEN", startDate.unix(), endDate.unix())
    ];

    docClient.query(params, function(err, res) {
        if (err) {
            callback({error: "error fetching observations"});
        } else {
            var subs = itemsToSubmissions(res.Items);
            callback(null, subs);
        }
    });
};

exports.getSubmission = function (subid, callback) {
    var params = {
        TableName: OBS_TABLE,
        FilterExpression: 'attribute_exists(obid) and subid = :subid',
        ExpressionAttributeValues: {':subid' : subid}
    };

    docClient.scan(params, function(err, res) {
        if (err) {
            callback({error: "error fetching observations"});
        } else {
            var sub = itemToSubmission(res.Items[0]);
            callback(null, sub);
        }
    });
};

exports.getObservations = function (filters, callback) {
    var params = {
        TableName: OBS_TABLE,
        IndexName: 'acl-epoch-index'
    };
    var startDate = moment().subtract('2', 'days');
    var endDate = moment();

    console.log('dates = %s', filters.dates)
    //todo: validate temporal query string values

    if (filters.last) {
        startDate = moment().subtract(filters.last.split(':')[0], filters.last.split(':')[1]);
    } else if (filters.dates) {

        startDate = moment(filters.dates.split(',')[0]);
        endDate = moment(filters.dates.split(',')[1]);
    }

    console.log('getting obs between start = %s and end = %s', startDate.format('YYYY-MM-DD'), endDate.format('YYYY-MM-DD'));
    
    params.KeyConditions = [
        docClient.Condition("acl", "EQ", "public"), 
        docClient.Condition("epoch", "BETWEEN", startDate.unix(), endDate.unix())
    ];

    docClient.query(params, function(err, res) {
        if (err) {
            callback({error: "error fetching observations"});
        } else {
            var subs = itemsToObservations(res.Items);
            callback(null, subs);
        }
    });
};

exports.getObservation = function (obid, callback) {
    var params = {
        TableName: OBS_TABLE,
        FilterExpression: 'obid = :obid',
        ExpressionAttributeValues: {':obid' : obid}
    };

    docClient.scan(params, function(err, res) {
        if (err) {
            callback({error: "error fetching observations"});
        } else {
            var sub = itemToObservation(res.Items[0]);
            callback(null, sub);
        }
    });
};