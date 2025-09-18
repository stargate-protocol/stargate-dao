import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-etherscan"
import "@nomiclabs/hardhat-waffle"
import "hardhat-deploy"
import "hardhat-deploy-ethers"
import { HardhatUserConfig } from "hardhat/config"
import "solidity-coverage"
import "dotenv/config"
import type { NetworksUserConfig } from "hardhat/types"
import { join } from "path"
import "./task/get-users-accounts"

function accounts() {
    return { mnemonic: process.env.MNEMONIC }
}

const networks: NetworksUserConfig = {
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
}

const externalConfig: HardhatUserConfig["external"] = {
    deployments: Object.fromEntries(
        Object.keys(networks).map((networkName) => [networkName, [join(__dirname, "deployments", networkName)]] as const)
    ),
}

const updateNetworkRpcUrls = (networks: NetworksUserConfig): NetworksUserConfig => {
    return Object.fromEntries(
        Object.entries(networks).map(([networkName, networkConfig]) => {
            if (networkConfig && "url" in networkConfig) {
                // Only use dynamic URL if the static one is undefined and template exists
                if (!networkConfig.url && process.env.RPC_URL_MAINNET) {
                    const dynamicUrl = getRpcUrl(networkName)
                    return [networkName, { ...networkConfig, url: dynamicUrl }]
                }
            }
            return [networkName, networkConfig]
        })
    )
}

const getRpcUrl = (chainName: string): string | null => {
    let templateUrl = process.env.RPC_URL_MAINNET
    if (!templateUrl) return null
    const url = templateUrl.replace("CHAIN", chainName)

    console.log("====> url", url)
    return url
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
        ...updateNetworkRpcUrls(networks),
    },
    external: externalConfig,
}

export default config
