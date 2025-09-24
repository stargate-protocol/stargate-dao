// jobs/runJob-callstatic.ts
import { ethers } from "hardhat"
import fs from "fs"
import { BATCH_SIZE, addressFromCsvLine, loadProcessed, startHeartbeat } from "./utils"

// If this import is the full Hardhat artifact JSON, use `.abi` below.
// If you already export plain ABI, drop the `.abi`.
import readerArtifact from "../../artifacts/contracts/ClaimReader.sol/ClaimReader.json"

export type JobConfig = {
    jobId: number
    signer: any // ethers.Signer (kept for compatibility; unused for callStatic)
    readerAddress: string
    token: string
    shardCsvPath: string
    outPath: string
    errPath: string
    skipPath: string
}

export async function runJob(cfg: JobConfig) {
    const { jobId, readerAddress, token, shardCsvPath, outPath, errPath, skipPath } = cfg

    // Instantiate reader with a provider only (no signer needed for callStatic)
    const abi = (readerArtifact as any).abi ?? (readerArtifact as any)
    const reader = new ethers.Contract(readerAddress, abi, ethers.provider)

    const processed = await loadProcessed(outPath)
    if (processed.size > 0) {
        console.log(`[Job ${jobId}] Resuming — already have ${processed.size} results logged.`)
    }

    const out = fs.createWriteStream(outPath, { flags: "a" })
    const err = fs.createWriteStream(errPath, { flags: "a" })
    const skip = fs.createWriteStream(skipPath, { flags: "a" })

    let seen = 0
    let ok = 0
    let failed = 0
    let skipped = 0
    const startedAt = Date.now()
    const batch: string[] = []

    // Fix a snapshot block so all batches are evaluated at the same chain state.
    const snapshotBlock = await ethers.provider.getBlockNumber()
    const callOpts = { gasLimit: 30_000_000_000_000, blockTag: snapshotBlock as any } // generous gas for eth_call

    const stopBeat = startHeartbeat(
        `[Job ${jobId}] running…`,
        () => `seen=${seen} ok=${ok} fail=${failed} skip=${skipped} pendingBatch=${batch.length}`
    )

    async function callBatchWithRetry(users: string[]) {
        const maxTries = 5
        let attempt = 0
        let lastErr: any

        while (attempt < maxTries) {
            try {
                console.log(`[Job ${jobId}] → callStatic batch size=${users.length} (attempt ${attempt + 1}) @block ${snapshotBlock}`)
                console.log("=======>", users.length)
                const [amounts, requiresSelf] = await reader.callStatic.viewFullClaimPerUser(users, token, callOpts)
                return { amounts, requiresSelf }
            } catch (e: any) {
                const msg = e?.error?.message || e?.message || String(e)
                console.log(`[Job ${jobId}]    attempt failed: ${msg}`)
                // Retry on transient node issues; otherwise rethrow
                if (/(timeout|temporar|429|503|ETIMEDOUT|ECONNRESET|gateway|header not found)/i.test(msg)) {
                    attempt++
                    lastErr = msg
                    continue
                }
                throw e
            }
        }
        throw new Error(`[Job ${jobId}] callBatchWithRetry failed after ${maxTries} attempts. lastErr=${lastErr}`)
    }

    // Stream the shard file
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
            try {
                const { amounts, requiresSelf } = await callBatchWithRetry(batch)

                for (let i = 0; i < batch.length; i++) {
                    const u = batch[i]
                    const key = u.toLowerCase()
                    const amount = amounts[i] // BigNumber
                    const onlySelf = !!requiresSelf[i]

                    if (onlySelf) {
                        skipped++
                        skip.write(
                            JSON.stringify({
                                address: u,
                                token,
                                status: "skipped_only_self",
                                jobId,
                                ts: Date.now(),
                            }) + "\n"
                        )
                    } else if (amount.isZero()) {
                        skipped++
                        skip.write(
                            JSON.stringify({
                                address: u,
                                token,
                                status: "skipped_no_balance",
                                jobId,
                                ts: Date.now(),
                            }) + "\n"
                        )
                    } else {
                        ok++
                        out.write(
                            JSON.stringify({
                                address: u,
                                token,
                                claimedAmount: amount.toString(), // exact value from contract
                                status: "ok",
                                txHash: "callStatic", // placeholder for schema compatibility
                                jobId,
                                ts: Date.now(),
                            }) + "\n"
                        )
                    }

                    // Mark as processed so we don't re-queue on resume
                    processed.add(key)
                }
            } catch (e: any) {
                failed += batch.length
                const msg = e?.error?.message || e?.message || String(e)
                for (const u of batch) {
                    err.write(
                        JSON.stringify({
                            address: u,
                            token,
                            status: "failed",
                            error: msg,
                            jobId,
                            ts: Date.now(),
                        }) + "\n"
                    )
                }
            } finally {
                batch.length = 0
            }
        }
    }

    // Flush any remainder
    if (batch.length > 0) {
        try {
            const { amounts, requiresSelf } = await callBatchWithRetry(batch)

            for (let i = 0; i < batch.length; i++) {
                const u = batch[i]
                const key = u.toLowerCase()
                const amount = amounts[i]
                const onlySelf = !!requiresSelf[i]

                if (onlySelf) {
                    skipped++
                    skip.write(
                        JSON.stringify({
                            address: u,
                            token,
                            status: "skipped_only_self",
                            jobId,
                            ts: Date.now(),
                        }) + "\n"
                    )
                } else if (amount.isZero()) {
                    skipped++
                    skip.write(
                        JSON.stringify({
                            address: u,
                            token,
                            status: "skipped_no_balance",
                            jobId,
                            ts: Date.now(),
                        }) + "\n"
                    )
                } else {
                    ok++
                    out.write(
                        JSON.stringify({
                            address: u,
                            token,
                            claimedAmount: amount.toString(),
                            status: "ok",
                            txHash: "callStatic",
                            jobId,
                            ts: Date.now(),
                        }) + "\n"
                    )
                }

                processed.add(key)
            }
        } catch (e: any) {
            failed += batch.length
            const msg = e?.error?.message || e?.message || String(e)
            for (const u of batch) {
                err.write(
                    JSON.stringify({
                        address: u,
                        token,
                        status: "failed",
                        error: msg,
                        jobId,
                        ts: Date.now(),
                    }) + "\n"
                )
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
    console.log(`[Job ${jobId}] skips: ${skipPath}`)
}
