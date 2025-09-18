// SPDX-License-Identifier: MIT

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import {Ownable} from "@openzeppelin-solc-0.7/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-solc-0.7/contracts/token/ERC20/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin-solc-0.7/contracts/utils/ReentrancyGuard.sol";

import {IFeeDistributor} from "./interfaces/IFeeDistributor.sol";

/**
 * Todo
 * this contract assumes the old contract stage is not going to be modified, check carefully if there is a way to modify the old contract stage and rekt it.
 *
 * */

/**
 * @title NewFeeDistributor
 * @notice Pays users exactly what the old FeeDistributor would pay, computed from its
 *         snapshotted state, but funded from this contract. Naming mirrors the original.
 */
contract NewFeeDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* -------------------- Constants & state -------------------- */
    uint256 private constant WEEK = 1 weeks;
    uint256 private constant WEEK_MINUS_SECOND = 1 weeks - 1;

    IFeeDistributor private immutable _old;

    // We maintain our own per-(user,token) cursor, just like the old contract does,
    // so we don’t double pay across multiple calls.
    mapping(address => mapping(IERC20 => uint256)) private _userTokenTimeCursor;

    /* -------------------- Events (match old) -------------------- */
    // Same event name + args as the old FeeDistributor
    event TokensClaimed(address indexed user, IERC20 indexed token, uint256 amount, uint256 newUserTokenTimeCursor);
    event TokenWithdrawn(IERC20 token, uint256 amount, address recipient);

    /* -------------------- Modifiers (match old semantics) -------------------- */
    modifier userAllowedToClaim(address user) {
        // If old contract enforces "only ve holder can claim", mirror the behavior
        if (_old.onlyVeHolderClaimingEnabled(user)) {
            require(msg.sender == user, "Claiming is not allowed");
        }
        _;
    }

    modifier tokenCanBeClaimed(IERC20 token) {
        _checkIfClaimingEnabled(token);
        _;
    }

    modifier tokensCanBeClaimed(IERC20[] calldata tokens) {
        uint256 tokensLength = tokens.length;
        for (uint256 i = 0; i < tokensLength; ++i) {
            _checkIfClaimingEnabled(tokens[i]);
        }
        _;
    }

    constructor(IFeeDistributor oldFeeDistributor) {
        _old = oldFeeDistributor;
    }

    /* -------------------- External admin helpers -------------------- */
    function withdrawToken(IERC20 token, uint256 amount, address recipient) external onlyOwner {
        token.safeTransfer(recipient, amount);
        emit TokenWithdrawn(token, amount, recipient);
    }

    /* -------------------- Public getters (mirroring names) -------------------- */

    // Mirror-style getter so you can inspect our local cursor
    function getUserTokenTimeCursor(address user, IERC20 token) external view returns (uint256) {
        uint256 c = _userTokenTimeCursor[user][token];
        if (c == 0) {
            // First time: mirror the old contract's default start via its getter
            return _old.getUserTokenTimeCursor(user, token);
        }
        return c;
    }

    function getOldFeeDistributor() external view returns (IFeeDistributor) {
        return _old;
    }

    /* -------------------- Claiming (same function names & shape) -------------------- */

    /**
     * @notice Claims all pending distributions of `token` for `user`, funded by this contract,
     *         using the same math/window as the old FeeDistributor.
     * @dev    Mirrors the structure of the original claimToken (minus checkpoints).
     */
    function claimToken(address user, IERC20 token) external nonReentrant userAllowedToClaim(user) tokenCanBeClaimed(token) returns (uint256) {
        // NOTE: We intentionally DO NOT call:
        //   _checkpointTotalSupply();
        //   _checkpointUserBalance(user);
        //   _checkpointToken(token, false);
        // Since they mutate the old contract's storage so claims are accurate going forward.
        return _claimToken(user, token);
    }

    /**
     * @notice Batch version, same signature idea as the old `claimTokens`.
     */
    function claimTokens(address user, IERC20[] calldata tokens) external nonReentrant userAllowedToClaim(user) tokensCanBeClaimed(tokens) returns (uint256[] memory) {
        uint256 len = tokens.length;
        uint256[] memory amounts = new uint256[](len);
        for (uint256 i = 0; i < len; ++i) {
            amounts[i] = _claimToken(user, tokens[i]);
        }
        return amounts;
    }

    /* -------------------- Internal logic (mirrors old _claimToken) -------------------- */

    function _claimToken(address user, IERC20 token) internal returns (uint256) {
        // Establish starting week: our local cursor or (first time) old.getUserTokenTimeCursor
        uint256 nextUserTokenWeekToClaim = _userTokenTimeCursor[user][token];
        if (nextUserTokenWeekToClaim == 0) {
            nextUserTokenWeekToClaim = _old.getUserTokenTimeCursor(user, token);
        }

        // Compute firstUnclaimableWeek exactly like the old contract:
        // min( roundUp(min(globalCursor, userCursor)), roundDown(tokenCursor) )
        uint256 firstUnclaimableWeek = _min(_roundUpTimestamp(_min(_old.getTimeCursor(), _old.getUserTimeCursor(user))), _roundDownTimestamp(_old.getTokenTimeCursor(token)));

        uint256 amount;
        // Same structure: iterate weeks up to a gas-friendly cap (20), break when we reach the bound
        for (uint256 i = 0; i < 20; ++i) {
            // We clearly cannot claim for `firstUnclaimableWeek` and so we break here.
            if (nextUserTokenWeekToClaim >= firstUnclaimableWeek) break;

            amount += (_old.getTokensDistributedInWeek(token, nextUserTokenWeekToClaim) * _old.getUserBalanceAtTimestamp(user, nextUserTokenWeekToClaim)) / _old.getTotalSupplyAtTimestamp(nextUserTokenWeekToClaim);

            nextUserTokenWeekToClaim += 1 weeks;
        }

        // Advance our local cursor to prevent double-claiming
        _userTokenTimeCursor[user][token] = nextUserTokenWeekToClaim;

        // Pay from this contract's balance
        if (amount > 0) {
            token.safeTransfer(user, amount);
        }

        emit TokensClaimed(user, token, amount, nextUserTokenWeekToClaim);
        return amount;
    }

    /* -------------------- Helpers (same names as old) -------------------- */

    function _roundDownTimestamp(uint256 timestamp) private pure returns (uint256) {
        return (timestamp / WEEK) * WEEK;
    }

    function _roundUpTimestamp(uint256 timestamp) private pure returns (uint256) {
        return _roundDownTimestamp(timestamp + WEEK_MINUS_SECOND);
    }

    /* does the same as Math.min */
    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _checkIfClaimingEnabled(IERC20 token) private view {
        require(_old.canTokenBeClaimed(token), "Token is not allowed");
    }
}
