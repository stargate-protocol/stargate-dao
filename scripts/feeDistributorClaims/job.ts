import { ethers } from "hardhat"
import fs from "fs"
import { NonceManager } from "@ethersproject/experimental"
import { BATCH_SIZE, EXEC_IFACE, addressFromCsvLine, loadProcessed, parseBatchReceipt, feeOverrides, startHeartbeat } from "./utils"

export type JobConfig = {
    jobId: number
    signer: any // ethers.Signer
    executorAddress: string
    token: string
    shardCsvPath: string
    outPath: string
    errPath: string
}

export async function runJob(cfg: JobConfig) {
    const { jobId, signer, executorAddress, token, shardCsvPath, outPath, errPath } = cfg

    const managed = new NonceManager(signer)
    const senderAddr = await signer.getAddress()
    await managed.setTransactionCount(await ethers.provider.getTransactionCount(senderAddr, "latest"))

    const ExecutorForJob = new ethers.Contract(executorAddress, EXEC_IFACE.fragments, managed)

    const processed = await loadProcessed(outPath)
    if (processed.size > 0) console.log(`[Job ${jobId}] Resuming — already have ${processed.size} results logged.`)

    const out = fs.createWriteStream(outPath, { flags: "a" })
    const err = fs.createWriteStream(errPath, { flags: "a" })

    let seen = 0
    let ok = 0
    let failed = 0
    let skipped = 0
    const startedAt = Date.now()
    const batch: string[] = []

    const stopBeat = startHeartbeat(
        `[Job ${jobId}] running…`,
        () => `seen=${seen} ok=${ok} fail=${failed} skip=${skipped} pendingBatch=${batch.length}`
    )

    async function sendBatchWithRetry(users: string[]) {
        const maxTries = 5
        let attempt = 0
        let lastErr: any
        while (attempt < maxTries) {
            try {
                const overrides = await feeOverrides(attempt)
                console.log(`[Job ${jobId}] → sending batch size=${users.length} (attempt ${attempt + 1})`)
                const tx = await ExecutorForJob.functions.batchFullClaimToken(users, token, overrides)
                const rc = await tx.wait()
                console.log(`[Job ${jobId}]    mined: ${rc.transactionHash}`)
                return rc
            } catch (e: any) {
                const msg = e?.error?.message || e?.message || ""
                console.log(`[Job ${jobId}]    attempt failed: ${msg}`)
                if (/(nonce too low|underpriced|already known|replacement|fee cap|conflict)/i.test(msg)) {
                    const fresh = await ethers.provider.getTransactionCount(senderAddr, "latest")
                    await managed.setTransactionCount(fresh)
                    attempt++
                    lastErr = msg
                    continue
                }
                throw e
            }
        }
        throw new Error(`[Job ${jobId}] sendBatchWithRetry failed after ${maxTries} attempts. lastErr=${lastErr}`)
    }

    // stream the shard file
    const rl = require("readline").createInterface({
        input: fs.createReadStream(shardCsvPath),
        crlfDelay: Infinity,
    })

    for await (const line of rl) {
        const addr = addressFromCsvLine(line)
        if (!addr) continue
        const user = ethers.utils.getAddress(addr)
        seen++
        if (processed.has(user.toLowerCase())) {
            if (seen % 250 === 0) console.log(`[Job ${jobId}] (skip processed) ${user}`)
            continue
        }

        batch.push(user)

        if (batch.length >= BATCH_SIZE) {
            const rc = await sendBatchWithRetry(batch)
            const perUser = parseBatchReceipt(rc, executorAddress)

            for (const u of batch) {
                const key = u.toLowerCase()
                const res = perUser[key]
                if (!res) {
                    failed++
                    err.write(
                        JSON.stringify({ address: u, token, status: "failed", error: "no-event-in-receipt", jobId, ts: Date.now() }) + "\n"
                    )
                    continue
                }
                if (res.status === "ok") {
                    ok++
                    out.write(
                        JSON.stringify({
                            address: u,
                            token,
                            claimedAmount: res.amount,
                            rounds: res.rounds ?? "0",
                            status: "ok",
                            txHash: rc.transactionHash,
                            jobId,
                            ts: Date.now(),
                        }) + "\n"
                    )
                } else if (res.status === "skipped") {
                    skipped++
                    const skipStatus = res.reason === "no_balance" ? "skipped_no_balance" : "skipped_only_self"
                    err.write(JSON.stringify({ address: u, token, status: skipStatus, jobId, ts: Date.now() }) + "\n")
                } else {
                    failed++
                    err.write(
                        JSON.stringify({ address: u, token, status: "failed", error: res.reason || "revert", jobId, ts: Date.now() }) + "\n"
                    )
                }
            }
            batch.length = 0
        }
    }

    // flush any remainder
    if (batch.length > 0) {
        const rc = await sendBatchWithRetry(batch)
        const perUser = parseBatchReceipt(rc, executorAddress)
        for (const u of batch) {
            const key = u.toLowerCase()
            const res = perUser[key]
            if (!res) {
                failed++
                err.write(JSON.stringify({ address: u, token, status: "failed", error: "no-event-in-receipt", jobId, ts: Date.now() }) + "\n")
                continue
            }
            if (res.status === "ok") {
                ok++
                out.write(
                    JSON.stringify({
                        address: u,
                        token,
                        claimedAmount: res.amount,
                        rounds: res.rounds ?? "0",
                        status: "ok",
                        txHash: rc.transactionHash,
                        jobId,
                        ts: Date.now(),
                    }) + "\n"
                )
            } else if (res.status === "skipped") {
                skipped++
                const skipStatus = res.reason === "no_balance" ? "skipped_no_balance" : "skipped_only_self"
                err.write(JSON.stringify({ address: u, token, status: skipStatus, jobId, ts: Date.now() }) + "\n")
            } else {
                failed++
                err.write(JSON.stringify({ address: u, token, status: "failed", error: res.reason || "revert", jobId, ts: Date.now() }) + "\n")
            }
        }
    }

    out.end()
    err.end()
    stopBeat()

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[Job ${jobId}] done. ok=${ok} fail=${failed} skip=${skipped} seen=${seen} elapsed=${elapsed}s`)
    console.log(`[Job ${jobId}] wrote: ${outPath}`)
    console.log(`[Job ${jobId}] errors: ${errPath}`)
}
