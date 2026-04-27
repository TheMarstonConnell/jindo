// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

contract Jindo {
    uint256 public constant CHUNK_SIZE = 1024;

    struct Contract {
        address host;
        address client;
        bytes32 root;
        uint256 size;
        uint256 challengeIndex;
        uint256 challengeBlock;
    }

    mapping(bytes32 => Contract) public contracts;

    mapping(address => address[]) public clientsOfHost;
    mapping(address => address[]) public hostsOfClient;

    // 1-based index into the arrays above; 0 means "not present"
    mapping(address => mapping(address => uint256)) private clientIndexOfHost;
    mapping(address => mapping(address => uint256)) private hostIndexOfClient;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant UPLOAD_TYPEHASH = keccak256(
        "Upload(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint256 newSize)"
    );
    bytes32 private constant DELETE_TYPEHASH = keccak256(
        "Delete(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint256 newSize)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    event ContractCreated(address indexed host, address indexed client, bytes32 root, uint256 size);
    event ContractUpdated(
        address indexed host, address indexed client, bytes32 oldRoot, bytes32 newRoot, uint256 newSize
    );
    event ContractRemoved(address indexed host, address indexed client);
    event ChallengeRotated(
        address indexed host, address indexed client, uint256 challengeIndex, uint256 challengeBlock
    );
    event ProofCommitted(
        address indexed host,
        address indexed client,
        uint256 challengeIndex,
        bytes32 fileRoot,
        uint256 chunkInFileIndex
    );

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes("Jindo")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function key(address host, address client) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(host, client));
    }

    function commitUpload(
        address client,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint256 newSize,
        bytes calldata signature
    ) external {
        _verifyAndCommit(UPLOAD_TYPEHASH, client, fileRoot, priorRoot, newRoot, newSize, signature);
    }

    function commitDelete(
        address client,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint256 newSize,
        bytes calldata signature
    ) external {
        _verifyAndCommit(DELETE_TYPEHASH, client, fileRoot, priorRoot, newRoot, newSize, signature);
    }

    function remove(address client) external {
        bytes32 k = key(msg.sender, client);
        require(contracts[k].host == msg.sender, "not authorized");

        _removeFrom(clientsOfHost[msg.sender], clientIndexOfHost[msg.sender], client);
        _removeFrom(hostsOfClient[client], hostIndexOfClient[client], msg.sender);

        delete contracts[k];
        emit ContractRemoved(msg.sender, client);
    }

    /// @notice Host commits a data-availability proof for the current challenge.
    /// @dev On success, rotates the challenge using the previous block's hash.
    function commitProof(
        address client,
        uint256 cumulativeBytesBefore,
        uint256 fileSize,
        bytes32 fileRoot,
        uint256 chunkInFileIndex,
        bytes calldata chunkBytes,
        bytes32[] calldata outerProof,
        bytes32[] calldata fileProof
    ) external {
        bytes32 k = key(msg.sender, client);
        Contract storage c = contracts[k];
        require(c.host == msg.sender, "not authorized");
        require(c.size > 0, "no data to challenge");

        uint256 challengeByte = c.challengeIndex * CHUNK_SIZE;
        require(cumulativeBytesBefore + fileSize <= c.size, "file overflows total");
        require(cumulativeBytesBefore <= challengeByte, "challenge before file");
        require(challengeByte < cumulativeBytesBefore + fileSize, "challenge after file");
        require(
            chunkInFileIndex == (challengeByte - cumulativeBytesBefore) / CHUNK_SIZE, "wrong chunk index"
        );

        // The chunk at the last index of a file may be shorter than CHUNK_SIZE.
        uint256 expectedLen;
        uint256 chunkStartInFile = chunkInFileIndex * CHUNK_SIZE;
        if (chunkStartInFile + CHUNK_SIZE > fileSize) {
            expectedLen = fileSize - chunkStartInFile;
        } else {
            expectedLen = CHUNK_SIZE;
        }
        require(chunkBytes.length == expectedLen, "wrong chunk length");

        // Outer-tree leaf binds (cumulativeBytesBefore, fileSize, fileRoot).
        bytes32 outerLeaf = keccak256(abi.encode(cumulativeBytesBefore, fileSize, fileRoot));
        require(_verifyMerkleProof(outerProof, c.root, outerLeaf), "bad outer proof");

        // File-tree leaf binds (chunkInFileIndex, chunkBytes).
        bytes32 fileLeafHash = keccak256(abi.encode(chunkInFileIndex, chunkBytes));
        require(_verifyMerkleProof(fileProof, fileRoot, fileLeafHash), "bad file proof");

        emit ProofCommitted(msg.sender, client, c.challengeIndex, fileRoot, chunkInFileIndex);
        _rotateChallenge(k, c);
    }

    function _verifyAndCommit(
        bytes32 typeHash,
        address client,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint256 newSize,
        bytes calldata signature
    ) private {
        bytes32 structHash =
            keccak256(abi.encode(typeHash, msg.sender, client, fileRoot, priorRoot, newRoot, newSize));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        require(_recover(digest, signature) == client, "bad signature");

        bytes32 k = key(msg.sender, client);
        Contract storage c = contracts[k];
        if (c.host == address(0)) {
            require(priorRoot == bytes32(0), "first commit needs priorRoot=0");
            c.host = msg.sender;
            c.client = client;
            c.root = newRoot;
            c.size = newSize;

            clientsOfHost[msg.sender].push(client);
            clientIndexOfHost[msg.sender][client] = clientsOfHost[msg.sender].length;
            hostsOfClient[client].push(msg.sender);
            hostIndexOfClient[client][msg.sender] = hostsOfClient[client].length;

            emit ContractCreated(msg.sender, client, newRoot, newSize);
        } else {
            require(c.root == priorRoot, "priorRoot mismatch");
            bytes32 oldRoot = c.root;
            c.root = newRoot;
            c.size = newSize;
            emit ContractUpdated(msg.sender, client, oldRoot, newRoot, newSize);
        }
        _rotateChallenge(k, c);
    }

    function _rotateChallenge(bytes32 k, Contract storage c) private {
        if (c.size == 0) {
            c.challengeIndex = 0;
            c.challengeBlock = 0;
            return;
        }
        uint256 totalChunks = (c.size + CHUNK_SIZE - 1) / CHUNK_SIZE;
        bytes32 prevHash = block.number == 0 ? bytes32(0) : blockhash(block.number - 1);
        uint256 seed = uint256(keccak256(abi.encodePacked(prevHash, k, c.root)));
        c.challengeIndex = seed % totalChunks;
        c.challengeBlock = block.number;
        emit ChallengeRotated(c.host, c.client, c.challengeIndex, c.challengeBlock);
    }

    function _verifyMerkleProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf)
        private
        pure
        returns (bool)
    {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sib = proof[i];
            computed = computed < sib
                ? keccak256(abi.encodePacked(computed, sib))
                : keccak256(abi.encodePacked(sib, computed));
        }
        return computed == root;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }

    function _removeFrom(address[] storage arr, mapping(address => uint256) storage indexOf, address value) private {
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
