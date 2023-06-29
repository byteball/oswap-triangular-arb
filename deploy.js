/*jslint node: true */
"use strict";
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const conf = require('ocore/conf.js');
const objectHash = require("ocore/object_hash.js");
const light_wallet = require("ocore/light_wallet.js");

const operator = require('aabot/operator.js');
const dag = require('aabot/dag.js');

const definition = ['autonomous agent', {
	base_aa: conf.arb_base_aas[0],
	params: {
		asset: 'base',
		owner: conf.owner,
		nonce: 0,
	}
}];

async function deploy() {
	const prefix = new RegExp('^222');
	const params = definition[1].params;
	console.error(`searching for nonce matching prefix ${prefix} ...`);
	const start_ts = Date.now();
	const printProgress = () => {
		const elapsed = Date.now() - start_ts;
		console.error(`trying ${params.nonce}, ${params.nonce / elapsed * 1000} nonces/sec`);
	};
	const interval = setInterval(printProgress, 10 * 1000);
	let arb_aa;
	do {
		params.nonce++;
		arb_aa = objectHash.getChash160(definition);
		if (params.nonce % 100000 === 0)
			printProgress();
	}
	while (!arb_aa.match(prefix));
	clearInterval(interval);
	console.error(`found arb AA ${arb_aa}, search took ${(Date.now() - start_ts)/1000} seconds`, definition);
	const unit = await dag.defineAA(definition);
	console.error('deployed in unit', unit);
}

eventBus.on('headless_wallet_ready', async () => {
	await operator.start();
	network.start();
	await light_wallet.waitUntilFirstHistoryReceived();
	await deploy();
	process.exit();
});

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});
