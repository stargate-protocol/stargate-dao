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

const chainName = "avalanche"
const decimals = 6

async function sortClaimsByAmount() {
    const inputFile = path.join(__dirname, `data/${chainName}/data/claims.ndjson`)
    const outputFile = path.join(__dirname, `data/${chainName}/data/sorted-claims-by-amount.csv`)

    console.log("Reading claims from:", inputFile)

    try {
        // Read the file
        const fileContent = fs.readFileSync(inputFile, "utf8")
        const lines = fileContent.trim().split("\n")

        console.log(`Processing ${lines.length} claim records...`)

        // Parse and process each line, aggregating by address to remove duplicates
        const addressClaimsMap = new Map<string, number>()
        let dupCount = 0

        for (const line of lines) {
            try {
                const record: ClaimRecord = JSON.parse(line)
                const numericAmount = parseInt(record.claimedAmount)
                const address = record.address

                // Aggregate amounts for duplicate addresses
                const existingAmount = addressClaimsMap.get(address) || 0

                if (existingAmount !== 0) {
                    console.log(
                        `DUPLICATE FOUND - Address: ${address}, Existing: ${(existingAmount / Math.pow(10, decimals)).toFixed(
                            decimals
                        )}, New: ${(numericAmount / Math.pow(10, decimals)).toFixed(decimals)}, Total: ${(
                            (existingAmount + numericAmount) /
                            Math.pow(10, decimals)
                        ).toFixed(decimals)}`
                    )
                    dupCount++
                    if (existingAmount !== numericAmount) {
                        console.warn("New amount not equal to existing amount")
                    }
                }
                addressClaimsMap.set(address, numericAmount)
            } catch (parseError) {
                console.warn("Failed to parse line:", line.substring(0, 100) + "...")
            }
        }

        // Convert aggregated data to sortable array
        const sortedClaims: SortedClaimEntry[] = []
        for (const [address, totalAmount] of addressClaimsMap) {
            // Convert to decimals (assuming the token has decimals)
            const formattedAmount = (totalAmount / Math.pow(10, decimals)).toFixed(decimals)

            sortedClaims.push({
                address: address,
                rawAmount: totalAmount.toString(),
                formattedAmount: formattedAmount,
                numericAmount: totalAmount,
            })
        }

        // Sort by numeric amount in descending order
        sortedClaims.sort((a, b) => b.numericAmount - a.numericAmount)

        console.log(`Sorted ${sortedClaims.length} unique addresses by claimed amount (descending)`)

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
        console.log(`Total claims: ${lines.length}`)
        console.log(`Duplicated claims found: ${dupCount}`)
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
