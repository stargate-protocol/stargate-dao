// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity >=0.7.0 <0.9.0;
pragma experimental ABIEncoderV2;

// For compatibility, we're keeping the same function names as in the original Curve code, including the mixed-case
// naming convention.
// solhint-disable func-name-mixedcase

interface IVotingEscrow {
    struct Point {
        int128 bias;
        int128 slope; // - dweight / dt
        uint256 ts;
        uint256 blk; // block
    }

    function epoch() external view returns (uint256);

    function balanceOfAtT(address user, uint256 timestamp) external view returns (uint256);

    function totalSupplyAtT(uint256 timestamp) external view returns (uint256);

    function user_point_epoch(address user) external view returns (uint256);

    function point_history(uint256 timestamp) external view returns (Point memory);

    function user_point_history(address user, uint256 timestamp) external view returns (Point memory);

    function checkpoint() external;

    function locked__end(address user) external view returns (uint256);
}