// SPDX-License-Identifier: MIT

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import {Ownable} from "@openzeppelin-solc-0.7/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin-solc-0.7/contracts/token/ERC20/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin-solc-0.7/contracts/utils/ReentrancyGuard.sol";

import {IFeeDistributor} from "./interfaces/IFeeDistributor.sol";
import {IVotingEscrow} from "./interfaces/IVotingEscrow.sol";

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

    IFeeDistributor private immutable _oldFD;
    IVotingEscrow private immutable _ve;

    // We maintain our own per-(user,token) cursor, just like the old contract does,
    // so we don’t double pay across multiple calls.
    mapping(address => mapping(IERC20 => uint256)) private _userTokenTimeCursor;

    /* -------------------- Events (match old) -------------------- */
    // Same event name + args as the old FeeDistributor
    event TokensClaimed(address indexed user, IERC20 indexed token, uint256 amount, uint256 newUserTokenTimeCursor);
    event TokenWithdrawn(IERC20 token, uint256 amount, address recipient);

    struct TokenStateView {
        uint256 lastTokenTime;
        uint256 timeSinceLastTokenCheckpoint;
        uint256 tokenTimeCursor;
        bool tokenWouldEarlyReturn;
    }

    /* -------------------- Modifiers (match old semantics) -------------------- */
    modifier userAllowedToClaim(address user) {
        // If old contract enforces "only ve holder can claim", mirror the behavior
        if (_oldFD.onlyVeHolderClaimingEnabled(user)) {
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
        _oldFD = oldFeeDistributor;
        _ve = oldFeeDistributor.getVotingEscrow();
    }

    /* -------------------- External admin helpers -------------------- */
    function withdrawToken(IERC20 token, uint256 amount, address recipient) external onlyOwner {
        token.safeTransfer(recipient, amount);
        emit TokenWithdrawn(token, amount, recipient);
    }

    /* -------------------- Public getters -------------------- */

    // Mirror-style getter so you can inspect our local cursor
    function getUserTokenTimeCursor(address user, IERC20 token) external view returns (uint256) {
        uint256 c = _userTokenTimeCursor[user][token];
        if (c == 0) {
            // First time: mirror the old contract's default start via its getter
            return _oldFD.getUserTokenTimeCursor(user, token);
        }
        return c;
    }

    function getOldFeeDistributor() external view returns (IFeeDistributor) {
        return _oldFD;
    }

    /* -------------------- Claiming -------------------- */

    /**
     * @notice Claims all pending distributions of `token` for `user`, funded by this contract,
     *         using the same math/window as the old FeeDistributor.
     * @dev    Mirrors the structure of the original claimToken (minus checkpoints).
     */
    function claimToken(address user, IERC20 token) external nonReentrant userAllowedToClaim(user) tokenCanBeClaimed(token) returns (uint256) {
        // mirrors: _timeCursor, _userState[user].timeCursor, tokenState.timeCursor
        uint256 timeCursor = _checkpointTotalSupply(); // as-if
        uint256 userTimeCursor = _checkpointUserBalance(user); // as-if

        TokenStateView memory tsv = _checkpointToken(token, false); // as-if

        return _claimToken(user, token, timeCursor, userTimeCursor, tsv);
    }

    /**
     * @notice Batch version, same signature idea as the old `claimTokens`.
     */
    function claimTokens(address user, IERC20[] calldata tokens) external nonReentrant userAllowedToClaim(user) tokensCanBeClaimed(tokens) returns (uint256[] memory) {
        uint256 timeCursor = _checkpointTotalSupply();
        uint256 userTimeCursor = _checkpointUserBalance(user);

        uint256 tokensLength = tokens.length;
        uint256[] memory amounts = new uint256[](tokensLength);

        for (uint256 i = 0; i < tokensLength; ++i) {
            TokenStateView memory tsv = _checkpointToken(tokens[i], false);
            amounts[i] = _claimToken(user, tokens[i], timeCursor, userTimeCursor, tsv);
        }
        return amounts;
    }

    /* -------------------- Internal functions -------------------- */

    function _claimToken(address user, IERC20 token, uint256 timeCursor, uint256 userTimeCursor, TokenStateView memory tsv) private returns (uint256) {
        require(block.timestamp > _oldFD.getStartTime(), "Fee distribution has not started yet");

        uint256 nextUserTokenWeekToClaim = _userTokenTimeCursor[user][token];
        if (nextUserTokenWeekToClaim == 0) {
            uint256 oldCursor = _oldFD.getUserTokenTimeCursor(user, token);
            if (oldCursor != 0) {
                nextUserTokenWeekToClaim = oldCursor;
            } else {
                nextUserTokenWeekToClaim = _initialUserStartWeek(user);
                uint256 ts = _oldFD.getTokenStartTime(token);
                if (ts > nextUserTokenWeekToClaim) nextUserTokenWeekToClaim = ts;
            }
        }

        // EXACT same one-liner as original
        uint256 firstUnclaimableWeek = _min(_roundUpTimestamp(_min(timeCursor, userTimeCursor)), _roundDownTimestamp(tsv.tokenTimeCursor));

        uint256 amount;
        for (uint256 i = 0; i < 20; ++i) {
            if (nextUserTokenWeekToClaim >= firstUnclaimableWeek) break;

            uint256 tokensPerWeek = _oldFD.getTokensDistributedInWeek(token, nextUserTokenWeekToClaim);

            // Use the old FD’s weekly snapshots (not live VE calls)
            uint256 userBal = _veBalanceOfAt(user, nextUserTokenWeekToClaim); // FD-style bias - slope*dt
            uint256 veSupply = _veTotalSupplyAt(nextUserTokenWeekToClaim); // FD-style bias - slope*dt

            if (veSupply == 0 || userBal == 0 || tokensPerWeek == 0) {
                nextUserTokenWeekToClaim += 1 weeks;
                continue;
            }

            amount += (tokensPerWeek * userBal) / veSupply;
            nextUserTokenWeekToClaim += 1 weeks;
        }

        _userTokenTimeCursor[user][token] = nextUserTokenWeekToClaim;

        if (amount > 0) {
            token.safeTransfer(user, amount);
        }

        emit TokensClaimed(user, token, amount, nextUserTokenWeekToClaim);
        return amount;
    }

    function _checkpointTotalSupply() private view returns (uint256 _timeCursor) {
        _timeCursor = _oldFD.getTimeCursor();
        uint256 weekStart = _roundDownTimestamp(block.timestamp);
        if (!(_timeCursor > weekStart || weekStart == block.timestamp)) {
            _timeCursor = weekStart + 1 weeks;
        }
    }

    function _checkpointUserBalance(address user) private view returns (uint256 _userTimeCursor) {
        require(_ve.user_point_epoch(user) > 0, "veSTG balance is zero");

        _userTimeCursor = _oldFD.getUserTimeCursor(user);
        if (_userTimeCursor == 0) {
            // find epoch containing FeeDistributor.startTime (same anchor the old uses)
            uint256 maxUserEpoch = _ve.user_point_epoch(user);
            uint256 min = 0;
            uint256 max = maxUserEpoch;
            uint256 startTime = _oldFD.getStartTime();

            IVotingEscrow.Point memory nextUserPoint;
            for (uint256 i = 0; i < 128; ++i) {
                if (min >= max) break;
                uint256 mid = (min + max + 2) / 2;
                nextUserPoint = _ve.user_point_history(user, mid);
                if (nextUserPoint.ts <= startTime) {
                    min = mid;
                } else {
                    max = mid - 1;
                }
            }
            uint256 userEpoch = min == 0 ? 1 : min;
            nextUserPoint = _ve.user_point_history(user, userEpoch);
            _userTimeCursor = _max(_oldFD.getStartTime(), _roundUpTimestamp(nextUserPoint.ts));
        }

        // Always perform the “as-if checkpointed now” bump
        uint256 weekStart = _roundDownTimestamp(block.timestamp);
        if (_userTimeCursor < weekStart) {
            _userTimeCursor = weekStart + WEEK;
        }
    }

    function _checkpointToken(IERC20 token, bool /*force*/) private view returns (TokenStateView memory s) {
        s.lastTokenTime = _oldFD.getTokenTimeCursor(token);
        if (s.lastTokenTime == 0) {
            s.timeSinceLastTokenCheckpoint = 0;
            s.tokenTimeCursor = block.timestamp;
            s.tokenWouldEarlyReturn = false;
        } else {
            s.timeSinceLastTokenCheckpoint = block.timestamp - s.lastTokenTime;
            bool alreadyThisWeek = _roundDownTimestamp(block.timestamp) == _roundDownTimestamp(s.lastTokenTime);
            bool nearingEnd = (_roundUpTimestamp(block.timestamp) - block.timestamp) < 1 days;
            s.tokenWouldEarlyReturn = (alreadyThisWeek && !nearingEnd); // force=false
            s.tokenTimeCursor = s.tokenWouldEarlyReturn ? s.lastTokenTime : block.timestamp;
        }
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

    /* does the same as Math.max */
    function _max(uint256 a, uint256 b) private pure returns (uint256) {
        return a >= b ? a : b;
    }

    function _checkIfClaimingEnabled(IERC20 token) private view {
        require(_oldFD.canTokenBeClaimed(token), "Token is not allowed");
    }

    function _veTotalSupplyAt(uint256 t) private view returns (uint256) {
        uint256 e = _findTimestampEpoch(t);
        IVotingEscrow.Point memory pt = _ve.point_history(e);

        int128 dt = t > pt.ts ? int128(t - pt.ts) : int128(0);
        int128 supply = pt.bias - pt.slope * dt;
        return supply > 0 ? uint256(supply) : 0;
    }

    function _veBalanceOfAt(address user, uint256 t) private view returns (uint256) {
        uint256 maxUserEpoch = _ve.user_point_epoch(user);
        if (maxUserEpoch == 0) return 0;

        // find epoch for user with ts <= t
        uint256 min = 0;
        uint256 max = maxUserEpoch;
        for (uint256 i = 0; i < 128; ++i) {
            if (min >= max) break;
            uint256 mid = (min + max + 2) / 2;
            IVotingEscrow.Point memory ptm = _ve.user_point_history(user, mid);
            if (ptm.ts <= t) {
                min = mid;
            } else {
                max = mid - 1;
            }
        }

        IVotingEscrow.Point memory pt = _ve.user_point_history(user, min == 0 ? 1 : min);
        int128 dt = t > pt.ts ? int128(t - pt.ts) : int128(0);
        int128 bal = pt.bias - pt.slope * dt;
        return bal > 0 ? uint256(bal) : 0;
    }

    function _findTimestampEpoch(uint256 timestamp) private view returns (uint256) {
        uint256 min = 0;
        uint256 max = _ve.epoch();
        for (uint256 i = 0; i < 128; ++i) {
            if (min >= max) break;
            uint256 mid = (min + max + 2) / 2;
            IVotingEscrow.Point memory pt = _ve.point_history(mid);
            if (pt.ts <= timestamp) {
                min = mid;
            } else {
                max = mid - 1;
            }
        }
        return min;
    }

    function _initialUserStartWeek(address user) private view returns (uint256) {
        // Same anchor the old FD uses: max(startTime, roundUp(userPoint.ts))
        uint256 startTime = _oldFD.getStartTime();
        uint256 maxUserEpoch = _ve.user_point_epoch(user);
        require(maxUserEpoch > 0, "veSTG balance is zero");

        uint256 lo = 0;
        uint256 hi = maxUserEpoch;
        for (uint256 i = 0; i < 128; ++i) {
            if (lo >= hi) break;
            uint256 mid = (lo + hi + 2) / 2;
            if (_ve.user_point_history(user, mid).ts <= startTime) lo = mid;
            else hi = mid - 1;
        }
        if (lo == 0) lo = 1;
        IVotingEscrow.Point memory p = _ve.user_point_history(user, lo);
        return _max(startTime, _roundUpTimestamp(p.ts));
    }
}
