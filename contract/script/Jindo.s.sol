// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {Jindo, IERC20} from "../src/Jindo.sol";

contract JindoScript is Script {
    Jindo public jindo;

    function run() public {
        // USDC contract address per network. Pass via env: JINDO_USDC=0x...
        address usdc = vm.envAddress("JINDO_USDC");

        vm.startBroadcast();
        jindo = new Jindo(IERC20(usdc));
        vm.stopBroadcast();

        console.log("Jindo deployed at:", address(jindo));
        console.log("USDC at:           ", usdc);
    }
}
