'use strict';

/* Magic Mirror
 * Module: MMM-Swipe
 * 
 * By Luke Moch http://github.com/mochman/
 * MIT Licensed
 */

/* jshint node: true, esversion:6 */

const NodeHelper = require('node_helper');
const statistics = require('math-statistics');
const Gpio = require('onoff').Gpio;
let { usleep } = require('usleep');

module.exports = NodeHelper.create({
    // "Private" node helper configuration options.
    _config: {
        MICROSECONDS_PER_CM: 1e6 / 34321,
        SAMPLE_SIZE: 5,
        TRIGGER_PULSE_TIME: 10, // microseconds (us)
        SWIPE_DIFFERENCE_MULTIPLE: 1.3
    },

    start: function() {
        this.config = {};
        this.started = false;
        this.mode = "off";
    },

    setupListener: function() {
        this.trigger = new Gpio(this.config.triggerPin, "out");
        this.echoLeft = new Gpio(this.config.echoLeftPin, "in", "both");
        this.echoRight = new Gpio(this.config.echoRightPin, "in", "both");
        this.startTick = { Left: [0, 0], Right: [0, 0] };
        this.lastDistance = { Left: 0.0, Right: 0.0 };
        this.measureLeftCb = this.measure.bind(this, "Left");
        this.measureRightCb = this.measure.bind(this, "Right");
    },

    startListener: function() {
        this.echoLeft.watch(this.measureLeftCb);
        this.echoRight.watch(this.measureRightCb);
        this.mode = "waiting";
        this.sampleInterval = setInterval(this.doTrigger.bind(this), this.config.sampleInterval);
    },

    stopListener: function() {
        this.echoLeft.unwatch(this.measureLeftCb);
        this.echoRight.unwatch(this.measureRightCb);
        this.mode = "off";
        clearInterval(this.sampleInterval);
    },

    doTrigger: function() {
        // Set trigger high for 10 microseconds
        this.trigger.writeSync(1);
        usleep(this._config.TRIGGER_PULSE_TIME);
        this.trigger.writeSync(0);
    },

    measure: function(which, err, value) {
        var diff, usDiff, dist;
        if (err) {
            throw err;
        }
        if (value == 1) {
            this.startTick[which] = process.hrtime();
        } else {
            diff = process.hrtime(this.startTick[which]);
            // Full conversion of hrtime to us => [0]*1000000 + [1]/1000
            usDiff = diff[0] * 1000000 + diff[1] / 1000;

            if (this.mode !== "detect" && usDiff > this.config.sensorTimeout) { // Ignore bad measurements
                return;
            }

            dist = usDiff / 2 / this._config.MICROSECONDS_PER_CM;

            this.lastDistance[which] = dist.toFixed(2);
            
            if (this.config.calibrate) {
                this.sendSocketNotification('CALIBRATION', this.lastDistance);
            }

            if (this.mode === "waiting") {
                this.monitor(which, dist);
            } else if (this.mode === "detect") {
                this.detect(which, dist);
            }
        }
    },

    monitor: function(which, dist) {
        if ((which === "Left" && dist <= this.config.leftDistance) ||
            (which === "Right" && dist <= this.config.rightDistance)) {
            var countdownTime = this.config.swipeSpeed / this._config.SAMPLE_SIZE;
            this.mode = "detect";
            this.gestureInfo = {
                distances: { Right: [], Left: [] },
                count: { Right: 0, Left: 0 },
                avgerages: { Right: 0.0, Left: 0.0 },
            };
            clearInterval(this.sampleInterval);
            this.sampleInterval = setInterval(this.doTrigger.bind(this), countdownTime);
        }
    },

    detect: function(which, dist) {
        if (this.gestureInfo.count[which] < this._config.SAMPLE_SIZE) {
            this.gestureInfo.distances[which].push(dist);
            this.gestureInfo.count[which] ++;
        } else if (this.gestureInfo.count[which] === this._config.SAMPLE_SIZE) {
            this.gestureInfo.distances[which].push(dist);
            this.gestureInfo.avgerages[which] = statistics.median(this.gestureInfo.distances[which]).toFixed(0);
            if (this.gestureInfo.count.Left === this._config.SAMPLE_SIZE && 
                this.gestureInfo.count.Right === this._config.SAMPLE_SIZE) {
                this.processSwipe();
            }
        }
    },

    processSwipe: function() {
        this.mode = "waiting";
        clearInterval(this.sampleInterval);
        this.sampleInterval = setInterval(this.doTrigger.bind(this), this.config.sampleInterval);

        if (this.gestureInfo.avgerages.Left <= this.config.leftDistance && 
            this.gestureInfo.avgerages.Right <= this.config.rightDistance) {
            this.sendSocketNotification('MOVEMENT', 'Press');
        } else if (this.gestureInfo.avgerages.Right * this._config.SWIPE_DIFFERENCE_MULTIPLE <= this.gestureInfo.avgerages.Left) {
            this.sendSocketNotification('MOVEMENT', 'Swipe Right');
        } else if (this.gestureInfo.avgerages.Left * this._config.SWIPE_DIFFERENCE_MULTIPLE <= this.gestureInfo.avgerages.Right) {
            this.sendSocketNotification('MOVEMENT', 'Swipe Left');
        }
    },

    socketNotificationReceived: function(notification, payload) {
        var self = this;
        if (notification === 'CONFIG') {
            if (!this.started) {
                this.config = payload;
                this.setupListener();
                this.started = true;
            }
            this.sendSocketNotification("STARTED", null);
        } else if (notification === 'START') {
            this.startListener();
        } else if (notification === 'STOP') {
            this.stopListener();
        }
    },
});
