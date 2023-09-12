// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity >=0.7.0 <0.9.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin-solc-0.7/contracts/token/ERC20/IERC20.sol";
import "./IVotingEscrow.sol";

/**
 * @title Fee Distributor
 * @notice Distributes any tokens transferred to the contract (e.g. Protocol fees) among veSTG
 * holders proportionally based on a snapshot of the week at which the tokens are sent to the FeeDistributor contract.
 * @dev Supports distributing arbitrarily many different tokens. In order to start distributing a new token to veSTG
 * holders simply transfer the tokens to the `FeeDistributor` contract and then call `checkpointToken`.
 */
interface IFeeDistributor {
    event TokenCheckpointed(IERC20 token, uint256 amount, uint256 lastCheckpointTimestamp);
    event TokensClaimed(address user, IERC20 token, uint256 amount, uint256 userTokenTimeCursor);
    event TokenWithdrawn(IERC20 token, uint256 amount, address recipient);
    event TokenClaimingEnabled(IERC20 token, bool enabled);
    event OnlyVeHolderClaimingEnabled(address user, bool enabled);

    /**
     * @notice Returns the VotingEscrow (veSTG) token contract
     */
    function getVotingEscrow() external view returns (IVotingEscrow);

    /**
     * @notice Returns the time when fee distribution starts.
     */
    function getStartTime() external view returns (uint256);

    /**
     * @notice Returns the global time cursor representing the most earliest uncheckpointed week.
     */
    function getTimeCursor() external view returns (uint256);

    /**
     * @notice Returns the user-level time cursor representing the most earliest uncheckpointed week.
     * @param user - The address of the user to query.
     */
    function getUserTimeCursor(address user) external view returns (uint256);

    /**
     * @notice Returns the user-level start time representing the first week they're eligible to claim tokens.
     * @param user - The address of the user to query.
     */
    function getUserStartTime(address user) external view returns (uint256);

    /**
     * @notice True if the given token can be claimed, false otherwise.
     * @param token - The ERC20 token address to query.
     */
    function canTokenBeClaimed(IERC20 token) external view returns (bool);

    /**
     * @notice Returns the token-level start time representing the timestamp users could start claiming this token
     * @param token - The ERC20 token address to query.
     */
    function getTokenStartTime(IERC20 token) external view returns (uint256);

    /**
     * @notice Returns the token-level time cursor storing the timestamp at up to which tokens have been distributed.
     * @param token - The ERC20 token address to query.
     */
    function getTokenTimeCursor(IERC20 token) external view returns (uint256);

    /**
     * @notice Returns the token-level cached balance.
     * @param token - The ERC20 token address to query.
     */
    function getTokenCachedBalance(IERC20 token) external view returns (uint256);

    /**
     * @notice Returns the user-level last checkpointed epoch.
     * @param user - The address of the user to query.
     */
    function getUserLastEpochCheckpointed(address user) external view returns (uint256);

    /**
     * @notice Returns the user-level time cursor storing the timestamp of the latest token distribution claimed.
     * @param user - The address of the user to query.
     * @param token - The ERC20 token address to query.
     */
    function getUserTokenTimeCursor(address user, IERC20 token) external view returns (uint256);

    /**
     * @notice Returns the user's cached balance of veSTG as of the provided timestamp.
     * @dev Only timestamps which fall on Thursdays 00:00:00 UTC will return correct values.
     * This function requires `user` to have been checkpointed past `timestamp` so that their balance is cached.
     * @param user - The address of the user of which to read the cached balance of.
     * @param timestamp - The timestamp at which to read the `user`'s cached balance at.
     */
    function getUserBalanceAtTimestamp(address user, uint256 timestamp) external view returns (uint256);

    /**
     * @notice Returns the cached total supply of veSTG as of the provided timestamp.
     * @dev Only timestamps which fall on Thursdays 00:00:00 UTC will return correct values.
     * This function requires the contract to have been checkpointed past `timestamp` so that the supply is cached.
     * @param timestamp - The timestamp at which to read the cached total supply at.
     */
    function getTotalSupplyAtTimestamp(uint256 timestamp) external view returns (uint256);

    /**
     * @notice Returns the FeeDistributor's cached balance of `token`.
     */
    function getTokenLastBalance(IERC20 token) external view returns (uint256);

    /**
     * @notice Returns the amount of `token` which the FeeDistributor received in the week beginning at `timestamp`.
     * @param token - The ERC20 token address to query.
     * @param timestamp - The timestamp corresponding to the beginning of the week of interest.
     */
    function getTokensDistributedInWeek(IERC20 token, uint256 timestamp) external view returns (uint256);

    // Preventing third-party claiming

    /**
     * @notice Enables / disables rewards claiming only by the VotingEscrow holder for the message sender.
     * @param enabled - True if only the VotingEscrow holder can claim their rewards, false otherwise.
     */
    function enableOnlyVeHolderClaiming(bool enabled) external;

    /**
     * @notice Returns true if only the VotingEscrow holder can claim their rewards, false otherwise.
     */
    function onlyVeHolderClaimingEnabled(address user) external view returns (bool);

    // Depositing

    /**
     * @notice Deposits tokens to be distributed in the current week.
     * @dev Sending tokens directly to the FeeDistributor instead of using `depositTokens` may result in tokens being
     * retroactively distributed to past weeks, or for the distribution to carry over to future weeks.
     *
     * If for some reason `depositTokens` cannot be called, in order to ensure that all tokens are correctly distributed
     * manually call `checkpointToken` before and after the token transfer.
     * @param token - The ERC20 token address to distribute.
     * @param amount - The amount of tokens to deposit.
     */
    function depositToken(IERC20 token, uint256 amount) external;

    /**
     * @notice Deposits tokens to be distributed in the current week.
     * @dev A version of `depositToken` which supports depositing multiple `tokens` at once.
     * See `depositToken` for more details.
     * @param tokens - An array of ERC20 token addresses to distribute.
     * @param amounts - An array of token amounts to deposit.
     */
    function depositTokens(IERC20[] calldata tokens, uint256[] calldata amounts) external;

    // Checkpointing

    /**
     * @notice Caches the total supply of veSTG at the beginning of each week.
     * This function will be called automatically before claiming tokens to ensure the contract is properly updated.
     */
    function checkpoint() external;

    /**
     * @notice Caches the user's balance of veSTG at the beginning of each week.
     * This function will be called automatically before claiming tokens to ensure the contract is properly updated.
     * @param user - The address of the user to be checkpointed.
     */
    function checkpointUser(address user) external;

    /**
     * @notice Assigns any newly-received tokens held by the FeeDistributor to weekly distributions.
     * @dev Any `token` balance held by the FeeDistributor above that which is returned by `getTokenLastBalance`
     * will be distributed evenly across the time period since `token` was last checkpointed.
     *
     * This function will be called automatically before claiming tokens to ensure the contract is properly updated.
     * @param token - The ERC20 token address to be checkpointed.
     */
    function checkpointToken(IERC20 token) external;

    /**
     * @notice Assigns any newly-received tokens held by the FeeDistributor to weekly distributions.
     * @dev A version of `checkpointToken` which supports checkpointing multiple tokens.
     * See `checkpointToken` for more details.
     * @param tokens - An array of ERC20 token addresses to be checkpointed.
     */
    function checkpointTokens(IERC20[] calldata tokens) external;

    // Claiming

    /**
     * @notice Claims all pending distributions of the provided token for a user.
     * @dev It's not necessary to explicitly checkpoint before calling this function, it will ensure the FeeDistributor
     * is up to date before calculating the amount of tokens to be claimed.
     * @param user - The user on behalf of which to claim.
     * @param token - The ERC20 token address to be claimed.
     * @return The amount of `token` sent to `user` as a result of claiming.
     */
    function claimToken(address user, IERC20 token) external returns (uint256);

    /**
     * @notice Claims a number of tokens on behalf of a user.
     * @dev A version of `claimToken` which supports claiming multiple `tokens` on behalf of `user`.
     * See `claimToken` for more details.
     * @param user - The user on behalf of which to claim.
     * @param tokens - An array of ERC20 token addresses to be claimed.
     * @return An array of the amounts of each token in `tokens` sent to `user` as a result of claiming.
     */
    function claimTokens(address user, IERC20[] calldata tokens) external returns (uint256[] memory);

    // Governance

    /**
     * @notice Withdraws the specified `amount` of the `token` from the contract to the `recipient`. Can be called only by Stargate DAO.
     * @param token - The token to withdraw.
     * @param amount - The amount to withdraw.
     * @param recipient - The address to transfer the tokens to.
     */
    function withdrawToken(IERC20 token, uint256 amount, address recipient) external;

    /**
     * @notice Enables or disables claiming of the given token. Can be called only by Stargate DAO.
     * @param token - The token to enable or disable claiming.
     * @param enable - True if the token can be claimed, false otherwise.
     */
    function enableTokenClaiming(IERC20 token, bool enable) external;
}
