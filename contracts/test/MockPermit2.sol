// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPermit2Transfer {
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

/// @dev Minimal Permit2 stand-in (AllowanceTransfer subset) so the ZapHelper's Permit2 branch
/// can be exercised deterministically without a mainnet fork. Matches the `approve` signature
/// the helper calls and the `transferFrom` a router calls to pull funds.
contract MockPermit2 {
    // owner => token => spender => allowance
    mapping(address => mapping(address => mapping(address => uint160))) public allowanceOf;

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowanceOf[msg.sender][token][spender] = amount;
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        uint160 a = allowanceOf[from][token][msg.sender];
        require(a >= amount, "permit2-allowance");
        if (a != type(uint160).max) allowanceOf[from][token][msg.sender] = a - amount;
        // Pulls via the ERC-20 allowance the owner granted to THIS Permit2 contract.
        require(IERC20(token).transferFrom(from, to, amount), "permit2-transfer");
    }
}

/// @dev A swap router that pulls its input through Permit2 (like the Universal Router), used to
/// drive the ZapHelper's Permit2 path. Sends `amountIn` of tokenOut (raw, from its seeded
/// reserve) to `to` — the rate is irrelevant; this only proves the Permit2 pull + execution.
contract MockPermit2Router {
    address public immutable permit2;

    constructor(address _permit2) {
        permit2 = _permit2;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address to) external {
        IPermit2Transfer(permit2).transferFrom(msg.sender, address(this), uint160(amountIn), tokenIn);
        require(IERC20(tokenOut).transfer(to, amountIn), "router-out");
    }
}

/// @dev Minimal stand-in exposing only `vlt()`/`usdc()` so a ZapHelper can be constructed for
/// tests that exercise the raw `zap` primitive (which never calls the vault).
contract MockVaultStub {
    address public immutable vlt;
    address public immutable usdc;

    constructor(address _vlt, address _usdc) {
        vlt = _vlt;
        usdc = _usdc;
    }
}
