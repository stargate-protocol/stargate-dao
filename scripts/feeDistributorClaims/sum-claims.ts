#!/usr/bin/env ts-node

import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const stat = promisify(fs.stat)

const chainName = "avalanche"

interface ClaimRecord {
    address: string
    rawAmount: string
    formattedAmount: string
}

interface ClaimsSummary {
    totalAmount: bigint
    totalClaims: number
    uniqueAddresses: number
}

class ClaimsSummarizer {
    private dataDir: string
    private chain: string

    constructor(dataDir: string, chain: string = chainName) {
        this.dataDir = dataDir
        this.chain = chain
    }

    async summarizeClaims(): Promise<void> {
        try {
            console.log("=== Claims Amount Summarizer ===")
            console.log(`Chain: ${this.chain}`)
            console.log(`Data directory: ${this.dataDir}`)
            console.log(`Looking for claims in: ${this.chain}/data/sorted-claims-by-amount.csv`)

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
        const claimsPath = path.join(chainPath, "data", "sorted-claims-by-amount.csv")

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
            uniqueAddresses: 0,
        }

        const addressSet = new Set<string>()

        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line) continue

            try {
                // Parse CSV: Address,Raw Amount,Formatted Amount (6 decimals)
                const columns = line.split(",")
                if (columns.length < 2) {
                    console.warn(`Warning: Invalid CSV format on line ${i + 1}: ${line}`)
                    continue
                }

                const claim: ClaimRecord = {
                    address: columns[0].trim(),
                    rawAmount: columns[1].trim(),
                    formattedAmount: columns[2]?.trim() || "",
                }

                // Track basic stats
                summary.totalClaims++

                // Track unique addresses
                if (claim.address) addressSet.add(claim.address)

                // Sum amounts from the raw amount column
                if (claim.rawAmount) {
                    try {
                        const amount = BigInt(claim.rawAmount)
                        summary.totalAmount += amount
                    } catch (amountError) {
                        console.warn(`Warning: Invalid amount on line ${i + 1}: ${claim.rawAmount}`)
                    }
                }
            } catch (parseError) {
                console.warn(`Warning: Could not parse line ${i + 1}: ${line.substring(0, 100)}...`)
            }
        }

        summary.uniqueAddresses = addressSet.size

        return summary
    }

    private printSummary(summary: ClaimsSummary): void {
        console.log("\n" + "=".repeat(50))
        console.log("CLAIMS SUMMARY")
        console.log("=".repeat(50))

        console.log(`Total Claims Processed: ${summary.totalClaims.toLocaleString()}`)
        console.log(`Unique Addresses: ${summary.uniqueAddresses.toLocaleString()}`)

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
                uniqueAddresses: summary.uniqueAddresses,
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
    const chain = args[1] || chainName

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
