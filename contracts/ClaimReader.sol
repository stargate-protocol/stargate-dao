// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol";
import {IFeeDistributor} from "./interfaces/IFeeDistributor.sol";

contract ClaimReader {
    IFeeDistributor public immutable fd;

    constructor(address _fd) {
        fd = IFeeDistributor(_fd);
    }

    /// @notice Dry-run claims and return per-user totals. Use callStatic (eth_call).
    /// @dev Reverts if token claiming is disabled in the FD.
    function viewFullClaimPerUser(address[] calldata users, IERC20 token) external returns (uint256[] memory totals, bool[] memory requiresSelfClaim) {
        // finalize caches at the current block timestamp
        fd.checkpoint();
        fd.checkpointToken(token);

        uint256 n = users.length;
        totals = new uint256[](n);
        requiresSelfClaim = new bool[](n);

        for (uint256 i = 0; i < n; ++i) {
            address user = users[i];
            uint256 claimed;
            // Try to claim in-transaction; will revert for users who enabled 'only self'
            for (uint256 r = 0; r < 10; ++r) {
                // try/catch isolates per-user failures
                try fd.claimToken(user, token) returns (uint256 amt) {
                    if (amt == 0) break;
                    claimed += amt;
                } catch {
                    // "Claiming is not allowed" or any other revert -> mark and skip
                    requiresSelfClaim[i] = true;
                    claimed = 0;
                    break;
                }
            }
            totals[i] = claimed; // 0 if requires self-claim
        }
    }
}
