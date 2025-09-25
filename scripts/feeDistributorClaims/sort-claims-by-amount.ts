import * as fs from "fs"
import * as path from "path"

interface ClaimRecord {
    address: string
    token: string
    claimedAmount: string
    status: string
    txHash: string
    jobId: number
    ts: number
}

interface SortedClaimEntry {
    address: string
    rawAmount: string
    formattedAmount: string
    numericAmount: number
}

const chainName = "bsc"
const decimals = 18

async function sortClaimsByAmount() {
    const inputFile = path.join(__dirname, `data/${chainName}/data/claims.ndjson`)
    const outputFile = path.join(__dirname, `data/${chainName}/data/sorted-claims-by-amount.csv`)

    console.log("Reading claims from:", inputFile)

    try {
        // Read the file
        const fileContent = fs.readFileSync(inputFile, "utf8")
        const lines = fileContent.trim().split("\n")

        console.log(`Processing ${lines.length} claim records...`)

        // Parse and process each line, consolidating duplicates by address
        const addressAmountMap = new Map<string, number>()
        let duplicatesFound = 0
        let totalRecordsProcessed = 0

        for (const line of lines) {
            try {
                const record: ClaimRecord = JSON.parse(line)
                const address = record.address.toLowerCase() // Normalize address case
                const numericAmount = parseInt(record.claimedAmount)

                totalRecordsProcessed++

                if (addressAmountMap.has(address)) {
                    // Address already exists, sum the amounts
                    const existingAmount = addressAmountMap.get(address)!
                    addressAmountMap.set(address, existingAmount + numericAmount)
                    duplicatesFound++
                } else {
                    // New address
                    addressAmountMap.set(address, numericAmount)
                }
            } catch (parseError) {
                console.warn("Failed to parse line:", line.substring(0, 100) + "...")
            }
        }

        console.log(`Found ${duplicatesFound} duplicate addresses out of ${totalRecordsProcessed} total records`)
        console.log(`After deduplication: ${addressAmountMap.size} unique addresses`)

        // Convert map to sorted array
        const sortedClaims: SortedClaimEntry[] = []

        for (const [address, numericAmount] of addressAmountMap.entries()) {
            // Convert using configured decimals
            const formattedAmount = (numericAmount / Math.pow(10, decimals)).toFixed(decimals)

            sortedClaims.push({
                address: address,
                rawAmount: numericAmount.toString(),
                formattedAmount: formattedAmount,
                numericAmount: numericAmount,
            })
        }

        // Sort by numeric amount in descending order
        sortedClaims.sort((a, b) => b.numericAmount - a.numericAmount)

        console.log(`Sorted ${sortedClaims.length} records by claimed amount (descending)`)

        // Create CSV content
        const csvLines = [`Address,Raw Amount,Formatted Amount (${decimals} decimals)`]

        for (const claim of sortedClaims) {
            csvLines.push(`${claim.address},${claim.rawAmount},${claim.formattedAmount}`)
        }

        // Write to output file
        fs.writeFileSync(outputFile, csvLines.join("\n"))

        console.log(`Results written to: ${outputFile}`)
        console.log(`Top 10 claims by amount:`)

        // Show top 10
        for (let i = 0; i < Math.min(10, sortedClaims.length); i++) {
            const claim = sortedClaims[i]
            console.log(`${i + 1}. ${claim.address}: ${claim.formattedAmount} (raw: ${claim.rawAmount})`)
        }

        // Show summary statistics
        const totalRaw = sortedClaims.reduce((sum, claim) => sum + claim.numericAmount, 0)
        const totalFormatted = (totalRaw / Math.pow(10, decimals)).toFixed(decimals)
        const avgRaw = Math.round(totalRaw / sortedClaims.length)
        const avgFormatted = (avgRaw / Math.pow(10, decimals)).toFixed(decimals)

        console.log(`\nSummary:`)
        console.log(`Total records: ${sortedClaims.length}`)
        console.log(`Total claimed amount: ${totalFormatted} (raw: ${totalRaw})`)
        console.log(`Average claimed amount: ${avgFormatted} (raw: ${avgRaw})`)
        console.log(`Highest claim: ${sortedClaims[0]?.formattedAmount || "N/A"}`)
        console.log(`Lowest claim: ${sortedClaims[sortedClaims.length - 1]?.formattedAmount || "N/A"}`)
    } catch (error) {
        console.error("Error processing claims:", error)
        process.exit(1)
    }
}

// Run the script
if (require.main === module) {
    sortClaimsByAmount()
        .then(() => {
            console.log("Script completed successfully!")
            process.exit(0)
        })
        .catch((error) => {
            console.error("Script failed:", error)
            process.exit(1)
        })
}

export { sortClaimsByAmount }
