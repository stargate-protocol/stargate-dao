// contracts/BatchClaimExecutor.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import {IERC20} from "@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol";
import {IFeeDistributor} from "./interfaces/IFeeDistributor.sol";

contract BatchClaimExecutor {
    IFeeDistributor public immutable oldFD;

    event Claimed(address indexed user, IERC20 indexed token, uint256 amount);
    event ClaimedWithRounds(address indexed user, IERC20 indexed token, uint256 amount, uint256 rounds);
    event ClaimFailed(address indexed user, IERC20 indexed token, bytes reason);
    event ClaimSkippedOnlySelf(address indexed user, IERC20 indexed token);

    constructor(address _oldFD) {
        oldFD = IFeeDistributor(_oldFD);
    }

    /// @notice Claims for multiple users in a single tx; loops each user until no more is claimable
    /// @dev Reverts if token is not enabled in the old FD.
    function batchFullClaimToken(address[] calldata users, IERC20 token) external returns (uint256 totalClaimed) {
        require(oldFD.canTokenBeClaimed(token), "Token not allowed");

        for (uint256 i = 0; i < users.length; ++i) {
            address user = users[i];

            // Respect "only ve holder can claim" setting on old FD
            if (oldFD.onlyVeHolderClaimingEnabled(user) && msg.sender != user) {
                emit ClaimSkippedOnlySelf(user, token);
                continue;
            }

            uint256 claimed;
            uint256 rounds;
            // huge safety cap to avoid pathological infinite loops
            for (uint256 r = 0; r < 4096; ++r) {
                try oldFD.claimToken(user, token) returns (uint256 amt) {
                    if (amt == 0) break;
                    claimed += amt;
                    rounds += 1;
                } catch (bytes memory reason) {
                    emit ClaimFailed(user, token, reason);
                    claimed = 0; // ignore partials if a revert happens mid-stream
                    rounds = 0;
                    break;
                }
            }

            if (rounds > 0) {
                emit ClaimedWithRounds(user, token, claimed, rounds);
                emit Claimed(user, token, claimed);
                totalClaimed += claimed;
            } else if (claimed == 0) {
                // if nothing claimed and not skipped, still emit a Claimed(0) for clarity
                emit Claimed(user, token, 0);
            }
        }
    }
}
