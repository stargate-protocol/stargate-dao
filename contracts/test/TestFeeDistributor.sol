// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "../FeeDistributor.sol";

contract TestFeeDistributor is FeeDistributor {
    constructor(IVotingEscrow votingEscrow, uint256 startTime) FeeDistributor(votingEscrow, startTime) {
        // solhint-disable-previous-line no-empty-blocks
    }

    function getUserLastEpochCheckpointed(address user) external view returns (uint256) {
        return _userState[user].lastEpochCheckpointed;
    }
}