import { BigNumber, ContractReceipt } from 'ethers'
import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'

export const currentTimestamp = async (): Promise<BigNumber> => {
    return BigNumber.from(await time.latest())
}

export const currentWeekTimestamp = async (): Promise<BigNumber> => {
    return (await currentTimestamp()).div(WEEK).mul(WEEK)
}

export const fromNow = async (seconds: number): Promise<BigNumber> => {
    const now = await currentTimestamp()
    return now.add(seconds)
}

export const advanceTime = async (seconds: BigNumber): Promise<void> => {
    await time.increase(seconds)
}

export const advanceToTimestamp = async (timestamp: BigNumber): Promise<void> => {
    await time.increaseTo(timestamp)
}

export const setNextBlockTimestamp = async (timestamp: BigNumber): Promise<void> => {
    await time.setNextBlockTimestamp(timestamp)
}

export const lastBlockNumber = async (): Promise<number> => await time.latestBlock()

export const receiptTimestamp = async (receipt: ContractReceipt | Promise<ContractReceipt>): Promise<BigNumber> => {
    const blockHash = (await receipt).blockHash
    const block = await ethers.provider.getBlock(blockHash)
    return BigNumber.from(block.timestamp)
}

export const roundDownTimestamp = (timestamp: BigNumber): BigNumber => {
    return BigNumber.from(timestamp).div(WEEK).mul(WEEK)
}

export const roundUpTimestamp = (timestamp: BigNumber): BigNumber => {
    return roundDownTimestamp(BigNumber.from(timestamp).add(WEEK).sub(1))
}

export const SECOND = 1
export const MINUTE = SECOND * 60
export const HOUR = MINUTE * 60
export const DAY = HOUR * 24
export const WEEK = DAY * 7
export const MONTH = DAY * 30

