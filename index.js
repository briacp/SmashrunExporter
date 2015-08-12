/* jshint node:true */
'use strict';
var fs = require('fs');
var request = require('request');
var cheerio = require('cheerio');
var Cacheman = require('cacheman-file');
var async = require('async');
var cradle = require('cradle');
var RateLimiter = require('limiter').RateLimiter;

console.log("Don't forget to to run CouchDB!");

// Allow 150 requests per hour (the Twitter search limit). Also understands
// 'second', 'minute', 'day', or a number of milliseconds
var limiter = new RateLimiter(120, 'minute');

var cacheRuns = new Cacheman('runs', {
    engine: 'file',
    ttl: '300d'
});
var cacheList = new Cacheman('list', {
    engine: 'file',
    ttl: '300d'
});

var data = fs.readFileSync('./config.js'),
    config;
var config = JSON.parse(data);

var db = new(cradle.Connection)().database(config.exportDB);

//processRun(12345);
exportRuns();

function exportRuns() {
    var month = config.startDate[1];
    var processList = function (html) {
        var $ = cheerio.load(html);
        $('table.run-data tr').filter(function () {
            var data = $(this);
            var runId = parseInt(data.attr('id'));
            if (runId) {
                processRun(runId);
            }
        });
    };
    for (var year = config.startDate[0]; year <= config.endDate[0]; year++) {
        for (month; month <= 12; month++) {
            var url = 'http://smashrun.com/' + config.user + '/list/' + year + '/' + month;

            var key = year + '_' + month;

            console.log("Process List " + key);

            //runCached(cacheList, key, url, processList);

            request({
                url: url,
                headers: {
                    Cookie: config.cookies
                }
            }, function (err, response, value) {
                if (err) {
                    throw err;
                }
                processList(value);
            });

            if (month == config.endDate[1] && year == config.endDate[0]) {
                break;
            }

        }
        month = 1;
    }
}


function processRun(runId) {
    var url = 'http://smashrun.com/' + config.user + '/run/' + runId;

    runCached(cacheRuns, runId, url, function (html) {
        console.log("Processing run " + runId);
        var $ = cheerio.load(html);

        var runData = {
            id: runId,
            tags: [],
            notables: [],
            route: {},
            weatherInfo: {},
            cadence: {},
            calories: {},
            elevationProfile: {},
        };

        $('script').filter(function () {
            var data = $(this);
            var s = data.text();
            if (!s.match(/_(viewUserId|thisRun)/)) {
                return;
            }

            // XXX Kinda awful, remove "var" because of use strict;
            var _thisRun, _runCountByDistance, _runCountByPace, _viewUserId;
            s = s.replace(/\bvar\b/g, "");
            eval(s);
            if (_thisRun) {
                runData = mergeOptions(_thisRun, runData);
            }
            if (_runCountByDistance) {
                runData.runCountByDistance = _runCountByDistance;
            }
            if (_runCountByPace) {
                runData.runCountByPace = _runCountByPace;
            }
            if (_viewUserId) {
                runData.viewUserId = _viewUserId;
            }
        });
        runData.chalkboard = $('.chalkboard').text().trim();

        // Time
        var elapsed = $('.timing-container .elapsed-time div').text().trim().replace(/\s.*/g, '');
        var timeElapsed = elapsed.split(/:/);

        var h, m, s;
        if (timeElapsed.length == 3) {
            s = parseInt(timeElapsed[2]);
            m = parseInt(timeElapsed[1]);
            h = parseInt(timeElapsed[0]);
        } else if (timeElapsed.length == 2) {
            s = parseInt(timeElapsed[1]);
            m = parseInt(timeElapsed[0]);
            h = 0;
        }
        elapsed = (h * 3600) + (m * 60) + s;

        var startDateTime = new Date(runData.startDateTime);

        var endDateTime = new Date(startDateTime.getTime());
        endDateTime.setSeconds(endDateTime.getSeconds() + elapsed);
        runData.elapsedSeconds = elapsed;
        runData.startDateTime = startDateTime;
        runData.endDateTime = endDateTime;

        // Elevation
        runData.elevationProfile.upHill = parseInt($('.elevation-profile .uphill').attr("data-value"));
        runData.elevationProfile.flat = parseInt($('.elevation-profile .flat').attr("data-value"));
        runData.elevationProfile.downHill = parseInt($('.elevation-profile .downhill').attr("data-value"));
        runData.elevationProfile.difficulty = parseInt($('.elevation-profile .difficulty').text().trim().replace(/\D/g, ''));
        var dds = $('#proElevationProfile .elevation-profile dd');
        runData.elevationProfile.gained = dds.first().text().trim();
        runData.elevationProfile.lost = dds.slice(1).text().trim();

        // Pace Variability
        runData.paceVariability = $('.pace-variability').text().trim().replace(/%$/, '') / 100;

        // Performance
        runData.performanceIndex = parseInt($("#proSPI .zone-map").text().trim());

        // Location
        runData.route.toponym = $("#toponym").text().trim();
        runData.route.locale = $("#locale").text().trim();

        // Calories
        runData.calories.total = parseInt($(".calories").text().trim());
        runData.calories.average = parseInt($(".calories").next().text().trim());
        runData.calories.foodEquivalent = $(".food").text().trim();

        // Cadence
        var cadenceRange = $("#cadenceInfo div.col1 div.data").text().trim().replace(/ppm$/, '');
        cadenceRange = cadenceRange.split(" - ");
        runData.cadence.min = parseInt(cadenceRange[0]);
        runData.cadence.max = parseInt(cadenceRange[1]);
        runData.cadence.average = parseInt($("#cadenceInfo div.col2 div.data").text().trim().replace(/ppm$/, ''));

        // Weather
        runData.weatherInfo.type = $('.weather-info .weather-sprite').attr('class').replace(/show-symbol/, '').replace(/weather-sprite/, '').trim();
        runData.weatherInfo.temp = $('.show-temperature').text().trim();
        runData.weatherInfo.humidity = $('.show-humidity').text().trim().replace(/%.*$/, '') / 100;

        // Notables
        $('.notables-container li').filter(function () {
            runData.notables.push($(this).text().trim());
        });

        // Tags
        $('#outputTags .tagNoEffect').filter(function () {
            runData.tags.push($(this).text().trim());
        });
        $('#outputTags .tagged').filter(function () {
            runData.tags.push($(this).text().trim());
        });

        // We use async here to make sure all the info are retrieved before saving the document
        async.parallel({
            // --------------------------------------------------------
            // Main data
            mainData: function (cb) {
                cb(null, runData);
            },
            // --------------------------------------------------------
            // Advanced Info (pro)
            advancedInfo: function (cb) {
                getPost(
                    "http://smashrun.com/services/running-jsonservice.asmx/GetRunInfo", {
                    runId: runId
                },

                function (value) {
                    var info = {};
                    if (value.results && value.results.run) {
                        info = value.results.run;
                    }
                    cb(null, info);
                });
            },
            // --------------------------------------------------------
            // Run notes
            notes: function (cb) {
                getPost(
                    "http://smashrun.com/services/runmap-jsonservice.asmx/GetRunMapNotes", {
                    runId: runId,
                    viewUserId: runData.viewUserId
                },

                function (value) {
                    var notes = {};
                    if (value.results && value.results.notes) {
                        notes = value.results.notes;
                    }
                    cb(null, notes);
                });
            },
            // --------------------------------------------------------
            // MapView
            mapView: function (cb) {
                getPost(
                    "http://smashrun.com/services/running-jsonservice.asmx/GetMapView", {
                    runId: runId,
                    viewUserId: runData.viewUserId,
                    measurementType: 3
                },

                function (value) {
                    var mapView = {};
                    if (value.results && value.results.mapView) {
                        mapView = value.results.mapView;
                        delete mapView.runId;
                        delete mapView.userId;
                    }
                    cb(null, mapView);
                });
            },
            // --------------------------------------------------------
            // SPI
            spi: function (cb) {
                var start = runData.startDateTime;
                var end = new Date(start.getTime());
                end.setDate(end.getDate() - 90);

                getPost(
                    "http://smashrun.com/services/pro-jsonservice.asmx/GetSPIsForUserBetweenDates", {
                    userId: runData.viewUserId,
                    startDate: end.toJSON(),
                    endDate: start.toJSON(),
                },

                function (value) {
                    var history = {};
                    if (value.results && value.results.history) {
                        history = value.results.history;
                    }
                    cb(null, history);
                });
            },
            // --------------------------------------------------------
            // Tenth Split
            tenthSplits: function (cb) {
                getPost(
                    "http://smashrun.com/services/running-jsonservice.asmx/GetTenthSplitsDocument", {
                    runId: runId,
                    userId: runData.viewUserId,
                    unit: config.unit
                },

                function (value) {
                    var tenthSplits = {};
                    if (value.results && value.results.tenthSplits) {
                        tenthSplits = value.results.tenthSplits;
                        delete tenthSplits.runId;
                        delete tenthSplits.userId;
                    }
                    cb(null, tenthSplits);
                });
            },

        },

        function (err, results) {

            var run = results.mainData;
            run = mergeOptions(run, results.advancedInfo);
            run.tenthSplits = results.tenthSplits;
            run.spi = {
                history: results.spi
            };
            run.notes = results.notes;
            run.mapView = results.mapView;

            db.save(run.id.toString(), run, function (err, res) {
                if (err) {
                    throw err;
                } else {
                    console.log("Run " + run.id + " saved to Couch");
                }
            });
        });

    });
}

function getPost(url, body, cb) {
    //console.log("getPost", url, body);

    limiter.removeTokens(1, function () {
        request.post({
            url: url,
            method: "POST",
            headers: {
                Cookie: config.cookies,
                "Content-Type": "application/json"
            },
            json: true,
            body: body
        }, function (err, response, value) {
            if (err) {
                throw err;
            }
            cb(value);
        });
    });
}

function runCached(cache, key, url, cb) {
    cache.get(key, function (err, value) {
        if (value) {
            console.log('(from cache)'); // XXX
            cb(value);
        } else {
            limiter.removeTokens(1, function () {
                request({
                    url: url,
                    headers: {
                        Cookie: config.cookies
                    }
                }, function (err, response, value) {
                    if (err) {
                        throw err;
                    }
                    console.log('(from web)');
                    cache.set(key, value, '10d', function (err, value) {
                        cb(value);
                    });
                });
            });

        }
    });
}

function mergeOptions(obj1, obj2) {
    var obj3 = {};
    var attrname;
    for (attrname in obj1) {
        obj3[attrname] = obj1[attrname];
    }
    for (attrname in obj2) {
        obj3[attrname] = obj2[attrname];
    }
    return obj3;
}
