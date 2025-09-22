import { ethers } from "hardhat"
import fs from "fs"
import path from "path"
import readline from "readline"

export const BATCH_SIZE = 10
export const GAS_LIMIT = 50_000_000
export const HEARTBEAT_MS = 30_000

// ABIs shared by runners
export const EXEC_IFACE = new ethers.utils.Interface([
    "event Claimed(address indexed user, address indexed token, uint256 amount)",
    "event ClaimedWithRounds(address indexed user, address indexed token, uint256 amount, uint256 rounds)",
    "event ClaimFailed(address indexed user, address indexed token, bytes reason)",
    "event ClaimSkippedOnlySelf(address indexed user, address indexed token)",
    "function batchFullClaimToken(address[] users, address token) returns (uint256 totalClaimed)",
])

export const VE_IFACE = new ethers.utils.Interface(["function unlocked() view returns (bool)"])

// ---- args & fs helpers ------------------------------------------------------

export function getArg(name: string, def?: string): string {
    const pref = `--${name}=`
    const hit = process.argv.find((a) => a.startsWith(pref))
    return (hit ? hit.slice(pref.length) : process.env[name.toUpperCase()]) ?? def ?? ""
}

export function ensureDirForFile(p: string) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
}

export async function loadProcessed(outPath: string): Promise<Set<string>> {
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

export function addressFromCsvLine(line: string): string | null {
    const raw = (line || "").trim()
    if (!raw) return null
    const addr = raw.split(",")[0].replace(/"/g, "").trim()
    return addr || null
}

// ---- CSV streaming ----------------------------------------------------------

export async function* lineStream(csvPath: string) {
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity })
    let lineNo = 0
    for await (const line of rl) {
        lineNo++
        yield { lineNo, line }
    }
}

// ---- receipt parsing --------------------------------------------------------

export type PerUserResult = { status: "ok"; amount: string; rounds?: string } | { status: "failed"; reason?: string } | { status: "skipped" }

export function parseBatchReceipt(rc: any, executorAddr: string): Record<string, PerUserResult> {
    const out: Record<string, PerUserResult> = {}
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
                out[key] = { status: "ok", amount, rounds }
                break
            }
            case "Claimed": {
                const amount = (parsed.args.amount as ethers.BigNumber).toString()
                if (!out[key]) out[key] = { status: "ok", amount }
                break
            }
            case "ClaimFailed": {
                const reasonHex: string = parsed.args.reason
                out[key] = { status: "failed", reason: reasonHex }
                break
            }
            case "ClaimSkippedOnlySelf": {
                out[key] = { status: "skipped" }
                break
            }
        }
    }
    return out
}

// ---- fee bump helper --------------------------------------------------------

export async function feeOverrides(attempt: number, gasLimit = GAS_LIMIT) {
    const { provider } = ethers
    const feeData = await provider.getFeeData()
    const bumpPct = 105 + attempt * 5 // 5% bump per retry
    const overrides: any = { gasLimit }

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        overrides.maxFeePerGas = feeData.maxFeePerGas.mul(bumpPct).div(100)
        overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(bumpPct).div(100)
    } else {
        const gp = await provider.getGasPrice()
        overrides.gasPrice = gp.mul(bumpPct).div(100)
    }
    return overrides
}

// ---- tiny heartbeat ---------------------------------------------------------

export function startHeartbeat(label: string, getter: () => string) {
    const id = setInterval(() => {
        console.log(`${label} ${getter()}`)
    }, HEARTBEAT_MS)
    return () => clearInterval(id)
}
