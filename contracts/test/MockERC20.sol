// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only ERC-20 with configurable decimals and an open mint, used to stand in
/// for VLT (18d) and USDC (6d) when exercising the vault against a locally-deployed,
/// REAL Uniswap V4 PoolManager. Also models USDC's transfer blacklist so the
/// blacklisted-redeem path can be tested.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;
    mapping(address => bool) public blacklisted;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blacklisted[from] && !blacklisted[to], "USDC: blacklisted");
        super._update(from, to, value);
    }
}
