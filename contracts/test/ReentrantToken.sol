// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentryTarget {
    function redeem(uint256 shares, address receiver) external returns (uint256, uint256);
    function compound() external returns (uint128);
}

/// @dev A hostile ERC-20 that attempts to re-enter the vault from inside a token
/// transfer (the ERC-777-style hook surface). Used to prove the guard blocks re-entry:
/// while the vault is mid-deposit (the guarded _deposit body), any vault token movement
/// fires (per `mode`) a reentrant `redeem()` or `compound()` — both must revert with
/// ReentrancyGuardReentrantCall(). We capture the revert data so the test can assert
/// the exact error.
contract ReentrantToken is ERC20 {
    uint8 public constant MODE_REDEEM = 0;
    uint8 public constant MODE_COMPOUND = 1;

    uint8 private immutable _decimals;
    address public target;
    bool public armed;
    uint8 public mode;
    bool public reentryAttempted;
    bool public reentryReverted;
    bytes public lastError;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTarget(address t) external {
        target = t;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function arm(bool a) external {
        armed = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && target != address(0)) {
            armed = false; // single-shot: fire on the first transfer after arming
            reentryAttempted = true;
            if (mode == MODE_COMPOUND) {
                try IReentryTarget(target).compound() {
                    reentryReverted = false;
                } catch (bytes memory err) {
                    reentryReverted = true;
                    lastError = err;
                }
            } else {
                try IReentryTarget(target).redeem(1, address(this)) {
                    reentryReverted = false;
                } catch (bytes memory err) {
                    reentryReverted = true;
                    lastError = err;
                }
            }
        }
    }
}
