// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IZapHelper {
    function router() external view returns (address);
    function vault() external view returns (address);
    function zap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address recipient,
        bytes calldata swapData
    ) external returns (uint256 amountOut);
    function zapDeposit(
        uint256 usdcAmount,
        uint256 swapUsdcToVlt,
        uint256 minVltOut,
        uint256 minShares,
        uint256 deadline,
        address recipient,
        bytes calldata swapData
    ) external returns (uint256 shares);
}

interface IPermit2Approve {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IVltUsdcVault {
    function vlt() external view returns (address);
    function usdc() external view returns (address);
    function deposit(
        uint256 vltAmount,
        uint256 usdcAmount,
        uint256 minShares,
        uint256 deadline,
        address recipient
    ) external returns (uint256 shares);
}

/*//////////////////////////////////////////////////////////////////////////
                                ZapHelper  (PERIPHERY)
    A replaceable convenience layer in FRONT of the vault. The vault itself takes
    a balanced VLT + USDC pair and has no knowledge of this contract — so this can
    be redeployed for any routing/topology change without touching the immutable
    core, and a bug here can never affect the vault's solvency or existing holders
    (it is just another caller).

    `zapDeposit(USDC)`: pull USDC, buy VLT from its external market by EXECUTING an
    off-chain-computed route against one whitelisted router (Uniswap's Universal
    Router on mainnet) — the buy-pressure leg — then deposit the bought VLT plus the
    remaining USDC into the vault, which mints shares directly to the recipient;
    any dust returns to the caller. `zap(...)` exposes the raw swap primitive.

    Immutable router (+ optional Permit2) and immutable vault. No owner, no custody —
    holds tokens only transiently within a call. Both entrypoints are nonReentrant
    (Shieldify I-03): the custody-free isolation ("holds nothing between calls") is
    enforced by construction rather than assumed across the arbitrary router call
    and any callback-capable token, since _sweep()/usdcForLp read FULL balances.
//////////////////////////////////////////////////////////////////////////*/
contract ZapHelper is IZapHelper, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The only contract this helper will ever call to swap (the router).
    address public immutable router;
    /// @notice Permit2 (canonical) when `router` pulls via Permit2 (Universal Router); else
    /// address(0) => the router pulls via a plain ERC20 allowance (V3 SwapRouter / tests).
    address public immutable permit2;
    /// @notice The vltUSDC vault this zapper deposits into.
    address public immutable vault;
    address public immutable vlt;
    address public immutable usdc;

    error RouterCallFailed();

    constructor(address _router, address _permit2, address _vault) {
        require(_router != address(0), "zero-router");
        require(_vault != address(0), "zero-vault");
        router = _router;
        // permit2 == address(0) is a valid configuration (plain-allowance routers / tests).
        // slither-disable-next-line missing-zero-check
        permit2 = _permit2;
        vault = _vault;
        vlt = IVltUsdcVault(_vault).vlt();
        usdc = IVltUsdcVault(_vault).usdc();
    }

    /// @notice Zap a USDC-only deposit into the vault: buy VLT for `swapUsdcToVlt` USDC via the
    /// off-chain route, then deposit (bought VLT + remaining USDC) into the vault. The vault mints
    /// shares DIRECTLY to `recipient` (and attributes its Deposit event to them — per-wallet PnL
    /// tracking needs no transfer-join); leftover dust (vault refund / swap residual) goes to the
    /// caller, who paid. Reverts after `deadline` (checked here BEFORE the swap leg, and again by
    /// the vault) so a stale mempool transaction cannot execute an old route under moved market
    /// terms.
    function zapDeposit(
        uint256 usdcAmount,
        uint256 swapUsdcToVlt,
        uint256 minVltOut,
        uint256 minShares,
        uint256 deadline,
        address recipient,
        bytes calldata swapData
    ) external nonReentrant returns (uint256 shares) {
        // Standard periphery-style deadline; second-level miner drift is irrelevant here.
        // solhint-disable not-rely-on-time
        // slither-disable-next-line timestamp
        require(block.timestamp <= deadline, "expired");
        // solhint-enable not-rely-on-time
        require(swapUsdcToVlt > 0 && swapUsdcToVlt < usdcAmount, "bad-split");
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);

        // Buy VLT from its external market (buy pressure), bounded by minVltOut.
        uint256 vltOut = _execRoute(usdc, vlt, swapUsdcToVlt, minVltOut, swapData);
        // USDC for the LP = whatever the swap didn't consume. The router can pull at most
        // `swapUsdcToVlt` (only that is approved), so this is always >= usdcAmount - swapUsdcToVlt;
        // measuring the held balance banks any swap under-spend into the deposit rather than
        // refunding it, and mirrors the VLT side (vltOut is itself a measured balance delta).
        uint256 usdcForLp = IERC20(usdc).balanceOf(address(this));

        // Deposit the balanced pair; the vault mints shares straight to `recipient` and refunds
        // add-dust here (this helper is the payer).
        IERC20(vlt).forceApprove(vault, vltOut);
        IERC20(usdc).forceApprove(vault, usdcForLp);
        shares = IVltUsdcVault(vault).deposit(vltOut, usdcForLp, minShares, deadline, recipient);
        IERC20(vlt).forceApprove(vault, 0);
        IERC20(usdc).forceApprove(vault, 0);

        // Any leftover (vault refund / swap residual) back to the caller.
        _sweep(vlt, msg.sender);
        _sweep(usdc, msg.sender);
    }

    /// @notice Raw swap primitive: pull `amountIn` of `tokenIn`, execute the route, forward the
    /// resulting `tokenOut` (>= minOut) to `recipient`, and refund any unspent `tokenIn` to the
    /// CALLER (who paid it — `recipient` is an output destination only). `swapData` must route
    /// the output to THIS helper (it measures its own balance delta). Reverts after `deadline`
    /// (Shieldify I-04, matching zapDeposit) so a stale mempool transaction cannot execute an
    /// old route under moved market terms.
    function zap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 deadline,
        address recipient,
        bytes calldata swapData
    ) external nonReentrant returns (uint256 amountOut) {
        // Standard periphery-style deadline; second-level miner drift is irrelevant here.
        // solhint-disable not-rely-on-time
        // slither-disable-next-line timestamp
        require(block.timestamp <= deadline, "expired");
        // solhint-enable not-rely-on-time
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = _execRoute(tokenIn, tokenOut, amountIn, minOut, swapData);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        _sweep(tokenIn, msg.sender);
    }

    /// @dev Execute the off-chain route against the whitelisted router, leaving the output in this
    /// helper. Assumes `amountIn` of `tokenIn` is already held here. Returns the measured output.
    function _execRoute(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata swapData)
        internal
        returns (uint256 amountOut)
    {
        if (permit2 == address(0)) {
            IERC20(tokenIn).forceApprove(router, amountIn);
        } else {
            IERC20(tokenIn).forceApprove(permit2, amountIn);
            // Short Permit2 expiry consumed within this same tx; time-based by Permit2's design.
            // solhint-disable-next-line not-rely-on-time
            IPermit2Approve(permit2).approve(tokenIn, router, uint160(amountIn), uint48(block.timestamp + 60));
        }

        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        // Execute the off-chain-computed route against the single whitelisted (immutable) router.
        // A low-level call is required to forward arbitrary route calldata; the helper is stateless
        // and holds no funds between calls, and the output is bounded by minOut below.
        // slither-disable-next-line reentrancy-balance,low-level-calls
        (bool ok, bytes memory ret) = router.call(swapData); // solhint-disable-line avoid-low-level-calls
        if (!ok) {
            if (ret.length > 0) {
                // Bubble up the router's revert reason.
                // slither-disable-next-line assembly
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert RouterCallFailed();
        }

        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        require(amountOut >= minOut, "zap-slippage");
        if (permit2 == address(0)) IERC20(tokenIn).forceApprove(router, 0);
    }

    /// @dev Forward this helper's full balance of `token` to `to` (it should hold nothing between calls).
    function _sweep(address token, address to) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
    }
}
