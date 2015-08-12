/* jshint node:true */
'use strict';
var fs = require('fs');
var cradle = require('cradle');

var /*const*/ MILE = 1.609344;
// Display the n best efforts
var /*const*/ TOP_EFFORTS = 10;

var data = fs.readFileSync('./config.js'),
    config;
var config = JSON.parse(data);
var db = new(cradle.Connection)().database(config.exportDB);

var effortTypes = [
   { label: '400m', distance: 0.4 },
   { label: '1k', distance: 1 },
   { label: '2k', distance: 2 },
   { label: '3k', distance: 3 },
   { label: '5k', distance: 5 },
   { label: '10k', distance: 10 },
   { label: '13k', distance: 13 },
   { label: '20k', distance: 20 },

   { label: '1/2 mile', distance: MILE / 2 },
   { label: '1 mile', distance: MILE },
   { label: '2 miles', distance: MILE * 2 },
   { label: '5 miles', distance: MILE * 5 },
   { label: '10 miles', distance: MILE * 10 },

   { label: 'Half-marathon', distance: 42.194988 / 2 },
   { label: 'Marathon', distance: 42.194988 }
];

effortTypes.sort(function(a,b){
   if (a.distance < b.distance) {
       return -1;
   }
   if (a.distance > b.distance) {
       return 1;
   }
   return 0;
});

var distanceKey, durationKey;

//findBestEfforts();

effortTypes.forEach(function (effort) {
    displayBestEfforts(effort.label);
});

function displayBestEfforts(effort) {
    /**
        map:
        function(doc) {
          var efforts = [
            '400m', 
            '1k', '2k', '3k', '5k', '10k', '13k', '20k', '1/2 mile', 
            '1 mile', '2 miles', '5 miles', '10 miles', 
            'Marathon', 'Half-marathon'
          ];

          if (doc.bestEfforts)
          {
              for (var i = 0; i < efforts.length; i++) {
                 if (doc.bestEfforts[efforts[i]]) {
                     emit(efforts[i], doc.bestEfforts[efforts[i]].duration);
                 }
              }

          }
        }
    */
    db.view("bestEfforts/all", {
        key: effort,
        include_docs: true
    }, function (err, rows) {
        console.log("Top " + TOP_EFFORTS + " - " + effort);
        var bests = [];
        rows.forEach(function (key, doc) {
            bests.push({
                duration: doc.bestEfforts[effort].duration,
                doc: doc
            });
        });

        // Sort by duration
        bests.sort(function (a, b) {
            if (a.duration < b.duration) {
                return -1;
            }
            if (a.duration > b.duration) {
                return 1;
            }
            return 0;
        });

        // Only keep the top 10
        bests = bests.slice(0, TOP_EFFORTS);

        bests.forEach(function(best){
            console.log("http://www.smashrun.com/" + config.user + "/run/" + best.doc.id);
            console.log("     " + best.doc.startDateTime);
            niceBest(best.doc.bestEfforts[effort]);
            console.log();
        });
        console.log("done " + effort);
        console.log();
    });
}

function findBestEfforts() {

    // TODO: Improve the view by returning only metrics for distance and durations
    // map: function(doc) { if (doc.mapView) emit(doc.id, doc.mapView); }
    db.view("mapViews/all", function (err, rows) {
        if (err) {
            throw err;
        }

        rows.forEach(function (runId, mapView, index) {

            if (!mapView.metrics) {
                return;
            }

            if (distanceKey == null) {
                for (var i = 0; i < mapView.metricKeys.length; i++) {
                    if (mapView.metricKeys[i].key == 'distance') {
                        distanceKey = mapView.metricKeys[i].index;
                    }
                    if (mapView.metricKeys[i].key == 'duration') {
                        durationKey = mapView.metricKeys[i].index;
                    }
                }
            }

            var bestEfforts = {};

            effortTypes.forEach(function (effort) {
                var effortDistance = effort.distance;

                var totalDistance = mapView.metrics[distanceKey][mapView.metrics[distanceKey].length - 1];

                if (totalDistance < effortDistance) {
                    return;
                }

                bestEfforts[effort.label] = findFastest(effortDistance, mapView);
            });

            if (Object.keys(bestEfforts).length > 0) {
                console.log(runId);

                // Update the DB with the new BestEfforts calculated:
                db.merge(runId.toString(), {
                    bestEfforts: bestEfforts
                }, function (err, res) {
                    if (err) {
                        throw err;
                    }
                    console.log("Run " + runId + " updated bestEfforts");
                });
            }

        });
    });
}


// TODO Be smart - use max/min speed to guess the window for the distance
//                 GPS samples between 5-10s
function findFastest(dist, mapView) {
    var segmentNumber = mapView.metrics[distanceKey].length;
    var best = null;

    var distances = mapView.metrics[distanceKey];
    var durations = mapView.metrics[durationKey];

    // Let's start at the beginning
    START: for (var indexStart = 0; indexStart < segmentNumber; indexStart++) {
        var duration;
        for (var indexEnd = 0; indexEnd < segmentNumber; indexEnd++) {

            // Look if we have reached our target distance from the start point
            var segmentDistance = distances[indexEnd] - distances[indexStart];

            // If so (there can probably be 10m difference du to GPS sample rate, we don't bother)
            if (segmentDistance >= dist) {
                var segmentDuration = durations[indexEnd] - durations[indexStart];

                var speed = (segmentDistance * 1000) / segmentDuration;

                //                console.log(indexEnd, indexStart, durations[indexEnd], durations[indexStart], segmentDuration, segmentDistance, speed);

                if (!best || speed > best.speed) {
                    best = {
                        effortDistance: dist,
                        start: indexStart,
                        end: indexEnd,
                        speed: speed,
                        duration: segmentDuration,
                        distance: segmentDistance,
                    };
                }
                continue START;
            }
        }
    }

    return best;
}


function niceBest(best) {

    console.log(  "     Speed    : " + niceSpeed(best.duration, best.distance));  //+ "\n" +
    console.log(  "     Pace     : " + nicePace(best.duration, best.distance));  //+ "\n" +
    console.log(  "     Points   : (" +  best.start + "," + best.end + ")");  //+ "\n" +
    console.log(  "     Distance : " + niceDist(best.distance));  //+ "\n" +
    console.log(  "     Time     : " + best.duration);  //+ "\n";

    return "";
}

function nicePace(time, dist) {
    if (!dist) return "--";

    dist = dist * 100;

    var pace = time/dist;//concise( duration( time / dist ) );

    return pace.toFixed(2)  + "m/km";
}

function niceSpeed(time, dist) {
    if (!time) return "--";

    dist = Math.round(dist * 1000);

    var speed = ( dist / time ) * 3.6;   // * 3600(s => h) / 1000(m => km)
    return speed.toFixed(3) + "km/h";
}

function niceDuration(duration) {
    return duration_exact(duration);
}

function niceDist(dist) {
    var d    = Math.round(dist * 1000);

    var km = Math.round( d / 1000 );
    var m = d - ( km * 1000 );

    if (km) {
        return km + "km " + m + "m";
    }
    else {
        return d + "m";
    }
}




