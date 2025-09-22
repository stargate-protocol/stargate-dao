export const REWARD_TOKEN_BY_CHAIN: Record<string, string> = {
    arbitrum: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
}

export const FD_BY_CHAIN: Record<string, string> = {
    arbitrum: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
    ethereum: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
}

export const VE_BY_CHAIN: Record<string, string> = {
    arbitrum: "0xfBd849E6007f9BC3CC2D6Eb159c045B8dc660268",
    ethereum: "0x0e42acBD23FAee03249DAFF896b78d7e79fBD58E",
}

export const INPUT_CSV_PATH = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/in/addresses.csv`

export const OUTPUT_NDJSON = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/out/claims.ndjson`
export const ERRORS_NDJSON = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/out/errors.ndjson`

export const EXECUTOR_STORE = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/executor.json`
