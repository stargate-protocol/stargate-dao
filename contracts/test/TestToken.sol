// SPDX-License-Identifier: BUSL-1.1

pragma solidity >=0.7.6;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestToken is ERC20 {
    constructor() ERC20("TEST", "TEST") {
        _mint(msg.sender, 100_000_000 ether);
    }

	function mint(address to, uint amount) external {
		_mint(to, amount);
	}
}