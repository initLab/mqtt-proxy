// noinspection HttpUrlsUsage

'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const HttpDispatcher = require('httpdispatcher');
const mqtt = require('mqtt');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

let status = {};

const dispatcher = new HttpDispatcher();

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

function buildCollectdCommand(host, plugin, pluginInstance, type, value, timestamp = 'N') {
	return `PUTVAL "${host}/${plugin}-${pluginInstance}/${type}" ${timestamp}:${value}`;
}

let collectdSocket;

if (config.collectd) {
	collectdSocket = net.connect(config.collectd.socket, function() {
		logger('collectd socket connected');
		collectdSocket.on('data', function(data) {
			logger('collectd socket received', data.toString());
		});
	});
}

const mqttClient = mqtt.connect(config.mqtt.url);

mqttClient.on('connect', function() {
	logger('mqtt connected');

	config.mqtt.topics.forEach(function(topic) {
		logger('subscribing to ' + topic);
		mqttClient.subscribe(topic);
	});
});

function parseValue(messageStr, packet) {
	try {
		const decoded = JSON.parse(messageStr);

		if (typeof decoded.timestamp !== 'undefined' && typeof decoded.value !== 'undefined') {
			return decoded;
		}

		// incorrect JSON contents
	}
	catch {
		// not JSON
	}

	if (packet.retain) {
		logger('Skipping retained packet without timestamp');
		return false;
	}

	const value = isFinite(messageStr) ? parseFloat(messageStr) : messageStr;

	// backwards compatibility
	return {
		value,
	};
}

mqttClient.on('message', function(topic, message, packet) {
	if (!config.mqtt.values.includes(topic)) {
		return;
	}

	const messageStr = message.toString();
	logger('[' + topic + '] ' + messageStr);

	const parsed = parseValue(messageStr, packet);

	if (parsed === false) {
		return;
	}

	let {
		timestamp,
		value,
	} = parsed;

	let collectTimestamp;

	if (typeof timestamp === 'undefined') {
		timestamp = Date.now();
	}
	else {
		collectTimestamp = Math.round(timestamp / 1000);
	}

	status[topic] = {
		timestamp,
		value,
	};

	let topicParts = topic.split('/');
	let collectdPluginInstance = topicParts.shift().replace(/-/g, '_');
	let type;

	if (topicParts[0] === 'relay') {
		topicParts[0] = 'state';
		type = topicParts.join('-');
	}
	else {
		collectdPluginInstance = topicParts.shift().replace(/-/g, '_');
		type = topicParts.pop();
	}

	const collectdCommand = buildCollectdCommand(
		collectdSocket ? config.collectd.host : 'localhost',
		collectdSocket ? config.collectd.plugin : 'my_plugin',
		collectdPluginInstance,
		type,
		value,
		collectTimestamp,
	);

	if (collectdSocket) {
		collectdSocket.write(collectdCommand + '\n');
	}

	logger('collectd socket sent', collectdCommand);
});

dispatcher.onGet('/status', function(req, res) {
	res.writeHead(200, {
		'Content-Type': 'application/json',
		'Access-Control-Allow-Origin': '*',
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
