import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-etherscan"
import "@nomiclabs/hardhat-waffle"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"
import "dotenv/config"

function accounts() {
    return { mnemonic: process.env.MNEMONIC }
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
    namedAccounts: {
        deployer: {
            default: 0, // wallet address 0, of the mnemonic in .env
        },
    },
    networks: {
        ethereum: {
            url: process.env.RPC_URL_ETHEREUM,
            chainId: 1,
            accounts: accounts(),
        },
        bsc: {
            url: process.env.RPC_URL_BSC,
            chainId: 56,
            accounts: accounts(),
        },
        avalanche: {
            url: process.env.RPC_URL_AVALANCHE,
            chainId: 43114,
            accounts: accounts(),
        },
        polygon: {
            url: process.env.RPC_URL_POLYGON,
            chainId: 137,
            accounts: accounts(),
        },
        arbitrum: {
            url: process.env.RPC_URL_ARBITRUM,
            chainId: 42161,
            accounts: accounts(),
        },
        optimism: {
            url: process.env.RPC_URL_OPTIMISM,
            chainId: 10,
            accounts: accounts(),
        },
        fantom: {
            url: process.env.RPC_URL_FANTOM,
            chainId: 250,
            accounts: accounts(),
        },
    },
}

export default config