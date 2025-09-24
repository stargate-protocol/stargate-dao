#!/usr/bin/env ts-node

import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const stat = promisify(fs.stat)

interface ClaimRecord {
    address: string
    token: string
    claimedAmount: string
    status: string
    txHash: string
    jobId: number
    ts: number
}

interface ClaimsSummary {
    totalAmount: bigint
    totalClaims: number
    successfulClaims: number
    failedClaims: number
    uniqueAddresses: number
    uniqueTokens: number
    statusBreakdown: Record<string, number>
}

class ClaimsSummarizer {
    private dataDir: string
    private chain: string

    constructor(dataDir: string, chain: string = "avalanche") {
        this.dataDir = dataDir
        this.chain = chain
    }

    async summarizeClaims(): Promise<void> {
        try {
            console.log("=== Claims Amount Summarizer ===")
            console.log(`Chain: ${this.chain}`)
            console.log(`Data directory: ${this.dataDir}`)
            console.log(`Looking for claims in: ${this.chain}/data/claims.ndjson`)

            // Find the claims file
            const claimsFile = await this.findClaimsFile()
            if (!claimsFile) {
                console.error("No claims file found!")
                return
            }

            console.log(`Reading claims from: ${path.relative(this.dataDir, claimsFile)}`)
            console.log("Processing claims data...")

            const summary = await this.processClaims(claimsFile)
            this.printSummary(summary)

            // Save summary to files
            await this.saveSummaryToFiles(summary, claimsFile)
        } catch (error) {
            console.error("Error summarizing claims:", error)
            throw error
        }
    }

    private async findClaimsFile(): Promise<string | null> {
        const chainPath = path.join(this.dataDir, this.chain)

        // Look specifically in the data subdirectory
        const claimsPath = path.join(chainPath, "data", "claims.ndjson")

        try {
            await stat(claimsPath)
            return claimsPath
        } catch {
            console.error(`Claims file not found at: ${claimsPath}`)
            return null
        }
    }

    private async processClaims(claimsFile: string): Promise<ClaimsSummary> {
        const content = await readFile(claimsFile, "utf-8")
        const lines = content.trim().split("\n")

        const summary: ClaimsSummary = {
            totalAmount: BigInt(0),
            totalClaims: 0,
            successfulClaims: 0,
            failedClaims: 0,
            uniqueAddresses: 0,
            uniqueTokens: 0,
            statusBreakdown: {},
        }

        const addressSet = new Set<string>()
        const tokenSet = new Set<string>()

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line) continue

            try {
                const claim: ClaimRecord = JSON.parse(line)

                // Track basic stats
                summary.totalClaims++

                // Track unique addresses and tokens
                if (claim.address) addressSet.add(claim.address)
                if (claim.token) tokenSet.add(claim.token)

                // Track status
                const status = claim.status || "unknown"
                summary.statusBreakdown[status] = (summary.statusBreakdown[status] || 0) + 1

                if (status === "ok") {
                    summary.successfulClaims++
                } else {
                    summary.failedClaims++
                }

                // Sum amounts (only for successful claims)
                if (claim.claimedAmount && status === "ok") {
                    try {
                        const amount = BigInt(claim.claimedAmount)
                        summary.totalAmount += amount
                    } catch (amountError) {
                        console.warn(`Warning: Invalid amount on line ${i + 1}: ${claim.claimedAmount}`)
                    }
                }
            } catch (parseError) {
                console.warn(`Warning: Could not parse line ${i + 1}: ${line.substring(0, 100)}...`)
            }
        }

        summary.uniqueAddresses = addressSet.size
        summary.uniqueTokens = tokenSet.size

        return summary
    }

    private printSummary(summary: ClaimsSummary): void {
        console.log("\n" + "=".repeat(50))
        console.log("CLAIMS SUMMARY")
        console.log("=".repeat(50))

        console.log(`Total Claims Processed: ${summary.totalClaims.toLocaleString()}`)
        console.log(`Successful Claims: ${summary.successfulClaims.toLocaleString()}`)
        console.log(`Failed Claims: ${summary.failedClaims.toLocaleString()}`)
        console.log(`Unique Addresses: ${summary.uniqueAddresses.toLocaleString()}`)
        console.log(`Unique Tokens: ${summary.uniqueTokens.toLocaleString()}`)

        console.log("\nSTATUS BREAKDOWN:")
        Object.entries(summary.statusBreakdown)
            .sort(([, a], [, b]) => b - a)
            .forEach(([status, count]) => {
                console.log(`  ${status}: ${count.toLocaleString()}`)
            })

        console.log("\nAMOUNT SUMMARY:")
        console.log(`Total Claimed Amount (raw): ${summary.totalAmount.toString()}`)

        // Format with different decimal assumptions
        console.log("\nFormatted amounts (assuming different decimals):")
        console.log(`  6 decimals (USDC/USDT): ${this.formatAmount(summary.totalAmount, 6)}`)
        console.log(`  No decimals (wei/raw): ${this.formatAmount(summary.totalAmount, 0)}`)

        console.log("\n" + "=".repeat(50))
    }

    private async saveSummaryToFiles(summary: ClaimsSummary, claimsFile: string): Promise<void> {
        // Save everything back to the data directory (same as source)
        const outputDir = path.dirname(claimsFile) // This will be the data directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")

        // Prepare data for JSON export
        const jsonSummary = {
            chain: this.chain,
            timestamp: new Date().toISOString(),
            claimsFile: path.relative(this.dataDir, claimsFile),
            summary: {
                totalClaims: summary.totalClaims,
                successfulClaims: summary.successfulClaims,
                failedClaims: summary.failedClaims,
                uniqueAddresses: summary.uniqueAddresses,
                uniqueTokens: summary.uniqueTokens,
                statusBreakdown: summary.statusBreakdown,
                amounts: {
                    totalAmountRaw: summary.totalAmount.toString(),
                    formatted: {
                        decimals6: this.formatAmount(summary.totalAmount, 6),
                        noDecimals: this.formatAmount(summary.totalAmount, 0),
                    },
                },
            },
        }

        // Save JSON summary
        const jsonFile = path.join(outputDir, `claims-summary-${this.chain}-${timestamp}.json`)
        await writeFile(jsonFile, JSON.stringify(jsonSummary, null, 2))
        console.log(`\n✓ JSON summary saved to: ${this.chain}/data/claims-summary-${this.chain}-${timestamp}.json`)
    }

    private formatAmount(amount: bigint, decimals: number): string {
        if (decimals === 0) {
            return amount.toLocaleString()
        } else {
            const divisor = BigInt(10 ** decimals)
            const wholePart = amount / divisor
            const fractionalPart = amount % divisor
            const fractionalStr = fractionalPart.toString().padStart(decimals, "0")
            return `${wholePart.toLocaleString()}.${fractionalStr}`
        }
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2)

    const dataDir = args[0] || path.join(__dirname, "data")
    const chain = args[1] || "avalanche"

    const summarizer = new ClaimsSummarizer(dataDir, chain)

    try {
        await summarizer.summarizeClaims()
    } catch (error) {
        console.error("Failed to summarize claims:", error)
        process.exit(1)
    }
}

// Export for use as a module
export { ClaimsSummarizer }

// Run if called directly
if (require.main === module) {
    main()
}
