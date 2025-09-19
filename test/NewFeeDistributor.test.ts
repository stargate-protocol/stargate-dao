import { expect } from "chai"
import { ethers, network } from "hardhat"
import { REWARD_TOKEN_BY_CHAIN, USERS_BY_CHAIN } from "./helpers/constants"
import fs from "fs"
import path from "path"
import { BigNumber, Contract } from "ethers"
import { getRpcUrl } from "../hardhat.config"

describe.only("Fork parity using deployments + per-chain token constant", async function () {
    describe("test ethereum ", async function () {
        const chainName = "ethereum"
        testGivenChainNameAndUserIndex(chainName)
    })

    describe("test arbitrum", async function () {
        const chainName = "arbitrum"
        testGivenChainNameAndUserIndex(chainName)
    })
})

interface ContractAddresses {
    ve: string
    oldFD: string
    newFD: string
}

async function testGivenChainNameAndUserIndex(chainName: string) {
    const usersLength = USERS_BY_CHAIN[chainName].length

    // Declare here; set them in `before`
    let ve!: string
    let oldFD!: string
    let newFD!: string

    before(async function () {
        // 1) Get deployed contract addresses from local files
        oldFD = getDeploymentAddress("FeeDistributor", chainName)
        ve = getDeploymentAddress("VotingEscrow", chainName)

        // 2) Fork to the chain
        await forkTo(chainName)

        // 3) Deploy newFD on the fork
        const NewFD = await ethers.getContractFactory("NewFeeDistributor")
        const deployed = await NewFD.deploy(oldFD)
        await deployed.deployed() // ensure code is there
        newFD = deployed.address
    })

    describe("test all users", function () {
        for (let i = 0; i < usersLength; i++) {
            // NOTE: do NOT pass an object with ve/oldFD/newFD here.
            // Those values will be read inside the test after `before` runs.
            specificUserBehavior(chainName, i, () => ({ ve, oldFD, newFD }))
        }
    })
}

function specificUserBehavior(chainName: string, userIndex: number, addrs: () => ContractAddresses) {
    const userAddress = USERS_BY_CHAIN[chainName][userIndex]
    const rewardToken = REWARD_TOKEN_BY_CHAIN[chainName]

    it(`Pre-unlock: old.callStatic == new.callStatic for user ${userIndex}`, async function () {
        console.log("here1", userAddress)
        const { ve, oldFD, newFD } = addrs()

        const user = await impersonate(userAddress)
        const oldFDContract = await ethers.getContractAt("FeeDistributor", oldFD)

        // 1) Set unlocked=false on ve
        const veContract = await ethers.getContractAt("VotingEscrow", ve)
        await setUnlocked(veContract, false)

        // 2) Amount old FD would pay
        const amountOldFD = await oldFDContract.connect(user).callStatic.claimToken(userAddress, rewardToken)
        // expect(amountOldFD).to.be.gt(0)

        // 3) Lock back the ve
        await setUnlocked(veContract, true)

        // 4) New FD on fork
        const newFDContract = await ethers.getContractAt("NewFeeDistributor", newFD)

        // 5) Move tokens from oldFD to newFD
        await fundNewFD(rewardToken, oldFD, newFD)

        // 6) Check new amount
        const amountNewFD = await newFDContract.connect(user).callStatic.claimToken(userAddress, rewardToken)

        // 7) Compare
        expect(amountNewFD).to.equal(amountOldFD)
        console.log("amountNewFD", amountNewFD.toString())
        console.log("amountOldFD", amountOldFD.toString())
    })

    it("Gas estimate", async function () {
        const { ve, oldFD, newFD } = addrs()

        await forkTo(chainName)

        const user = await impersonate(userAddress)
        const oldFDContract = await ethers.getContractAt("FeeDistributor", oldFD)

        // 1) unlocked=false
        const veContract = await ethers.getContractAt("VotingEscrow", ve)
        await setUnlocked(veContract, false)

        // 2) Gas old
        const gasOld = await oldFDContract.connect(user).estimateGas.claimToken(userAddress, rewardToken)

        // 3) Lock back
        await setUnlocked(veContract, true)

        // 4) New FD + fund
        const newFDContract = await ethers.getContractAt("NewFeeDistributor", newFD)
        await fundNewFD(rewardToken, oldFD, newFD)

        // 5) Gas new
        const gasNew = await newFDContract.connect(user).estimateGas.claimToken(userAddress, rewardToken)

        // Optional cost calc
        const fee = await ethers.provider.getFeeData()
        const block = await ethers.provider.getBlock("latest")
        const base = block.baseFeePerGas || (fee.gasPrice as BigNumber)
        const priority = fee.maxPriorityFeePerGas || ethers.utils.parseUnits("2", "gwei")
        const effective = base.add(priority)

        console.log("oldFD gas:", gasOld.toString(), "wei cost:", gasOld.mul(effective).toString())
        console.log("newFD gas:", gasNew.toString(), "wei cost:", gasNew.mul(effective).toString())
    })
}
/* -------------------- Helper functions -------------------- */

async function setUnlocked(veContract: Contract, unlocked: boolean) {
    /**
     * VotingEscrow contract slot positions
     * 0 owner
     * 1 reentered status
     * 2 supply
     * 3 unlocked
     */
    const slotIdx = 3
    const slot = "0x" + slotIdx.toString(16).padStart(64, "0")

    // New value: 32-byte left-padded hex
    const value = "0x" + (unlocked ? "01" : "00").repeat(32)

    // set the unlocked slot to false
    await network.provider.send("hardhat_setStorageAt", [veContract.address, slot, value])

    // check the unlocked slot is false
    expect(await ethers.provider.getStorageAt(veContract.address, slotIdx)).to.be.equal(value)
    expect(await veContract.unlocked()).to.be.equal(unlocked)
}

async function forkTo(chain: string) {
    const rpcUrl = getRpcUrl(chain)

    await ethers.provider.send("hardhat_reset", [
        {
            forking: { jsonRpcUrl: rpcUrl! },
        },
    ])
}

async function impersonate(addr: string) {
    await ethers.provider.send("hardhat_impersonateAccount", [addr])
    await ethers.provider.send("hardhat_setBalance", [addr, "0x1000000000000000000"]) // 1 ETH
    return await ethers.getSigner(addr)
}

async function fundNewFD(tokenAddr: string, fromAddr: string, to: string) {
    const erc20 = await ethers.getContractAt("@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol:IERC20", tokenAddr)
    const src = await impersonate(fromAddr)
    const bal = await erc20.balanceOf(fromAddr)
    if (bal > 0) await erc20.connect(src).transfer(to, bal)
}

function getDeploymentAddress(name: string, chain: string): string {
    // reads deployments/<chain>/<name>.json
    const p = path.join(process.cwd(), "deployments", chain, `${name}.json`)
    if (!fs.existsSync(p)) throw new Error(`Deployment file not found: ${p}`)
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    if (!j.address) throw new Error(`No 'address' in ${p}`)
    return j.address as string
}
