// constants/tokens.ts
export const REWARD_TOKEN_BY_CHAIN: Record<string, string> = {
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    arbitrum: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
}

export const PREUNLOCK_BLOCK: Record<string, number> = {
    ethereum: 23221842,
    arbitrum: 372386017,
}
// }
// 23221842
// 23235566
// // 23221843

// cast call 0x0e42acBD23FAee03249DAFF896b78d7e79fBD58E "unlocked()" --block 23221842 --rpc-url https://1.rpc.thirdweb.com/4ca262ff7114dc09024ea5fdb0084a6c
// cast call 0x0e42acBD23FAee03249DAFF896b78d7e79fBD58E "unlocked()" --block 23235566 --rpc-url https://1.rpc.thirdweb.com/4ca262ff7114dc09024ea5fdb0084a6c
// cast run 0xf5b70695233e3deff16090a95abcb96ae52ad6c31460a32061279f9e230751c3 --rpc-url https://42161.rpc.thirdweb.com/4ca262ff7114dc09024ea5fdb0084a6c
