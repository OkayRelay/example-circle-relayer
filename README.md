# Example-Circle-Relayer

Please start by reading the [design document](https://github.com/wormhole-foundation/example-circle-relayer/blob/main/DESIGN.md).

## Prerequisites

Install [Foundry tools](https://book.getfoundry.sh/getting-started/installation), which include `forge`, `anvil` and `cast` CLI tools.

## Build

Run the following commands to install necessary dependencies and to build the smart contracts:

```
cd evm
make dependencies
make build
```

## Testnet Contract Deployment

Before deploying the contracts, set the `Deployment Variables` in the following files:

- `evm/env/avax-fuji-testnet.env`
- `evm/env/eth-goerli-testnet.env`

Then deploy the contracts to testnet by executing the following commands:

```

# goerli
. env/eth-goerli-testnet.env && PRIVATE_KEY=put_your_private_key_here bash shell-scripts/deploy_circle_relayer.sh

# fuji
. env/avax-fuji-testnet.env && PRIVATE_KEY=put_your_private_key_here bash shell-scripts/deploy_circle_relayer.sh

```

## Testnet Contract Registration

After deploying the contracts, set the `Contract Registration Environment Variables` in the following files:

- `evm/env/avax-fuji-testnet.env`
- `evm/env/eth-goerli-testnet.env`

Then register the contracts by executing the following commands:

```
# goerli
. env/eth-goerli-testnet.env && PRIVATE_KEY=put_your_private_key_here bash shell-scripts/register_contracts.sh

# fuji
. env/avax-fuji-testnet.env && PRIVATE_KEY=put_your_private_key_here bash shell-scripts/register_contracts.sh
```

## Testing Environment

There are currently no solidity-based units tests or local-validator integration tests written to support the Circle-Relayer contracts. However, the testing environments have been set up, and we encourage integrators to thoroughly test the contracts before deploying to mainnet. The testing environments can be found in the following locations:

- [Unit Tests](https://github.com/wormhole-foundation/example-circle-relayer/blob/main/evm/forge-test/CircleRelayer.t.sol)
- [Integration Tests](https://github.com/wormhole-foundation/example-circle-relayer/tree/main/evm/ts-test)

Once tests have been written, they can be executed with the following commands:

```
# unit tests
make unit-test

# local-validator integration tests
make integration-test

# unit tests and local-validator integration tests
make test
```
