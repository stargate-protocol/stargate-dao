export const REWARD_TOKEN_BY_CHAIN: Record<string, string> = {
    arbitrum: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    bsc: "0x55d398326f99059fF775485246999027B3197955",
    fantom: "0x28a92dde19d9989f39a49905d7c9c2fac7799bdf",
    optimism: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
}

export const FD_BY_CHAIN: Record<string, string> = {
    arbitrum: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
    ethereum: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
    avalanche: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
    bsc: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
    fantom: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
    optimism: "0xAF667811A7eDcD5B0066CD4cA0da51637DB76D09",
}

export const VE_BY_CHAIN: Record<string, string> = {
    arbitrum: "0xfBd849E6007f9BC3CC2D6Eb159c045B8dc660268",
    ethereum: "0x0e42acBD23FAee03249DAFF896b78d7e79fBD58E",
    avalanche: "0xCa0F57D295bbcE554DA2c07b005b7d6565a58fCE",
    bsc: "0xD4888870C8686c748232719051b677791dBDa26D",
    fantom: "0x933421675cDC8c280e5F21f0e061E77849293dba",
    optimism: "0x43d2761ed16C89A2C4342e2B16A3C61Ccf88f05B",
}

export const INPUT_CSV_PATH = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/in/addresses.csv`

export const OUTPUT_NDJSON = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/out/claims.ndjson`
export const ERRORS_NDJSON = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/out/errors.ndjson`
export const SKIPS_NDJSON = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/out/skips.ndjson`

export const EXECUTOR_STORE = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/executor.json`
export const READER_STORE = (chain: string) => `./scripts/feeDistributorClaims/data/${chain}/reader.json`
