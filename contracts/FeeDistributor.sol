// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin-solc-0.7/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin-solc-0.7/contracts/math/Math.sol";
import "@openzeppelin-solc-0.7/contracts/math/SafeMath.sol";
import "@openzeppelin-solc-0.7/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IFeeDistributor.sol";
import "./interfaces/IVotingEscrow.sol";

// solhint-disable not-rely-on-time

/**
 * @title Fee Distributor
 * @author Balancer Labs. Original version https://github.com/balancer/balancer-v2-monorepo/blob/master/pkg/liquidity-mining/contracts/fee-distribution/FeeDistributor.sol
 * @notice Distributes any tokens transferred to the contract (e.g. Protocol fees) among veSTG
 * holders proportionally based on a snapshot of the week at which the tokens are sent to the FeeDistributor contract.
 * @dev Supports distributing arbitrarily many different tokens. In order to start distributing a new token to veSTG
 * holders simply transfer the tokens to the `FeeDistributor` contract and then call `checkpointToken`.
 */
contract FeeDistributor is IFeeDistributor, ReentrancyGuard {
    using SafeMath for uint;
    using SafeERC20 for IERC20;

    IVotingEscrow private immutable _votingEscrow;

    uint private immutable _startTime;

    // Global State
    uint private _timeCursor;
    mapping(uint => uint) private _veSupplyCache;

    // Token State

    // `startTime` and `timeCursor` are both timestamps so comfortably fit in a uint64.
    // `cachedBalance` will comfortably fit the total supply of any meaningful token.
    // Should more than 2^128 tokens be sent to this contract then checkpointing this token will fail until enough
    // tokens have been claimed to bring the total balance back below 2^128.
    struct TokenState {
        uint64 startTime;
        uint64 timeCursor;
        uint128 cachedBalance;
    }
    mapping(IERC20 => TokenState) private _tokenState;
    mapping(IERC20 => mapping(uint => uint)) private _tokensPerWeek;

    // User State

    // `startTime` and `timeCursor` are timestamps so will comfortably fit in a uint64.
    // For `lastEpochCheckpointed` to overflow would need over 2^128 transactions to the VotingEscrow contract.
    struct UserState {
        uint64 startTime;
        uint64 timeCursor;
        uint128 lastEpochCheckpointed;
    }
    mapping(address => UserState) internal _userState;
    mapping(address => mapping(uint => uint)) private _userBalanceAtTimestamp;
    mapping(address => mapping(IERC20 => uint)) private _userTokenTimeCursor;
    mapping(address => bool) private _onlyVeHolderClaimingEnabled;

    /**
     * @dev Reverts if only the VotingEscrow holder can claim their rewards and the given address is a third-party caller.
     * @param user - Address to validate as the only allowed caller.
     */
    modifier allowedToClaim(address user) {
        if (_onlyVeHolderClaimingEnabled[user]) {
            require(msg.sender == user, "Claiming is not allowed");
        }
        _;
    }

    constructor(IVotingEscrow votingEscrow, uint startTime) {
        _votingEscrow = votingEscrow;

        startTime = _roundDownTimestamp(startTime);
        uint currentWeek = _roundDownTimestamp(block.timestamp);
        require(startTime >= currentWeek, "Cannot start before current week");
        if (startTime == currentWeek) {
            // We assume that `votingEscrow` has been deployed in a week previous to this one.
            // If `votingEscrow` did not have a non-zero supply at the beginning of the current week
            // then any tokens which are distributed this week will be lost permanently.
            require(votingEscrow.totalSupplyAtT(currentWeek) > 0, "Zero total supply results in lost tokens");
        }
        _startTime = startTime;
        _timeCursor = startTime;
    }

    /**
     * @notice Returns the VotingEscrow (veSTG) token contract
     */
    function getVotingEscrow() external view override returns (IVotingEscrow) {
        return _votingEscrow;
    }

    /**
     * @notice Returns the global time cursor representing the most earliest uncheckpointed week.
     */
    function getTimeCursor() external view override returns (uint) {
        return _timeCursor;
    }

    /**
     * @notice Returns the user-level time cursor representing the most earliest uncheckpointed week.
     * @param user - The address of the user to query.
     */
    function getUserTimeCursor(address user) external view override returns (uint) {
        return _userState[user].timeCursor;
    }

    /**
     * @notice Returns the token-level time cursor storing the timestamp at up to which tokens have been distributed.
     * @param token - The ERC20 token address to query.
     */
    function getTokenTimeCursor(IERC20 token) external view override returns (uint) {
        return _tokenState[token].timeCursor;
    }

    /**
     * @notice Returns the user-level time cursor storing the timestamp of the latest token distribution claimed.
     * @param user - The address of the user to query.
     * @param token - The ERC20 token address to query.
     */
    function getUserTokenTimeCursor(address user, IERC20 token) external view override returns (uint) {
        return _getUserTokenTimeCursor(user, token);
    }

    /**
     * @notice Returns the user's cached balance of veSTG as of the provided timestamp.
     * @dev Only timestamps which fall on Thursdays 00:00:00 UTC will return correct values.
     * This function requires `user` to have been checkpointed past `timestamp` so that their balance is cached.
     * @param user - The address of the user of which to read the cached balance of.
     * @param timestamp - The timestamp at which to read the `user`'s cached balance at.
     */
    function getUserBalanceAtTimestamp(address user, uint timestamp) external view override returns (uint) {
        return _userBalanceAtTimestamp[user][timestamp];
    }

    /**
     * @notice Returns the cached total supply of veSTG as of the provided timestamp.
     * @dev Only timestamps which fall on Thursdays 00:00:00 UTC will return correct values.
     * This function requires the contract to have been checkpointed past `timestamp` so that the supply is cached.
     * @param timestamp - The timestamp at which to read the cached total supply at.
     */
    function getTotalSupplyAtTimestamp(uint timestamp) external view override returns (uint) {
        return _veSupplyCache[timestamp];
    }

    /**
     * @notice Returns the FeeDistributor's cached balance of `token`.
     */
    function getTokenLastBalance(IERC20 token) external view override returns (uint) {
        return _tokenState[token].cachedBalance;
    }

    /**
     * @notice Returns the amount of `token` which the FeeDistributor received in the week beginning at `timestamp`.
     * @param token - The ERC20 token address to query.
     * @param timestamp - The timestamp corresponding to the beginning of the week of interest.
     */
    function getTokensDistributedInWeek(IERC20 token, uint timestamp) external view override returns (uint) {
        return _tokensPerWeek[token][timestamp];
    }

    // Preventing third-party claiming

    /**
     * @notice Enables / disables rewards claiming only by the VotingEscrow holder for the message sender.
     * @param enabled - True if only the VotingEscrow holder can claim their rewards, false otherwise.
     */
    function enableOnlyVeHolderClaiming(bool enabled) external override {
        _onlyVeHolderClaimingEnabled[msg.sender] = enabled;
        emit OnlyVeHolderClaimingEnabled(msg.sender, enabled);
    }

    /**
     * @notice Returns true if only the VotingEscrow holder can claim their rewards, false otherwise.
     */
    function onlyVeHolderClaimingEnabled(address user) external view override returns (bool) {
        return _onlyVeHolderClaimingEnabled[user];
    }

    // Depositing

    /**
     * @notice Deposits tokens to be distributed in the current week.
     * @dev Sending tokens directly to the FeeDistributor instead of using `depositToken` may result in tokens being
     * retroactively distributed to past weeks, or for the distribution to carry over to future weeks.
     *
     * If for some reason `depositToken` cannot be called, in order to ensure that all tokens are correctly distributed
     * manually call `checkpointToken` before and after the token transfer.
     * @param token - The ERC20 token address to distribute.
     * @param amount - The amount of tokens to deposit.
     */
    function depositToken(IERC20 token, uint amount) external override nonReentrant {
        _checkpointToken(token, false);
        token.safeTransferFrom(msg.sender, address(this), amount);
        _checkpointToken(token, true);
    }

    /**
     * @notice Deposits tokens to be distributed in the current week.
     * @dev A version of `depositToken` which supports depositing multiple `tokens` at once.
     * See `depositToken` for more details.
     * @param tokens - An array of ERC20 token addresses to distribute.
     * @param amounts - An array of token amounts to deposit.
     */
    function depositTokens(IERC20[] calldata tokens, uint[] calldata amounts) external override nonReentrant {
        require(tokens.length == amounts.length, "Input length mismatch");

        uint length = tokens.length;
        for (uint i = 0; i < length; ++i) {
            _checkpointToken(tokens[i], false);
            tokens[i].safeTransferFrom(msg.sender, address(this), amounts[i]);
            _checkpointToken(tokens[i], true);
        }
    }

    // Checkpointing

    /**
     * @notice Caches the total supply of veSTG at the beginning of each week.
     * This function will be called automatically before claiming tokens to ensure the contract is properly updated.
     */
    function checkpoint() external override nonReentrant {
        _checkpointTotalSupply();
    }

    /**
     * @notice Caches the user's balance of veSTG at the beginning of each week.
     * This function will be called automatically before claiming tokens to ensure the contract is properly updated.
     * @param user - The address of the user to be checkpointed.
     */
    function checkpointUser(address user) external override nonReentrant {
        _checkpointUserBalance(user);
    }

    /**
     * @notice Assigns any newly-received tokens held by the FeeDistributor to weekly distributions.
     * @dev Any `token` balance held by the FeeDistributor above that which is returned by `getTokenLastBalance`
     * will be distributed evenly across the time period since `token` was last checkpointed.
     *
     * This function will be called automatically before claiming tokens to ensure the contract is properly updated.
     * @param token - The ERC20 token address to be checkpointed.
     */
    function checkpointToken(IERC20 token) external override nonReentrant {
        _checkpointToken(token, true);
    }

    /**
     * @notice Assigns any newly-received tokens held by the FeeDistributor to weekly distributions.
     * @dev A version of `checkpointToken` which supports checkpointing multiple tokens.
     * See `checkpointToken` for more details.
     * @param tokens - An array of ERC20 token addresses to be checkpointed.
     */
    function checkpointTokens(IERC20[] calldata tokens) external override nonReentrant {
        uint tokensLength = tokens.length;
        for (uint i = 0; i < tokensLength; ++i) {
            _checkpointToken(tokens[i], true);
        }
    }

    // Claiming

    /**
     * @notice Claims all pending distributions of the provided token for a user.
     * @dev It's not necessary to explicitly checkpoint before calling this function, it will ensure the FeeDistributor
     * is up to date before calculating the amount of tokens to be claimed.
     * @param user - The user on behalf of which to claim.
     * @param token - The ERC20 token address to be claimed.
     * @return The amount of `token` sent to `user` as a result of claiming.
     */
    function claimToken(address user, IERC20 token) external override nonReentrant allowedToClaim(user) returns (uint) {
        _checkpointTotalSupply();
        _checkpointUserBalance(user);
        _checkpointToken(token, false);

        uint amount = _claimToken(user, token);
        return amount;
    }

    /**
     * @notice Claims a number of tokens on behalf of a user.
     * @dev A version of `claimToken` which supports claiming multiple `tokens` on behalf of `user`.
     * See `claimToken` for more details.
     * @param user - The user on behalf of which to claim.
     * @param tokens - An array of ERC20 token addresses to be claimed.
     * @return An array of the amounts of each token in `tokens` sent to `user` as a result of claiming.
     */
    function claimTokens(address user, IERC20[] calldata tokens) external override nonReentrant allowedToClaim(user) returns (uint[] memory) {
        _checkpointTotalSupply();
        _checkpointUserBalance(user);

        uint tokensLength = tokens.length;
        uint[] memory amounts = new uint[](tokensLength);
        for (uint i = 0; i < tokensLength; ++i) {
            _checkpointToken(tokens[i], false);
            amounts[i] = _claimToken(user, tokens[i]);
        }

        return amounts;
    }

    // Internal functions

    /**
     * @dev It is required that both the global, token and user state have been properly checkpointed
     * before calling this function.
     */
    function _claimToken(address user, IERC20 token) internal returns (uint) {
        TokenState storage tokenState = _tokenState[token];
        uint nextUserTokenWeekToClaim = _getUserTokenTimeCursor(user, token);

        // The first week which cannot be correctly claimed is the earliest of:
        // - A) The global or user time cursor (whichever is earliest), rounded up to the end of the week.
        // - B) The token time cursor, rounded down to the beginning of the week.
        //
        // This prevents the two failure modes:
        // - A) A user may claim a week for which we have not processed their balance, resulting in tokens being locked.
        // - B) A user may claim a week which then receives more tokens to be distributed. However the user has
        //      already claimed for that week so their share of these new tokens are lost.
        uint firstUnclaimableWeek = Math.min(_roundUpTimestamp(Math.min(_timeCursor, _userState[user].timeCursor)), _roundDownTimestamp(tokenState.timeCursor));

        mapping(uint => uint) storage tokensPerWeek = _tokensPerWeek[token];
        mapping(uint => uint) storage userBalanceAtTimestamp = _userBalanceAtTimestamp[user];

        uint amount;
        for (uint i = 0; i < 20; ++i) {
            // We clearly cannot claim for `firstUnclaimableWeek` and so we break here.
            if (nextUserTokenWeekToClaim >= firstUnclaimableWeek) break;

            amount += (tokensPerWeek[nextUserTokenWeekToClaim] * userBalanceAtTimestamp[nextUserTokenWeekToClaim]) / _veSupplyCache[nextUserTokenWeekToClaim];
            nextUserTokenWeekToClaim += 1 weeks;
        }
        // Update the stored user-token time cursor to prevent this user claiming this week again.
        _userTokenTimeCursor[user][token] = nextUserTokenWeekToClaim;

        if (amount > 0) {
            // For a token to be claimable it must have been added to the cached balance so this is safe.
            tokenState.cachedBalance = uint128(tokenState.cachedBalance - amount);
            token.safeTransfer(user, amount);
            emit TokensClaimed(user, token, amount, nextUserTokenWeekToClaim);
        }

        return amount;
    }

    /**
     * @dev Calculate the amount of `token` to be distributed to `_votingEscrow` holders since the last checkpoint.
     */
    function _checkpointToken(IERC20 token, bool force) internal {
        TokenState storage tokenState = _tokenState[token];
        uint lastTokenTime = tokenState.timeCursor;
        uint timeSinceLastCheckpoint;
        if (lastTokenTime == 0) {
            // If it's the first time we're checkpointing this token then start distributing from now.
            // Also mark at which timestamp users should start attempts to claim this token from.
            lastTokenTime = block.timestamp;
            tokenState.startTime = uint64(_roundDownTimestamp(block.timestamp));

            // Prevent someone from assigning tokens to an inaccessible week.
            require(block.timestamp > _startTime, "Fee distribution has not started yet");
        } else {
            timeSinceLastCheckpoint = block.timestamp - lastTokenTime;

            if (!force) {
                // Checkpointing N times within a single week is completely equivalent to checkpointing once at the end.
                // We then want to get as close as possible to a single checkpoint every Wed 23:59 UTC to save gas.

                // We then skip checkpointing if we're in the same week as the previous checkpoint.
                bool alreadyCheckpointedThisWeek = _roundDownTimestamp(block.timestamp) == _roundDownTimestamp(lastTokenTime);
                // However we want to ensure that all of this week's fees are assigned to the current week without
                // overspilling into the next week. To mitigate this, we checkpoint if we're near the end of the week.
                bool nearingEndOfWeek = _roundUpTimestamp(block.timestamp) - block.timestamp < 1 days;

                // This ensures that we checkpoint once at the beginning of the week and again for each user interaction
                // towards the end of the week to give an accurate final reading of the balance.
                if (alreadyCheckpointedThisWeek && !nearingEndOfWeek) {
                    return;
                }
            }
        }

        tokenState.timeCursor = uint64(block.timestamp);

        uint tokenBalance = token.balanceOf(address(this));
        uint newTokensToDistribute = tokenBalance.sub(tokenState.cachedBalance);
        if (newTokensToDistribute == 0) return;
        require(tokenBalance <= type(uint128).max, "Maximum token balance exceeded");
        tokenState.cachedBalance = uint128(tokenBalance);

        uint firstIncompleteWeek = _roundDownTimestamp(lastTokenTime);
        uint nextWeek = 0;

        // Distribute `newTokensToDistribute` evenly across the time period from `lastTokenTime` to now.
        // These tokens are assigned to weeks proportionally to how much of this period falls into each week.
        mapping(uint => uint) storage tokensPerWeek = _tokensPerWeek[token];
        for (uint i = 0; i < 20; ++i) {
            // This is safe as we're incrementing a timestamp.
            nextWeek = firstIncompleteWeek + 1 weeks;
            if (block.timestamp < nextWeek) {
                // `firstIncompleteWeek` is now the beginning of the current week, i.e. this is the final iteration.
                if (timeSinceLastCheckpoint == 0 && block.timestamp == lastTokenTime) {
                    tokensPerWeek[firstIncompleteWeek] += newTokensToDistribute;
                } else {
                    // block.timestamp >= lastTokenTime by definition.
                    tokensPerWeek[firstIncompleteWeek] += (newTokensToDistribute * (block.timestamp - lastTokenTime)) / timeSinceLastCheckpoint;
                }
                // As we've caught up to the present then we should now break.
                break;
            } else {
                // We've gone a full week or more without checkpointing so need to distribute tokens to previous weeks.
                if (timeSinceLastCheckpoint == 0 && nextWeek == lastTokenTime) {
                    // It shouldn't be possible to enter this block
                    tokensPerWeek[firstIncompleteWeek] += newTokensToDistribute;
                } else {
                    // nextWeek > lastTokenTime by definition.
                    tokensPerWeek[firstIncompleteWeek] += (newTokensToDistribute * (nextWeek - lastTokenTime)) / timeSinceLastCheckpoint;
                }
            }

            // We've now "checkpointed" up to the beginning of next week so must update timestamps appropriately.
            lastTokenTime = nextWeek;
            firstIncompleteWeek = nextWeek;
        }

        emit TokenCheckpointed(token, newTokensToDistribute, lastTokenTime);
    }

    /**
     * @dev Cache the `user`'s balance of `_votingEscrow` at the beginning of each new week
     */
    function _checkpointUserBalance(address user) internal {
        uint maxUserEpoch = _votingEscrow.user_point_epoch(user);

        // If user has no epochs then they have never locked STG.
        // They clearly will not then receive fees.
        require(maxUserEpoch > 0, "veSTG balance is zero");

        UserState storage userState = _userState[user];

        // `nextWeekToCheckpoint` represents the timestamp of the beginning of the first week
        // which we haven't checkpointed the user's VotingEscrow balance yet.
        uint nextWeekToCheckpoint = userState.timeCursor;

        uint userEpoch;
        if (nextWeekToCheckpoint == 0) {
            // First checkpoint for user so need to do the initial binary search
            userEpoch = _findTimestampUserEpoch(user, _startTime, 0, maxUserEpoch);
        } else {
            if (nextWeekToCheckpoint >= block.timestamp) {
                // User has checkpointed the current week already so perform early return.
                // This prevents a user from processing epochs created later in this week, however this is not an issue
                // as if a significant number of these builds up then the user will skip past them with a binary search.
                return;
            }

            // Otherwise use the value saved from last time
            userEpoch = userState.lastEpochCheckpointed;

            // This optimizes a scenario common for power users, which have frequent `VotingEscrow` interactions in
            // the same week. We assume that any such user is also claiming fees every week, and so we only perform
            // a binary search here rather than integrating it into the main search algorithm, effectively skipping
            // most of the week's irrelevant checkpoints.
            // The slight tradeoff is that users who have multiple infrequent `VotingEscrow` interactions and also don't
            // claim frequently will also perform the binary search, despite it not leading to gas savings.
            if (maxUserEpoch - userEpoch > 20) {
                userEpoch = _findTimestampUserEpoch(user, nextWeekToCheckpoint, userEpoch, maxUserEpoch);
            }
        }

        // Epoch 0 is always empty so bump onto the next one so that we start on a valid epoch.
        if (userEpoch == 0) {
            userEpoch = 1;
        }

        IVotingEscrow.Point memory nextUserPoint = _votingEscrow.user_point_history(user, userEpoch);

        // If this is the first checkpoint for the user, calculate the first week they're eligible for.
        // i.e. the timestamp of the first Thursday after they locked.
        // If this is earlier then the first distribution then fast forward to then.
        if (nextWeekToCheckpoint == 0) {
            // Disallow checkpointing before `startTime`.
            require(block.timestamp > _startTime, "Fee distribution has not started yet");
            nextWeekToCheckpoint = Math.max(_startTime, _roundUpTimestamp(nextUserPoint.ts));
            userState.startTime = uint64(nextWeekToCheckpoint);
        }

        // It's safe to increment `userEpoch` and `nextWeekToCheckpoint` in this loop as epochs and timestamps
        // are always much smaller than 2^256 and are being incremented by small values.
        IVotingEscrow.Point memory currentUserPoint;
        for (uint i = 0; i < 50; ++i) {
            if (nextWeekToCheckpoint >= nextUserPoint.ts && userEpoch <= maxUserEpoch) {
                // The week being considered is contained in a user epoch after that described by `currentUserPoint`.
                // We then shift `nextUserPoint` into `currentUserPoint` and query the Point for the next user epoch.
                // We do this in order to step though epochs until we find the first epoch starting after
                // `nextWeekToCheckpoint`, making the previous epoch the one that contains `nextWeekToCheckpoint`.
                userEpoch += 1;
                currentUserPoint = nextUserPoint;
                if (userEpoch > maxUserEpoch) {
                    nextUserPoint = IVotingEscrow.Point(0, 0, 0, 0);
                } else {
                    nextUserPoint = _votingEscrow.user_point_history(user, userEpoch);
                }
            } else {
                // The week being considered lies inside the user epoch described by `oldUserPoint`
                // we can then use it to calculate the user's balance at the beginning of the week.
                if (nextWeekToCheckpoint >= block.timestamp) {
                    // Break if we're trying to cache the user's balance at a timestamp in the future.
                    // We only perform this check here to ensure that we can still process checkpoints created
                    // in the current week.
                    break;
                }

                int128 dt = int128(nextWeekToCheckpoint - currentUserPoint.ts);
                uint userBalance = currentUserPoint.bias > currentUserPoint.slope * dt ? uint(currentUserPoint.bias - currentUserPoint.slope * dt) : 0;

                // User's lock has expired and they haven't relocked yet.
                if (userBalance == 0 && userEpoch > maxUserEpoch) {
                    nextWeekToCheckpoint = _roundUpTimestamp(block.timestamp);
                    break;
                }

                // User had a nonzero lock and so is eligible to collect fees.
                _userBalanceAtTimestamp[user][nextWeekToCheckpoint] = userBalance;

                nextWeekToCheckpoint += 1 weeks;
            }
        }

        // We subtract off 1 from the userEpoch to step back once so that on the next attempt to checkpoint
        // the current `currentUserPoint` will be loaded as `nextUserPoint`. This ensures that we can't skip over the
        // user epoch containing `nextWeekToCheckpoint`.
        // userEpoch > 0 so this is safe.
        userState.lastEpochCheckpointed = uint64(userEpoch - 1);
        userState.timeCursor = uint64(nextWeekToCheckpoint);
    }

    /**
     * @dev Cache the totalSupply of VotingEscrow token at the beginning of each new week
     */
    function _checkpointTotalSupply() internal {
        uint nextWeekToCheckpoint = _timeCursor;
        uint weekStart = _roundDownTimestamp(block.timestamp);

        // We expect `timeCursor == weekStart + 1 weeks` when fully up to date.
        if (nextWeekToCheckpoint > weekStart || weekStart == block.timestamp) {
            // We've already checkpointed up to this week so perform early return
            return;
        }

        IVotingEscrow votingEscrow = _votingEscrow;
        votingEscrow.checkpoint();

        // Step through the each week and cache the total supply at beginning of week on this contract
        for (uint i = 0; i < 20; ++i) {
            if (nextWeekToCheckpoint > weekStart) break;

            // NOTE: Replaced Balancer's logic with Solidly/Velodrome implementation due to the differences in the VotingEscrow totalSupply function
            // See https://github.com/velodrome-finance/v1/blob/master/contracts/RewardsDistributor.sol#L143

            uint epoch = _findTimestampEpoch(nextWeekToCheckpoint);
            IVotingEscrow.Point memory pt = votingEscrow.point_history(epoch);

            int128 dt = nextWeekToCheckpoint > pt.ts ? int128(nextWeekToCheckpoint - pt.ts) : 0;
            int128 supply = pt.bias - pt.slope * dt;
            _veSupplyCache[nextWeekToCheckpoint] = supply > 0 ? uint(supply) : 0;

            // This is safe as we're incrementing a timestamp
            nextWeekToCheckpoint += 1 weeks;
        }
        // Update state to the end of the current week (`weekStart` + 1 weeks)
        _timeCursor = nextWeekToCheckpoint;
    }

    // Helper functions

    /**
     * @dev Wrapper around `_userTokenTimeCursor` which returns the start timestamp for `token`
     * if `user` has not attempted to interact with it previously.
     */
    function _getUserTokenTimeCursor(address user, IERC20 token) internal view returns (uint) {
        uint userTimeCursor = _userTokenTimeCursor[user][token];
        if (userTimeCursor > 0) return userTimeCursor;
        // This is the first time that the user has interacted with this token.
        // We then start from the latest out of either when `user` first locked veSTG or `token` was first checkpointed.
        return Math.max(_userState[user].startTime, _tokenState[token].startTime);
    }

    /**
     * @dev Return the user epoch number for `user` corresponding to the provided `timestamp`
     */
    function _findTimestampUserEpoch(address user, uint timestamp, uint minUserEpoch, uint maxUserEpoch) internal view returns (uint) {
        IVotingEscrow votingEscrow = _votingEscrow;
        uint min = minUserEpoch;
        uint max = maxUserEpoch;

        // Perform binary search through epochs to find epoch containing `timestamp`
        for (uint i = 0; i < 128; ++i) {
            if (min >= max) break;

            // Algorithm assumes that inputs are less than 2^128 so this operation is safe.
            // +2 avoids getting stuck in min == mid < max
            uint mid = (min + max + 2) / 2;
            IVotingEscrow.Point memory pt = votingEscrow.user_point_history(user, mid);
            if (pt.ts <= timestamp) {
                min = mid;
            } else {
                // max > min so this is safe.
                max = mid - 1;
            }
        }
        return min;
    }

    /**
     * @dev Return the global epoch number corresponding to the provided `timestamp`
     */
    function _findTimestampEpoch(uint timestamp) internal view returns (uint) {
        IVotingEscrow votingEscrow = _votingEscrow;
        uint min = 0;
        uint max = votingEscrow.epoch();

        // Perform binary search through epochs to find epoch containing `timestamp`
        for (uint i = 0; i < 128; i++) {
            if (min >= max) break;

            // Algorithm assumes that inputs are less than 2^128 so this operation is safe.
            // +2 avoids getting stuck in min == mid < max
            uint mid = (min + max + 2) / 2;
            IVotingEscrow.Point memory pt = votingEscrow.point_history(mid);
            if (pt.ts <= timestamp) {
                min = mid;
            } else {
                max = mid - 1;
            }
        }
        return min;
    }

    /**
     * @dev Rounds the provided timestamp down to the beginning of the previous week (Thurs 00:00 UTC)
     */
    function _roundDownTimestamp(uint timestamp) private pure returns (uint) {
        // Division by zero or overflows are impossible here.
        return (timestamp / 1 weeks) * 1 weeks;
    }

    /**
     * @dev Rounds the provided timestamp up to the beginning of the next week (Thurs 00:00 UTC)
     */
    function _roundUpTimestamp(uint timestamp) private pure returns (uint) {
        // Overflows are impossible here for all realistic inputs.
        return _roundDownTimestamp(timestamp + 1 weeks - 1);
    }
}
