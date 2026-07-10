// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test-only. Forces Hardhat to compile the concrete v4-core PoolManager and the
/// official v4-core test routers so the JS suite can deploy them by name and exercise
/// the vault against a REAL PoolManager (no mocking of settlement). Never deployed to
/// production — it exists only to pull these artifacts into `artifacts/`.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
