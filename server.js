'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const dispatcher = require('httpdispatcher');
const URL = require('url');
const QS = require('querystring');
const mqtt = require('mqtt');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

let status = {};

function leadingZero(num) {
	if (num > 9) {
		return num;
	}
	
	return '0' + num;
}

function logger() {
	const dt = new Date;
	const args = Array.prototype.slice.apply(arguments);
	
	args.unshift(
		'[' +
		leadingZero(dt.getDate()) + '.' +
		leadingZero(dt.getMonth()) + '.' +
		(dt.getFullYear()) + ' ' +
		leadingZero(dt.getHours()) + ':' +
		leadingZero(dt.getMinutes()) + ':' +
		leadingZero(dt.getSeconds()) +
		']'
	);
	
	console.log.apply(console, args);
}

const collectdSocket = net.connect(config.collectd.socket, function() {
	logger('collectd socket connected');
});

const mqttClient = mqtt.connect(config.mqtt.url);

mqttClient.on('connect', function() {
	logger('mqtt connected');
	
	config.mqtt.topics.forEach(function(topic) {
		logger('subscribing to ' + topic);
		mqttClient.subscribe(topic);
	});
});

mqttClient.on('message', function(topic, message, packet) {
	if (packet.retain) {
		return;
	}

	if (!config.mqtt.values.includes(topic)) {
		return;
	}
	
	const value = message.toString();
	logger('[' + topic + '] ' + value);

	status[topic] = {
		timestamp: Date.now(),
		value: value
	};

	const topicParts = topic.split('/', 2);
	const collectdPluginInstance = topicParts[0].replace(/\-/g, '_');
	const key = topicParts[1];

	collectdSocket.write(
		'PUTVAL "' +
		config.collectd.host + '/' +
		config.collectd.plugin + '-' +
		collectdPluginInstance + '/' +
		key + '" N:' +
		value + '\n'
	);
});

dispatcher.onGet('/status', function(req, res) {
	res.writeHead(200, {
		'Content-Type': 'application/json'
    });

	res.end(JSON.stringify(status));
});

http.createServer(function(req, res) {
	const conn = req.connection;
	
	logger('HTTP client connected: ' + conn.remoteAddress + ':' + conn.remotePort);
	logger(req.method + ' ' + req.url);
	
	try {
		dispatcher.dispatch(req, res);
	}
	catch(err) {
		logger(err);
	}
}).listen(config.listen.port, config.listen.hostname, function() {
	logger('Server listening on: http://' + config.listen.hostname + ':' + config.listen.port);
});
