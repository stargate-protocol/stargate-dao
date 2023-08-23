import { ethers } from "hardhat"
import { BigNumber, Contract, ContractTransaction, utils } from "ethers"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { advanceToTimestamp, currentTimestamp, DAY, receiptTimestamp, WEEK, roundUpTimestamp, roundDownTimestamp } from "./helpers/time"

describe("FeeDistributor", function () {
    let votingEscrow: Contract
    let token: Contract
    let rewardsToken: Contract
    let rewardsToken2: Contract
    let feeDistributor: Contract
    let startTime: BigNumber
    let user1: SignerWithAddress, user2: SignerWithAddress, other: SignerWithAddress

    async function createLockForUser(user: SignerWithAddress, amount: BigNumber, lockDuration: number): Promise<void> {
        await token.mint(user.address, amount)
        await token.connect(user).approve(votingEscrow.address, amount)
        const now = await currentTimestamp()
        await votingEscrow.connect(user).create_lock(amount, now.add(lockDuration))
    }

    async function depositForUser(user: SignerWithAddress, amount: BigNumber): Promise<void> {
        await token.mint(user.address, amount)
        await token.connect(user).approve(votingEscrow.address, amount)
        await votingEscrow.connect(user).increase_amount(amount)
    }

    function expectTimestampsMatch(timestamp: BigNumber, expectedTimestamp: BigNumber): void {
        const weekNumber = BigNumber.from(timestamp).div(WEEK).toNumber()
        const expectedWeekNumber = BigNumber.from(expectedTimestamp).div(WEEK).toNumber()
        const difference = weekNumber - expectedWeekNumber
        expect(timestamp, `Timestamp is ${Math.abs(difference)} weeks ${difference > 0 ? "ahead" : "behind"} expected value`).to.be.eq(
            expectedTimestamp
        )
    }

    function getWeekTimestamps(end: BigNumber): BigNumber[] {
        const numWeeks = roundDownTimestamp(end).sub(roundDownTimestamp(startTime)).div(WEEK).toNumber()
        return Array.from({ length: numWeeks }, (_, i) => roundDownTimestamp(startTime).add(i * WEEK))
    }

    async function expectConsistentUserBalance(user: SignerWithAddress, timestamp: BigNumber): Promise<void> {
        const userAddress = user.address
        const cachedBalance = await feeDistributor.getUserBalanceAtTimestamp(userAddress, timestamp)
        const expectedBalance = await votingEscrow.balanceOfAtT(userAddress, timestamp)
        expect(cachedBalance).to.be.eq(expectedBalance)
    }

    async function expectConsistentUserBalancesUpToTimestamp(user: SignerWithAddress, timestamp: BigNumber): Promise<void> {
        const userAddress = user.address
        const weekTimestamps = getWeekTimestamps(await currentTimestamp())
        for (const weekTimestamp of weekTimestamps) {
            if (weekTimestamp.lt(timestamp)) {
                await expectConsistentUserBalance(user, weekTimestamp)
            } else {
                expect(await feeDistributor.getUserBalanceAtTimestamp(userAddress, weekTimestamp)).to.be.eq(0)
            }
        }
    }

    before("setup signers", async () => {
        ;[, user1, user2, other] = await ethers.getSigners()
    })

    beforeEach("deploy FeeDistributor", async () => {
        const tokenFactory = await ethers.getContractFactory("TestToken")
        token = await tokenFactory.deploy()
        rewardsToken = await tokenFactory.deploy()
        rewardsToken2 = await tokenFactory.deploy()

        const votingEscrowFactory = await ethers.getContractFactory("VotingEscrow")
        votingEscrow = await votingEscrowFactory.deploy(token.address, 0)

        // startTime is rounded up to the beginning of next week
        startTime = roundUpTimestamp(await currentTimestamp())
        const feeDistributorFactory = await ethers.getContractFactory("TestFeeDistributor")
        feeDistributor = await feeDistributorFactory.deploy(votingEscrow.address, startTime)

        const amount = utils.parseEther("1")
        await createLockForUser(user1, amount, 365 * DAY)
        await createLockForUser(user2, amount.mul(2), 365 * DAY)
        // User 1 owns a third of the locked token - they'll have about a third of the VotingEscrow supply
        // (not exactly due to how decaying works).

        expect(await votingEscrow.balanceOf(user1.address)).to.be.gt(0, "zero VotingEscrow balance")
        expect(await votingEscrow.totalSupply()).to.be.gt(0, "zero VotingEscrow supply")
    })

    describe("constructor", () => {
        it("sets the VotingEscrow contract address", async () => {
            expect(await feeDistributor.getVotingEscrow()).to.be.eq(votingEscrow.address)
        })

        it("sets the time cursor to the expected value", async () => {
            expectTimestampsMatch(await feeDistributor.getTimeCursor(), startTime)
        })
    })

    describe("checkpointing", () => {
        describe("global checkpoint", () => {
            context("when startTime has not passed", () => {
                it("does nothing", async () => {
                    expectTimestampsMatch(await feeDistributor.getTimeCursor(), startTime)
                    expect(await feeDistributor.getTotalSupplyAtTimestamp(startTime)).to.be.eq(0)

                    await feeDistributor.checkpoint()

                    expectTimestampsMatch(await feeDistributor.getTimeCursor(), startTime)
                    expect(await feeDistributor.getTotalSupplyAtTimestamp(startTime)).to.be.eq(0)
                })
            })

            context("when startTime has passed", () => {
                beforeEach("advance time past startTime", async () => {
                    await advanceToTimestamp(startTime.add(1))
                })

                context("when the contract has already been checkpointed", () => {
                    let nextWeek: BigNumber

                    beforeEach("checkpoint contract", async () => {
                        // We checkpoint the contract so that the next time
                        // we call this function there will be no update to perform.
                        const tx = await feeDistributor.checkpoint()
                        nextWeek = roundUpTimestamp(await receiptTimestamp(tx.wait()))
                    })

                    it("nothing happens", async () => {
                        expectTimestampsMatch(await feeDistributor.getTimeCursor(), nextWeek)

                        await feeDistributor.checkpoint()

                        expectTimestampsMatch(await feeDistributor.getTimeCursor(), nextWeek)
                    })
                })

                context("when the contract has not been checkpointed this week", () => {
                    let start: BigNumber
                    let end: BigNumber

                    beforeEach("advance time past startTime", async () => {
                        start = startTime.add(1)
                    })
                    context("when the contract hasn't checkpointed in a small number of weeks", () => {
                        beforeEach("set end timestamp", async () => {
                            end = start.add(WEEK - 1)
                        })

                        beforeEach("advance time to end of period to checkpoint", async () => {
                            await advanceToTimestamp(end)
                        })

                        it("advances the global time cursor to the start of the next week", async () => {
                            expectTimestampsMatch(await feeDistributor.getTimeCursor(), startTime)

                            const tx = await feeDistributor.checkpoint()

                            const txTimestamp = await receiptTimestamp(tx.wait())
                            // Add 1 as if the transaction falls exactly on the beginning of the week
                            // then we also go to the end of the week as we can read the current balance
                            const nextWeek = roundUpTimestamp(txTimestamp.add(1))

                            expectTimestampsMatch(await feeDistributor.getTimeCursor(), nextWeek)
                        })
                    })
                })
            })
        })

        describe("user checkpoint", () => {
            describe("checkpointUser", () => {
                let user: SignerWithAddress
                let start: BigNumber
                let end: BigNumber

                function testCheckpoint(checkpointsPerWeek = 0) {
                    let expectFullySynced: boolean

                    beforeEach("advance time to end of period to checkpoint", async () => {
                        const numWeeks = roundDownTimestamp(end).sub(roundDownTimestamp(start)).div(WEEK).toNumber()
                        for (let i = 0; i < numWeeks; i++) {
                            if (i > 0) {
                                await advanceToTimestamp(roundDownTimestamp(start).add(i * WEEK + 1))
                            }
                            for (let j = 0; j < checkpointsPerWeek; j++) {
                                await depositForUser(user, ethers.utils.parseEther("1"))
                            }
                        }
                        await advanceToTimestamp(end)

                        const lastCheckpointedEpoch = await feeDistributor.getUserLastEpochCheckpointed(user.address)
                        const currentEpoch = await votingEscrow.user_point_epoch(user.address)

                        // In order to determine whether we expect the user to be fully checkpointed after a single call we must
                        // calculate the expected number of iterations of the for loop for the user to be fully up to date.
                        // We can then compare against the limit of iterations before it automatically breaks (50).
                        let iterations
                        if (currentEpoch.sub(lastCheckpointedEpoch).lte(20)) {
                            // We use an iteration every time we either:
                            // a) write a value of the user's balance to storage, or
                            // b) move forwards an epoch.
                            iterations = numWeeks + checkpointsPerWeek * numWeeks
                        } else {
                            // In this case, we skip the checkpoints in the first week as we trigger the binary search shortcut.
                            // We then remove another `checkpointsPerWeek` iterations.
                            iterations = numWeeks + Math.max(checkpointsPerWeek * (numWeeks - 1), 0)
                        }

                        expectFullySynced = iterations < 50
                    })

                    it("advances the user's time cursor", async () => {
                        const userCursorBefore = await feeDistributor.getUserTimeCursor(user.address)

                        const tx = await feeDistributor.checkpointUser(user.address)

                        if (expectFullySynced) {
                            // This is a stronger check to ensure that we're completely up to date.
                            const txTimestamp = await receiptTimestamp(tx.wait())
                            const nextWeek = roundUpTimestamp(txTimestamp)
                            expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user.address), nextWeek)
                        } else {
                            // If we're not fully syncing then just check that we've managed to progress at least one week.
                            const nextWeek = userCursorBefore.add(WEEK)
                            expect(await feeDistributor.getUserTimeCursor(user.address)).to.be.gte(nextWeek)
                        }
                    })

                    it("progresses the most recently checkpointed epoch", async () => {
                        const currentEpoch = await votingEscrow.user_point_epoch(user.address)
                        const previousLastCheckpointedEpoch = await feeDistributor.getUserLastEpochCheckpointed(user.address)

                        await feeDistributor.checkpointUser(user.address)

                        const newLastCheckpointedEpoch = await feeDistributor.getUserLastEpochCheckpointed(user.address)

                        if (previousLastCheckpointedEpoch.eq(currentEpoch) || expectFullySynced) {
                            expect(newLastCheckpointedEpoch).to.be.eq(currentEpoch)
                        } else {
                            expect(newLastCheckpointedEpoch).to.be.gt(previousLastCheckpointedEpoch)
                        }
                    })

                    it("stores the user's balance at the start of each week", async () => {
                        const userCursorBefore = await feeDistributor.getUserTimeCursor(user.address)
                        expectConsistentUserBalancesUpToTimestamp(user, userCursorBefore)

                        await feeDistributor.checkpointUser(user.address)

                        const userCursorAfter = await feeDistributor.getUserTimeCursor(user.address)
                        expectConsistentUserBalancesUpToTimestamp(user, userCursorAfter)
                    })
                }

                context("on first checkpoint", () => {
                    context("when startTime has not passed", () => {
                        it("reverts", async () => {
                            await expect(feeDistributor.checkpointUser(user1.address)).to.be.revertedWith("Fee distribution has not started yet")
                        })
                    })

                    context("when startTime has passed", () => {
                        beforeEach("advance time past startTime", async () => {
                            await advanceToTimestamp(startTime.add(1))

                            start = await currentTimestamp()
                        })

                        context("when user hasn't checkpointed in a small number of weeks", () => {
                            beforeEach("set end timestamp", async () => {
                                end = start.add(8 * WEEK - 1)
                            })

                            context("when user locked prior to the beginning of the week", () => {
                                beforeEach("set user", async () => {
                                    user = user1
                                })
                                testCheckpoint()
                            })

                            context("when user locked after the beginning of the week", () => {
                                beforeEach("set user", async () => {
                                    user = other
                                    await createLockForUser(other, ethers.utils.parseEther("1"), 365 * DAY)
                                })
                                testCheckpoint()
                            })
                        })
                    })
                })

                context("on subsequent checkpoints", () => {
                    beforeEach("advance time past startTime and checkpoint", async () => {
                        await advanceToTimestamp(startTime.add(1))
                        await feeDistributor.checkpointUser(user1.address)
                    })

                    context("when the user has already been checkpointed", () => {
                        let nextWeek: BigNumber

                        beforeEach("checkpoint contract", async () => {
                            // We checkpoint the contract so that the next time
                            // we call this function there will be no update to perform.
                            const tx = await feeDistributor.checkpointUser(user1.address)
                            nextWeek = roundUpTimestamp(await receiptTimestamp(tx.wait()))
                        })

                        context("when user is fully synced up to present", () => {
                            it("doesn't update the user's time cursor", async () => {
                                expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user1.address), nextWeek)

                                await feeDistributor.checkpointUser(user1.address)

                                expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user1.address), nextWeek)
                            })

                            it("remains on the most recent user epoch", async () => {
                                const currentEpoch = await votingEscrow.user_point_epoch(user1.address)

                                // Check that we're on the most recent user epoch already
                                const previousLastCheckpointedEpoch = await feeDistributor.getUserLastEpochCheckpointed(user1.address)
                                expect(previousLastCheckpointedEpoch).to.be.eq(currentEpoch)

                                await feeDistributor.checkpointUser(user1.address)

                                const newLastCheckpointedEpoch = await feeDistributor.getUserLastEpochCheckpointed(user1.address)
                                expect(newLastCheckpointedEpoch).to.be.eq(currentEpoch)
                            })
                        })

                        context("when more checkpoints are created", () => {
                            beforeEach("create many checkpoints", async () => {
                                const NUM_CHECKPOINTS = 25
                                for (let i = 0; i < NUM_CHECKPOINTS; i++) {
                                    await depositForUser(user1, ethers.utils.parseEther("1"))
                                }
                            })

                            it("doesn't update the user's time cursor", async () => {
                                expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user1.address), nextWeek)

                                await feeDistributor.checkpointUser(user1.address)

                                expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user1.address), nextWeek)
                            })

                            it("progresses the most recently checkpointed epoch", async () => {
                                await feeDistributor.checkpointUser(user2.address)

                                const currentEpoch = await votingEscrow.user_point_epoch(user2.address)
                                const newLastCheckpointedEpoch = await feeDistributor.getUserLastEpochCheckpointed(user2.address)

                                expect(newLastCheckpointedEpoch).to.be.eq(currentEpoch)
                            })
                        })
                    })

                    context("when the user has not been checkpointed this week", () => {
                        beforeEach("advance time past startTime", async () => {
                            await advanceToTimestamp(startTime.add(WEEK).add(1))

                            start = await currentTimestamp()
                        })

                        context("when user hasn't checkpointed in a small number of weeks", () => {
                            beforeEach("set end timestamp", async () => {
                                end = start.add(8 * WEEK - 1)
                            })

                            context("when user locked prior to the beginning of the week", () => {
                                beforeEach("set user", async () => {
                                    user = user1
                                })

                                context("when the user receives a small number of checkpoints", () => {
                                    testCheckpoint(2)
                                })

                                context("when the user receives enough checkpoints they cannot fully sync", () => {
                                    testCheckpoint(10)
                                })
                            })
                        })
                    })
                })
            })
        })

        describe("token checkpoint", () => {
            let tokens: Contract[]
            let tokenAmounts: BigNumber[]
            let tokenAddresses: string[]

            function itCheckpointsTokensCorrectly(checkpointTokens: () => Promise<ContractTransaction>): void {
                context("when startTime has not passed", () => {
                    it("reverts", async () => {
                        await expect(checkpointTokens()).to.be.revertedWith("Fee distribution has not started yet")
                    })
                })

                context("when startTime has passed", () => {
                    beforeEach("advance time past startTime", async () => {
                        await advanceToTimestamp(startTime.add(100))
                    })

                    it("updates the token's time cursor to the current timestamp", async () => {
                        const tx = await checkpointTokens()

                        for (const token of tokens) {
                            const tokenTimeCursor = await feeDistributor.getTokenTimeCursor(token.address)
                            const txTimestamp = await receiptTimestamp(tx.wait())
                            expectTimestampsMatch(tokenTimeCursor, txTimestamp)
                        }
                    })

                    context("when FeeDistributor hasn't received new tokens", () => {
                        beforeEach("send tokens and checkpoint", async () => {
                            for (let i = 0; i < tokens.length; i++) {
                                await tokens[i].mint(feeDistributor.address, tokenAmounts[i])
                            }

                            await feeDistributor.checkpointTokens(tokens.map((token) => token.address))
                        })

                        it("maintains the same cached balance", async () => {
                            const expectedTokenLastBalances = await Promise.all(
                                tokens.map((token) => feeDistributor.getTokenLastBalance(token.address))
                            )
                            await checkpointTokens()

                            for (let i = 0; i < tokens.length; i++) {
                                expect(await feeDistributor.getTokenLastBalance(tokens[i].address)).to.be.eq(expectedTokenLastBalances[i])
                            }
                        })
                    })

                    context("when FeeDistributor has received new tokens", () => {
                        beforeEach("send tokens", async () => {
                            for (let i = 0; i < tokens.length; i++) {
                                await tokens[i].mint(feeDistributor.address, tokenAmounts[i])
                            }
                        })

                        it("updates the cached balance by the amount of new tokens received", async () => {
                            const previousTokenLastBalances = await Promise.all(
                                tokens.map((token) => feeDistributor.getTokenLastBalance(token.address))
                            )

                            await checkpointTokens()
                            const newTokenLastBalances = await Promise.all(
                                tokens.map((token) => feeDistributor.getTokenLastBalance(token.address))
                            )

                            for (let i = 0; i < tokens.length; i++) {
                                expect(newTokenLastBalances[i].sub(previousTokenLastBalances[i])).to.be.eq(tokenAmounts[i])
                            }
                        })
                    })
                })
            }

            describe("checkpointToken", () => {
                beforeEach("Deploy protocol fee token", async () => {
                    tokens = [rewardsToken]
                    tokenAmounts = [ethers.utils.parseEther("1000")]
                    tokenAddresses = [rewardsToken.address]
                })

                itCheckpointsTokensCorrectly(() => feeDistributor.checkpointToken(tokens[0].address))
            })

            describe("checkpointTokens", () => {
                beforeEach("Deploy protocol fee token", async () => {
                    tokens = [rewardsToken, rewardsToken2]
                    tokenAmounts = [ethers.utils.parseEther("1000"), ethers.utils.parseEther("2000")]
                    tokenAddresses = [rewardsToken.address, rewardsToken2.address]
                })

                itCheckpointsTokensCorrectly(() => feeDistributor.checkpointTokens(tokenAddresses))
            })
        })
    })

    describe("claiming", () => {
        let tokens: Contract[]
        let tokenAmounts: BigNumber[]
        let tokenAddresses: string[]

        const itRevertsBeforeStartTime = (claimTokens: () => Promise<ContractTransaction>) => {
            context("when startTime has not passed", () => {
                it("reverts", async () => {
                    await expect(claimTokens()).to.be.revertedWith("Fee distribution has not started yet")
                })
            })
        }

        function itUpdatesCheckpointsCorrectly(
            claimTokens: () => Promise<ContractTransaction>,
            checkpointTypes: ("global" | "user" | "token" | "user-token")[]
        ): void {
            if (checkpointTypes.includes("global")) {
                it("checkpoints the global state", async () => {
                    const nextWeek = roundUpTimestamp(await currentTimestamp())
                    await claimTokens()

                    expectTimestampsMatch(await feeDistributor.getTimeCursor(), nextWeek)
                })
            }

            if (checkpointTypes.includes("token")) {
                it("checkpoints the token state", async () => {
                    const previousTimeCursors = await Promise.all(tokens.map((token) => feeDistributor.getTokenTimeCursor(token.address)))
                    const tx = await claimTokens()
                    const txTimestamp = await receiptTimestamp(tx.wait())

                    // This replicates the rate limiting of performing token checkpoints in the FeeDistributor contract.
                    // If we've already checkpointed the token this week and we're not in the last day of the week then we
                    // shouldn't checkpoint the token.
                    const expectedTimeCursors = previousTimeCursors.map((prevTimeCursor) => {
                        const alreadyCheckpointedThisWeek = roundDownTimestamp(txTimestamp).eq(roundDownTimestamp(prevTimeCursor))
                        const nearingEndOfWeek = roundUpTimestamp(txTimestamp).sub(txTimestamp).lt(DAY)

                        return alreadyCheckpointedThisWeek && !nearingEndOfWeek ? prevTimeCursor : txTimestamp
                    })

                    for (let i = 0; i < tokens.length; i++) {
                        const tokenTimeCursor = await feeDistributor.getTokenTimeCursor(tokens[i].address)
                        expectTimestampsMatch(tokenTimeCursor, expectedTimeCursors[i])
                    }
                })
            }

            if (checkpointTypes.includes("user")) {
                it("checkpoints the user state", async () => {
                    const nextWeek = roundUpTimestamp(await currentTimestamp())

                    await claimTokens()
                    expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user1.address), nextWeek)
                })
            }

            if (checkpointTypes.includes("user-token")) {
                it("updates the token time cursor for the user to the latest claimed week", async () => {
                    const thisWeek = roundDownTimestamp(await currentTimestamp())

                    await claimTokens()
                    for (const token of tokens) {
                        expectTimestampsMatch(await feeDistributor.getUserTokenTimeCursor(user1.address, token.address), thisWeek)
                    }
                })
            }
        }

        function itClaimsNothing(claimTokens: () => Promise<ContractTransaction>, simulateClaimTokens: () => Promise<BigNumber[]>): void {
            it("maintains the same cached balance", async () => {
                const expectedTokenLastBalances = await Promise.all(tokens.map((token) => feeDistributor.getTokenLastBalance(token.address)))
                await claimTokens()

                for (let i = 0; i < tokens.length; i++) {
                    expect(await feeDistributor.getTokenLastBalance(tokens[i].address)).to.be.eq(expectedTokenLastBalances[i])
                }
            })

            it("returns zero", async () => {
                expect(await simulateClaimTokens()).to.be.eql(tokenAmounts.map(() => BigNumber.from(0)))
            })
        }

        function itClaimsTokensCorrectly(claimTokens: () => Promise<ContractTransaction>): void {
            it("transfers tokens to the user", async () => {
                const balancesBefore = await Promise.all(tokens.map((token) => token.balanceOf(user1.address)))
                await claimTokens()
                const balancesAfter = await Promise.all(tokens.map((token) => token.balanceOf(user1.address)))

                for (let i = 0; i < tokens.length; i++) {
                    expect(balancesBefore[i]).to.be.lt(balancesAfter[i])
                }
            })

            it("subtracts the number of tokens claimed from the cached balance", async () => {
                const previousTokenLastBalances = await Promise.all(tokens.map((token) => feeDistributor.getTokenLastBalance(token.address)))
                await claimTokens()
                const newTokenLastBalances = await Promise.all(tokens.map((token) => feeDistributor.getTokenLastBalance(token.address)))

                for (let i = 0; i < tokens.length; i++) {
                    expect(newTokenLastBalances[i]).to.be.lt(previousTokenLastBalances[i])
                }
            })
        }

        describe("claimToken", () => {
            beforeEach("Deploy protocol fee token", async () => {
                tokens = [rewardsToken]
                tokenAmounts = tokens.map(() => ethers.utils.parseEther("1"))
                tokenAddresses = [rewardsToken.address]
            })

            context("when performing the first claim", () => {
                itRevertsBeforeStartTime(() => feeDistributor.claimToken(user1.address, rewardsToken.address))

                context("when startTime has passed", () => {
                    beforeEach("advance time past startTime", async () => {
                        await advanceToTimestamp(startTime.add(100))
                    })

                    itUpdatesCheckpointsCorrectly(
                        () => feeDistributor.claimToken(user1.address, rewardsToken.address),
                        ["global", "token", "user", "user-token"]
                    )

                    // Return values from static-calling claimToken need to be converted into array format to standardise test code.
                    context("when there are no tokens to distribute to user", () => {
                        itClaimsNothing(
                            () => feeDistributor.claimToken(user1.address, rewardsToken.address),
                            async () => [await feeDistributor.callStatic.claimToken(user1.address, rewardsToken.address)]
                        )
                    })

                    context("when there are tokens to distribute to user", () => {
                        beforeEach("send tokens", async () => {
                            for (let i = 0; i < tokens.length; i++) {
                                await tokens[i].mint(feeDistributor.address, tokenAmounts[i])
                            }
                            await feeDistributor.checkpointTokens(tokenAddresses)

                            // For the week to become claimable we must wait until the next week starts
                            const nextWeek = roundUpTimestamp(await currentTimestamp())
                            await advanceToTimestamp(nextWeek.add(1))
                        })

                        itClaimsTokensCorrectly(() => feeDistributor.claimToken(user1.address, rewardsToken.address))

                        context("when veSTG balance is zero", () => {
                            it("reverts", async () => {
                                await expect(feeDistributor.claimToken(other.address, rewardsToken.address)).to.be.revertedWith(
                                    "veSTG balance is zero"
                                )
                            })
                        })

                        context("when only VotingEscrow holder can claim", () => {
                            beforeEach("enable claiming only by VotingEscrow holder", async () => {
                                await feeDistributor.connect(user1).enableOnlyVeHolderClaiming(true)
                            })

                            context("when called by a third-party", () => {
                                it("reverts", async () => {
                                    await expect(
                                        feeDistributor.connect(other).claimToken(user1.address, rewardsToken.address)
                                    ).to.be.revertedWith("Claiming is not allowed")
                                })
                            })

                            context("when called by the VotingEscrow holder", () => {
                                itClaimsTokensCorrectly(() => feeDistributor.connect(user1).claimToken(user1.address, rewardsToken.address))
                            })
                        })
                    })
                })
            })

            context("when performing future claims", () => {
                beforeEach("perform the first claim", async () => {
                    await advanceToTimestamp(startTime.add(1))
                    const tx = await feeDistributor.claimToken(user1.address, rewardsToken.address)
                    const txTimestamp = await receiptTimestamp(tx.wait())

                    const thisWeek = roundDownTimestamp(txTimestamp)
                    const nextWeek = roundUpTimestamp(txTimestamp)

                    // Check that the first checkpoint left the FeeDistributor in the expected state.
                    expectTimestampsMatch(await feeDistributor.getTimeCursor(), nextWeek)
                    expectTimestampsMatch(await feeDistributor.getTokenTimeCursor(rewardsToken.address), txTimestamp)
                    expectTimestampsMatch(await feeDistributor.getUserTimeCursor(user1.address), nextWeek)
                    expectTimestampsMatch(await feeDistributor.getUserTokenTimeCursor(user1.address, rewardsToken.address), thisWeek)
                })

                context("when the user has many checkpoints", () => {
                    beforeEach("create many checkpoints", async () => {
                        // Creating many checkpoints now would prevent the user from checkpointing startTime+WEEK, which is only
                        // claimable at startTime+2*WEEK.

                        const NUM_CHECKPOINTS = 100
                        for (let i = 0; i < NUM_CHECKPOINTS; i++) {
                            await depositForUser(user1, utils.parseEther("1"))
                        }
                        await advanceToTimestamp(startTime.add(WEEK).add(1))
                    })

                    context("when there are tokens to distribute to user", () => {
                        beforeEach("send tokens", async () => {
                            await feeDistributor.checkpointTokens(tokenAddresses)
                            for (let i = 0; i < tokens.length; i++) {
                                await tokens[i].mint(feeDistributor.address, tokenAmounts[i])
                            }
                            await feeDistributor.checkpointTokens(tokenAddresses)

                            // For the week to become claimable we must wait until the next week starts
                            const nextWeek = roundUpTimestamp(await currentTimestamp())
                            await advanceToTimestamp(nextWeek.add(1))
                        })

                        itUpdatesCheckpointsCorrectly(
                            () => feeDistributor.claimToken(user1.address, rewardsToken.address),
                            ["global", "user", "token", "user-token"]
                        )

                        itClaimsTokensCorrectly(() => feeDistributor.claimToken(user1.address, rewardsToken.address))
                    })
                })
            })
        })

        describe("claimTokens", () => {
            beforeEach("Deploy protocol fee token", async () => {
                tokens = [rewardsToken, rewardsToken2]
                tokenAmounts = [ethers.utils.parseEther("1000"), ethers.utils.parseEther("2000")]
                tokenAddresses = [rewardsToken.address, rewardsToken2.address]
            })

            context("when performing the first claim", () => {
                itRevertsBeforeStartTime(() => feeDistributor.claimTokens(user1.address, tokenAddresses))

                context("when startTime has passed", () => {
                    beforeEach("advance time past startTime", async () => {
                        await advanceToTimestamp(startTime.add(100))
                    })

                    itUpdatesCheckpointsCorrectly(
                        () => feeDistributor.claimTokens(user1.address, tokenAddresses),
                        ["global", "token", "user", "user-token"]
                    )

                    context("when there are no tokens to distribute to user", () => {
                        itClaimsNothing(
                            () => feeDistributor.claimTokens(user1.address, tokenAddresses),
                            () => feeDistributor.callStatic.claimTokens(user1.address, tokenAddresses)
                        )
                    })

                    context("when there are tokens to distribute to user", () => {
                        beforeEach("send tokens", async () => {
                            for (let i = 0; i < tokens.length; i++) {
                                await tokens[i].mint(feeDistributor.address, tokenAmounts[i])
                            }
                            await feeDistributor.checkpointTokens(tokenAddresses)

                            // For the week to become claimable we must wait until the next week starts
                            const nextWeek = roundUpTimestamp(await currentTimestamp())
                            await advanceToTimestamp(nextWeek.add(1))
                        })

                        itClaimsTokensCorrectly(() => feeDistributor.claimTokens(user1.address, tokenAddresses))

                        context("when only VotingEscrow holder can claim", () => {
                            beforeEach("enable claiming only by VotingEscrow holder", async () => {
                                await feeDistributor.connect(user1).enableOnlyVeHolderClaiming(true)
                            })

                            context("when called by a third-party", () => {
                                it("reverts", async () => {
                                    await expect(feeDistributor.connect(other).claimTokens(user1.address, tokenAddresses)).to.be.revertedWith(
                                        "Claiming is not allowed"
                                    )
                                })
                            })

                            context("when called by the VotingEscrow holder", () => {
                                itClaimsTokensCorrectly(() => feeDistributor.connect(user1).claimTokens(user1.address, tokenAddresses))
                            })
                        })
                    })                    
                })
            })
        })
    })
})
