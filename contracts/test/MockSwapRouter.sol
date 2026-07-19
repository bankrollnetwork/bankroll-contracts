// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test-only stand-in for VLT's external market (the V2 VLT/WETH route, abstracted to a
/// direct USDC<->VLT venue). Constant-product (x*y=k) so buying VLT moves its price UP and
/// DRAINS the VLT reserve — letting tests assert the deposit's buy-pressure flywheel. Pulls
/// tokenIn via a plain allowance (the ZapHelper is deployed with permit2 == address(0) in tests).
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    address public immutable usdc;
    address public immutable vlt;

    constructor(address _usdc, address _vlt) {
        usdc = _usdc;
        vlt = _vlt;
    }

    /// Spend `amountIn` USDC (pulled from caller), receive VLT at the constant-product price
    /// (0.3% fee), sent to `to`. This is the calldata the off-chain "route" encodes for tests.
    function swapUsdcForVlt(uint256 amountIn, address to) external returns (uint256 out) {
        uint256 rIn = IERC20(usdc).balanceOf(address(this));
        uint256 rOut = IERC20(vlt).balanceOf(address(this));
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountInWithFee = (amountIn * 997) / 1000;
        out = (rOut * amountInWithFee) / (rIn + amountInWithFee);
        IERC20(vlt).safeTransfer(to, out);
    }

    /// Spend `amountIn` VLT (pulled from caller), receive USDC at the constant-product price
    /// (0.3% fee), sent to `to` — the reverse leg, used by zapRedeem tests.
    function swapVltForUsdc(uint256 amountIn, address to) external returns (uint256 out) {
        uint256 rIn = IERC20(vlt).balanceOf(address(this));
        uint256 rOut = IERC20(usdc).balanceOf(address(this));
        IERC20(vlt).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 amountInWithFee = (amountIn * 997) / 1000;
        out = (rOut * amountInWithFee) / (rIn + amountInWithFee);
        IERC20(usdc).safeTransfer(to, out);
    }

    function vltReserve() external view returns (uint256) {
        return IERC20(vlt).balanceOf(address(this));
    }
}
