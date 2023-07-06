import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-etherscan"
import "@nomiclabs/hardhat-waffle"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import {HardhatUserConfig} from "hardhat/config"
import "solidity-coverage"
import "dotenv/config"

function getMnemonic(network?: string) {
    if (network) {
        const mnemonic = process.env["MNEMONIC_" + network.toUpperCase()]
        if (mnemonic && mnemonic !== "") {
            return mnemonic
        }
    }

    const mnemonic = process.env.MNEMONIC
    if (!mnemonic || mnemonic === "") {
        return "test test test test test test test test test test test junk"
    }
    return mnemonic
}

function accounts(endpointKey?: string) {
    return {mnemonic: getMnemonic(endpointKey)}
}

const config: HardhatUserConfig = {
    solidity: {
        compilers: [
            {
                version: "0.7.6",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 9999,
                    },
                },
            },
            {
                version: "0.8.4",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 9999,
                    },
                },
            },
        ],
    },
    networks: {
        ethereum: {
            url: "https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
            chainId: 1,
            accounts: accounts(),
        },
        bsc: {
            url: "https://bsc-dataseed1.binance.org",
            chainId: 56,
            accounts: accounts(),
        },
        avalanche: {
            url: "https://api.avax.network/ext/bc/C/rpc",
            chainId: 43114,
            accounts: accounts(),
        },
        polygon: {
            url: "https://rpc-mainnet.maticvigil.com",
            chainId: 137,
            accounts: accounts(),
        },
        arbitrum: {
            url: `https://arb1.arbitrum.io/rpc`,
            chainId: 42161,
            accounts: accounts(),
        },
        optimism: {
            url: `https://mainnet.optimism.io`,
            chainId: 10,
            accounts: accounts(),
        },
        fantom: {
            url: `https://rpcapi.fantom.network`,
            chainId: 250,
            accounts: accounts(),
        },
    },
}

export default config