import { ethers, network } from "hardhat"
import fs from "fs"
import path from "path"
import { NonceManager } from "@ethersproject/experimental"

import { REWARD_TOKEN_BY_CHAIN, FD_BY_CHAIN, VE_BY_CHAIN, INPUT_CSV_PATH, OUTPUT_NDJSON, ERRORS_NDJSON, EXECUTOR_STORE } from "./constants"

import { getArg, ensureDirForFile, lineStream, addressFromCsvLine, VE_IFACE, EXEC_IFACE } from "./utils"
import { runJob } from "./job"

// split main CSV to N shards, starting at `startLine` (dropping earlier lines)
async function splitCsvIntoShards(mainCsv: string, outDir: string, workers: number, startLine: number) {
    fs.mkdirSync(outDir, { recursive: true })
    const shardPaths: string[] = Array.from({ length: workers }, (_, i) => path.join(outDir, `addresses.part${i}.csv`))
    const writers = shardPaths.map((p) => fs.createWriteStream(p, { flags: "w" }))

    let written = 0
    for await (const { lineNo, line } of lineStream(mainCsv)) {
        if (lineNo < startLine) continue
        const addr = addressFromCsvLine(line)
        if (!addr) continue
        const shardIdx = (lineNo - startLine) % workers
        writers[shardIdx].write(addr + "\n")
        written++
        if (written % 50_000 === 0) console.log(`[split] wrote ${written} lines so far…`)
    }
    writers.forEach((w) => w.end())
    console.log(`[split] completed. total=${written}`)
    return shardPaths
}

async function main() {
    const chain = getArg("chain", "arbitrum")
    const workers = parseInt(getArg("workers", "10"), 10)
    const startLine = parseInt(getArg("start-line", "0"), 10)
    const freshExecutor = /^1|true$/i.test(getArg("fresh-executor", ""))
    const forceResplit = /^1|true$/i.test(getArg("force-resplit", ""))

    console.log(`\n=== Threads Orchestrator ===`)
    console.log(`Network:   ${network.name}`)
    console.log(`Chain:     ${chain}`)
    console.log(`Workers:   ${workers}`)
    console.log(`StartLine: ${startLine}`)

    const REWARD = REWARD_TOKEN_BY_CHAIN[chain]
    const FD = FD_BY_CHAIN[chain]
    const VE = VE_BY_CHAIN[chain]
    if (!REWARD || !FD || !VE) throw new Error(`Unknown chain '${chain}' for constants.`)

    const CSV_MAIN = path.resolve(process.cwd(), INPUT_CSV_PATH(chain))
    const OUT_BASE = path.resolve(process.cwd(), OUTPUT_NDJSON(chain))
    const ERR_BASE = path.resolve(process.cwd(), ERRORS_NDJSON(chain))
    const EXEC_PATH = path.resolve(process.cwd(), EXECUTOR_STORE(chain))
    const SHARD_DIR = path.join(path.dirname(CSV_MAIN), "shards")

    console.log(`FD:      ${FD}`)
    console.log(`VE:      ${VE}`)
    console.log(`Token:   ${REWARD}`)
    console.log(`CSV:     ${CSV_MAIN}`)
    console.log(`Shards:  ${SHARD_DIR}/addresses.part{0..${workers - 1}}.csv`)
    console.log(`Out*:    ${OUT_BASE.replace(/\.ndjson$/, ".jobX.ndjson")}`)
    console.log(`Err*:    ${ERR_BASE.replace(/\.ndjson$/, ".jobX.ndjson")}`)
    console.log(`Store:   ${EXEC_PATH}`)

    // Ensure dirs
    ensureDirForFile(OUT_BASE)
    ensureDirForFile(ERR_BASE)
    ensureDirForFile(EXEC_PATH)

    // 1) Ensure VE locked
    const veCtr = new ethers.Contract(VE, VE_IFACE, ethers.provider)
    const isUnlocked: boolean = await veCtr.unlocked()
    if (isUnlocked) throw new Error("VE is UNLOCKED (must be false). Call setUnlocked(false) on the fork before running.")
    console.log(`VE unlocked(): ${isUnlocked} (expected false)`)

    // 2) Executor deploy/attach (single shared instance)
    const allSigners = await ethers.getSigners()
    if (allSigners.length < workers) throw new Error(`Need at least ${workers} signers from mnemonic; got ${allSigners.length}`)

    const deploySigner = allSigners[0]
    const managedDeployer = new NonceManager(deploySigner)
    await managedDeployer.setTransactionCount(await ethers.provider.getTransactionCount(await deploySigner.getAddress(), "latest"))

    const ExecutorFactory = new ethers.ContractFactory(EXEC_IFACE.fragments, "0x", managedDeployer) // ABI-only factory (attach later)
    // we actually need the real factory from artifacts (with bytecode). Use artifacts:
    const RealFactory = await ethers.getContractFactory("BatchClaimExecutor", managedDeployer)

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
            executor = RealFactory.attach(executorAddr)
            console.log(`Executor: ${executor.address} (attached from store)`)
        } else {
            console.log(`Executor in store has no code. Redeploying…`)
            executor = await (await RealFactory.deploy(FD)).deployed()
            fs.writeFileSync(EXEC_PATH, JSON.stringify({ address: executor.address, fd: FD, chain, deployedAt: Date.now() }, null, 2))
            console.log(`Executor: ${executor.address} (deployed)`)
        }
    } else {
        executor = await (await RealFactory.deploy(FD)).deployed()
        fs.writeFileSync(EXEC_PATH, JSON.stringify({ address: executor.address, fd: FD, chain, deployedAt: Date.now() }, null, 2))
        console.log(`Executor: ${executor.address} (deployed new)`)
    }

    // 3) Split CSV -> shards (round-robin after startLine)
    let shardPaths: string[] = []
    const expectedShard0 = path.join(SHARD_DIR, `addresses.part0.csv`)
    const shardsExist = fs.existsSync(expectedShard0)

    if (!shardsExist || forceResplit) {
        console.log(`[split] creating shard files…`)
        shardPaths = await splitCsvIntoShards(CSV_MAIN, SHARD_DIR, workers, startLine)
    } else {
        console.log(`[split] shards already exist — reusing (pass --force-resplit=1 to rebuild)`)
        shardPaths = Array.from({ length: workers }, (_, i) => path.join(SHARD_DIR, `addresses.part${i}.csv`))
    }

    // 4) Launch jobs
    const token = ethers.utils.getAddress(REWARD)
    const jobs: Promise<void>[] = []

    for (let i = 0; i < workers; i++) {
        const signer = allSigners[i]
        const outPath = OUT_BASE.replace(/\.ndjson$/, `.job${i}.ndjson`)
        const errPath = ERR_BASE.replace(/\.ndjson$/, `.job${i}.ndjson`)
        const shardCsvPath = shardPaths[i]

        console.log(`[Job ${i}] will read: ${shardCsvPath}`)
        console.log(`[Job ${i}] out: ${outPath}`)
        console.log(`[Job ${i}] err: ${errPath}`)

        jobs.push(
            runJob({
                jobId: i,
                signer,
                executorAddress: executor.address,
                token,
                shardCsvPath,
                outPath,
                errPath,
            }).catch((e) => console.error(`[Job ${i}] fatal:`, e))
        )
    }

    console.log(`\nAll jobs launched. Watch per-job logs.`)
    await Promise.all(jobs)
    console.log(`\nAll jobs completed.`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
