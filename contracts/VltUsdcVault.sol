// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/*//////////////////////////////////////////////////////////////////////////
                              vltUSDC VAULT
    Tokenized, auto-compounding Uniswap V4 VLT/USDC LP position.

    Design:
      - Holds ONE full-range V4 position (VLT/USDC, 1% fee tier).
      - Shares are denominated in the position's LIQUIDITY (L), not dollars.
        => no oracle anywhere. Mint/redeem never price a token.
      - deposit(VLT, USDC): pull a (roughly balanced) pair of both tokens, LP them
        into the V4 pool, refund dust, and mint shares pro-rata to the liquidity
        (ΔL) actually added. The vault performs NO swap and has no external
        dependency. A separate, replaceable periphery zapper (see ZapHelper)
        converts a USDC-only deposit into the balanced pair by buying VLT from its
        external market (the buy-pressure leg) and then calling deposit().
      - redeem(shares): burn shares, remove pro-rata liquidity, return BOTH
        tokens in-kind (no auto-sell). Solvent by construction.
      - Auto-compound: deposit() runs the internal _compound() leg once the
        claimable value reaches AUTO_COMPOUND_MIN_USDC (and the position
        exists). Fees are collected and 100% reinvests as liquidity — NO fee
        of any kind is taken. Mints NO shares, so L grows against a fixed
        share supply => every holder's redemption value rises automatically.
        There is NO compound entrypoint and no keeper: the vault's external
        write surface is deposit and redeem, full stop — compounding is purely
        a side effect of deposits (a small deposit forces one in a quiet
        market). Deposit and compound share fate by design — the leg is
        argument-free and its swap is bounded to a ≤5% price move (unfilled
        remainder folds forward). Staleness is value-neutral —
        deposit/redeem already retain accrued fees for all holders, and
        everything folds forward into the next compound.
      - Fee retention: V4 folds a position's FULL accrued fees into callerDelta
        on ANY modifyLiquidity, so deposit()/redeem() split principal from
        feesAccrued and retain the fees at address(this) for all holders.
        Without the split, the first party to touch the position after fees
        accrue would sweep 100% of the uncompounded fees. No path ever pays
        fees out — the compound leg converts them to position liquidity.
        Covered by test/vault.fees.test.js.
      - Compound residual dust folds forward into the next compound: it is
        never counted in shares, so it can only ever raise future NAV.
      - Bounded fee-timing socialization (accepted design; Shieldify M-01/L-02):
        value outside L (pending fees + retained balances + dust) is a common
        pool for ALL holders; shares enter and exit priced on L only. Because
        deposit() compounds BEFORE minting whenever claimable >= $100, an
        entrant can never buy into >= $100 of common-pool value, and an exit
        forfeits at most its pro-rata slice of that same bounded pool (fold it
        in first with a dust deposit if the gate is open). Bidirectional and
        ~zero-sum across holders; the alternative (full-inventory share
        pricing) would need spot valuation inside every permissionless call —
        the exact manipulation surface this oracle-free design avoids.

    NOTE (read before deploying): the V4 unlock/settle/take delta accounting
    in the callback is the part most likely to contain a sign/settlement bug.
    Every `_settle`/`_take`/`modifyLiquidity` path is exercised by the Hardhat
    suite (test/) against a REAL PoolManager (local deploy + optional mainnet
    fork). Shieldify review received 2026-07 (1 Medium / 3 Low / 8 Info against
    4dae465; hardening applied — see AUDIT-SHIELDIFY-RESPONSE.md). Fixes-review
    round pending — do not deploy real funds before it concludes.
//////////////////////////////////////////////////////////////////////////*/

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Position} from "@uniswap/v4-core/src/libraries/Position.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";

import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Fully ownerless / immutable: no admin, no pause, no sweep. Every parameter is fixed at deploy
// or a constant; deposit/redeem are permissionless and compounding is deposit-triggered.
contract VltUsdcVault is ERC20, ReentrancyGuard, IUnlockCallback {
    using CurrencyLibrary for Currency;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 internal constant BPS = 10_000;

    /// @dev Permanently locked on the first deposit to neutralize the
    /// first-depositor share-inflation attack (Uniswap-V2 style dead shares).
    uint256 internal constant MINIMUM_LIQUIDITY = 1_000;

    /// @dev Fixed-point scales: Q96 for the V4 sqrt price, Q128 for fee growth.
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant Q128 = 1 << 128;

    /// @dev The compound leg's internal rebalance swap is bounded to a <=5% pool-price move via
    /// `sqrtPriceLimitX96`. Because price = sqrtP^2, the sqrt-space factors are sqrt(0.95) and
    /// sqrt(1.05) (×BPS). The swap fills as much as fits inside this bound; any unfilled remainder
    /// folds forward into the next compound. This bounds the price impact OF THE VAULT'S OWN SWAP
    /// — the filled portion executes at the prevailing spot price. Executing at a manipulated spot
    /// is uneconomic to induce: the at-risk notional is the vault's loose balance, which the $100
    /// deposit trigger keeps at trigger scale under any deposit flow, while pushing-then-restoring
    /// the full-range 1% pool costs fees on a far larger notional that accrue mostly to the vault
    /// itself as the dominant LP.
    uint256 internal constant SQRT_LIMIT_DOWN_BPS = 9747;  // ceil(sqrt(0.95) * 10000) → ≤5% drop
    uint256 internal constant SQRT_LIMIT_UP_BPS = 10246;   // floor(sqrt(1.05) * 10000) → ≤5% rise

    /// @notice Claimable value (USDC, 6-dec) at which deposit() runs its best-effort auto-compound
    /// before measuring the depositor's liquidity. A fixed, ungoverned constant — no admin setter,
    /// so it can never be used to disable compounding. Set so the compound's extra gas (paid by the
    /// triggering depositor) always reinvests a meaningful amount; below it, fees and retained
    /// balances simply keep folding forward at zero cost to holders.
    uint256 public constant AUTO_COMPOUND_MIN_USDC = 100e6;

    /*//////////////////////////////////////////////////////////////
                                IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    IPoolManager public immutable poolManager;

    // Pool identity. token0/token1 ordering is enforced at deploy (token0 < token1).
    Currency public immutable currency0;
    Currency public immutable currency1;
    PoolKey public poolKey; // set once in constructor; not mutable thereafter

    // Convenience handles (which of 0/1 is USDC vs VLT is resolved at deploy).
    // USDC is a 6-decimal token with a transfer blacklist; see redeem() notes.
    IERC20 public immutable usdc;
    IERC20 public immutable vlt;
    bool public immutable usdcIsCurrency0;

    // Full-range bounds, aligned to the pool's tick spacing.
    int24 public immutable tickLower;
    int24 public immutable tickUpper;

    // The vault's single V4 position key — keccak of (this, tickLower, tickUpper, salt 0),
    // all lifetime-fixed, so computed once at deploy (Shieldify I-06).
    bytes32 public immutable positionKey;

    // Timestamp of the first deposit (when L/share == 1.0 and fee accrual begins). Write-once, 0
    // until then. Informational only — lets clients annualize the L/share fee growth into an APR
    // without relying on historical event-log queries. No admin can set or change it.
    uint256 public inceptionTime;

    // Daily L/share history for trailing (7d/30d) fee-growth APR. `perShareWad` is L/share scaled by
    // 1e18 (a fixed-point ratio, NOT the share decimals, which are 0); we store the RATIO because it
    // nets out deposits/redeems and moves only on the compound leg. One snapshot per UTC day, written
    // at the end of _compound(). A circular buffer: feeHistoryHead is the newest slot. Informational only.
    // 35 slots = the longest reported window (30d) + ~5 days of headroom, so under fast (≈daily)
    // compounding the ≥30-day-old snapshot the 30d window needs is still retained (not yet evicted).
    // Sparse compounding is unaffected — the ring just spans a longer wall-clock period.
    uint256 internal constant FEE_HISTORY_LEN = 35;
    struct Snapshot { uint32 timestamp; uint224 perShareWad; } // packs into one storage word
    Snapshot[FEE_HISTORY_LEN] public feeHistory;
    uint32 public lastSnapshotDay; // block.timestamp / 1 days of the newest write (0 = none yet)
    uint8 public feeHistoryHead;   // index of the newest write; packs with lastSnapshotDay

    /// @notice Lifetime pool fees realized by the vault, token-named (VLT 18d / USDC 6d).
    /// Incremented by _recordFees() at EVERY point fees are collected from the position — the
    /// compound leg's fresh harvest AND deposit()/redeem()'s harvest-and-retain pokes — so the
    /// counters always equal the events identity: Σ `Compound` fees + Σ `FeesRetained` fees.
    /// (Compound-only recording would under-count: every redeem and every below-threshold deposit
    /// realizes fees too.) Informational, like the APR ring: read by clients, never used in
    /// vault accounting.
    uint256 public totalFeesVlt;
    uint256 public totalFeesUsdc;

    /*//////////////////////////////////////////////////////////////
                                  ACTIONS
    //////////////////////////////////////////////////////////////*/

    enum Action {
        DEPOSIT,
        REDEEM,
        COMPOUND
    }

    struct DepositData {
        address payer;            // refund destination for unused contribution (always msg.sender)
        uint256 retain0;          // vault currency0 balance to KEEP (pre-existing fees/dust)
        uint256 retain1;          // vault currency1 balance to KEEP (pre-existing fees/dust)
    }

    struct RedeemData {
        address receiver;         // destination for both redeemed tokens
        uint256 liquidity;        // liquidity (L) to remove — NOT share count
    }

    /*//////////////////////////////////////////////////////////////
                                  EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @dev `vltUsed`/`usdcUsed` are the amounts the pool actually CONSUMED for the liquidity add
    /// (settled to the PoolManager) — NOT the amounts pulled from the caller; any imbalanced excess
    /// is refunded to the payer within the same call and never appears here. `recipient` is the
    /// share owner (cost-basis attribution for per-wallet PnL); `sender` is the payer — for zaps
    /// that is the ZapHelper, so sender != recipient distinguishes zapped entries from direct ones.
    event Deposit(
        address indexed sender,
        address indexed recipient,
        uint256 vltUsed,
        uint256 usdcUsed,
        uint256 sharesOut,
        uint128 liquidityAdded
    );
    /// @dev `owner` is whose shares burned (PnL attribution); `receiver` is where both tokens went.
    /// CONVENTION (all events + external views): amounts are named by TOKEN (`vlt*` 18d / `usdc*`
    /// 6d), never by currency0/1 pool order — that ordering is an address-sort accident the
    /// contract maps away internally (see `_toVltUsdc`), so consumers never need `usdcIsCurrency0`.
    event Redeem(
        address indexed owner,
        address indexed receiver,
        uint256 sharesIn,
        uint256 vltOut,
        uint256 usdcOut
    );

    /// @dev `vltFees`/`usdcFees` are the FULL pool fees this compound freshly harvested (raw);
    /// every unit reinvests for holders — no fee is carved out for anyone. Emitted so log-based
    /// fee accounting (explorers, Dune, a DefiLlama fees adapter) can attribute realized pool fees
    /// without view-call archaeology: total realized fees = Σ Compound fees + Σ FeesRetained fees,
    /// all of it supply-side.
    event Compound(
        uint256 vltFees,
        uint256 usdcFees,
        uint128 liquidityAdded
    );

    /// @dev Pool fees harvested and RETAINED at the vault for all holders when a deposit() or
    /// redeem() touches the position (V4 realizes accrued fees on ANY modifyLiquidity — the fee
    /// retention split, see the header). Without this event those harvests are invisible in the
    /// logs, and event-based fee accounting would systematically under-report between compounds.
    event FeesRetained(uint256 vltFees, uint256 usdcFees);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /// @param _poolManager  Uniswap V4 PoolManager (mainnet singleton).
    /// @param _key          PoolKey of the VLT/USDC 1% pool (hooks MUST be address(0)).
    /// @param _usdc         USDC token address (used to label currency0/1).
    constructor(
        IPoolManager _poolManager,
        PoolKey memory _key,
        address _usdc
    ) ERC20("Bankroll VLT-USDC LP", "vltUSDC") {
        require(address(_key.hooks) == address(0), "hooks-not-allowed");
        require(Currency.unwrap(_key.currency0) < Currency.unwrap(_key.currency1), "token-order");
        // The vault is immutable and ownerless — a misdeployment is unrecoverable, so the
        // deployment contract is asserted on-chain, not only in scripts (Shieldify I-08).
        // The 1% tier is part of the economics (prices manipulation, captures profit for holders).
        require(_key.fee == 10000, "fee-not-1pct");
        // spacing == 0 would otherwise surface as a raw division panic in the tick snap below.
        require(_key.tickSpacing > 0, "bad-tick-spacing");
        // Both legs must be ERC-20s; a native leg would be currency0 (address(0) sorts first).
        require(Currency.unwrap(_key.currency0) != address(0), "native-not-allowed");
        // Deploy order is pool-init -> vault; an uninitialized pool means a wrong key.
        // slither-disable-next-line unused-return
        (uint160 sqrtPriceX96,,,) = _poolManager.getSlot0(_key.toId());
        require(sqrtPriceX96 != 0, "pool-not-initialized");

        poolManager = _poolManager;
        poolKey = _key;
        currency0 = _key.currency0;
        currency1 = _key.currency1;

        address t0 = Currency.unwrap(_key.currency0);
        address t1 = Currency.unwrap(_key.currency1);
        require(_usdc == t0 || _usdc == t1, "usdc-not-in-pool");

        usdcIsCurrency0 = (_usdc == t0);
        usdc = IERC20(_usdc);
        vlt = IERC20(usdcIsCurrency0 ? t1 : t0);

        // Full range, snapped to spacing. The divide-then-multiply is the intended snap to a
        // tick-spacing multiple (the truncation IS the point), not a precision bug.
        int24 spacing = _key.tickSpacing;
        // slither-disable-next-line divide-before-multiply
        int24 lo = (TickMath.MIN_TICK / spacing) * spacing;
        // slither-disable-next-line divide-before-multiply
        int24 hi = (TickMath.MAX_TICK / spacing) * spacing;
        tickLower = lo;
        tickUpper = hi;
        // Every input is fixed for the contract's lifetime, so the position key is too
        // (Shieldify I-06): computed once here, reused by every position read.
        positionKey = Position.calculatePositionKey(address(this), lo, hi, bytes32(0));
    }

    /// @notice Shares are denominated in raw Uniswap liquidity (L) — integer L units, NOT a
    /// 18-decimal token. Reporting 0 decimals makes balances/totalSupply read as the actual L value
    /// (large whole numbers) in wallets/explorers/clients, instead of L/1e18 fractions under OZ's
    /// default 18. Purely metadata: mint/burn/transfer amounts (raw L) are unchanged.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /*//////////////////////////////////////////////////////////////
                          VIEW: POSITION LIQUIDITY
    //////////////////////////////////////////////////////////////*/

    /// @notice Current liquidity (L) of the vault's single position, read live
    /// from the PoolManager — the single source of truth (no tracked mirror to desync).
    function positionLiquidity() public view returns (uint128 liq) {
        liq = poolManager.getPositionLiquidity(poolKey.toId(), positionKey);
    }

    /// @notice What the next auto-compound would reinvest, computed WITHOUT touching the position:
    /// the vault's retained balances (deposit/redeem-retained fees + prior dust) PLUS the position's
    /// pending uncompounded pool fees, per currency, valued in USDC at the spot price. deposit()
    /// gates on `valueUsdc` (auto-compound runs at `AUTO_COMPOUND_MIN_USDC`); the UI shows the rest.
    /// @return vltAmount claimable VLT (raw 18d): retained balance + pending fees.
    /// @return usdcAmount claimable USDC (raw 6d): retained balance + pending fees.
    /// @return valueUsdc total claimable value in USDC (6-dec raw): retained + fees. Gate input.
    /// @return feesValueUsdc value in USDC (6-dec raw) of the PENDING POOL FEES only (informational
    /// split: fresh pool fees vs previously-retained balances).
    function compoundClaimable()
        public
        view
        returns (uint256 vltAmount, uint256 usdcAmount, uint256 valueUsdc, uint256 feesValueUsdc)
    {
        // Pending pool fees, derived exactly as V4 credits them on the next modifyLiquidity:
        // liquidity × (feeGrowthInside_now − feeGrowthInside_last), in Q128. No state change.
        (uint128 liq, uint256 fg0Last, uint256 fg1Last) = poolManager.getPositionInfo(poolKey.toId(), positionKey);
        (uint256 fg0, uint256 fg1) = poolManager.getFeeGrowthInside(poolKey.toId(), tickLower, tickUpper);
        uint256 pending0;
        uint256 pending1;
        unchecked {
            // V4 stores fee growth mod 2**256; the wrapping subtraction IS the intended delta.
            pending0 = FullMath.mulDiv(liq, fg0 - fg0Last, Q128);
            pending1 = FullMath.mulDiv(liq, fg1 - fg1Last, Q128);
        }

        uint256 amount0 = _selfBalance(currency0) + pending0;
        uint256 amount1 = _selfBalance(currency1) + pending1;
        (vltAmount, usdcAmount) = _toVltUsdc(amount0, amount1);

        // slither-disable-next-line unused-return
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey.toId());
        valueUsdc = _valueInUsdc(amount0, amount1, uint256(sqrtPriceX96));
        feesValueUsdc = _valueInUsdc(pending0, pending1, uint256(sqrtPriceX96));
    }

    /// @notice Two-token analog of ERC-4626 `previewRedeem`: the principal (VLT, USDC) a
    /// redeemer would receive for `shares` at the CURRENT price, WITHOUT executing. Excludes the
    /// position's uncompounded fees (those are retained for all holders, exactly as redeem() does).
    /// @dev An ESTIMATE for display only — the in-kind split moves with the live price and V4 rounds
    /// liquidity-removal amounts DOWN, so the real redeem() may return a hair less. redeem() takes no
    /// min bounds (in-kind redemption isn't value-extractable), so this needn't gate anything.
    function previewRedeem(uint256 shares) public view returns (uint256 vltAmount, uint256 usdcAmount) {
        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality
        if (shares == 0 || supply == 0) return (0, 0);
        // redeem()'s downcast is safe because _burn enforces shares <= supply. A preview must
        // NEVER revert — clamp out-of-range input to the full-supply quote instead (Shieldify I-05).
        if (shares > supply) shares = supply;
        uint128 liquidityToRemove = uint128((uint256(positionLiquidity()) * shares) / supply);
        // slither-disable-next-line incorrect-equality
        if (liquidityToRemove == 0) return (0, 0);
        // slither-disable-next-line unused-return
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey.toId());
        // Full-range: the price is always within (tickLower, tickUpper), so both legs are active.
        // roundUp=false mirrors the amount V4 credits the remover on modifyLiquidity.
        uint256 amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickUpper), liquidityToRemove, false);
        uint256 amount1 = SqrtPriceMath.getAmount1Delta(TickMath.getSqrtPriceAtTick(tickLower), sqrtPriceX96, liquidityToRemove, false);
        (vltAmount, usdcAmount) = _toVltUsdc(amount0, amount1);
    }

    /// @dev Value a (currency0, currency1) raw pair in USDC (6-dec raw) at sqrt price `sp`.
    /// sqrtPriceX96 encodes raw currency1/currency0, so token decimals are already baked in.
    function _valueInUsdc(uint256 amt0, uint256 amt1, uint256 sp) internal view returns (uint256) {
        if (usdcIsCurrency0) {
            // currency0 = USDC, currency1 = VLT. USDC(VLT) = vlt / price = vlt · Q96^2 / sqrtP^2.
            return amt0 + FullMath.mulDiv(FullMath.mulDiv(amt1, Q96, sp), Q96, sp);
        }
        // currency0 = VLT, currency1 = USDC. USDC(VLT) = vlt · price = vlt · sqrtP^2 / Q96^2.
        return amt1 + FullMath.mulDiv(FullMath.mulDiv(amt0, sp, Q96), sp, Q96);
    }

    /// @dev Fold a freshly collected (currency0, currency1) fee pair into the lifetime totals and
    /// return it token-named — a drop-in for `_toVltUsdc` at each event-emitting collection site
    /// (_onDeposit / _onRedeem / _onCompound), so the counters can never drift from the events.
    function _recordFees(uint256 fee0, uint256 fee1)
        internal
        returns (uint256 vltFees, uint256 usdcFees)
    {
        (vltFees, usdcFees) = _toVltUsdc(fee0, fee1);

        if (vltFees > 0) totalFeesVlt += vltFees;
        if (usdcFees > 0) totalFeesUsdc += usdcFees;
    }

    /*//////////////////////////////////////////////////////////////
                                 DEPOSIT
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposit a (roughly balanced) pair of VLT + USDC; receive vltUSDC shares (a pro-rata
    /// claim on the LP's liquidity). The vault performs NO swap and has no external dependency —
    /// the caller (typically the periphery ZapHelper) supplies both tokens. Imbalanced input is
    /// fine: the vault adds the balanced portion and refunds the excess.
    /// @param vltAmount   VLT to deposit (18 decimals).
    /// @param usdcAmount  USDC to deposit (6 decimals).
    /// @param minShares   Minimum shares to mint (slippage protection on the LP add).
    /// @param deadline    Unix timestamp after which the deposit reverts. Guards a transaction
    ///                    that lingers in the mempool from executing under stale market terms
    ///                    (minShares bounds the share count but not the dollar terms of entry).
    /// @param recipient   Owner of the minted shares. Tokens are always pulled from — and any
    ///                    unused excess refunded to — msg.sender; only the shares (and the event
    ///                    attribution) go to `recipient`. Lets a periphery zapper mint straight
    ///                    to the end wallet instead of forwarding shares after the fact.
    function deposit(
        uint256 vltAmount,
        uint256 usdcAmount,
        uint256 minShares,
        uint256 deadline,
        address recipient
    ) external nonReentrant returns (uint256 shares) {
        require(recipient != address(0), "zero-recipient");
        // Shares minted to the vault itself would be unredeemable forever — redeem() burns only
        // msg.sender's shares and the vault never calls itself (Shieldify I-07 footgun guard).
        require(recipient != address(this), "self-recipient");
        // Standard periphery-style deadline; second-level miner drift is irrelevant here.
        // solhint-disable not-rely-on-time
        // slither-disable-next-line timestamp
        require(block.timestamp <= deadline, "expired");
        // solhint-enable not-rely-on-time
        require(vltAmount > 0 && usdcAmount > 0, "zero-deposit");

        // Auto-compound: fold accrued fees into liquidity BEFORE this depositor's liquidity is
        // measured — existing holders get the NAV bump first; the depositor buys in at the
        // post-compound price. Runs ahead of the retain0/1 snapshot so compound-consumed
        // balances are never double-counted. Direct internal call: deposit and compound share
        // fate by design (the leg is argument-free with hard internal bounds).
        //
        // The positionLiquidity() gate is LOAD-BEARING, not an optimization: V4 reverts a
        // zero-delta modifyLiquidity poke on a nonexistent position, so without it a ≥$100
        // donation to a virgin vault would make the FIRST deposit trigger a reverting compound
        // — permanently bricking the vault for $100 (nothing can lower claimable). With the
        // gate, pre-seed donations sit retained and fold into the first post-seed compound.
        (,, uint256 claimableUsdc,) = compoundClaimable();
        if (claimableUsdc >= AUTO_COMPOUND_MIN_USDC && positionLiquidity() > 0) {
            _compound();
        }

        // Pre-existing vault balances (fees retained by prior redeems + compound dust) belong
        // to all holders, never to this depositor. Snapshot BEFORE pulling the deposit so the
        // refund leaves exactly these behind (they fold forward into the next compound).
        uint256 retain0 = _selfBalance(currency0);
        uint256 retain1 = _selfBalance(currency1);

        vlt.safeTransferFrom(msg.sender, address(this), vltAmount);
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        uint128 liqBefore = positionLiquidity();

        // `retain0/1` are a deliberate pre-call snapshot passed INTO the callback; `liquidityAdded`
        // and `shares` below are decoded from the unlock RETURN value, not from any stale balance.
        // Combined with nonReentrant, the reentrancy-balance heuristic here is a false positive.
        // slither-disable-next-line reentrancy-balance
        bytes memory res = poolManager.unlock(
            abi.encode(
                Action.DEPOSIT,
                abi.encode(DepositData(msg.sender, retain0, retain1))
            )
        );
        (uint128 liquidityAdded, uint256 paid0, uint256 paid1) =
            abi.decode(res, (uint128, uint256, uint256));
        require(liquidityAdded > 0, "no-liquidity-added");

        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality
        if (supply == 0) {
            // First deposit: bootstrap 1 share == 1 unit of L, lock MINIMUM_LIQUIDITY forever.
            require(liquidityAdded > MINIMUM_LIQUIDITY, "below-min-liquidity");
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
            shares = liquidityAdded - MINIMUM_LIQUIDITY;
            // solhint-disable-next-line not-rely-on-time
            inceptionTime = block.timestamp; // anchor for L/share fee-growth APR (write-once)
        } else {
            // Pro-rata to liquidity actually added (NOT to contract token balances —
            // basing on ΔL from the pool neutralizes direct-donation inflation).
            shares = (supply * liquidityAdded) / liqBefore;
        }

        // After compounds L/share > 1, so a dust deposit can floor to zero shares while its
        // liquidity sticks to the position. Reject it even at minShares == 0 (Shieldify L-01;
        // UniswapV2's INSUFFICIENT_LIQUIDITY_MINTED precedent).
        require(shares > 0, "zero-shares-minted");
        require(shares >= minShares, "slippage-shares");
        _mint(recipient, shares);
        (uint256 vltUsed, uint256 usdcUsed) = _toVltUsdc(paid0, paid1);
        emit Deposit(msg.sender, recipient, vltUsed, usdcUsed, shares, liquidityAdded);
    }

    /*//////////////////////////////////////////////////////////////
                                  REDEEM
    //////////////////////////////////////////////////////////////*/

    /// @notice Burn the caller's vltUSDC shares; send `receiver` a pro-rata share of the LP in
    /// BOTH tokens (no auto-sell).
    /// @dev USDC NOTE: if the receiver is on USDC's blacklist, the USDC `take` leg reverts and the
    /// whole redeem reverts — the caller can simply redeem to a different receiver. Not a vault
    /// solvency issue: VLT and the position are untouched. There are no token approvals anywhere
    /// (settlement uses transfer), so there is no stale-allowance surface.
    /// @param shares    Shares to burn (always the caller's — there is no owner/operator model).
    /// @param receiver  Destination for both redeemed tokens.
    /// @return vltOut   VLT sent to `receiver` (raw 18d).
    /// @return usdcOut  USDC sent to `receiver` (raw 6d).
    function redeem(uint256 shares, address receiver)
        external
        nonReentrant
        returns (uint256 vltOut, uint256 usdcOut)
    {
        require(receiver != address(0), "zero-receiver");
        // Foolproof by design: takes ONLY shares, no slippage bounds. Redemption is in-kind (removes
        // pro-rata liquidity, returns both tokens, never swaps), so it can't be sandwiched for value
        // — a manipulated-then-restored price leaves the redeemer with a bundle worth MORE at the
        // true price (AM-GM), never less. The only effect of a price move is the token split, and
        // you always receive your fair pro-rata share. No admin gate either — exit is always open.
        require(shares > 0, "zero-shares");
        uint256 supply = totalSupply();

        // Liquidity to remove = pro-rata of the live position.
        // The product (liq * shares) fits in uint256; the quotient is <= liq, which is a
        // uint128 from the PoolManager, so the downcast below cannot truncate.
        uint128 liq = positionLiquidity();
        uint128 liquidityToRemove = uint128((uint256(liq) * shares) / supply);
        require(liquidityToRemove > 0, "dust-redeem");

        // Burn first (effects before interactions).
        _burn(msg.sender, shares);

        bytes memory res = poolManager.unlock(
            abi.encode(Action.REDEEM, abi.encode(RedeemData(receiver, liquidityToRemove)))
        );
        (uint256 amount0, uint256 amount1) = abi.decode(res, (uint256, uint256));
        (vltOut, usdcOut) = _toVltUsdc(amount0, amount1);
        emit Redeem(msg.sender, receiver, shares, vltOut, usdcOut);
    }

    /*//////////////////////////////////////////////////////////////
                                 COMPOUND
    //////////////////////////////////////////////////////////////*/

    /// @dev Compound the vault's accrued value into position liquidity: harvests pool fees,
    /// internally rebalances against the vault's OWN pool (swapping ~half the value-imbalance,
    /// bounded to a ≤5% price move — the unfilled remainder folds forward), and reinvests
    /// everything (harvested fees + retained balances) with NO fee of any kind, minting NO
    /// shares (NAV/share rises).
    /// There is NO external compound entrypoint: compounding is purely a side effect of deposits
    /// (this is reached only from deposit()'s trigger, which holds the reentrancy lock and has
    /// checked both the threshold and that the position exists). Anyone who wants to force a
    /// compound in a quiet market simply makes a small deposit. The rebalance is foolproof
    /// without caller input: the swap is small, runs in the vault's own pool (it largely pays
    /// the fee to itself as LP), and is hard-bounded by sqrtPriceLimitX96 — sandwiching it is
    /// unprofitable.
    function _compound() internal returns (uint128 liquidityAdded) {
        // _snapshotFeeGrowth() writes ring state AFTER this unlock — benign: the only caller
        // (deposit) is nonReentrant, the V4 flash-accounting is fully settled by now, and the
        // writes are informational only.
        // slither-disable-next-line reentrancy-benign
        bytes memory res = poolManager.unlock(abi.encode(Action.COMPOUND, bytes("")));
        liquidityAdded = abi.decode(res, (uint128));
        _snapshotFeeGrowth(); // record post-compound L/share for the trailing-APR ring (≤ once/day)
    }

    // The trailing-APR ring below intentionally uses block.timestamp for DAILY snapshot dedup and for
    // annualizing L/share growth. Nothing of value depends on sub-day precision, so a miner's few-second
    // timestamp drift is irrelevant — these are informational reads only. (Suppress both linters' generic
    // time warnings for the whole block rather than line-by-line.)
    // solhint-disable not-rely-on-time
    // slither-disable-start timestamp

    /// @dev Append the current L/share to the daily ring buffer, at most once per UTC day. Reached only
    /// after a real compound (deposits below the auto-compound trigger never enter the leg, so L/share
    /// didn't move). The snapshot is purely informational — it feeds feeApr() and changes no accounting.
    function _snapshotFeeGrowth() private {
        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality
        if (supply == 0) return;
        uint32 day = uint32(block.timestamp / 1 days);
        if (day <= lastSnapshotDay) return; // already captured today (day only increases)
        uint8 head = lastSnapshotDay == 0 ? 0 : uint8((feeHistoryHead + 1) % FEE_HISTORY_LEN);
        feeHistory[head] = Snapshot(uint32(block.timestamp), uint224((uint256(positionLiquidity()) * 1e18) / supply));
        feeHistoryHead = head;
        lastSnapshotDay = day;
    }

    /// @notice Trailing L-per-share growth APR in basis points over the lifetime, ~7-day, and
    /// ~30-day windows, derived from the L/share daily ring. Each is annualized by the ACTUAL
    /// elapsed time between the matched snapshot and now. A window returns 0 when there isn't a
    /// snapshot at least that old yet (insufficient history). NOTE: cadence-dependent guidance,
    /// not a guarantee — sparse or clustered compounds make short windows noisy. The metric is
    /// provenance-blind (Shieldify I-01): it measures ALL compounded no-mint liquidity growth per
    /// share — organic trading fees, pool/vault donations, redemption-forfeited value concentrating
    /// on remaining shares, and rounding dust — every source of which accrues to holders. Pending
    /// (uncompounded) value lives in compoundClaimable and is NOT reflected until compounded.
    /// View-only; the 30-slot scan costs nothing off-chain.
    function feeApr() external view returns (uint256 lifetimeBps, uint256 d7Bps, uint256 d30Bps) {
        uint256 supply = totalSupply();
        // slither-disable-next-line incorrect-equality
        if (supply == 0 || inceptionTime == 0) return (0, 0, 0);
        uint256 perNow = (uint256(positionLiquidity()) * 1e18) / supply;
        lifetimeBps = _annualizedBps(1e18, inceptionTime, perNow); // baseline L/share == 1.0 (1e18) at inception
        d7Bps = _windowApr(perNow, 7 days);
        d30Bps = _windowApr(perNow, 30 days);
    }

    /// @dev APR over the snapshot whose timestamp is the largest at least `window` old (so the realized
    /// window is ≥ requested). Returns 0 if no snapshot is that old yet.
    function _windowApr(uint256 perNow, uint256 window) private view returns (uint256) {
        if (block.timestamp <= window) return 0;
        uint256 target = block.timestamp - window;
        uint256 bestTs = 0; // sentinel: no qualifying snapshot found yet
        uint256 bestPer = 0;
        for (uint256 i = 0; i < FEE_HISTORY_LEN; ++i) {
            Snapshot memory s = feeHistory[i];
            if (s.timestamp != 0 && s.timestamp <= target && s.timestamp > bestTs) {
                bestTs = s.timestamp;
                bestPer = s.perShareWad;
            }
        }
        if (bestTs == 0) return 0; // no snapshot at least `window` old → insufficient history
        return _annualizedBps(bestPer, bestTs, perNow);
    }

    /// @dev Annualize the L/share growth from (perThen @ tsThen) to perNow into bps. 0 if non-positive.
    function _annualizedBps(uint256 perThen, uint256 tsThen, uint256 perNow) private view returns (uint256) {
        if (perNow <= perThen || tsThen >= block.timestamp || perThen == 0) return 0;
        uint256 elapsed = block.timestamp - tsThen;
        // bps = (perNow - perThen)/perThen × (365 days / elapsed) × 10_000, via mulDiv (no overflow).
        return FullMath.mulDiv(perNow - perThen, 365 days * BPS, perThen * elapsed);
    }
    // slither-disable-end timestamp
    // solhint-enable not-rely-on-time

    /*//////////////////////////////////////////////////////////////
                          UNLOCK CALLBACK (V4 CORE)
    //////////////////////////////////////////////////////////////*/

    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "only-pool-manager");
        (Action action, bytes memory data) = abi.decode(raw, (Action, bytes));

        if (action == Action.DEPOSIT) {
            return _onDeposit(abi.decode(data, (DepositData)));
        } else if (action == Action.REDEEM) {
            return _onRedeem(abi.decode(data, (RedeemData)));
        } else {
            return _onCompound(); // Action.COMPOUND carries no payload
        }
    }

    /*//////////////////////////////////////////////////////////////
                        CALLBACK HANDLERS (internal)

      DELTA CONVENTION (V4): a NEGATIVE delta for a currency means the vault
      owes the pool (must _settle by paying in). A POSITIVE delta means the
      pool owes the vault (we _take). Every one of these paths must net to zero
      by the time the unlock callback returns or the PoolManager reverts with
      CurrencyNotSettled. The signs are the #1 source of bugs here; the Hardhat
      suite asserts zero residual deltas on every callback.
    //////////////////////////////////////////////////////////////*/

    // Reentrancy: the only external calls are into the trusted PoolManager within our own
    // unlock, and the whole entrypoint is nonReentrant — the FeesRetained emit is not a vector, and the
    // only post-call state writes are the informational lifetime fee counters (_recordFees).
    // slither-disable-next-line reentrancy-events,reentrancy-benign
    function _onDeposit(DepositData memory d) internal returns (bytes memory) {
        uint256 retain0 = d.retain0;
        uint256 retain1 = d.retain1;

        // 1. Harvest the position's uncompounded fees to the vault FIRST. V4 realizes the
        //    position's full fees on ANY modifyLiquidity, so if we didn't pull them out here
        //    they would be credited into the depositor's add below (a free fee grab). Pulling
        //    them now keeps them as vault-owned balance that folds forward to all holders, and
        //    leaves the add in step 3 with zero feesAccrued. Skipped on the first deposit
        //    (no position yet).
        if (positionLiquidity() > 0) {
            // liquidityDelta == 0 => callerDelta == feesAccrued; we use `fees` and intentionally
            // discard the (equal) callerDelta.
            // slither-disable-next-line unused-return
            (, BalanceDelta fees) = poolManager.modifyLiquidity(
                poolKey,
                ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 0, salt: bytes32(0)}),
                ""
            );
            int128 f0 = fees.amount0();
            int128 f1 = fees.amount1();
            if (f0 > 0) {
                poolManager.take(currency0, address(this), uint256(uint128(f0)));
                retain0 += uint256(uint128(f0));
            }
            if (f1 > 0) {
                poolManager.take(currency1, address(this), uint256(uint128(f1)));
                retain1 += uint256(uint128(f1));
            }
            if (f0 > 0 || f1 > 0) {
                (uint256 vltFees, uint256 usdcFees) = _recordFees(
                    f0 > 0 ? uint256(uint128(f0)) : 0,
                    f1 > 0 ? uint256(uint128(f1)) : 0
                );
                emit FeesRetained(vltFees, usdcFees);
            }
        }

        // 2. Add liquidity from the DEPOSITOR's contribution only (balance minus retained). The
        //    VLT was already sourced externally by the ZapHelper in deposit() before this unlock,
        //    so the vault now holds (bought VLT + remaining USDC) on top of the retained balances.
        uint256 bal0 = _selfBalance(currency0);
        uint256 bal1 = _selfBalance(currency1);
        (uint128 liquidityAdded, uint256 paid0, uint256 paid1) = _addLiquidity(
            bal0 > retain0 ? bal0 - retain0 : 0,
            bal1 > retain1 ? bal1 - retain1 : 0
        );

        // 3. Refund the payer's unused contribution; keep the retained (vault-owned) tokens.
        _refundDust(d.payer, retain0, retain1);

        // paid0/1 are what the pool actually consumed — the depositor's true cost basis.
        return abi.encode(liquidityAdded, paid0, paid1);
    }

    // Reentrancy: the only external calls are into the trusted PoolManager within our own
    // unlock, and the whole entrypoint is nonReentrant — the FeesRetained emit is not a vector, and the
    // only post-call state writes are the informational lifetime fee counters (_recordFees).
    // slither-disable-next-line reentrancy-events,reentrancy-benign
    function _onRedeem(RedeemData memory d) internal returns (bytes memory) {
        (BalanceDelta callerDelta, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: -int256(uint256(d.liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // V4 folds the position's FULL uncompounded fees (feesAccrued) into callerDelta on any
        // modify. The redeemer is entitled ONLY to their pro-rata PRINCIPAL — the fees belong to
        // all holders, so split them out and keep them at the vault (they fold forward into the
        // next compound). Both deltas are positive here (pool owes the vault).
        BalanceDelta principalDelta = callerDelta - feesAccrued;
        uint256 amount0 = uint256(int256(principalDelta.amount0()));
        uint256 amount1 = uint256(int256(principalDelta.amount1()));
        // No min-out check: in-kind redemption is not value-extractable (see redeem()).

        // Principal to the receiver.
        if (amount0 > 0) poolManager.take(currency0, d.receiver, amount0);
        if (amount1 > 0) poolManager.take(currency1, d.receiver, amount1);

        // Uncompounded fees retained at the vault (address(this)) for all holders.
        int128 f0 = feesAccrued.amount0();
        int128 f1 = feesAccrued.amount1();
        if (f0 > 0) poolManager.take(currency0, address(this), uint256(uint128(f0)));
        if (f1 > 0) poolManager.take(currency1, address(this), uint256(uint128(f1)));
        if (f0 > 0 || f1 > 0) {
            (uint256 vltFees, uint256 usdcFees) = _recordFees(
                f0 > 0 ? uint256(uint128(f0)) : 0,
                f1 > 0 ? uint256(uint128(f1)) : 0
            );
            emit FeesRetained(vltFees, usdcFees);
        }

        return abi.encode(amount0, amount1);
    }

    // Reentrancy: the only external calls are into the trusted PoolManager within our own
    // unlock, and the whole entrypoint is nonReentrant — the trailing event is not a vector, and the
    // only post-call state writes are the informational lifetime fee counters (_recordFees).
    // slither-disable-next-line reentrancy-events,reentrancy-benign
    function _onCompound() internal returns (bytes memory) {
        // 1. Collect accrued fees: modifyLiquidity with liquidityDelta == 0 returns the
        //    fees owed as `feesAccrued` (== callerDelta when delta is zero), a positive delta.
        // slither-disable-next-line unused-return
        (, BalanceDelta fees) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: 0, salt: bytes32(0)}),
            ""
        );
        uint256 fee0 = uint256(int256(fees.amount0()));
        uint256 fee1 = uint256(int256(fees.amount1()));
        // No "nothing-to-compound" guard here: deposit() already gated on total claimable value
        // (fees + retained) via compoundClaimable(), so we proceed to reinvest the retained balance
        // even when this harvest's fresh pool fees happen to be ~0.

        // 2. Pull 100% of the harvested fees into the vault, zeroing the positive deltas.
        if (fee0 > 0) poolManager.take(currency0, address(this), fee0);
        if (fee1 > 0) poolManager.take(currency1, address(this), fee1);

        // 3. Internally rebalance toward the pool ratio so both sides can enter the position.
        //    _rebalance computes the direction + size (≈half the value-imbalance) and bounds its
        //    own price impact to ≤5% via sqrtPriceLimitX96; any unfilled remainder folds forward
        //    into the next compound. No caller input, no minSwapOut — the loose balance being
        //    rebalanced is trigger-scale by construction (see SQRT_LIMIT_* notes).
        _rebalance(_selfBalance(currency0), _selfBalance(currency1));

        // 4. Reinvest the FULL vault balance — this harvest PLUS retained deposit/redeem fees and
        //    prior compound dust, 100% of it, with no fee carved out for anyone. Mints NO shares
        //    -> L grows against fixed supply -> NAV/share rises. Any sub-dust the add can't place
        //    (one side rounds down) stays in the vault and FOLDS FORWARD into the next compound —
        //    never counted in shares, so it can only ever increase future holders' redemption
        //    value. This is the documented choice. The compound leg makes no external transfer to
        //    any account; its only token movements are settlements with the PoolManager.
        // Consumed amounts are unused here: Compound's fee fields already carry the accounting.
        (uint128 liquidityAdded,,) = _addLiquidity(_selfBalance(currency0), _selfBalance(currency1));

        {
            (uint256 vltFees, uint256 usdcFees) = _recordFees(fee0, fee1);
            emit Compound(vltFees, usdcFees, liquidityAdded);
        }
        return abi.encode(liquidityAdded);
    }

    /*//////////////////////////////////////////////////////////////
                       LOW-LEVEL V4 HELPERS (internal)
    //////////////////////////////////////////////////////////////*/

    /// @dev Add liquidity from the vault's current token balances and settle what we owe.
    /// @return liquidity  L actually added to the position.
    /// @return paid0      currency0 the pool consumed (settled) for the add.
    /// @return paid1      currency1 the pool consumed (settled) for the add.
    function _addLiquidity(uint256 amount0Desired, uint256 amount1Desired)
        internal
        returns (uint128 liquidity, uint256 paid0, uint256 paid1)
    {
        // slither-disable-next-line incorrect-equality
        if (amount0Desired == 0 && amount1Desired == 0) return (0, 0, 0);

        // We need only the price from slot0.
        // slither-disable-next-line unused-return
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey.toId());
        liquidity = _liquidityForAmounts(sqrtPriceX96, amount0Desired, amount1Desired);
        // slither-disable-next-line incorrect-equality
        if (liquidity == 0) return (0, 0, 0);

        // Callers (deposit/compound) harvest fees BEFORE this, so feesAccrued here is ~0; any
        // residual from an intervening swap on our own position is netted into `delta` and
        // reinvested. We use `delta` (callerDelta) and intentionally discard feesAccrued.
        // slither-disable-next-line unused-return
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Adding liquidity produces negative deltas (we owe the pool): settle each.
        if (delta.amount0() < 0) {
            paid0 = uint256(uint128(-delta.amount0()));
            _settle(currency0, paid0);
        }
        if (delta.amount1() < 0) {
            paid1 = uint256(uint128(-delta.amount1()));
            _settle(currency1, paid1);
        }
    }

    /// @dev Compute and execute the compound rebalance swap: move ~half the value-imbalance from
    /// the heavy side to the light side so both can enter the full-range position. One bound, no
    /// caller input: the swap's own price impact is limited to a ≤5% move via `sqrtPriceLimitX96`,
    /// so it may partially fill; any unfilled remainder simply stays in the vault and folds
    /// forward into the next compound. The notional is inherently small — the vault's loose
    /// balance, which the deposit trigger clears at ~$100 scale (see the SQRT_LIMIT_* notes for
    /// why executing it at a manipulated spot is uneconomic to induce).
    function _rebalance(uint256 r0, uint256 r1) internal {
        // slither-disable-next-line unused-return
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey.toId());
        uint256 sp = uint256(sqrtPriceX96);

        // Value of currency0 expressed in currency1 (raw): r0 · price = r0 · sqrtP^2 / Q96^2.
        uint256 value0InCcy1 = FullMath.mulDiv(FullMath.mulDiv(r0, sp, Q96), sp, Q96);

        bool zeroForOne;
        uint256 amountIn;
        if (r1 > value0InCcy1) {
            // Excess currency1 → sell ~half the imbalance, currency1 → currency0 (oneForZero).
            zeroForOne = false;
            amountIn = (r1 - value0InCcy1) / 2;
        } else {
            // Excess currency0 → sell ~half the imbalance, currency0 → currency1 (zeroForOne).
            // Value of currency1 in currency0 (raw): r1 / price = r1 · Q96^2 / sqrtP^2.
            uint256 value1InCcy0 = FullMath.mulDiv(FullMath.mulDiv(r1, Q96, sp), Q96, sp);
            zeroForOne = true;
            amountIn = (r0 > value1InCcy0 ? r0 - value1InCcy0 : 0) / 2;
        }

        // slither-disable-next-line incorrect-equality
        if (amountIn == 0) return; // already balanced or only dust — nothing to swap

        // Bound the pool-price move to ≤5% in sqrt-space, clamped to the valid band.
        uint256 limit = zeroForOne
            ? FullMath.mulDiv(sp, SQRT_LIMIT_DOWN_BPS, BPS)
            : FullMath.mulDiv(sp, SQRT_LIMIT_UP_BPS, BPS);
        uint256 minBound = uint256(uint160(TickMath.MIN_SQRT_PRICE)) + 1;
        uint256 maxBound = uint256(uint160(TickMath.MAX_SQRT_PRICE)) - 1;
        if (limit < minBound) limit = minBound;
        if (limit > maxBound) limit = maxBound;

        _swapExactIn(zeroForOne, amountIn, uint160(limit));
    }

    /// @dev Exact-input swap routed through our own pool, bounded by `sqrtPriceLimitX96`. Settles
    /// the input ACTUALLY consumed and takes the output to self. With a price-limit bound the swap
    /// may partially fill; the bound (not a minOut) is the slippage guard, and any unconsumed input
    /// stays in the vault to fold forward.
    function _swapExactIn(bool zeroForOne, uint256 amountIn, uint160 sqrtPriceLimitX96)
        internal
        returns (uint256 amountOut)
    {
        BalanceDelta delta = poolManager.swap(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            ""
        );

        if (zeroForOne) {
            _settle(currency0, uint256(uint128(-delta.amount0())));
            amountOut = uint256(uint128(delta.amount1()));
            poolManager.take(currency1, address(this), amountOut);
        } else {
            _settle(currency1, uint256(uint128(-delta.amount1())));
            amountOut = uint256(uint128(delta.amount0()));
            poolManager.take(currency0, address(this), amountOut);
        }
    }

    /// @dev Pay a currency we owe into the PoolManager (sync -> transfer -> settle).
    function _settle(Currency currency, uint256 amount) internal {
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return;
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
        // settle() returns the amount paid; we transferred the exact owed amount above.
        // slither-disable-next-line unused-return
        poolManager.settle();
    }

    function _selfBalance(Currency currency) internal view returns (uint256) {
        return IERC20(Currency.unwrap(currency)).balanceOf(address(this));
    }

    /// @dev Map a currency0/1-ordered pair to (VLT, USDC). The single boundary between the
    /// pool's address-sorted ordering (all internal/V4 plumbing) and the token-named external
    /// surface (all events and external view returns).
    function _toVltUsdc(uint256 amount0, uint256 amount1)
        internal
        view
        returns (uint256 vltAmount, uint256 usdcAmount)
    {
        (vltAmount, usdcAmount) = usdcIsCurrency0 ? (amount1, amount0) : (amount0, amount1);
    }

    /// @dev Refund the depositor's leftover zap dust — everything ABOVE the retained
    /// (vault-owned) balances. `retain0`/`retain1` are the pre-deposit balances plus any fees
    /// harvested during this deposit; those stay in the vault for all holders.
    function _refundDust(address to, uint256 retain0, uint256 retain1) internal {
        uint256 b0 = _selfBalance(currency0);
        uint256 b1 = _selfBalance(currency1);
        if (b0 > retain0) IERC20(Currency.unwrap(currency0)).safeTransfer(to, b0 - retain0);
        if (b1 > retain1) IERC20(Currency.unwrap(currency1)).safeTransfer(to, b1 - retain1);
    }

    /// @dev Canonical liquidity-for-amounts over [tickLower, tickUpper], delegated to
    /// v4-periphery's audited LiquidityAmounts. Returns the largest L the given amounts
    /// can fully fund (the min of the two single-sided computations), so the subsequent
    /// modifyLiquidity never demands more token than the vault holds.
    function _liquidityForAmounts(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1)
        internal
        view
        returns (uint128)
    {
        return LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );
    }
    }
