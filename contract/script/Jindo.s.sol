// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script, console} from "forge-std/Script.sol";
import {Jindo} from "../src/Jindo.sol";

contract JindoScript is Script {
    Jindo public jindo;

    function run() public {
        vm.startBroadcast();
        jindo = new Jindo();
        vm.stopBroadcast();

        console.log("Jindo deployed at:", address(jindo));
    }
}
