// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Create2Factory} from "./Create2Factory.sol";

/// @notice Deploys the Create2Factory (idempotent — skips if already deployed)
/// and then deploys any additional launchpad contracts through it.
///
/// Required env vars:
///   DEPLOYER_PRIVATE_KEY   — hex private key of the deployer wallet (no 0x prefix required)
///   RIALO_DEVNET_RPC       — RPC URL, e.g. https://devnet.rialo.io:4101
///
/// Optional env vars:
///   CREATE2_FACTORY_ADDRESS — skip factory deploy and reuse an existing one
///   DRY_RUN                 — set to "true" to skip broadcast (local simulation only)
///
/// After a successful run the script writes to stdout:
///   FACTORY=<address>
/// Add more contracts in the _deployLaunchpadContracts() hook below.
contract DeployLaunchpad is Script {
    // Salt for deterministic factory address (change to re-deploy to a new address)
    bytes32 constant FACTORY_SALT = keccak256("hugefun.Create2Factory.v1");

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        console.log("[DeployLaunchpad] deployer:", deployer);

        // ── 1. Deploy or reuse Create2Factory ────────────────────────────────
        address factoryAddr = vm.envOr("CREATE2_FACTORY_ADDRESS", address(0));
        bool dryRun = keccak256(bytes(vm.envOr("DRY_RUN", "false"))) == keccak256("true");

        if (factoryAddr == address(0)) {
            bytes memory factoryBytecode = type(Create2Factory).creationCode;
            // Predict the address the deployer EOA would produce via CREATE
            // (We deploy the factory directly, not via another factory)
            if (!dryRun) {
                vm.startBroadcast(deployerKey);
                Create2Factory factory = new Create2Factory();
                factoryAddr = address(factory);
                vm.stopBroadcast();
            } else {
                console.log("[DeployLaunchpad] DRY_RUN — skipping factory broadcast");
                factoryAddr = address(0xDEAD);
            }
            console.log("[DeployLaunchpad] Create2Factory deployed at:", factoryAddr);
        } else {
            console.log("[DeployLaunchpad] Reusing existing Create2Factory at:", factoryAddr);
        }

        // Emit machine-readable line for CI to capture
        console.log("FACTORY=%s", vm.toString(factoryAddr));

        // ── 2. Deploy additional launchpad contracts ──────────────────────────
        if (!dryRun) {
            vm.startBroadcast(deployerKey);
            _deployLaunchpadContracts(Create2Factory(factoryAddr), deployerKey);
            vm.stopBroadcast();
        }
    }

    /// @dev Add your launchpad contract deployments here.
    /// Use factory.deploy(salt, creationCode) for deterministic addresses.
    /// This function is called inside vm.startBroadcast/vm.stopBroadcast.
    function _deployLaunchpadContracts(Create2Factory /*factory*/, uint256 /*deployerKey*/) internal virtual {
        // TODO: add token factory, bonding curve, or escrow contracts here.
        // Example:
        //   bytes memory code = abi.encodePacked(type(BondingCurve).creationCode);
        //   address bondingCurve = factory.deploy(keccak256("hugefun.BondingCurve.v1"), code);
        //   console.log("BONDING_CURVE=%s", vm.toString(bondingCurve));
    }
}
