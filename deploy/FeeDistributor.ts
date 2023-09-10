import "@nomiclabs/hardhat-ethers"
import "hardhat-deploy"
import { HardhatRuntimeEnvironment } from "hardhat/types"

module.exports = async function (hre: HardhatRuntimeEnvironment) {
    const { deployments, getNamedAccounts } = hre
    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    const votingEscrow = await deployments.get("VotingEscrow")
    const startTime = Date.UTC(2023, 8, 7) / 1000

    await deploy("FeeDistributor", {
        from: deployer,
        args: [votingEscrow.address, startTime],
        skipIfAlreadyDeployed: true,
        log: true,
        waitConfirmations: 1,
    })
}

module.exports.tags = ["FeeDistributor"]
