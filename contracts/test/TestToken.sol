// SPDX-License-Identifier: BUSL-1.1

pragma solidity >=0.7.6;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Token is ERC20 {
    constructor(uint amount) ERC20("TEST", "TEST") {
        _mint(msg.sender, amount);
    }

	function mint(address to, uint amount) external {
		_mint(to, amount);
	}
}