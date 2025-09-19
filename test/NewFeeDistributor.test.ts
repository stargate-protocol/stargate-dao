import { expect } from "chai"
import { ethers, network } from "hardhat"
import { REWARD_TOKEN_BY_CHAIN, PREUNLOCK_BLOCK } from "./helpers/constants"
import fs from "fs"
import path from "path"
import { Contract } from "ethers"
import { getRpcUrl } from "../hardhat.config"

describe("Fork parity using deployments + per-chain token constant", () => {
    let chainName: string
    let REWARD_TOKEN: string
    let PRE_BLOCK: number
    let POST_BLOCK: number
    let TEST_USER: string

    let oldFD: string
    let ve: string

    before(async () => {
        chainName = getChain()
        oldFD = await getDeploymentAddress("FeeDistributor", chainName)
        ve = await getDeploymentAddress("VotingEscrow", chainName)

        console.log("chainName", chainName)
        console.log("oldFD", oldFD)
        console.log("ve", ve)

        REWARD_TOKEN = REWARD_TOKEN_BY_CHAIN[chainName]
        PRE_BLOCK = PREUNLOCK_BLOCK[chainName]
        POST_BLOCK = PRE_BLOCK + 10
        TEST_USER = "0xD237F03bb8b3982dB0C87C22Ce84f36927a57872" // random user

        if (!REWARD_TOKEN) throw new Error(`No reward token constant for chain  ${chainName}`)
    })

    it.only("Pre-unlock: old.callStatic == new.callStatic", async () => {
        await forkTo(chainName)

        const user = await impersonate(TEST_USER)
        const oldFDContract = await ethers.getContractAt("FeeDistributor", oldFD)

        // 1. Set the unlocked slot to false
        const veContract = await ethers.getContractAt("VotingEscrow", ve)
        await setUnlocked(veContract)

        // 2. Get the amount of tokens that the old FeeDistributor would pay
        const amountOldFD = await oldFDContract.connect(user).callStatic.claimToken(TEST_USER, REWARD_TOKEN)
        console.log("amountOldFD", amountOldFD)
        expect(amountOldFD).to.be.gt(0)

        // 3. Deploy newFeeDistributor on the fork
        const NewFD = await ethers.getContractFactory("NewFeeDistributor")
        const newFD = await NewFD.deploy(oldFD)

        // 4. Fund NewFeeDistributor from FeeDistributor’s own balance on fork (or swap to a rich holder)
        await fundNewFD(REWARD_TOKEN, oldFD, newFD.address, amountOldFD)

        // 5. Check the amount of tokens that the new FeeDistributor would pay
        console.log("pre-unlock newFD")
        const amountNewFD = await newFD.connect(user).callStatic.claimToken(TEST_USER, REWARD_TOKEN)
        console.log("amountNewFD", amountNewFD)

        // 6. Check the amount is the same in both FeeDistributors
        expect(amountNewFD).to.equal(amountOldFD)
    })

    it.skip("Post-unlock: old reverts, new returns same amount as pre-unlock", async () => {
        // First, re-run pre-unlock to capture expected amount
        await forkTo(chainName)
        const userPre = await impersonate(TEST_USER)
        const oldFDContract = await ethers.getContractAt("FeeDistributor", oldFD)
        const amountPreUnlock = await oldFDContract.connect(userPre).callStatic.claimToken(TEST_USER, REWARD_TOKEN)
        expect(amountPreUnlock).to.be.gt(0)

        // Now move to a block after unlock
        await forkTo(chainName)
        const user = await impersonate(TEST_USER)
        // const fd = await ethers.getContractAt("FeeDistributor", oldFD.address)
        // todo check the revert is the expected one
        // ! will no revert until a week latter :(
        await expect(oldFDContract.connect(user).callStatic.claimToken(TEST_USER, REWARD_TOKEN)).to.be.reverted // typically "unlocked globally" via VE.checkpoint()

        // NewFeeDistributor still matches the pre-unlock amount
        const NewFD = await ethers.getContractFactory("NewFeeDistributor")
        const newFD = await NewFD.deploy(oldFD)
        await newFD.waitForDeployment()

        await fundNewFD(REWARD_TOKEN, oldFD, await newFD.getAddress(), amountPreUnlock)

        const preview = await newFD.connect(user).callStatic.claimToken(TEST_USER, REWARD_TOKEN)
        expect(preview).to.equal(amountPreUnlock)

        // Optional: real stateful claim to ensure transfer succeeds
        const token = await ethers.getContractAt("IERC20", REWARD_TOKEN)
        const before = await token.balanceOf(TEST_USER)
        await newFD.connect(user).claimToken(TEST_USER, REWARD_TOKEN)
        const after = await token.balanceOf(TEST_USER)
        expect(after - before).to.equal(amountPreUnlock)

        // todo check can't claim twice
    })
})

/* -------------------- Helper functions -------------------- */

async function setUnlocked(veContract: Contract) {
    /**
     * VotingEscrow contract slot positions
     * 0 owner
     * 1 reentered status
     * 2 supply
     * 3 unlocked
     */
    const slotIdx = 3
    const slot = "0x" + slotIdx.toString(16).padStart(64, "0")

    // New value: 32-byte left-padded hex (false = all zeros)
    const value = "0x" + "00".repeat(32)

    // set the unlocked slot to false
    await network.provider.send("hardhat_setStorageAt", [veContract.address, slot, value])

    // check the unlocked slot is false
    expect(await ethers.provider.getStorageAt(veContract.address, slotIdx)).to.be.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    )
    expect(await veContract.unlocked()).to.be.false
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

async function fundNewFD(tokenAddr: string, fromAddr: string, to: string, minAmount: bigint) {
    const erc20 = await ethers.getContractAt("@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol:IERC20", tokenAddr)
    const src = await impersonate(fromAddr)
    const bal = await erc20.balanceOf(fromAddr)
    const amt = bal >= minAmount ? minAmount : bal
    if (amt > 0) await erc20.connect(src).transfer(to, amt)
}

export function getDeploymentAddress(name: string, chain: string): string {
    // reads deployments/<chain>/<name>.json
    const p = path.join(process.cwd(), "deployments", chain, `${name}.json`)
    if (!fs.existsSync(p)) throw new Error(`Deployment file not found: ${p}`)
    const j = JSON.parse(fs.readFileSync(p, "utf8"))
    if (!j.address) throw new Error(`No 'address' in ${p}`)
    return j.address as string
}

export function getChain(): string {
    // todo
    const c = process.env.FORK_CHAIN || "arbitrum"
    return c
}
