"use strict";
var crypto = require('crypto');
const _ = require('lodash');

const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const mutex = require('ocore/mutex.js');
const network = require('ocore/network.js');
const device = require('ocore/device.js');
const aa_composer = require("ocore/aa_composer.js");
const storage = require("ocore/storage.js");
const db = require("ocore/db.js");
const constants = require("ocore/constants.js");
const light_wallet = require("ocore/light_wallet.js");

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const aa_state = require('aabot/aa_state.js');
const light_data_feeds = conf.bLight ? require('aabot/light_data_feeds.js') : null;

const CurveAA = require('./curve.js');
const xmutex = require("./xmutex");


let arb_aas;
let my_arb_aas;
let prev_trigger_initial_unit = {};

let oswapInfos = {};

let arbByAsset = {};

let oswapsByAsset = {};
let oswapsByPair = {};
let oppositeAssets = {};
let triangles = [];
let trianglesByOswap = {};

let lastArbTs = {};

let prevStateHashes = {};

let busyTriangles = {};

const sha256 = str => crypto.createHash("sha256").update(str, "utf8").digest("base64");

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAaStateToEmpty() {
	const unlock = await mutex.lock('aa_free');
	while (true) {
		const ts = Date.now();
		const aa_unlock = await aa_state.lock();
		aa_unlock();
		const elapsed = Date.now() - ts;
		if (elapsed <= 1)
			break;
		console.log(`taking aa_state lock took ${elapsed}ms, will wait more`);
	}
	process.nextTick(unlock); // delay unlock to give a chance to the immediately following code to lock aa_state
}

function getWaitTimeTillNextArb(triangle) {
	let timeout = 0;
	for (let oswap_aa of triangle.oswap_aas) {
		const t = lastArbTs[oswap_aa] + 3000 - Date.now();
		if (t > timeout)
			timeout = t;
	}
	return timeout;
}

async function estimateAndArbAll() {
	await waitForAaStateToEmpty();
	console.log('estimateAndArbAll');
	for (let triangle of triangles)
		await queueEstimateAndArb(triangle);
}

async function queueEstimateAndArb(triangle) {
	const { id } = triangle;
	if (busyTriangles[id])
		return console.log(`triangle ${id} already busy or queued`);
	busyTriangles[id] = true;
	console.log(`triangle ${id} added to busy`);
	await estimateAndArbUnderArbLock(triangle);
}

async function estimateAndArbUnderArbLock(triangle) {
	await xmutex.lock();
	await estimateAndArb(triangle);
	await xmutex.unlock();
}

async function estimateAndArb(triangle) {
	await waitForAaStateToEmpty();
	const unlock = await mutex.lock('estimate');
	const { asset, arb_aa, id, oswap_aas } = triangle;
	console.log('===== estimateAndArb triangle ' + id);
	const timeout = getWaitTimeTillNextArb(triangle);
	if (timeout > 0) {
		setTimeout(() => estimateAndArbUnderArbLock(triangle), timeout + 10);
		return unlock(`too fast after the previous arb affecting the same pools, will estimate again in ${timeout}ms`);
	}

	const finish = (msg) => {
		busyTriangles[id] = false;
		console.log(`triangle ${id} removed from busy`);
		unlock(msg);
	};

	
	// simulate an arb request
	const aa_unlock = await aa_state.lock();
	let upcomingStateVars = _.cloneDeep(aa_state.getUpcomingStateVars());
	let upcomingBalances = _.cloneDeep(aa_state.getUpcomingBalances());
	const arb_balances = upcomingBalances[arb_aa];
	if (!arb_balances[asset]) {
		console.log(`arb ${arb_aa} zero balance`, arb_balances);
		aa_unlock();
		return finish();
	}
	for (let oswap_aa of oswap_aas) {
		const { x_asset, y_asset } = oswapInfos[oswap_aa];
		const balances = upcomingBalances[oswap_aa];
		if (!balances[x_asset] || !balances[y_asset]) {
			console.log(`triangle ${id}: oswap ${oswap_aa} zero balance`, balances);
			aa_unlock();
			return finish();
		}
	}
	const state = sha256(JSON.stringify([upcomingStateVars, upcomingBalances]));

	if (state === prevStateHashes[id]) {
		console.log(`triangle ${id}: the state hasn't changed`);
		aa_unlock();
		return finish();
	}
	prevStateHashes[id] = state;

	const { share, secondary_share, arrResponses } = await findBestSharesForArb(arb_aa, oswap_aas, id);
	aa_unlock();
	if (!share || !secondary_share)
		return finish(`${id} arb would bounce`);
	const arbResponses = arrResponses.filter(r => r.aa_address === arb_aa);
	const lastResponse = arbResponses[arbResponses.length - 1];
	const profit = lastResponse.response.responseVars.profit;
	if (!profit)
		throw Error(`no profit in response vars from ${arb_aa}`);
	const usd_profit = await getUsdAmount(profit, asset);
	console.log(`estimateAndArb: ${id} would succeed with profit ${profit} or $${usd_profit}`);
	if (usd_profit < conf.min_profit)
		return finish(`profit would be too small $` + usd_profit);
	const unit = await dag.sendAARequest(arb_aa, { arb: 1, oswap_aas, share, secondary_share });
	if (!unit)
		return finish(`sending arb request failed`);
	const objJoint = await dag.readJoint(unit);
	// upcoming state vars are updated and the next request will see them
	console.log(`estimateAndArb: ${id} calling onAARequest manually`);
	await aa_state.onAARequest({ unit: objJoint.unit, aa_address: arb_aa });
	for (let oswap_aa of oswap_aas)
		lastArbTs[oswap_aa] = Date.now();
	finish();
}


async function getUsdAmount(amount, asset) {
	const { decimals } = await getAssetInfo(asset);
	return amount / 10 ** decimals * network.exchangeRates[(asset === 'base' ? 'GBYTE' : asset) + '_USD'];
}


const max_balance_share = 0.05;

async function exchangeNonMainAssets() {
	let bRemains = false;
	await xmutex.lock();
	console.log('exchangeNonMainAssets');
	for (let asset in arbByAsset) {
		const arb_aa = arbByAsset[asset];
		const upcomingBalances = aa_state.getUpcomingBalances();
		const balances = upcomingBalances[arb_aa];
		const main_usd_balance = await getUsdAmount(balances[asset], asset);
		for (const a in balances) {
			if (a === asset)
				continue;
			const balance = balances[a];
			const usd_balance = await getUsdAmount(balance, a);
			const { symbol } = await getAssetInfo(a);
			if (usd_balance < main_usd_balance * max_balance_share) {
				console.log(`arb ${arb_aa}: ${symbol} balance is $${usd_balance} which is still small compared with the main balance $${main_usd_balance}, will not swap`);
				continue;
			}
			console.log(`arb ${arb_aa}: ${symbol} balance is $${usd_balance} which is more than ${max_balance_share * 100}% of the main balance $${main_usd_balance}, will swap`);
			const pair = getPair(a, asset);
			const pools = oswapsByPair[pair];
			console.log(`arb ${arb_aa}: pools`, pools);
			if (!pools) {
				console.log(`arb ${arb_aa}: no pools to swap ${symbol} to ${asset}, skipping`);
				continue;
			}
			const { pool, pool_balance } = findBestPool(pools, a);
			console.log(`arb ${arb_aa}: best pool`, pool);
			const aa_unlock = await aa_state.lock();
			const share = await findBestShareForSwap(arb_aa, pool, balance / pool_balance);
			aa_unlock();
			if (!share) {
				console.log(`share would be 0`);
				continue;
			}
			const unit = await dag.sendAARequest(arb_aa, { exchange: 1, oswap_aa: pool, share });
			console.log(`arb ${arb_aa}: sent request to swap ${symbol} to ${asset}: ${unit}`);
			if (!unit) {
				console.log(`sending exchange request failed`);
				continue;
			}
			lastArbTs[pool] = Date.now();
			const objJoint = await dag.readJoint(unit);
			console.log(`exchangeNonMainAssets ${arb_aa}/${pool}: calling onAARequest manually`);
			await aa_state.onAARequest({ unit: objJoint.unit, aa_address: arb_aa });
			if (share < 0.9)
				bRemains = true;
		}
	}
	console.log('exchangeNonMainAssets done');
	await xmutex.unlock();
	if (bRemains) {
		console.log(`some assets remain unexchanged, will exchangeNonMainAssets more`);
		await exchangeNonMainAssets();
	}
}

function findBestPool(pools, asset) {
	let best_pool;
	let best_balance = 0;
	for (const pool of pools) {
		const upcomingBalances = aa_state.getUpcomingBalances();
		const pool_balance = upcomingBalances[pool][asset];
		if (pool_balance > best_balance) {
			best_balance = pool_balance;
			best_pool = { pool, pool_balance };
		}
	}
	if (!best_pool)
		throw Error(`best pool not found`);
	return best_pool;
}

const max_ratio = 0.01;

async function findBestSharesForArb(arb_aa, oswap_aas, id) {
	const start_ts = Date.now();
	let share = 1;
	let secondary_share = 1;
	let arrResponses;
	while (share > 0 && secondary_share > 0) {
		console.log(`trying arb ${id} with shares ${share}/${secondary_share}`);
		let upcomingStateVars = _.cloneDeep(aa_state.getUpcomingStateVars());
		let upcomingBalances = _.cloneDeep(aa_state.getUpcomingBalances());
		const payload = {
			arb: 1,
			oswap_aas,
			share,
			secondary_share,
		};
		const objUnit = {
			unit: 'dummy_trigger_unit',
			authors: [{ address: operator.getAddress() }],
			messages: [
				{
					app: 'payment',
					payload: {
						outputs: [{ address: arb_aa, amount: 1e4 }]
					}
				},
				{
					app: 'data',
					payload
				},
			],
			timestamp: Math.round(Date.now() / 1000),
		};
		arrResponses = await aa_composer.estimatePrimaryAATrigger(objUnit, arb_aa, upcomingStateVars, upcomingBalances);
		if (!arrResponses[0].bounced) {
			const balances = upcomingBalances[arb_aa];
			for (let a in balances)
				if (balances[a] < 0)
					throw Error(`${id}: ${a} balance would become negative: ${balances[a]}`);
			break;
		}
		const { error } = arrResponses[0].response;
		console.log(`shares ${share}/${secondary_share} would bounce: ` + error);
		if (error.match(/no arb opportunity exists$/))
			return {};
		const arrMatches = error.match(/^one of secondary AAs bounced with error: (\w{32}: )?(\w{32}: )?(\w{32}: )?/);
		if (!arrMatches || !arrMatches[1]) {
			console.log(`unexpected bounce message`);
			throw Error(`unexpected bounce message ` + error);
			share = 0;
			break;
		}
		if (arrMatches[3] || arrMatches[2]) {
			secondary_share -= 0.1;
			if (secondary_share < 0.7) {
				secondary_share = 1;
				share -= 0.1;
			}
		}
		else
			share -= 0.1;
	}
	console.log(`found shares ${share}/${secondary_share} for arb ${id} in ${Date.now() - start_ts}ms`);
	if (share < 0.001)
		share = 0;
	if (secondary_share < 0)
		secondary_share = 0;
	return { share, secondary_share, arrResponses };
}

async function findBestShareForSwap(arb_aa, oswap_aa, amount_ratio) {
	const start_ts = Date.now();
	let share = amount_ratio < max_ratio ? 1 : max_ratio / amount_ratio;
	while (share > 0) {
		console.log(`trying exchange arb ${arb_aa} oswap ${oswap_aa} with share ${share}`);
		let upcomingStateVars = _.cloneDeep(aa_state.getUpcomingStateVars());
		let upcomingBalances = _.cloneDeep(aa_state.getUpcomingBalances());
		const payload = {
			exchange: 1,
			oswap_aa,
			share,
		};
		const objUnit = {
			unit: 'dummy_trigger_unit',
			authors: [{ address: operator.getAddress() }],
			messages: [
				{
					app: 'payment',
					payload: {
						outputs: [{ address: arb_aa, amount: 1e4 }]
					}
				},
				{
					app: 'data',
					payload
				},
			],
			timestamp: Math.round(Date.now() / 1000),
		};
		const arrResponses = await aa_composer.estimatePrimaryAATrigger(objUnit, arb_aa, upcomingStateVars, upcomingBalances);
		if (!arrResponses[0].bounced)
			break;
		console.log(`share ${share} would bounce: ` + arrResponses[0].response.error);
		share -= 0.1;
	}
	console.log(`found share ${share} for exchange arb ${arb_aa} oswap ${oswap_aa} in ${Date.now() - start_ts}ms`);
	if (share < 0)
		share = 0;
	return share;
}

let assetInfos = {};
async function getAssetInfo(asset){
	if (asset == 'base')
		return { symbol: 'GBYTE', asset, decimals: 9 };
	if (assetInfos[asset])
		return assetInfos[asset];
	const symbol = await dag.readAAStateVar(conf.token_registry_address, "a2s_" + asset);
	if (!symbol)
		throw Error(`no such asset ` + asset);
	const desc_hash = await dag.readAAStateVar(conf.token_registry_address, "current_desc_" + asset);
	if (!desc_hash)
		throw Error(`no desc_hash for ` + symbol);
	const decimals = await dag.readAAStateVar(conf.token_registry_address, "decimals_" + desc_hash);
	if (typeof decimals !== 'number')
		throw Error(`no decimals for ` + symbol);
	assetInfos[asset] = { symbol, asset, decimals };
	return assetInfos[asset];
}


async function onAAResponse(objAAResponse) {
	const { aa_address, trigger_unit, trigger_initial_unit, trigger_address, bounced, response } = objAAResponse;
	if (bounced && trigger_address === operator.getAddress())
		return console.log(`=== our request ${trigger_unit} bounced with error`, response.error);
	if (bounced)
		return console.log(`request ${trigger_unit} bounced with error`, response.error);
	const triangles = getAffectedTriangles([aa_address]);
	console.log(`triangles affected by response from ${aa_address} initial trigger ${trigger_initial_unit} trigger ${trigger_unit}`, triangles);
	if (triangles.length === 0)
		return;
	await waitForAaStateToEmpty();
	const unlock = await mutex.lock('resp');
	for (let triangle of triangles) {
		if (trigger_initial_unit !== prev_trigger_initial_unit[triangle.id])
			await queueEstimateAndArb(triangle);
		prev_trigger_initial_unit[triangle.id] = trigger_initial_unit;
	}
	unlock();
}

async function onAARequest(objAARequest, arrResponses) {
	const address = objAARequest.unit.authors[0].address;
	if (address === operator.getAddress())
		return console.log(`skipping our own request`);
	if (arrResponses[0].bounced)
		return console.log(`trigger ${objAARequest.unit.unit} from ${address} will bounce`, arrResponses[0].response.error);
	const aas = arrResponses.map(r => r.aa_address);
	console.log(`request from ${address} trigger ${objAARequest.unit.unit} affected AAs`, aas);
	const triangles = getAffectedTriangles(aas);
	console.log(`affected triangles`, triangles);
	if (triangles.length === 0)
		return;
	await waitForAaStateToEmpty();
	for (let triangle of triangles)
		await queueEstimateAndArb(triangle);
}

function getAffectedTriangles(aas) {
	let affected_triangles = [];
	for (let aa of aas) {
		const triangles = trianglesByOswap[aa];
		if (triangles)
			affected_triangles = affected_triangles.concat(triangles);
	}
	return _.uniq(affected_triangles);
}

async function waitForStability() {
	const last_mci = await device.requestFromHub('get_last_mci', null);
	console.log(`last mci ${last_mci}`);
	while (true) {
		await wait(60 * 1000);
		const props = await device.requestFromHub('get_last_stable_unit_props', null);
		const { main_chain_index } = props;
		console.log(`last stable mci ${main_chain_index}`);
		if (main_chain_index >= last_mci)
			break;
	}
	console.log(`mci ${last_mci} is now stable`);
}

async function initArbList() {
	if (!conf.owner)
		throw Error(`no owner`);
	const rows = await dag.getAAsByBaseAAs(conf.arb_base_aas);
	arb_aas = [];
	my_arb_aas = [];
	for (let { address, definition } of rows) {
		arb_aas.push(address);
		if (definition[1].params.owner === conf.owner && address.startsWith('22'))
			my_arb_aas.push(address);
	}
	console.log('my arb AAs', my_arb_aas);
	console.log('all arb AAs', arb_aas);
}

function addAsset(asset, oswap_aa) {
	if (!oswapsByAsset[asset])
		oswapsByAsset[asset] = [];
	oswapsByAsset[asset].push(oswap_aa);
}

function getPair(x_asset, y_asset) {
	return x_asset < y_asset ? x_asset + '_' + y_asset : y_asset + '_' + x_asset;
}

function addPair(x_asset, y_asset, oswap_aa) {
	const pair = getPair(x_asset, y_asset);
	if (!oswapsByPair[pair])
		oswapsByPair[pair] = [];
	oswapsByPair[pair].push(oswap_aa);
	oppositeAssets[oswap_aa] = {
		[x_asset]: y_asset,
		[y_asset]: x_asset,
	};
}

async function initOswapList() {
	if (!conf.oswap_base_aas)
		throw Error(`no conf.oswap_base_aas`);
	const rows = await dag.getAAsByBaseAAs(conf.oswap_base_aas);
	for (let { address, definition } of rows) {
		const { x_asset, y_asset } = definition[1].params;
		const balances = await dag.readAABalances(address);
	//	console.error(address, balances);
		if (!balances[x_asset] || !balances[y_asset]) {
			console.log(`skipping empty oswap`, address);
			continue;
		}
		await aa_state.followAA(address);
		oswapInfos[address] = { x_asset, y_asset };
		addAsset(x_asset, address);
		addAsset(y_asset, address);
		addPair(x_asset, y_asset, address);
	}
	console.log('all oswap AAs', oswapsByAsset);
}

function addTriangle(pool, triangle) {
	if (!trianglesByOswap[pool])
		trianglesByOswap[pool] = [];
	trianglesByOswap[pool].push(triangle);
}

async function findTriangles(asset) {
	const { symbol: A } = await getAssetInfo(asset);
	const entry_oswap_aas = oswapsByAsset[asset];
//	console.error({entry_oswap_aas})
	for (let i = 0; i < entry_oswap_aas.length; i++){
		const poolAB = entry_oswap_aas[i];
		const assetB = oppositeAssets[poolAB][asset];
		for (let j = i + 1; j < entry_oswap_aas.length; j++){
			const poolAC = entry_oswap_aas[j];
			const assetC = oppositeAssets[poolAC][asset];
			const poolBCs = oswapsByPair[getPair(assetB, assetC)];
			if (poolBCs) {
				const { symbol: B } = await getAssetInfo(assetB);
				const { symbol: C } = await getAssetInfo(assetC);
				const symbols = [A, B, C];
				for (const poolBC of poolBCs) {
					const arb_aa = arbByAsset[asset];
					const oswap_aas = [poolAB, poolBC, poolAC];
					const id = arb_aa + '-' + symbols.join(',') + '-' + oswap_aas.join(',');
					const triangle = {
						asset,
						arb_aa,
						id,
						oswap_aas,
						symbols,
					};
					triangles.push(triangle);
					addTriangle(poolAB, triangle);
					addTriangle(poolBC, triangle);
					addTriangle(poolAC, triangle);
				}
			}
		}
	}
}

async function findAllTriangles() {
	for (let asset in arbByAsset)
		await findTriangles(asset);
	console.log('triangles', triangles);
}


async function addArb(arb_aa) {
	console.log(`adding arb ${arb_aa}`);
	await aa_state.followAA(arb_aa);

	const { asset } = await dag.readAAParams(arb_aa);
	if (!asset)
		throw Error(`no asset in arb: ${arb_aa}`);
	
	if (my_arb_aas.includes(arb_aa)) {
		arbByAsset[asset] = arb_aa;
	}
}

async function loadLibs() {
	for (let address of conf.lib_aas) {
	//	await dag.loadAA(address);
		const definition = await dag.readAADefinition(address);
		const payload = { address, definition };
		await storage.insertAADefinitions(db, [payload], constants.GENESIS_UNIT, 0, false);
	}
}

async function watchForNewArbs() {
	for (let aa of conf.arb_base_aas) {
		await dag.loadAA(aa);
		network.addLightWatchedAa(aa); // to learn when new arb AAs are defined based on it
	}
	for (let aa of conf.arb_base_aas) {
		eventBus.on("aa_definition_applied-" + aa, async (address, definition) => {
			console.log(`new arb defined ${address}`);
			const owner = definition[1].params.owner;
			if (owner === conf.owner)
				my_arb_aas.push(address);
			arb_aas.push(address);
			await addArb(address);
		});
	}
}


async function watchBuffers() {
	const rows = await dag.getAAsByBaseAAs(conf.buffer_base_aas);
	for (let { address, definition } of rows) {
		let curve_aa = definition[1].params.curve_aa;
		await CurveAA.create(curve_aa);
		await aa_state.followAA(address);
	}
}

async function watchForNewBuffers() {
	for (let aa of conf.buffer_base_aas) {
		await dag.loadAA(aa);
		network.addLightWatchedAa(aa); // to learn when new buffer AAs are defined based on it
	}
	for (let aa of conf.buffer_base_aas) {
		eventBus.on("aa_definition_applied-" + aa, async (address, definition) => {
			let curve_aa = definition[1].params.curve_aa;
			if (CurveAA.get(curve_aa))
				await aa_state.followAA(address);
		});
	}
}

async function watchOstableOswapArbs() {
	const rows = await dag.getAAsByBaseAAs(conf.ostable_oswap_arb_base_aas);
	for (let { address, definition } of rows) {
		const { stable_aa, stable_oswap_aa, reserve_oswap_aa } = definition[1].params;
		const { curve_aa } = await dag.readAAParams(stable_aa);
		await CurveAA.create(curve_aa);
		await aa_state.followAA(address);
		await aa_state.followAA(stable_aa);
		await aa_state.followAA(stable_oswap_aa);
		await aa_state.followAA(reserve_oswap_aa);
	}
}

async function watchOswapTokenArbs() {
	const rows = await dag.getAAsByBaseAAs(conf.oswap_token_arb_base_aas);
	for (let { address, definition } of rows) {
		const { oswap_token_aa, oswap_v2_aa } = definition[1].params;
		await aa_state.followAA(address);
		await aa_state.followAA(oswap_token_aa);
		await aa_state.followAA(oswap_v2_aa);

		const oracle = await dag.executeGetter(oswap_token_aa, 'get_oracle');
		await light_data_feeds.updateDataFeed(oracle, 'TVL');
	}
}

async function startWatching() {
	await loadLibs();
	await initArbList();
	for (let arb_aa of arb_aas)
		await addArb(arb_aa);
	await watchForNewArbs();

	await initOswapList();
	await findAllTriangles();

	// init the buffers linked to the watched curves
	await watchBuffers();
	await watchForNewBuffers();

	await watchOstableOswapArbs();
	await watchOswapTokenArbs();

	await light_wallet.waitUntilFirstHistoryReceived();

	await waitForStability();

	eventBus.on("aa_request_applied", onAARequest);
	eventBus.on("aa_response_applied", onAAResponse);

	await exchangeNonMainAssets();
	setInterval(exchangeNonMainAssets, 2 * 3600 * 1000);

	setTimeout(estimateAndArbAll, 1000);
}


exports.startWatching = startWatching;

