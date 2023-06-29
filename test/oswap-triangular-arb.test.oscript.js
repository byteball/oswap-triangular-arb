// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const { promisify } = require('util')
const path = require('path')
const fs = require('fs')
const _ = require('lodash')
const objectHash = require("ocore/object_hash.js");
//const { expect } = require('chai');
const parseOjson = require('ocore/formula/parse_ojson').parse

async function getAaAddress(aa_src) {
	return objectHash.getChash160(await promisify(parseOjson)(aa_src));
}



describe('Oswap triangular arb', function () {
	this.timeout(1200000)


	before(async () => {
		console.error('--- starting')

		const arb_lib = fs.readFileSync(path.join(__dirname, '../triangular-lib.oscript'), 'utf8');
		const arb_lib_address = await getAaAddress(arb_lib);
		let arb_base = fs.readFileSync(path.join(__dirname, '../oswap-triangular-arb.oscript'), 'utf8');
		arb_base = arb_base.replace(/\$lib_aa = '\w{32}'/, `$lib_aa = '${arb_lib_address}'`)

		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ assetA: {} })
			.with.asset({ assetB: {} })
			.with.asset({ assetC: {} })

			.with.agent({ lbc: path.join(__dirname, '../node_modules/oswap-v2-aa/linear-bonding-curve.oscript') })
			.with.agent({ pool_lib: path.join(__dirname, '../node_modules/oswap-v2-aa/pool-lib.oscript') })
			.with.agent({ pool_lib_by_price: path.join(__dirname, '../node_modules/oswap-v2-aa/pool-lib-by-price.oscript') })
			.with.agent({ governance_base: path.join(__dirname, '../node_modules/oswap-v2-aa/governance.oscript') })
			.with.agent({ v2Pool: path.join(__dirname, '../node_modules/oswap-v2-aa/pool.oscript') })
			.with.agent({ v2OswapFactory: path.join(__dirname, '../node_modules/oswap-v2-aa/factory.oscript') })

			.with.agent({ arb_lib: path.join(__dirname, '../triangular-lib.oscript') })
			.with.agent({ arb_base })

			.with.wallet({ alice: {base: 10000e9, assetA: 1000e9, assetB: 1000e9, assetC: 1000e9} })
			.with.wallet({ bob: {base: 1000e9, assetA: 1000e9, assetB: 1000e9, assetC: 1000e9} })
			.with.explorer()
			.run()

		this.assetA = this.network.asset.assetA
		this.assetB = this.network.asset.assetB
		this.assetC = this.network.asset.assetC
		console.error('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)

		this.reserve_asset = 'base'

		this.executeGetter = async (aaAddress, getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress,
				getter,
				args
			})
			if (error)
				console.log(error)
			expect(error).to.be.null
			return result
		}

		this.get_price = async (aaAddress, asset_label, bAfterInterest = true) => {
			return await this.executeGetter(aaAddress, 'get_price', [asset_label, 0, 0, bAfterInterest])
		}

		this.get_leveraged_price = async (aaAddress, asset_label, L) => {
			return await this.executeGetter(aaAddress, 'get_leveraged_price', [asset_label, L, true])
		}



		this.printAllLogs = async (response) => {
			const { response_unit, logs, aa_address, response: { responseVars } } = response
			console.log('logs', aa_address, JSON.stringify(logs, null, 2))
			console.log('resp vars', responseVars)
			if (!response_unit)
				return;
			const { unitObj } = await this.alice.getUnitInfo({ unit: response_unit })
			const payments = Utils.getExternalPayments(unitObj)
			const addresses = _.uniq(payments.map(p => p.address)).sort()
			for (let aa of addresses) {
				const { response } = await this.network.getAaResponseToUnitByAA(response_unit, aa)
				if (response)
					await this.printAllLogs(response);
			}
		}

	})



	it('Bob defines AB pool', async () => {
		this.base_interest_rate = 0//.3
		this.swap_fee = 0.003
		this.exit_fee = 0.005
		this.leverage_profit_tax = 0.1
		this.arb_profit_tax = 0.9
		this.alpha = 0.5
		this.beta = 1 - this.alpha
		this.pool_leverage = 10
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.v2OswapFactory,
			amount: 10000,
			data: {
				x_asset: this.assetA,
				y_asset: this.assetB,
				swap_fee: this.swap_fee,
				exit_fee: this.exit_fee,
				leverage_profit_tax: this.leverage_profit_tax,
				arb_profit_tax: this.arb_profit_tax,
				base_interest_rate: this.base_interest_rate,
				alpha: this.alpha,
				pool_leverage: this.pool_leverage,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.AB_aa = response.response.responseVars.address
		expect(this.AB_aa).to.be.validAddress

		this.AB_bounce_fees = /*this.x_asset !== 'base' && */{ base: [{ address: this.AB_aa, amount: 1e4 }] }
	})
	

	it('Bob defines BC pool', async () => {
		this.base_interest_rate = 0//.3
		this.swap_fee = 0.003
		this.exit_fee = 0.005
		this.leverage_profit_tax = 0.1
		this.arb_profit_tax = 0.9
		this.alpha = 0.5
		this.beta = 1 - this.alpha
		this.pool_leverage = 10
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.v2OswapFactory,
			amount: 10000,
			data: {
				x_asset: this.assetB,
				y_asset: this.assetC,
				swap_fee: this.swap_fee,
				exit_fee: this.exit_fee,
				leverage_profit_tax: this.leverage_profit_tax,
				arb_profit_tax: this.arb_profit_tax,
				base_interest_rate: this.base_interest_rate,
				alpha: this.alpha,
				pool_leverage: this.pool_leverage,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.BC_aa = response.response.responseVars.address
		expect(this.BC_aa).to.be.validAddress

		this.BC_bounce_fees = /*this.x_asset !== 'base' && */{ base: [{ address: this.BC_aa, amount: 1e4 }] }
	})
	

	it('Bob defines CA pool', async () => {
		this.base_interest_rate = 0//.3
		this.swap_fee = 0.003
		this.exit_fee = 0.005
		this.leverage_profit_tax = 0.1
		this.arb_profit_tax = 0.9
		this.alpha = 0.5
		this.beta = 1 - this.alpha
		this.pool_leverage = 10
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.v2OswapFactory,
			amount: 10000,
			data: {
				x_asset: this.assetC,
				y_asset: this.assetA,
				swap_fee: this.swap_fee,
				exit_fee: this.exit_fee,
				leverage_profit_tax: this.leverage_profit_tax,
				arb_profit_tax: this.arb_profit_tax,
				base_interest_rate: this.base_interest_rate,
				alpha: this.alpha,
				pool_leverage: this.pool_leverage,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		this.CA_aa = response.response.responseVars.address
		expect(this.CA_aa).to.be.validAddress

		this.CA_bounce_fees = /*this.x_asset !== 'base' && */{ base: [{ address: this.CA_aa, amount: 1e4 }] }
	})
	
	
	it('Bob defines a new arbitrage AA', async () => {
		const params = {
			asset: this.assetA,
			owner: this.bobAddress,
			nonce: 0,
		}
		const definition = ['autonomous agent', {
			base_aa: this.network.agent.arb_base,
			params
		}];
		do {
			params.nonce++;
			this.arb_aa = objectHash.getChash160(definition);
		}
		while (!this.arb_aa.startsWith('22'));
		console.log('arb AA', this.arb_aa, params)
		const { unit, error } = await this.bob.sendMulti({
			messages: [{
				app: 'definition',
				payload: {
					address: this.arb_aa,
					definition,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Alice sends money to arbitrage AA', async () => {
		const amount = 100e9
		this.arb_asset = this.assetA

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.arb_aa, amount: 1e4 }],
				[this.arb_asset]: [{ address: this.arb_aa, amount: amount }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq('added')
	})


	it('Bob authorizes Alice to manage the arbitrage AA', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				add_manager: 1,
				manager: this.aliceAddress,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq(`added ${this.aliceAddress} as manager`)
	})



	it('Alice adds liquidity to AB pool', async () => {
		const amountA = 40e9
		const amountB = 60e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.AB_aa, amount: 1e4 }],
				[this.assetA]: [{ address: this.AB_aa, amount: amountA }],
				[this.assetB]: [{ address: this.AB_aa, amount: amountB }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(JSON.parse(response.response.responseVars.event).type).to.be.equal("add")
	})

	it('Alice adds liquidity to BC pool', async () => {
		const amountB = 50e9
		const amountC = 100e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.BC_aa, amount: 1e4 }],
				[this.assetB]: [{ address: this.BC_aa, amount: amountB }],
				[this.assetC]: [{ address: this.BC_aa, amount: amountC }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(JSON.parse(response.response.responseVars.event).type).to.be.equal("add")
	})


	it('Alice adds liquidity to CA pool', async () => {
		const amountC = 200e9
		const amountA = 150e9
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.CA_aa, amount: 1e4 }],
				[this.assetC]: [{ address: this.CA_aa, amount: amountC }],
				[this.assetA]: [{ address: this.CA_aa, amount: amountA }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(JSON.parse(response.response.responseVars.event).type).to.be.equal("add")
	})




	it('Alice buys positive L-tokens in AB', async () => {
	//	return;
		const x_change = 0
		const delta_Xn = -300e6
		const L = 5
		const result = await this.executeGetter(this.AB_aa, 'get_leveraged_trade_amounts', [this.assetA, L, delta_Xn, 0, this.aliceAddress])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, initial_price, final_price } = result
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(shares)
		
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.assetA]: [{address: this.AB_aa, amount: gross_delta + x_change}],
				...this.AB_bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: this.assetA,
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const final_x5_leveraged_price = await this.get_leveraged_price(this.AB_aa, this.assetA, 5)
		console.log({ final_x5_leveraged_price })
		expect(final_x5_leveraged_price).to.be.gt(1)
		expect(final_x5_leveraged_price).to.be.gt(avg_share_price)
	})
	

	it('Alice buys negative L-tokens in BC', async () => {
	//	return;
		const delta_Xn = -100e6
		const L = 10
		const result = await this.executeGetter(this.BC_aa, 'get_leveraged_trade_amounts', [this.assetC, L, delta_Xn, 0, this.aliceAddress])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, initial_price, final_price } = result
		expect(leveraged_balances[-L + 'x'].supply).to.be.eq(shares)
		
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.assetC]: [{ address: this.BC_aa, amount: gross_delta }],
				...this.BC_bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: this.assetC,
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.BC_aa)
		console.log('vars', vars)

		const final_y10_leveraged_price = await this.get_leveraged_price(this.BC_aa, this.assetC, 10)
		console.log({ final_y10_leveraged_price })
		expect(final_y10_leveraged_price).to.be.gt(1)
		expect(final_y10_leveraged_price).to.be.gt(avg_share_price)
	})
	

	
	it('Alice triggers arbitrage to arb along the A-B-C-A path', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({initial_balances})

		const initial_AB_price = await this.get_price(this.AB_aa, this.assetA)
		const initial_BC_price = await this.get_price(this.BC_aa, this.assetB)
		const initial_CA_price = await this.get_price(this.CA_aa, this.assetC)
		const initial_AB2_price = 1 / initial_BC_price / initial_CA_price
		console.log({ initial_AB_price, initial_BC_price, initial_CA_price, initial_AB2_price })
		console.log('oswap_aas', [this.AB_aa, this.BC_aa, this.CA_aa])

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			//	asset: this.arb_asset,
				oswap_aas: [this.AB_aa, this.BC_aa, this.CA_aa],
				share: 0.15,
				secondary_share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal("will arb by selling A to AB, then B to BC, then C to CA")
		console.log(response.response.responseVars);


		const AB_price = await this.get_price(this.AB_aa, this.assetA)
		const BC_price = await this.get_price(this.BC_aa, this.assetB)
		const CA_price = await this.get_price(this.CA_aa, this.assetC)
		const AB2_price = 1 / BC_price / CA_price
		console.log({ AB_price, BC_price, CA_price, AB2_price })

		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})
	
	
	it('Alice triggers arbitrage 2 to arb along the A-B-C-A path', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({initial_balances})

		const initial_AB_price = await this.get_price(this.AB_aa, this.assetA)
		const initial_BC_price = await this.get_price(this.BC_aa, this.assetB)
		const initial_CA_price = await this.get_price(this.CA_aa, this.assetC)
		const initial_AB2_price = 1 / initial_BC_price / initial_CA_price
		console.log({ initial_AB_price, initial_BC_price, initial_CA_price, initial_AB2_price })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
				asset: this.arb_asset,
				oswap_aas: [this.AB_aa, this.BC_aa, this.CA_aa],
				share: 0.15,
				secondary_share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal("will arb by selling A to AB, then B to BC, then C to CA")
		console.log(response.response.responseVars);


		const AB_price = await this.get_price(this.AB_aa, this.assetA)
		const BC_price = await this.get_price(this.BC_aa, this.assetB)
		const CA_price = await this.get_price(this.CA_aa, this.assetC)
		const AB2_price = 1 / BC_price / CA_price
		console.log({ AB_price, BC_price, CA_price, AB2_price })

		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})
	
	
	it('Alice triggers arbitrage 3 to arb along the A-B-C-A path', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({initial_balances})

		const initial_AB_price = await this.get_price(this.AB_aa, this.assetA)
		const initial_BC_price = await this.get_price(this.BC_aa, this.assetB)
		const initial_CA_price = await this.get_price(this.CA_aa, this.assetC)
		const initial_AB2_price = 1 / initial_BC_price / initial_CA_price
		console.log({ initial_AB_price, initial_BC_price, initial_CA_price, initial_AB2_price })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
				asset: this.arb_asset,
				oswap_aas: [this.AB_aa, this.BC_aa, this.CA_aa],
				share: 0.15,
				secondary_share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal("will arb by selling A to AB, then B to BC, then C to CA")
		console.log(response.response.responseVars);


		const AB_price = await this.get_price(this.AB_aa, this.assetA)
		const BC_price = await this.get_price(this.BC_aa, this.assetB)
		const CA_price = await this.get_price(this.CA_aa, this.assetC)
		const AB2_price = 1 / BC_price / CA_price
		console.log({ AB_price, BC_price, CA_price, AB2_price })

		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})
	
	it('Alice triggers exchange of assetB', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({ initial_balances }, { A: this.assetA, B: this.assetB, C: this.assetC})

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				exchange: 1,
				oswap_aa: this.AB_aa,
				share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal(`will exchange ${this.assetB} to main asset`)
		console.log(response.response.responseVars);

		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})

/*
	it('Alice triggers arbitrage again after buying', async () => {
	//	process.exit()
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)
		console.log('arb logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.eq("no arb opportunity exists")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

		expect(1).to.eq(0)
	})*/

	
	it('Alice sells A to AB pool in order to lower its price and increase the B price', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_AB_price = await this.get_price(this.AB_aa, this.assetA)
		const initial_BC_price = await this.get_price(this.BC_aa, this.assetB)
		const initial_CA_price = await this.get_price(this.CA_aa, this.assetC)
		const initial_AB2_price = 1 / initial_BC_price / initial_CA_price
		console.log({ initial_AB_price, initial_BC_price, initial_CA_price, initial_AB2_price })

		const final_price = 1/initial_AB_price * 2.5
		console.log({ initial_AB_price, final: 1/final_price })

		const shifts_and_bounds = await this.executeGetter(this.AB_aa, 'get_shifts_and_bounds')
		console.log({shifts_and_bounds})
		const result = await this.executeGetter(this.AB_aa, 'get_swap_amounts_by_final_price', [this.assetA, final_price])
		const Y_amount = result.in

		const { unit, error } = await this.alice.sendMulti({
			asset: this.assetA,
			base_outputs: [{address: this.AB_aa, amount: 1e4}],
			asset_outputs: [{address: this.AB_aa, amount: Y_amount}],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
					final_price,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(JSON.parse(response.response.responseVars.event).type).to.be.equal("swap")
	})


	
	it('Alice triggers arbitrage to arb along the A-C-B-A path', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({initial_balances})

		const initial_AB_price = await this.get_price(this.AB_aa, this.assetA)
		const initial_BC_price = await this.get_price(this.BC_aa, this.assetB)
		const initial_CA_price = await this.get_price(this.CA_aa, this.assetC)
		const initial_AB2_price = 1 / initial_BC_price / initial_CA_price
		console.log({ initial_AB_price, initial_BC_price, initial_CA_price, initial_AB2_price })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
				asset: this.arb_asset,
				oswap_aas: [this.AB_aa, this.BC_aa, this.CA_aa],
			//	share: 0.99,
			//	secondary_share: 0.99,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	expect(response.response.responseVars.message).to.be.equal("will arb by selling A to AB, then B to BC, then C to CA")
		expect(response.response.responseVars.message).to.be.equal("will arb by selling A to AC, then C to CB, then B to BA")
		console.log(response.response.responseVars);


		const AB_price = await this.get_price(this.AB_aa, this.assetA)
		const BC_price = await this.get_price(this.BC_aa, this.assetB)
		const CA_price = await this.get_price(this.CA_aa, this.assetC)
		const AB2_price = 1 / BC_price / CA_price
		console.log({ AB_price, BC_price, CA_price, AB2_price })

		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})
	
	/*
	it('Alice triggers arbitrage again after selling', async () => {
		await this.network.timetravel({ shift: '1h' })
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		console.log(response.response.responseVars);
		expect(response.response.error).to.be.eq("no arb opportunity exists")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})*/
	

	it('Bob withdraws the funds', async () => {
		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);

		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				asset: this.assetC
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		const payments = Utils.getExternalPayments(unitObj)
		expect(payments.length).to.eq(1)
		const payment = payments[0]
		expect(payment.asset).to.be.eq(this.assetC)
		expect(payment.address).to.be.eq(this.bobAddress)
		expect(payment.amount).to.be.eq(initial_balances[this.assetC].total)
		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})
		expect(final_balances[this.assetC]).to.be.undefined

	})


	after(async () => {
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
