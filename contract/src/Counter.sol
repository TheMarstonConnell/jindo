// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

contract Jindo {
    struct Contract {
        address host;
        address client;
        bytes32 root;
        uint256 size;
    }

    mapping(bytes32 => Contract) public contracts;

    mapping(address => address[]) public clientsOfHost;
    mapping(address => address[]) public hostsOfClient;

    // 1-based index into the arrays above; 0 means "not present"
    mapping(address => mapping(address => uint256)) private clientIndexOfHost;
    mapping(address => mapping(address => uint256)) private hostIndexOfClient;

    function key(address host, address client) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(host, client));
    }

    function create(address host, address client, bytes32 root, uint256 size) external {
        bytes32 k = key(host, client);
        require(contracts[k].host == address(0), "exists");

        contracts[k] = Contract({host: host, client: client, root: root, size: size});

        clientsOfHost[host].push(client);
        clientIndexOfHost[host][client] = clientsOfHost[host].length;

        hostsOfClient[client].push(host);
        hostIndexOfClient[client][host] = hostsOfClient[client].length;
    }

    function remove(address host, address client) external {
        bytes32 k = key(host, client);
        require(contracts[k].host != address(0), "missing");

        _removeFrom(clientsOfHost[host], clientIndexOfHost[host], client);
        _removeFrom(hostsOfClient[client], hostIndexOfClient[client], host);

        delete contracts[k];
    }

    function _removeFrom(
        address[] storage arr,
        mapping(address => uint256) storage indexOf,
        address value
    ) private {
        uint256 idx = indexOf[value];
        uint256 lastIdx = arr.length;
        if (idx != lastIdx) {
            address last = arr[lastIdx - 1];
            arr[idx - 1] = last;
            indexOf[last] = idx;
        }
        arr.pop();
        delete indexOf[value];
    }
}
