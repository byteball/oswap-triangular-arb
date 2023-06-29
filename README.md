# Autonomous agent and bot for triangular arbitrage among Oswap pools

The bot finds triangles among Oswap pools, such as AB-BC-CA (where A, B, and C are tokens), and looks for opportunities to make money by trading along the triangle, e.g.:

1. swap A to B via pool AB
1. swap B received in the previous step to swap it to C via pool BC
1. swap C received in the previous step to swap it to A via pool CA

If the amount of A received in the final step is greater than the input amount in the first step, an arbitrage opportunity exists, and the bot trades.

The trades are executed by an AA that stores the trading capital and ensures that either all 3 trades succeed or none, and that it earns a profit. The AA is triggered by the companion bot when it sees an opportunity for a profitable arbitrage.


## Usage

The base AA is already deployed (see its addresses by opening `oswap-triangular-arb.oscript` in VS Code with [Oscript plugin](https://marketplace.visualstudio.com/items?itemName=obyte.oscript-vscode-plugin)), deploy your personal arbitrage AA by indicating your address in the `owner` field of your `conf.json` and running
```bash
node deploy.js
```
This deploys an arb AA whose capital is in GBYTE and all triangles must have two GBYTE pairs. Edit the `deploy.js` script to deploy a bot with a different main asset.

Run the bot:
```bash
node run.js oswap-triangular-arb 2>errlog
```

Add some money to your arb AA and a small amount (for network fees) to the bot's balance.


### Run tests
```bash
yarn test
```

