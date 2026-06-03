// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract Jindo {
    uint256 public constant CHUNK_SIZE = 1024;

    /// @dev atto-USDC per byte per day. Internally everything is denominated in
    /// atto-USDC (10^-18 USDC = 10^-12 base USDC units). Conversion to base USDC
    /// only happens at deposit/withdraw/claim. With 6-decimal USDC base units,
    /// $0.023/GB/month (= $0.000767/GB/day) ≈ 714_300 atto/byte/day:
    ///   0.023 * 1e18 atto / 1_073_741_824 bytes / 30 days
    uint64 public constant RATE_BYTE_DAY = 714_300;

    /// One atto-USDC = 10^-18 USDC. One base USDC unit = 10^-6 USDC.
    /// So `1 base unit = 10^12 atto`.
    uint256 private constant ATTO_PER_BASE = 1e12;
    uint256 private constant SECONDS_PER_DAY = 86_400;

    /// @dev 4 storage slots per pair:
    ///   slot 0: host (20) | size (8) | _pad (4)
    ///   slot 1: client (20) | challengeIndex (8) | _pad (4)
    ///   slot 2: root (32)
    ///   slot 3: lastProof (8) | accrued (16) | _pad (8)
    /// `lastProof` is the timestamp of the most recent successful commitProof.
    /// It also gates the UTC-day cooldown: a proof reverts if `lastProof`
    /// already lies in the current UTC calendar day. On the very first
    /// commitUpload for a pair we seed it to block.timestamp, which keeps the
    /// host's first payable proof in a different UTC day than the upload.
    /// `accrued` carries sub-base-unit dust between proofs — once it crosses
    /// 1 USDC base unit (10^12 atto) we flush to the host on the next proof.
    struct Contract {
        address host;
        uint64 size;
        address client;
        uint64 challengeIndex;
        bytes32 root;
        uint64 lastProof;
        uint128 accrued;
    }

    /// Per-client deposit pool, atto-USDC. One deposit funds every pair the client
    /// has with any host. _payProof() debits this on each successful proof.
    ///
    /// ⚠ cross-host griefing risk
    /// ────────────────────────────
    /// `balance` is global per-client and drained first-come-first-served by
    /// whichever host calls `commitProof` first on a given UTC day. The contract
    /// itself doesn't enforce that an incoming upload reserves enough pool for
    /// every existing host the client already has; that's currently a host-side
    /// check (see handleUpload in src/host/server.ts).
    ///
    /// Failure mode: an honest host A only checks `balance >= my_size × rate × 30`
    /// at upload time. If client already has hosts B and C with their own
    /// outstanding sizes, the *aggregate* coverage might fall below 30 days —
    /// host A accepts the new upload, then B and C's `_payProof` calls race A
    /// for the limited pool. Whoever proves first gets paid; whoever loses the
    /// race accrues nothing and effectively stores the data for free until the
    /// client re-funds.
    ///
    /// Mitigations to consider if/when the contract is opened to a multi-host
    /// marketplace where hosts can't be assumed to cooperate:
    ///   1. Have hosts check `balance >= sum(sizes of every pair this client
    ///      has, queried via hostsOfClient) × rate × 30` at upload time.
    ///   2. Enforce the check on-chain inside _verifyAndCommit so even buggy or
    ///      adversarial hosts can't accept underfunded uploads. Adds ~2k gas
    ///      per upload but is credibly neutral and works for any host code.
    ///
    /// For a single-operator deployment (one host, friendly clients) the
    /// per-pair host check is sufficient and the griefing surface doesn't apply.
    mapping(address => uint128) public balance;

    // intentional uppercase: USDC is the token's market symbol; matches every
    // ERC-20 reference in the codebase.
    // slither-disable-next-line naming-convention
    IERC20 public immutable USDC;

    mapping(bytes32 => Contract) public contracts;

    /// Hosts a client has live pairs with. Maintained on-chain because client
    /// reserve checks (and any UI showing "where am I storing data") need to
    /// enumerate them. The reverse direction (clients-of-host) is NOT tracked
    /// on-chain — hosts already have authoritative lists in their local DB,
    /// and skipping it saves ~44k gas (2 cold SSTOREs) per first upload.
    mapping(address => address[]) public hostsOfClient;

    function getHostsOfClient(address client) external view returns (address[] memory) {
        return hostsOfClient[client];
    }

    /// Sum of `size` across every live pair this client has. Loops over
    /// `hostsOfClient` rather than caching a running total — uploads are far
    /// more frequent than reserve checks, so an SSTORE per upload would cost
    /// more than it saves on the read side.
    function getSizeOfClient(address client) public view returns (uint64) {
        address[] storage hosts = hostsOfClient[client];
        uint256 len = hosts.length;
        uint64 size = 0;
        for (uint256 i; i < len;) {
            size += contracts[key(hosts[i], client)].size;
            unchecked {
                ++i;
            }
        }
        return size;
    }

    /// Atto-USDC the client could pull right now without breaching the 30-day
    /// reserve check in withdraw(). Returns 0 when the pool has already fallen
    /// below the reserve — proofs can drive it under as commitments accrue.
    function getWithdrawableBalance(address client) public view returns (uint128) {
        return _withdrawable(balance[client], client);
    }

    function _withdrawable(uint128 bal, address client) private view returns (uint128) {
        uint128 reserve = uint128(getSizeOfClient(client)) * uint128(RATE_BYTE_DAY) * 30;
        if (reserve >= bal) return 0;
        return bal - reserve;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // Upload signs over a batch of fileRoots — uploading 1 or N files goes
    // through the same path. Per EIP-712, dynamic-length `bytes32[]` fields
    // hash to keccak256(abi.encodePacked(elements)) when computing the
    // structHash; we mirror that on chain in commitUpload.
    bytes32 private constant UPLOAD_TYPEHASH = keccak256(
        "Upload(address host,address client,bytes32[] fileRoots,bytes32 priorRoot,bytes32 newRoot,uint64 newSize)"
    );
    bytes32 private constant DELETE_TYPEHASH = keccak256(
        "Delete(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint64 newSize)"
    );

    // intentional uppercase: this is the EIP-712 standard variable name used
    // by every other implementation (OZ, Solady, etc.). Wallets show it.
    // slither-disable-next-line naming-convention
    bytes32 public immutable DOMAIN_SEPARATOR;

    error NotAuthorized();
    error NoData();
    error FileOverflow();
    error ChallengeBeforeFile();
    error ChallengeAfterFile();
    error WrongChunkIndex();
    error WrongChunkLength();
    error BadOuterProof();
    error BadFileProof();
    error BadSignature();
    error PriorRootRequiredZero();
    error PriorRootMismatch();
    error InsufficientBalance();
    error TransferFailed();
    error CooldownActive();

    event ContractCreated(address indexed host, address indexed client, bytes32 root, uint256 size);
    event ContractUpdated(
        address indexed host, address indexed client, bytes32 oldRoot, bytes32 newRoot, uint256 newSize
    );
    event ContractRemoved(address indexed host, address indexed client);
    event ChallengeRotated(
        address indexed host, address indexed client, uint256 challengeIndex, uint256 challengeBlock
    );
    event ProofCommitted(
        address indexed host, address indexed client, uint256 challengeIndex, bytes32 fileRoot, uint256 chunkInFileIndex
    );
    event Deposited(address indexed client, uint256 baseAmount, uint256 attoAmount);
    event Withdrawn(address indexed client, uint256 baseAmount);
    event EarningsClaimed(address indexed host, address indexed client, uint256 baseAmount);

    constructor(IERC20 usdc) {
        USDC = usdc;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes("Jindo")), keccak256(bytes("1")), block.chainid, address(this))
        );
    }

    function key(address host, address client) public pure returns (bytes32 result) {
        // intentional inline asm: cheap 40-byte (host||client) keccak key derivation.
        // slither-disable-next-line assembly
        assembly {
            // Layout 40 bytes: host (20) || client (20) at memory[0..40), then hash.
            mstore(0x00, shl(96, host))
            mstore(0x14, shl(96, client))
            result := keccak256(0x00, 0x28)
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Payment functions
    // ─────────────────────────────────────────────────────────────────────────────

    /// Client pulls USDC into the contract; balance is held in atto units.
    function deposit(uint256 baseAmount) external {
        uint256 attoAmount = baseAmount * ATTO_PER_BASE;
        balance[msg.sender] += uint128(attoAmount);
        emit Deposited(msg.sender, baseAmount, attoAmount);
        if (!USDC.transferFrom(msg.sender, address(this), baseAmount)) revert TransferFailed();
    }

    /// Client pulls unspent funds from their pool. The pool must keep at least
    /// 30 days of fees for the client's current total stored bytes — otherwise
    /// a client could fund a pair, withdraw the next block, and starve every
    /// host they're committed to. Atto dust below 1 base unit stays.
    function withdraw(uint256 baseAmount) external {
        uint256 attoAmount = baseAmount * ATTO_PER_BASE;
        uint128 bal = balance[msg.sender];
        if (attoAmount > _withdrawable(bal, msg.sender)) revert InsufficientBalance();
        balance[msg.sender] = bal - uint128(attoAmount);
        emit Withdrawn(msg.sender, baseAmount);
        if (!USDC.transfer(msg.sender, baseAmount)) revert TransferFailed();
    }

    /// Charge the client one day of storage and credit it to the host's
    /// accrued balance. Pure bookkeeping — no USDC transfer happens here. The
    /// host pulls whole base units out via claimEarnings() on their own schedule.
    function _payProof(Contract storage c) private {
        uint256 dailyFeeAtto = uint256(c.size) * uint256(RATE_BYTE_DAY);
        uint128 pool = balance[c.client];
        if (dailyFeeAtto > pool) dailyFeeAtto = pool;
        if (dailyFeeAtto == 0) return;
        balance[c.client] = pool - uint128(dailyFeeAtto);
        c.accrued += uint128(dailyFeeAtto);
    }

    /// Host pulls accrued earnings from one pair. Floor-divides atto to base;
    /// sub-base-unit dust stays on `accrued` for the next claim.
    function claimEarnings(address client) external {
        bytes32 k = key(msg.sender, client);
        Contract storage c = contracts[k];
        if (c.host != msg.sender) revert NotAuthorized();

        uint256 baseAmount = uint256(c.accrued) / ATTO_PER_BASE;
        if (baseAmount == 0) return;
        // intentional: floor-divide atto → base units, scrub the floored portion,
        // leave sub-base-unit dust for the next claim.
        // slither-disable-next-line divide-before-multiply
        c.accrued -= uint128(baseAmount * ATTO_PER_BASE);
        emit EarningsClaimed(msg.sender, client, baseAmount);
        if (!USDC.transfer(msg.sender, baseAmount)) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────────────────────────
    //  Storage commitments
    // ─────────────────────────────────────────────────────────────────────────────

    /// Add 1+ files to a pair in a single transaction with a single client
    /// signature. The client signs over the full bytes32[] batch (per EIP-712
    /// dynamic-array hashing); we recompute the same digest on chain.
    function commitUpload(
        address client,
        bytes32[] calldata fileRoots,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint64 newSize,
        bytes calldata signature
    ) external {
        if (fileRoots.length == 0) revert NoData();
        // EIP-712 array hashing: bytes32[] hashes to keccak256(packed elements).
        bytes32 fileRootsHash = keccak256(abi.encodePacked(fileRoots));
        _verifyAndCommit(UPLOAD_TYPEHASH, client, fileRootsHash, priorRoot, newRoot, newSize, signature);
    }

    function commitDelete(
        address client,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint64 newSize,
        bytes calldata signature
    ) external {
        _verifyAndCommit(DELETE_TYPEHASH, client, fileRoot, priorRoot, newRoot, newSize, signature);
    }

    /// Host ends the storage relationship. Flushes any whole-base-unit dust the
    /// host has built up across prior proofs but does NOT charge the client for
    /// the days since the last proof — those are forfeit (same rule as missed
    /// proofs). Sub-base-unit dust on `accrued` is dropped when the pair is
    /// deleted; the client keeps whatever is left in their global pool.
    function remove(address client) external {
        bytes32 k = key(msg.sender, client);
        Contract storage c = contracts[k];
        if (c.host != msg.sender) revert NotAuthorized();

        // Cache the values we need post-delete, then perform every state
        // mutation (delete + index removal) BEFORE the external call. This is
        // checks-effects-interactions: a hostile USDC token can't reenter into
        // claimEarnings/commitProof/etc. and exploit a half-deleted pair.
        uint256 hostPayout = uint256(c.accrued) / ATTO_PER_BASE;
        address payHost = c.host;

        _removeFrom(hostsOfClient[client], msg.sender);
        delete contracts[k];
        emit ContractRemoved(msg.sender, client);

        if (hostPayout > 0) {
            emit EarningsClaimed(payHost, client, hostPayout);
            if (!USDC.transfer(payHost, hostPayout)) revert TransferFailed();
        }
    }

    /// @notice Host commits a data-availability proof for the current challenge.
    /// @dev On success, settles accrual and rotates the challenge. The proof
    /// guards are deliberately inlined here for gas and auditability, which
    /// pushes cyclomatic complexity past Slither's default threshold.
    // slither-disable-next-line cyclomatic-complexity
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
        if (c.host != msg.sender) revert NotAuthorized();
        uint256 cSize = c.size;
        if (cSize == 0) revert NoData();

        uint64 challengeIdx = c.challengeIndex;
        uint256 challengeByte = uint256(challengeIdx) * CHUNK_SIZE;
        uint256 fileEnd = cumulativeBytesBefore + fileSize;
        if (fileEnd > cSize) revert FileOverflow();
        if (cumulativeBytesBefore > challengeByte) revert ChallengeBeforeFile();
        if (challengeByte >= fileEnd) revert ChallengeAfterFile();
        if (chunkInFileIndex != (challengeByte - cumulativeBytesBefore) / CHUNK_SIZE) revert WrongChunkIndex();

        // The chunk at the last index of a file may be shorter than CHUNK_SIZE.
        uint256 expectedLen;
        uint256 chunkStartInFile = chunkInFileIndex * CHUNK_SIZE;
        if (chunkStartInFile + CHUNK_SIZE > fileSize) {
            expectedLen = fileSize - chunkStartInFile;
        } else {
            expectedLen = CHUNK_SIZE;
        }
        if (chunkBytes.length != expectedLen) revert WrongChunkLength();

        // Outer-tree leaf binds (cumulativeBytesBefore, fileSize, fileRoot).
        bytes32 outerLeaf = keccak256(abi.encode(cumulativeBytesBefore, fileSize, fileRoot));
        if (!_verifyMerkleProof(outerProof, c.root, outerLeaf)) revert BadOuterProof();

        // File-tree leaf binds (chunkInFileIndex, chunkBytes).
        bytes32 fileLeafHash = keccak256(abi.encode(chunkInFileIndex, chunkBytes));
        if (!_verifyMerkleProof(fileProof, fileRoot, fileLeafHash)) revert BadFileProof();

        // UTC-day cooldown: at most one paid proof per calendar day. A host
        // that misses a UTC day forfeits that day's revenue. Unix timestamps
        // are seconds since 1970-01-01 00:00:00 UTC, so floor-dividing by
        // SECONDS_PER_DAY gives the UTC day number — same number means the
        // last proof landed somewhere in today's window. The strict equality
        // on a derived UTC-day index is the cooldown's whole semantic.
        // slither-disable-next-line incorrect-equality,timestamp
        if (uint256(c.lastProof) / SECONDS_PER_DAY == block.timestamp / SECONDS_PER_DAY) {
            revert CooldownActive();
        }
        c.lastProof = uint64(block.timestamp);
        _payProof(c);

        emit ProofCommitted(msg.sender, client, challengeIdx, fileRoot, chunkInFileIndex);
        _rotateChallenge(k, c, msg.sender, client, uint64(cSize));
    }

    function _verifyAndCommit(
        bytes32 typeHash,
        address client,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint64 newSize,
        bytes calldata signature
    ) private {
        bytes32 structHash = keccak256(abi.encode(typeHash, msg.sender, client, fileRoot, priorRoot, newRoot, newSize));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (_recover(digest, signature) != client) revert BadSignature();

        bytes32 k = key(msg.sender, client);
        Contract storage c = contracts[k];
        if (c.host == address(0)) {
            if (priorRoot != bytes32(0)) revert PriorRootRequiredZero();
            c.host = msg.sender;
            c.client = client;
            c.root = newRoot;
            c.size = newSize;

            hostsOfClient[client].push(msg.sender);

            emit ContractCreated(msg.sender, client, newRoot, newSize);
        } else {
            if (c.root != priorRoot) revert PriorRootMismatch();
            // No accrual to settle — payment is per-proof and uploads/deletes
            // don't charge anything. Mid-day size changes apply on the next proof.
            bytes32 oldRoot = c.root;
            c.root = newRoot;
            c.size = newSize;
            emit ContractUpdated(msg.sender, client, oldRoot, newRoot, newSize);
        }
        _rotateChallenge(k, c, msg.sender, client, newSize);
    }

    function _rotateChallenge(bytes32 k, Contract storage c, address host, address client, uint64 size) private {
        if (size == 0) {
            c.challengeIndex = 0;
            return;
        }
        uint256 totalChunks;
        unchecked {
            totalChunks = (uint256(size) + CHUNK_SIZE - 1) / CHUNK_SIZE;
        }
        bytes32 prevHash = blockhash(block.number - 1);
        // intentional weak prng: prevHash + k + root only needs to be
        // unpredictable to the host, not cryptographically strong. The worst
        // a block proposer can do is influence one challenge by one block;
        // they still can't pick a chunk they don't store.
        uint256 seed = uint256(keccak256(abi.encodePacked(prevHash, k, c.root)));
        // slither-disable-next-line weak-prng
        uint64 newIndex = uint64(seed % totalChunks);
        c.challengeIndex = newIndex;
        emit ChallengeRotated(host, client, newIndex, block.number);
    }

    function _verifyMerkleProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) private pure returns (bool) {
        bytes32 computed = leaf;
        uint256 len = proof.length;
        for (uint256 i; i < len;) {
            bytes32 sib = proof[i];
            // intentional inline asm: sorted-pair keccak, the hot loop of proof verification.
            // slither-disable-next-line assembly
            assembly {
                switch lt(computed, sib)
                case 1 {
                    mstore(0x00, computed)
                    mstore(0x20, sib)
                }
                default {
                    mstore(0x00, sib)
                    mstore(0x20, computed)
                }
                computed := keccak256(0x00, 0x40)
            }
            unchecked {
                ++i;
            }
        }
        return computed == root;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        // intentional inline asm: split the 65-byte signature into r/s/v without abi.decode.
        // slither-disable-next-line assembly
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

    function _removeFrom(address[] storage arr, address value) private {
        uint256 len = arr.length;
        for (uint256 i; i < len;) {
            if (arr[i] == value) {
                uint256 lastIdx = len - 1;
                if (i != lastIdx) arr[i] = arr[lastIdx];
                arr.pop();
                return;
            }
            unchecked {
                ++i;
            }
        }
    }
}
