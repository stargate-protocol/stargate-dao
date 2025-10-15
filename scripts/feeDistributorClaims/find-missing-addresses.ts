import fs from "fs"
import path from "path"

/**
 * Script to find addresses that are in addresses.csv but not in any claims.job*.ndjson files
 * Also creates done-addresses files with addresses that were successfully processed
 */
async function findMissingAddresses() {
    const baseDir = path.join(__dirname, "data/avalanche")
    const csvFile = path.join(baseDir, "in/addresses.csv")
    const outDir = path.join(baseDir, "data")

    console.log("Reading addresses from CSV...")

    // Read all addresses from CSV file
    const csvContent = fs.readFileSync(csvFile, "utf-8")
    const allAddresses = new Set(
        csvContent
            .split("\n")
            .map((line) => line.trim().toLowerCase())
            .filter((line) => line.length > 0)
    )

    console.log(`Found ${allAddresses.size} addresses in addresses.csv`)

    // Read all addresses from claims files
    console.log("Reading addresses from claims files...")
    const claimedAddresses = new Set<string>()
    const claimDetails = new Map<string, any>() // Store the claim details for each address

    // Find all claims.job*.ndjson files
    const claimsFiles = fs.readdirSync(outDir).filter((file) => file.startsWith("claims") && file.endsWith(".ndjson"))
    const skipFiles = fs.readdirSync(outDir).filter((file) => file.startsWith("skips") && file.endsWith(".ndjson"))

    console.log(`Found ${claimsFiles.length} claims files with`)
    console.log(`Found ${skipFiles.length} skip files`)

    for (const file of [...claimsFiles, ...skipFiles]) {
        const filePath = path.join(outDir, file)

        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8")
            const lines = content.split("\n").filter((line) => line.trim().length > 0)

            console.log(`Processing ${file} with ${lines.length} elements...`)

            for (const line of lines) {
                try {
                    const claim = JSON.parse(line)
                    if (claim.address) {
                        const addressLower = claim.address.toLowerCase()
                        claimedAddresses.add(addressLower)
                        // Store the claim details (keep the latest one if multiple)
                        claimDetails.set(addressLower, claim)
                    }
                } catch (error) {
                    console.warn(`Error parsing line in ${file}:`, line)
                }
            }
        }
    }

    console.log(`Found ${claimedAddresses.size} addresses in claims files`)

    // Find addresses that are in CSV but not in claims (missing)
    const missingAddresses = new Set<string>()
    // Find addresses that are in BOTH CSV and claims (done)
    const doneAddresses = new Set<string>()

    for (const address of allAddresses) {
        if (!claimedAddresses.has(address)) {
            missingAddresses.add(address)
        } else {
            doneAddresses.add(address)
        }
    }

    console.log(`Found ${missingAddresses.size} missing addresses`)
    console.log(`Found ${doneAddresses.size} done addresses`)

    // Write missing addresses to a new file
    const missingAddressesArray = Array.from(missingAddresses).sort()
    const outputFile = path.join(baseDir, "data/missing-addresses.csv")

    fs.writeFileSync(outputFile, missingAddressesArray.join("\n"))

    console.log(`Missing addresses written to: ${outputFile}`)

    // Also create an NDJSON file with more details
    const detailsFile = path.join(baseDir, "data/missing-addresses-details.ndjson")
    const details = missingAddressesArray.map((address) => ({
        address: address,
        inCsv: true,
        inClaims: false,
        timestamp: new Date().toISOString(),
    }))

    fs.writeFileSync(detailsFile, details.map((detail) => JSON.stringify(detail)).join("\n"))

    console.log(`Missing addresses details written to: ${detailsFile}`)

    // Write done addresses to files
    const doneAddressesArray = Array.from(doneAddresses).sort()
    const doneOutputFile = path.join(baseDir, "data/done-addresses.csv")

    fs.writeFileSync(doneOutputFile, doneAddressesArray.join("\n"))

    console.log(`Done addresses written to: ${doneOutputFile}`)

    // Also create an NDJSON file with claim details for done addresses
    const doneDetailsFile = path.join(baseDir, "data/done-addresses.ndjson")
    const doneDetails = doneAddressesArray.map((address) => {
        const claimDetail = claimDetails.get(address)
        return {
            address: address,
            inCsv: true,
            inClaims: true,
            claimedAmount: claimDetail?.claimedAmount || null,
            token: claimDetail?.token || null,
            status: claimDetail?.status || null,
            txHash: claimDetail?.txHash || null,
            jobId: claimDetail?.jobId || null,
            timestamp: new Date().toISOString(),
        }
    })

    fs.writeFileSync(doneDetailsFile, doneDetails.map((detail) => JSON.stringify(detail)).join("\n"))

    console.log(`Done addresses details written to: ${doneDetailsFile}`)

    // Summary
    console.log("\n=== SUMMARY ===")
    console.log(`Total addresses in CSV file: ${allAddresses.size}`)
    console.log(`Total addresses in claims files: ${claimedAddresses.size}`)
    console.log(`Addresses in BOTH CSV and claims: ${doneAddresses.size}`)
    console.log(`Addresses ONLY in CSV (missing from claims): ${missingAddresses.size}`)
    console.log(`Addresses ONLY in claims (not in CSV): ${claimedAddresses.size - doneAddresses.size}`)
    console.log(``)
    console.log(`Processing success rate: ${((doneAddresses.size / allAddresses.size) * 100).toFixed(2)}% of CSV addresses were processed`)

    if (claimedAddresses.size === doneAddresses.size) {
        console.log(`✅ All addresses in claims files are also in the CSV file`)
    } else {
        console.log(`⚠️  ${claimedAddresses.size - doneAddresses.size} addresses in claims are NOT in the original CSV file`)
    }
}

// Run the script
findMissingAddresses().catch(console.error)
