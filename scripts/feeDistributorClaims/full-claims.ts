// scripts/full-claims.ts
import { ethers, network } from "hardhat"
import fs from "fs"
import path from "path"
import readline from "readline"
import { NonceManager } from "@ethersproject/experimental"

import { REWARD_TOKEN_BY_CHAIN, FD_BY_CHAIN, VE_BY_CHAIN, INPUT_CSV_PATH, OUTPUT_NDJSON, ERRORS_NDJSON, EXECUTOR_STORE } from "./constants"

// ---- hardcoded per your request ----
const BATCH_SIZE = 1
const GAS_LIMIT = 50_000_000

// Executor ABI: batch + rich events (no maxRounds arg)
const EXEC_IFACE = new ethers.utils.Interface([
    "event Claimed(address indexed user, address indexed token, uint256 amount)",
    "event ClaimedWithRounds(address indexed user, address indexed token, uint256 amount, uint256 rounds)",
    "event ClaimFailed(address indexed user, address indexed token, bytes reason)",
    "function batchFullClaimToken(address[] users, address token) returns (uint256 totalClaimed)",
])
const VE_IFACE = new ethers.utils.Interface(["function unlocked() view returns (bool)"])

function getArg(name: string): string | undefined {
    const pref = `--${name}=`
    const hit = process.argv.find((a) => a.startsWith(pref))
    return hit ? hit.slice(pref.length) : undefined
}

async function loadProcessed(outPath: string): Promise<Set<string>> {
    const done = new Set<string>()
    if (!fs.existsSync(outPath)) return done
    const rl = readline.createInterface({ input: fs.createReadStream(outPath), crlfDelay: Infinity })
    for await (const line of rl) {
        const t = line.trim()
        if (!t) continue
        try {
            const obj = JSON.parse(t)
            if (obj?.address && obj?.status === "ok") done.add(String(obj.address).toLowerCase())
        } catch {}
    }
    return done
}

async function* addressStream(csvPath: string) {
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity })
    for await (const line of rl) {
        const raw = line.trim()
        if (!raw) continue
        const addr = raw.split(",")[0].replace(/"/g, "").trim()
        if (addr) yield addr
    }
}

type PerUserResult = {
    status: "ok" | "failed" | "skipped"
    amount?: string
    rounds?: string
    reason?: string
}

function parseBatchReceipt(rc: any, executorAddr: string): Record<string, PerUserResult> {
    const results: Record<string, PerUserResult> = {}
    const execLower = executorAddr.toLowerCase()

    for (const log of rc.logs) {
        if (log.address.toLowerCase() !== execLower) continue
        let parsed: any
        try {
            parsed = EXEC_IFACE.parseLog(log)
        } catch {
            continue
        }
        const user = ethers.utils.getAddress(parsed.args.user)
        const key = user.toLowerCase()

        switch (parsed.name) {
            case "ClaimedWithRounds": {
                const amount = (parsed.args.amount as ethers.BigNumber).toString()
                const rounds = (parsed.args.rounds as ethers.BigNumber).toString()
                results[key] = { status: "ok", amount, rounds }
                break
            }
            case "Claimed": {
                const amount = (parsed.args.amount as ethers.BigNumber).toString()
                if (!results[key]) results[key] = { status: "ok", amount }
                break
            }
            case "ClaimFailed": {
                const reasonHex: string = parsed.args.reason
                results[key] = { status: "failed", reason: reasonHex }
                break
            }
        }
    }
    return results
}

async function main() {
    const chain = getArg("chain") || process.env.CHAIN || "arbitrum"
    if (!chain) throw new Error("Pass --chain=arbitrum|ethereum (or set CHAIN env var)")
    const freshExecutor = /^1|true$/i.test(getArg("fresh-executor") || "")

    console.log(`\n=== Full Claims Runner (batch=${BATCH_SIZE}) ===`)
    console.log(`Network: ${network.name}`)
    console.log(`Chain:   ${chain}`)

    const REWARD = REWARD_TOKEN_BY_CHAIN[chain]
    const FD = FD_BY_CHAIN[chain]
    const VE = VE_BY_CHAIN[chain]
    if (!REWARD || !FD || !VE) throw new Error(`Unknown chain '${chain}' for constants.`)

    const CSV_IN = path.resolve(process.cwd(), INPUT_CSV_PATH(chain))
    const OUT_PATH = path.resolve(process.cwd(), OUTPUT_NDJSON(chain))
    const ERR_PATH = path.resolve(process.cwd(), ERRORS_NDJSON(chain))
    const EXEC_PATH = path.resolve(process.cwd(), EXECUTOR_STORE(chain))

    console.log(`FD:     ${FD}`)
    console.log(`VE:     ${VE}`)
    console.log(`Token:  ${REWARD}`)
    console.log(`CSV:    ${CSV_IN}`)
    console.log(`Out:    ${OUT_PATH}`)
    console.log(`Errors: ${ERR_PATH}`)
    console.log(`Store:  ${EXEC_PATH}`)

    // Ensure directories
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
    fs.mkdirSync(path.dirname(ERR_PATH), { recursive: true })
    fs.mkdirSync(path.dirname(EXEC_PATH), { recursive: true })

    // 1) Ensure VE is locked (unlocked() must be false)
    const veCtr = new ethers.Contract(VE, VE_IFACE, ethers.provider)
    const isUnlocked: boolean = await veCtr.unlocked()
    if (isUnlocked) {
        throw new Error("VE is UNLOCKED (must be false). Call setUnlocked(false) on the fork before running.")
    }
    console.log(`VE unlocked(): ${isUnlocked} (expected false)`)

    // 2) Managed signer (prevents nonce races)
    const [base] = await ethers.getSigners()
    const senderAddr = await base.getAddress()
    const managed = new NonceManager(base)
    await managed.setTransactionCount(await ethers.provider.getTransactionCount(senderAddr, "latest"))
    console.log(`Sender: ${senderAddr}`)

    // 3) Deploy or attach BatchClaimExecutor (persist between runs)
    const Executor = await ethers.getContractFactory("BatchClaimExecutor", managed)

    let executorAddr: string | undefined
    if (!freshExecutor && fs.existsSync(EXEC_PATH)) {
        try {
            const j = JSON.parse(fs.readFileSync(EXEC_PATH, "utf8"))
            if (j?.address) executorAddr = ethers.utils.getAddress(j.address)
        } catch {}
    }

    let executor: any
    if (executorAddr) {
        const code = await ethers.provider.getCode(executorAddr)
        if (code && code !== "0x") {
            executor = Executor.attach(executorAddr)
            console.log(`Executor: ${executor.address} (attached from store)`)
        } else {
            console.log(`Executor address in store has no code. Redeploying...`)
            executor = await (await Executor.deploy(FD)).deployed()
            fs.writeFileSync(EXEC_PATH, JSON.stringify({ address: executor.address, fd: FD, chain, deployedAt: Date.now() }, null, 2))
            console.log(`Executor: ${executor.address} (deployed)`)
        }
    } else {
        executor = await (await Executor.deploy(FD)).deployed()
        fs.writeFileSync(EXEC_PATH, JSON.stringify({ address: executor.address, fd: FD, chain, deployedAt: Date.now() }, null, 2))
        console.log(`Executor: ${executor.address} (deployed new)`)
    }

    const token = ethers.utils.getAddress(REWARD)
    const processed = await loadProcessed(OUT_PATH)
    if (processed.size > 0) {
        console.log(`Resuming — already have ${processed.size} results logged.`)
    }

    const out = fs.createWriteStream(OUT_PATH, { flags: "a" })
    const err = fs.createWriteStream(ERR_PATH, { flags: "a" })

    const sendBatchWithRetry = async (users: string[]) => {
        const maxTries = 5
        let attempt = 0
        let lastErr: any

        while (attempt < maxTries) {
            try {
                const feeData = await ethers.provider.getFeeData()
                const bumpPct = 105 + attempt * 5
                const overrides: any = { gasLimit: GAS_LIMIT }

                if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                    overrides.maxFeePerGas = feeData.maxFeePerGas.mul(bumpPct).div(100)
                    overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(bumpPct).div(100)
                } else {
                    const gp = await ethers.provider.getGasPrice()
                    overrides.gasPrice = gp.mul(bumpPct).div(100)
                }

                console.log(`  → sending batch (size=${users.length}, attempt ${attempt + 1})`)
                const tx = await executor.connect(managed).batchFullClaimToken(users, token, overrides)
                console.log(`    tx sent: ${tx.hash}`)
                const rc = await tx.wait()
                console.log(`    tx mined: ${rc.transactionHash}`)
                return rc
            } catch (e: any) {
                const msg = e?.error?.message || e?.message || ""
                console.log(`    attempt failed: ${msg}`)
                if (/(nonce too low|underpriced|already known|replacement|fee cap|conflict)/i.test(msg)) {
                    const fresh = await ethers.provider.getTransactionCount(await managed.getAddress(), "latest")
                    await managed.setTransactionCount(fresh)
                    attempt++
                    lastErr = msg
                    continue
                }
                throw e
            }
        }
        throw new Error(`sendBatchWithRetry failed after ${maxTries} attempts. lastErr=${lastErr}`)
    }

    // -------- main loop (batched) --------
    const startedAt = Date.now()
    let seen = 0
    let ok = 0
    let failed = 0
    let skipped = 0

    console.log(`\nProcessing addresses from CSV in batches of ${BATCH_SIZE}…`)

    const batch: string[] = []

    const flushIfNeeded = async (force = false) => {
        if (!force && batch.length < BATCH_SIZE) return
        if (batch.length === 0) return

        console.log(`\nSending batch of ${batch.length} users…`)
        const rc = await sendBatchWithRetry(batch)
        const perUser = parseBatchReceipt(rc, executor.address)

        for (const u of batch) {
            const userLC = u.toLowerCase()
            const res = perUser[userLC]

            if (!res) {
                failed++
                err.write(
                    JSON.stringify({
                        address: u,
                        token,
                        status: "failed",
                        error: "no-event-in-receipt",
                        network: network.name,
                        chain,
                        ts: Date.now(),
                    }) + "\n"
                )
                continue
            }

            if (res.status === "ok") {
                ok++
                out.write(
                    JSON.stringify({
                        address: u,
                        token,
                        claimedAmount: res.amount ?? "0",
                        rounds: res.rounds ?? "0",
                        status: "ok",
                        txHash: rc.transactionHash,
                        network: network.name,
                        chain,
                        ts: Date.now(),
                    }) + "\n"
                )
            } else if (res.status === "skipped") {
                skipped++
                err.write(
                    JSON.stringify({ address: u, token, status: "skipped_only_self", network: network.name, chain, ts: Date.now() }) + "\n"
                )
            } else {
                failed++
                err.write(
                    JSON.stringify({
                        address: u,
                        token,
                        status: "failed",
                        error: res.reason || "revert",
                        network: network.name,
                        chain,
                        ts: Date.now(),
                    }) + "\n"
                )
            }
        }

        batch.length = 0
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
        console.log(`progress: seen=${seen} ok=${ok} failed=${failed} skipped=${skipped} elapsed=${elapsed}s`)
    }

    for await (const raw of addressStream(CSV_IN)) {
        seen++
        const user = ethers.utils.getAddress(raw)

        if (processed.has(user.toLowerCase())) {
            if (seen % 250 === 0) console.log(`  (skip processed) ${user} — seen=${seen}`)
            continue
        }

        batch.push(user)
        if (batch.length >= BATCH_SIZE) {
            await flushIfNeeded(true)
        }
    }

    await flushIfNeeded(true)

    out.end()
    err.end()

    const totalElapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`\nDone. ok=${ok} failed=${failed} skipped=${skipped} seen=${seen} elapsed=${totalElapsed}s`)
    console.log(`Wrote: ${OUT_PATH}`)
    console.log(`Errors: ${ERR_PATH}`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
