#!/usr/bin/env ts-node

import * as fs from "fs"
import * as path from "path"
import { promisify } from "util"

const readdir = promisify(fs.readdir)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)
const stat = promisify(fs.stat)
const mkdir = promisify(fs.mkdir)

interface ConsolidationOptions {
    dataDir: string
    outputDir?: string
    chains?: string[]
    fileTypes?: string[]
}

class FileConsolidator {
    private dataDir: string
    private outputDir: string
    private chains: string[]
    private fileTypes: string[]

    constructor(options: ConsolidationOptions) {
        this.dataDir = options.dataDir
        this.outputDir = options.outputDir || this.dataDir
        this.chains = options.chains || []
        this.fileTypes = options.fileTypes || ["claims", "errors", "skips"]
    }

    async consolidateFiles(): Promise<void> {
        try {
            // Discover chains if not specified
            if (this.chains.length === 0) {
                this.chains = await this.discoverChains()
            } else {
                // Validate specified chains exist
                const availableChains = await this.discoverChains()
                for (const chain of this.chains) {
                    if (!availableChains.includes(chain)) {
                        throw new Error(`Chain '${chain}' not found. Available chains: ${availableChains.join(", ")}`)
                    }
                }
            }

            console.log(`Found chains: ${this.chains.join(", ")}`)

            // Process each chain
            for (const chain of this.chains) {
                console.log(`\nProcessing chain: ${chain}`)
                await this.processChain(chain)
            }

            console.log("\nConsolidation completed successfully!")
        } catch (error) {
            console.error("Error during consolidation:", error)
            throw error
        }
    }

    private async discoverChains(): Promise<string[]> {
        const chains: string[] = []
        const items = await readdir(this.dataDir, { withFileTypes: true })

        for (const item of items) {
            if (item.isDirectory() && item.name !== "consolidated") {
                const chainPath = path.join(this.dataDir, item.name)
                // Check if it has an output directory
                const hasOutput = await this.hasOutputDirectory(chainPath)
                if (hasOutput) {
                    chains.push(item.name)
                }
            }
        }

        return chains
    }

    private async hasOutputDirectory(chainPath: string): Promise<boolean> {
        const possibleOutputDirs = ["out"]

        for (const outDir of possibleOutputDirs) {
            try {
                const outputPath = path.join(chainPath, outDir)
                const stats = await stat(outputPath)
                if (stats.isDirectory()) {
                    return true
                }
            } catch {
                // Directory doesn't exist, continue
            }
        }

        return false
    }

    async findOutputDirectory(chainPath: string): Promise<string | null> {
        const possibleOutputDirs = ["out"]

        for (const outDir of possibleOutputDirs) {
            try {
                const outputPath = path.join(chainPath, outDir)
                const stats = await stat(outputPath)
                if (stats.isDirectory()) {
                    return outputPath
                }
            } catch {
                // Directory doesn't exist, continue
            }
        }

        return null
    }

    private async processChain(chain: string): Promise<void> {
        const chainPath = path.join(this.dataDir, chain)
        const outputPath = await this.findOutputDirectory(chainPath)

        if (!outputPath) {
            console.log(`  No output directory found for chain: ${chain}`)
            return
        }

        console.log(`  Output directory: ${path.basename(outputPath)}`)

        // Process each file type - consolidate directly into the chain's output directory
        for (const fileType of this.fileTypes) {
            await this.consolidateFileType(outputPath, outputPath, chain, fileType)

            // If this is an errors file, also create an addresses-only file
            if (fileType === "errors") {
                await this.extractAddressesFromErrors(outputPath, chain)
            }
        }
    }

    private async consolidateFileType(sourcePath: string, outputPath: string, chain: string, fileType: string): Promise<void> {
        try {
            const files = await readdir(sourcePath)
            const jobFiles = files
                .filter((file) => file.startsWith(`${fileType}.job`) && file.endsWith(".ndjson"))
                .sort((a, b) => {
                    const jobA = parseInt(a.match(/job(\d+)/)?.[1] || "0")
                    const jobB = parseInt(b.match(/job(\d+)/)?.[1] || "0")
                    return jobA - jobB
                })

            if (jobFiles.length === 0) {
                console.log(`    No ${fileType} job files found`)
                return
            }

            console.log(`    Consolidating ${jobFiles.length} ${fileType} files`)

            const consolidatedPath = path.join(outputPath, `${fileType}.ndjson`)
            console.log(`    Writing to: ${consolidatedPath}`)
            const writeStream = fs.createWriteStream(consolidatedPath, { flags: "w" })

            let totalLines = 0

            for (const jobFile of jobFiles) {
                const jobFilePath = path.join(sourcePath, jobFile)
                const content = await readFile(jobFilePath, "utf-8")

                if (content.trim()) {
                    writeStream.write(content)
                    if (!content.endsWith("\n")) {
                        writeStream.write("\n")
                    }

                    const lines = content.trim().split("\n").length
                    totalLines += lines
                }
            }

            writeStream.end()

            console.log(`    ✓ Consolidated ${totalLines} ${fileType} records into ${path.basename(consolidatedPath)}`)

            // Create summary file
            await this.createSummaryFile(outputPath, chain, fileType, jobFiles.length, totalLines)
        } catch (error) {
            console.error(`    Error consolidating ${fileType} for chain ${chain}:`, error)
        }
    }

    private async createSummaryFile(
        outputPath: string,
        chain: string,
        fileType: string,
        fileCount: number,
        totalRecords: number
    ): Promise<void> {
        const summaryPath = path.join(outputPath, `${fileType}.summary.json`)
        const summary = {
            chain,
            fileType,
            sourceFiles: fileCount,
            totalRecords,
            consolidatedAt: new Date().toISOString(),
            consolidatedFile: `${fileType}.ndjson`,
        }

        await writeFile(summaryPath, JSON.stringify(summary, null, 2))
    }

    async extractAddressesFromErrors(outputPath: string, chain: string): Promise<void> {
        try {
            const errorsFile = path.join(outputPath, "errors.ndjson")

            // Check if errors file exists
            try {
                await stat(errorsFile)
            } catch {
                console.log(`    No errors file found to extract addresses from`)
                return
            }

            console.log(`    Extracting addresses from errors file...`)

            const content = await readFile(errorsFile, "utf-8")
            if (!content.trim()) {
                console.log(`    Errors file is empty`)
                return
            }

            const addressSet = new Set<string>()
            const lines = content.trim().split("\n")
            let validLines = 0

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const errorRecord = JSON.parse(line)
                        if (errorRecord.address) {
                            addressSet.add(errorRecord.address)
                            validLines++
                        }
                    } catch (parseError) {
                        console.warn(`    Warning: Could not parse error record: ${line.substring(0, 100)}...`)
                    }
                }
            }

            // Write addresses to file
            const addressesFile = path.join(outputPath, "errors-addresses.txt")
            const addressesArray = Array.from(addressSet).sort()
            await writeFile(addressesFile, addressesArray.join("\n") + "\n")

            console.log(`    ✓ Extracted ${addressesArray.length} unique addresses from ${validLines} error records`)
            console.log(`    ✓ Saved addresses to ${path.basename(addressesFile)}`)
        } catch (error) {
            console.error(`    Error extracting addresses from errors for chain ${chain}:`, error)
        }
    }

    private async ensureDirectory(dir: string): Promise<void> {
        try {
            await mkdir(dir, { recursive: true })
        } catch (error: any) {
            if (error.code !== "EEXIST") {
                throw error
            }
        }
    }
}

// Standalone function to extract addresses from existing error files
async function extractAddressesOnly() {
    const dataDir = path.join(__dirname, "data")
    const targetChain = "avalanche"

    console.log("=== Error Addresses Extractor ===")
    console.log(`Data directory: ${dataDir}`)
    console.log(`Target chain: ${targetChain}`)

    const consolidator = new FileConsolidator({
        dataDir,
        chains: [targetChain],
        fileTypes: [],
    })

    try {
        // Find the chain's output directory
        const chainPath = path.join(dataDir, targetChain)
        const outputPath = await consolidator.findOutputDirectory(chainPath)

        if (!outputPath) {
            console.error(`No output directory found for chain: ${targetChain}`)
            process.exit(1)
        }

        console.log(`Processing chain: ${targetChain}`)
        await consolidator.extractAddressesFromErrors(outputPath, targetChain)
        console.log("\nAddress extraction completed successfully!")
    } catch (error) {
        console.error("Failed to extract addresses:", error)
        process.exit(1)
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2)

    // Check if we should run address extraction only
    if (args.includes("--addresses-only") || args.includes("-a")) {
        await extractAddressesOnly()
        return
    }

    // Parse arguments
    let dataDir = path.join(__dirname, "data")
    let targetChain = "avalanche"

    console.log("=== Fee Distributor Claims File Consolidator ===")
    console.log(`Data directory: ${dataDir}`)

    const consolidator = new FileConsolidator({
        dataDir,
        chains: targetChain ? [targetChain] : [],
        fileTypes: ["claims", "errors", "skips"],
    })

    if (targetChain) {
        console.log(`Target chain: ${targetChain}`)
        console.log(`Consolidating job files for ${targetChain} into its output directory...`)
    } else {
        console.log("Consolidating job files for all chains into their respective output directories...")
    }

    try {
        await consolidator.consolidateFiles()
    } catch (error) {
        console.error("Failed to consolidate files:", error)
        process.exit(1)
    }
}

// Run if called directly
if (require.main === module) {
    main()
}

export { FileConsolidator }
