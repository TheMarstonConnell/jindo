// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {Jindo, IERC20} from "../src/Jindo.sol";

/// Minimal ERC20 mock used to simulate USDC in tests. 6 decimals like real USDC.
contract MockUSDC is IERC20 {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public _balances;
    mapping(address => mapping(address => uint256)) public allowance;

    function balanceOf(address a) external view returns (uint256) {
        return _balances[a];
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(_balances[msg.sender] >= amount, "insufficient");
        _balances[msg.sender] -= amount;
        _balances[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(_balances[from] >= amount, "insufficient");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "no allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _balances[from] -= amount;
        _balances[to] += amount;
        return true;
    }
}

contract JindoTest is Test {
    Jindo jindo;
    MockUSDC usdc;

    uint256 constant CLIENT_PK = 0xA11CE;
    uint256 constant OTHER_PK = 0xB0B;

    address host;
    address otherHost;
    address client;
    address otherClient;

    bytes32 constant ROOT_1 = bytes32(uint256(0xAA));
    bytes32 constant ROOT_2 = bytes32(uint256(0xBB));
    bytes32 constant FILE_ROOT_1 = bytes32(uint256(0x111));
    bytes32 constant FILE_ROOT_2 = bytes32(uint256(0x222));

    bytes32 constant UPLOAD_TYPEHASH = keccak256(
        "Upload(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint64 newSize)"
    );
    bytes32 constant DELETE_TYPEHASH = keccak256(
        "Delete(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint64 newSize)"
    );

    function setUp() public {
        usdc = new MockUSDC();
        jindo = new Jindo(IERC20(address(usdc)));
        host = address(0xA1);
        otherHost = address(0xA2);
        client = vm.addr(CLIENT_PK);
        otherClient = address(0xB2);
    }

    function _read(address h, address c) internal view returns (Jindo.Contract memory) {
        (address rh, uint64 size, address rc, uint64 challengeIndex, bytes32 root, uint64 lastProof, uint128 accrued) =
            jindo.contracts(jindo.key(h, c));
        return Jindo.Contract({
            host: rh,
            size: size,
            client: rc,
            challengeIndex: challengeIndex,
            root: root,
            lastProof: lastProof,
            accrued: accrued
        });
    }

    function _digest(
        bytes32 typeHash,
        address h,
        address c,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint256 newSize
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(typeHash, h, c, fileRoot, priorRoot, newRoot, newSize));
        return keccak256(abi.encodePacked("\x19\x01", jindo.DOMAIN_SEPARATOR(), structHash));
    }

    function _signWith(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signUpload(
        uint256 pk,
        address h,
        address c,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint256 newSize
    ) internal view returns (bytes memory) {
        return _signWith(pk, _digest(UPLOAD_TYPEHASH, h, c, fileRoot, priorRoot, newRoot, newSize));
    }

    function _signDelete(
        uint256 pk,
        address h,
        address c,
        bytes32 fileRoot,
        bytes32 priorRoot,
        bytes32 newRoot,
        uint256 newSize
    ) internal view returns (bytes memory) {
        return _signWith(pk, _digest(DELETE_TYPEHASH, h, c, fileRoot, priorRoot, newRoot, newSize));
    }

    function test_commitUpload_firstCallCreatesContract() public {
        bytes memory sig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig);

        Jindo.Contract memory c = _read(host, client);
        assertEq(c.host, host);
        assertEq(c.client, client);
        assertEq(c.root, ROOT_1);
        assertEq(c.size, 100);
        assertEq(jindo.hostsOfClient(client, 0), host);
    }

    function test_commitUpload_subsequentCallUpdates() public {
        bytes memory sig1 = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig1);

        bytes memory sig2 = _signUpload(CLIENT_PK, host, client, FILE_ROOT_2, ROOT_1, ROOT_2, 250);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_2, ROOT_1, ROOT_2, 250, sig2);

        Jindo.Contract memory c = _read(host, client);
        assertEq(c.root, ROOT_2);
        assertEq(c.size, 250);
    }

    function test_commitUpload_revertsOnPriorRootMismatch() public {
        bytes memory sig1 = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig1);

        // signed with the wrong priorRoot
        bytes memory sig2 = _signUpload(CLIENT_PK, host, client, FILE_ROOT_2, ROOT_2, ROOT_1, 250);
        vm.prank(host);
        vm.expectRevert(Jindo.PriorRootMismatch.selector);
        jindo.commitUpload(client, FILE_ROOT_2, ROOT_2, ROOT_1, 250, sig2);
    }

    function test_commitUpload_revertsIfFirstCallHasNonZeroPriorRoot() public {
        bytes memory sig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, ROOT_1, ROOT_2, 100);
        vm.prank(host);
        vm.expectRevert(Jindo.PriorRootRequiredZero.selector);
        jindo.commitUpload(client, FILE_ROOT_1, ROOT_1, ROOT_2, 100, sig);
    }

    function test_commitUpload_revertsOnSignatureFromWrongKey() public {
        bytes memory sig = _signUpload(OTHER_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        vm.expectRevert(Jindo.BadSignature.selector);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig);
    }

    function test_commitUpload_revertsIfTamperedAfterSigning() public {
        bytes memory sig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        // host inflates the size in the call
        vm.prank(host);
        vm.expectRevert(Jindo.BadSignature.selector);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 999, sig);
    }

    function test_commitUpload_revertsIfHostUsesOtherHostsHostField() public {
        // Sig was issued for `host`, but `otherHost` tries to use it
        bytes memory sig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(otherHost);
        vm.expectRevert(Jindo.BadSignature.selector);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig);
    }

    function test_commitUpload_rejectsDeleteSignature() public {
        // Delete-typed signature should not pass commitUpload (different type hash)
        bytes memory sig = _signDelete(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        vm.expectRevert(Jindo.BadSignature.selector);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig);
    }

    function test_commitDelete_works() public {
        // create first
        bytes memory upSig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, upSig);

        // delete with a Delete-typed signature
        bytes memory delSig = _signDelete(CLIENT_PK, host, client, FILE_ROOT_1, ROOT_1, bytes32(0), 0);
        vm.prank(host);
        jindo.commitDelete(client, FILE_ROOT_1, ROOT_1, bytes32(0), 0, delSig);

        Jindo.Contract memory c = _read(host, client);
        assertEq(c.root, bytes32(0));
        assertEq(c.size, 0);
    }

    function test_commitDelete_rejectsUploadSignature() public {
        bytes memory upSig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, upSig);

        bytes memory wrongSig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, ROOT_1, bytes32(0), 0);
        vm.prank(host);
        vm.expectRevert(Jindo.BadSignature.selector);
        jindo.commitDelete(client, FILE_ROOT_1, ROOT_1, bytes32(0), 0, wrongSig);
    }

    function test_remove_clearsContract() public {
        bytes memory sig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig);

        vm.prank(host);
        jindo.remove(client);

        Jindo.Contract memory c = _read(host, client);
        assertEq(c.host, address(0));
        assertEq(c.size, 0);
    }

    function test_remove_revertsIfNotHost() public {
        bytes memory sig = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig);

        vm.prank(otherHost);
        vm.expectRevert(Jindo.NotAuthorized.selector);
        jindo.remove(client);
    }

    function test_remove_swapAndPopKeepsIndexesConsistent() public {
        // One client with two hosts; first host removes → second host should
        // move into slot 0 of hostsOfClient, length goes 2 → 1.
        bytes memory sigA = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sigA);

        bytes memory sigB = _signUpload(CLIENT_PK, otherHost, client, FILE_ROOT_2, bytes32(0), ROOT_2, 200);
        vm.prank(otherHost);
        jindo.commitUpload(client, FILE_ROOT_2, bytes32(0), ROOT_2, 200, sigB);

        vm.prank(host);
        jindo.remove(client);

        assertEq(jindo.hostsOfClient(client, 0), otherHost);
        vm.expectRevert();
        jindo.hostsOfClient(client, 1);
    }

    function test_clientCanHaveMultipleHosts() public {
        bytes memory sig1 = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sig1);

        bytes memory sig2 = _signUpload(CLIENT_PK, otherHost, client, FILE_ROOT_2, bytes32(0), ROOT_2, 200);
        vm.prank(otherHost);
        jindo.commitUpload(client, FILE_ROOT_2, bytes32(0), ROOT_2, 200, sig2);

        Jindo.Contract memory a = _read(host, client);
        Jindo.Contract memory b = _read(otherHost, client);
        assertEq(a.root, ROOT_1);
        assertEq(b.root, ROOT_2);
    }

    // ── proof tests ────────────────────────────────────────────────────────────

    function _commutativeHash(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function test_commitProof_twoChunkSingleFileHappyPath() public {
        // 2 KiB single file → 2 chunks, single-file outer tree.
        bytes memory chunk0 = new bytes(1024);
        bytes memory chunk1 = new bytes(1024);
        for (uint256 i = 0; i < 1024; i++) {
            chunk0[i] = bytes1(uint8(i & 0xFF));
            chunk1[i] = bytes1(uint8((i + 7) & 0xFF));
        }

        bytes32 leaf0 = keccak256(abi.encode(uint256(0), chunk0));
        bytes32 leaf1 = keccak256(abi.encode(uint256(1), chunk1));
        bytes32 fr = _commutativeHash(leaf0, leaf1);

        // Single-file outer tree: root == single leaf == keccak256(abi.encode(0, fileSize, fileRoot))
        bytes32 outerRoot = keccak256(abi.encode(uint256(0), uint256(2048), fr));

        bytes memory upSig = _signUpload(CLIENT_PK, host, client, fr, bytes32(0), outerRoot, 2048);
        vm.prank(host);
        jindo.commitUpload(client, fr, bytes32(0), outerRoot, 2048, upSig);

        Jindo.Contract memory c = _read(host, client);
        assertTrue(c.challengeIndex < 2);

        bytes memory targetChunk;
        bytes32 sibling;
        if (c.challengeIndex == 0) {
            targetChunk = chunk0;
            sibling = leaf1;
        } else {
            targetChunk = chunk1;
            sibling = leaf0;
        }

        bytes32[] memory fileProof = new bytes32[](1);
        fileProof[0] = sibling;
        bytes32[] memory outerProof = new bytes32[](0);

        // Roll forward so blockhash(prev) is well-defined and rotation has fresh entropy.
        // Also skip past the 1-day cooldown that began on commitUpload.
        skip(1 days);
        vm.roll(block.number + 1);

        vm.prank(host);
        jindo.commitProof(client, 0, 2048, fr, c.challengeIndex, targetChunk, outerProof, fileProof);

        // After commitProof the challenge is rotated again — verifying it didn't revert is sufficient.
    }

    function test_commitProof_revertsIfNoData() public {
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(host);
        vm.expectRevert(Jindo.NotAuthorized.selector);
        jindo.commitProof(client, 0, 0, bytes32(0), 0, "", empty, empty);
    }

    function test_commitProof_revertsOnBadOuterProof() public {
        bytes memory chunk = new bytes(1024);
        bytes32 fr = keccak256(abi.encode(uint256(0), chunk));
        bytes32 outerRoot = keccak256(abi.encode(uint256(0), uint256(1024), fr));

        bytes memory upSig = _signUpload(CLIENT_PK, host, client, fr, bytes32(0), outerRoot, 1024);
        vm.prank(host);
        jindo.commitUpload(client, fr, bytes32(0), outerRoot, 1024, upSig);

        // Tamper: claim a different fileRoot which can't appear in the (single-leaf) outer tree.
        bytes32 fakeFr = keccak256("totally fake");
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(host);
        vm.expectRevert(Jindo.BadOuterProof.selector);
        jindo.commitProof(client, 0, 1024, fakeFr, 0, chunk, empty, empty);
    }

    function test_commitProof_revertsOnBadFileProof() public {
        bytes memory chunk = new bytes(1024);
        bytes32 fr = keccak256(abi.encode(uint256(0), chunk));
        bytes32 outerRoot = keccak256(abi.encode(uint256(0), uint256(1024), fr));

        bytes memory upSig = _signUpload(CLIENT_PK, host, client, fr, bytes32(0), outerRoot, 1024);
        vm.prank(host);
        jindo.commitUpload(client, fr, bytes32(0), outerRoot, 1024, upSig);

        bytes memory tampered = new bytes(1024);
        tampered[0] = 0x01; // any single byte difference
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(host);
        vm.expectRevert(Jindo.BadFileProof.selector);
        jindo.commitProof(client, 0, 1024, fr, 0, tampered, empty, empty);
    }

    function test_commitProof_revertsOnWrongChunkLength() public {
        bytes memory chunk = new bytes(1024);
        bytes32 fr = keccak256(abi.encode(uint256(0), chunk));
        bytes32 outerRoot = keccak256(abi.encode(uint256(0), uint256(1024), fr));

        bytes memory upSig = _signUpload(CLIENT_PK, host, client, fr, bytes32(0), outerRoot, 1024);
        vm.prank(host);
        jindo.commitUpload(client, fr, bytes32(0), outerRoot, 1024, upSig);

        bytes memory shortChunk = new bytes(512);
        bytes32[] memory empty = new bytes32[](0);
        vm.prank(host);
        vm.expectRevert(Jindo.WrongChunkLength.selector);
        jindo.commitProof(client, 0, 1024, fr, 0, shortChunk, empty, empty);
    }

    function test_commitProof_revertsIfFileOverflowsTotal() public {
        bytes memory chunk = new bytes(1024);
        bytes32 fr = keccak256(abi.encode(uint256(0), chunk));
        bytes32 outerRoot = keccak256(abi.encode(uint256(0), uint256(1024), fr));

        bytes memory upSig = _signUpload(CLIENT_PK, host, client, fr, bytes32(0), outerRoot, 1024);
        vm.prank(host);
        jindo.commitUpload(client, fr, bytes32(0), outerRoot, 1024, upSig);

        bytes32[] memory empty = new bytes32[](0);
        vm.prank(host);
        vm.expectRevert(Jindo.FileOverflow.selector);
        // claim fileSize=2048 > c.size=1024
        jindo.commitProof(client, 0, 2048, fr, 0, chunk, empty, empty);
    }

    // ── payment tests ──────────────────────────────────────────────────────────

    /// Helper: fund `who` with USDC and approve the Jindo contract to pull `amount`.
    function _fundAndApprove(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(jindo), amount);
    }

    /// Sign+commit an upload of `size` bytes against an empty prior root. Used
    /// by the reserve tests where we just need a sized commitment on record
    /// and never drive a proof against it.
    function _commitSizedUpload(uint256 pk, address h, address c, bytes32 fileRoot, bytes32 newRoot, uint64 size)
        internal
    {
        bytes memory sig = _signUpload(pk, h, c, fileRoot, bytes32(0), newRoot, size);
        vm.prank(h);
        jindo.commitUpload(c, fileRoot, bytes32(0), newRoot, size, sig);
    }

    function test_deposit_increasesBalanceInAtto() public {
        _fundAndApprove(client, 1_000_000); // $1.00 USDC base units
        vm.prank(client);
        jindo.deposit(1_000_000);

        // 1 base unit = 1e12 atto
        assertEq(jindo.balance(client), uint128(1_000_000) * 1e12);
        assertEq(usdc.balanceOf(address(jindo)), 1_000_000);
        assertEq(usdc.balanceOf(client), 0);
    }

    function test_withdraw_returnsBaseUnits() public {
        _fundAndApprove(client, 1_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000);

        vm.prank(client);
        jindo.withdraw(400_000);

        assertEq(jindo.balance(client), uint128(600_000) * 1e12);
        assertEq(usdc.balanceOf(client), 400_000);
    }

    function test_withdraw_revertsIfInsufficient() public {
        _fundAndApprove(client, 1_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000);

        vm.prank(client);
        vm.expectRevert(Jindo.InsufficientBalance.selector);
        jindo.withdraw(2_000_000);
    }

    function test_withdraw_blockedBy30DayReserve() public {
        _fundAndApprove(client, 100_000); // $0.10
        vm.prank(client);
        jindo.deposit(100_000);

        // 1 GiB commitment → reserve ≈ 23,008 base units (~$0.023/mo) is a
        // meaningful chunk of the deposit, so the boundary is observable.
        uint64 size = uint64(1 << 30);
        _commitSizedUpload(CLIENT_PK, host, client, FILE_ROOT_1, ROOT_1, size);

        uint256 reserveAtto = uint256(size) * uint256(jindo.RATE_BYTE_DAY()) * 30;
        uint256 bal = uint256(jindo.balance(client));
        // Largest base-unit withdrawal that still leaves the reserve covered.
        uint256 maxSafeBase = (bal - reserveAtto) / 1e12;

        vm.prank(client);
        vm.expectRevert(Jindo.InsufficientBalance.selector);
        jindo.withdraw(maxSafeBase + 1);

        // At the limit it goes through.
        vm.prank(client);
        jindo.withdraw(maxSafeBase);
    }

    function test_withdraw_reserveSumsAcrossHosts() public {
        _fundAndApprove(client, 50_000);
        vm.prank(client);
        jindo.deposit(50_000);

        // Two hosts, each storing 1 GiB. The reserve should reflect both.
        uint64 size = uint64(1 << 30);
        _commitSizedUpload(CLIENT_PK, host, client, FILE_ROOT_1, ROOT_1, size);
        _commitSizedUpload(CLIENT_PK, otherHost, client, FILE_ROOT_2, ROOT_2, size);
        assertEq(uint256(jindo.getSizeOfClient(client)), uint256(size) * 2);

        uint256 reserveAtto = uint256(size) * 2 * uint256(jindo.RATE_BYTE_DAY()) * 30;
        uint256 bal = uint256(jindo.balance(client));
        uint256 maxSafeBase = (bal - reserveAtto) / 1e12;

        // The single-host slack (~27k base) wouldn't revert here; the fact
        // that maxSafeBase + 1 reverts proves both hosts are summed in.
        vm.prank(client);
        vm.expectRevert(Jindo.InsufficientBalance.selector);
        jindo.withdraw(maxSafeBase + 1);

        vm.prank(client);
        jindo.withdraw(maxSafeBase);
    }

    function test_withdraw_unblockedAfterRemove() public {
        _fundAndApprove(client, 100_000);
        vm.prank(client);
        jindo.deposit(100_000);

        uint64 size = uint64(1 << 30);
        _commitSizedUpload(CLIENT_PK, host, client, FILE_ROOT_1, ROOT_1, size);

        // Reserved while the contract exists — full drain blocked.
        vm.prank(client);
        vm.expectRevert(Jindo.InsufficientBalance.selector);
        jindo.withdraw(100_000);

        vm.prank(host);
        jindo.remove(client);

        // Reserve drops to zero with no live contracts; the whole pool clears.
        vm.prank(client);
        jindo.withdraw(100_000);
        assertEq(jindo.balance(client), 0);
    }

    /// Set up a 2-chunk (2 KiB) contract with a valid signed upload, return chunks
    /// and the file/outer roots so callers can drive a real commitProof.
    function _setupTwoChunkContract()
        internal
        returns (bytes memory chunk0, bytes memory chunk1, bytes32 fr, bytes32 outerRoot)
    {
        chunk0 = new bytes(1024);
        chunk1 = new bytes(1024);
        for (uint256 i = 0; i < 1024; i++) {
            chunk0[i] = bytes1(uint8(i & 0xFF));
            chunk1[i] = bytes1(uint8((i + 7) & 0xFF));
        }
        bytes32 leaf0 = keccak256(abi.encode(uint256(0), chunk0));
        bytes32 leaf1 = keccak256(abi.encode(uint256(1), chunk1));
        fr = _commutativeHash(leaf0, leaf1);
        outerRoot = keccak256(abi.encode(uint256(0), uint256(2048), fr));

        bytes memory upSig = _signUpload(CLIENT_PK, host, client, fr, bytes32(0), outerRoot, 2048);
        vm.prank(host);
        jindo.commitUpload(client, fr, bytes32(0), outerRoot, 2048, upSig);
    }

    /// Run a real commitProof against a contract created by _setupTwoChunkContract.
    function _doProof(bytes memory chunk0, bytes memory chunk1, bytes32 fr) internal {
        Jindo.Contract memory c = _read(host, client);
        bytes32 leaf0 = keccak256(abi.encode(uint256(0), chunk0));
        bytes32 leaf1 = keccak256(abi.encode(uint256(1), chunk1));

        bytes memory targetChunk;
        bytes32 sibling;
        if (c.challengeIndex == 0) {
            targetChunk = chunk0;
            sibling = leaf1;
        } else {
            targetChunk = chunk1;
            sibling = leaf0;
        }
        bytes32[] memory fileProof = new bytes32[](1);
        fileProof[0] = sibling;
        bytes32[] memory outerProof = new bytes32[](0);

        vm.roll(block.number + 1);
        vm.prank(host);
        jindo.commitProof(client, 0, 2048, fr, c.challengeIndex, targetChunk, outerProof, fileProof);
    }

    function test_proof_chargesPoolAndCreditsAccrued_noTransferYet() public {
        _fundAndApprove(client, 1_000_000_000); // $1k worth of headroom
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();

        // Cooldown: lastProof was set on commitUpload, so we must wait 1 day.
        skip(1 days);
        uint128 balBefore = jindo.balance(client);
        _doProof(c0, c1, fr);

        uint256 dailyAtto = 2048 * uint256(jindo.RATE_BYTE_DAY());
        // Pure bookkeeping: nothing transferred yet.
        assertEq(usdc.balanceOf(host), 0);
        // Client was charged exactly one day at proof time.
        assertEq(uint256(balBefore - jindo.balance(client)), dailyAtto);
        Jindo.Contract memory cAfter = _read(host, client);
        // Entire daily fee sits on `accrued` (no auto-flush).
        assertEq(uint256(cAfter.accrued), dailyAtto);
        assertEq(cAfter.lastProof, uint64(block.timestamp));
    }

    function test_claimEarnings_paysOutWholeBaseUnits() public {
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        // Use a 2 GiB file so a single proof's daily fee crosses 1 base unit.
        // We can't use the chunk-based prover here without wiring up a real merkle
        // tree at that size, so synthesize accrued by stuffing it via repeated
        // 2 KiB proofs — uses the proof flow we already have.
        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();
        uint256 dailyAtto = 2048 * uint256(jindo.RATE_BYTE_DAY());
        uint256 proofsToFlush = (1e12 + dailyAtto - 1) / dailyAtto;

        for (uint256 i = 0; i < proofsToFlush; i++) {
            skip(1 days);
            _doProof(c0, c1, fr);
        }

        // Confirm dust crossed the threshold.
        Jindo.Contract memory cBefore = _read(host, client);
        assertGe(uint256(cBefore.accrued), 1e12);

        uint256 expectedBase = uint256(cBefore.accrued) / 1e12;
        vm.prank(host);
        jindo.claimEarnings(client);

        assertEq(usdc.balanceOf(host), expectedBase);
        Jindo.Contract memory cAfter = _read(host, client);
        // Dust below 1 base unit remains on accrued.
        assertEq(uint256(cAfter.accrued), uint256(cBefore.accrued) - expectedBase * 1e12);
    }

    function test_claimEarnings_revertsIfNotHost() public {
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);
        _setupTwoChunkContract();

        vm.prank(otherHost);
        vm.expectRevert(Jindo.NotAuthorized.selector);
        jindo.claimEarnings(client);
    }

    function test_claimEarnings_zeroDustIsNoop() public {
        // Without any proof, accrued = 0; claim is a no-op (no revert, no transfer).
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);
        _setupTwoChunkContract();

        vm.prank(host);
        jindo.claimEarnings(client);
        assertEq(usdc.balanceOf(host), 0);
    }

    function test_proof_revertsSameUtcDay() public {
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        // Pin time to a UTC midnight so the day-boundary math is unambiguous.
        // We then drive the test on a fixed timeline:
        //   T=0      midnight, upload (lastProof seeded to 0)
        //   T=1d     midnight next day, first proof
        //   T=1d+12h still in day 1 — second proof should revert
        //   T=2d     midnight next day, second proof should succeed
        // Pin the timeline to literal UTC midnights. Don't use
        // `uint256 day0 = block.timestamp;` as an anchor — under via_ir the
        // optimizer treats that as a live alias for block.timestamp and the
        // value drifts as we vm.warp around.
        uint256 dayBase = 2 days; // 172800: midnight starting "day 2" UTC
        vm.warp(dayBase);

        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();

        vm.warp(dayBase + 1 days);
        _doProof(c0, c1, fr);

        // 12 hours later — still the same UTC day as the proof. Must revert.
        vm.warp(dayBase + 1 days + 12 hours);
        bytes32[] memory fileProof = new bytes32[](1);
        bytes32[] memory outerProof = new bytes32[](0);
        Jindo.Contract memory c = _read(host, client);
        bytes32 leaf0 = keccak256(abi.encode(uint256(0), c0));
        bytes32 leaf1 = keccak256(abi.encode(uint256(1), c1));
        fileProof[0] = c.challengeIndex == 0 ? leaf1 : leaf0;
        bytes memory targetChunk = c.challengeIndex == 0 ? c0 : c1;

        vm.roll(block.number + 1);
        vm.prank(host);
        vm.expectRevert(Jindo.CooldownActive.selector);
        jindo.commitProof(client, 0, 2048, fr, c.challengeIndex, targetChunk, outerProof, fileProof);
    }

    function test_proof_succeedsOnNextUtcDay() public {
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        uint256 dayBase = 2 days;
        vm.warp(dayBase);

        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();

        vm.warp(dayBase + 1 days);
        _doProof(c0, c1, fr);

        // Move the clock to the start of the next UTC day. The cooldown
        // releases the moment we cross into a new floor(timestamp / 86400).
        vm.warp(dayBase + 2 days);
        _doProof(c0, c1, fr);

        // Two proofs landed → client charged for two days.
        Jindo.Contract memory c = _read(host, client);
        uint256 dailyAtto = 2048 * uint256(jindo.RATE_BYTE_DAY());
        assertEq(uint256(c.accrued), dailyAtto * 2);
    }

    function test_proof_missedDaysAreForfeit() public {
        // Host waits 5 days then proves once: should only be charged/paid 1 day.
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();
        uint128 balBefore = jindo.balance(client);

        skip(5 days);
        _doProof(c0, c1, fr);

        uint256 dailyAtto = 2048 * uint256(jindo.RATE_BYTE_DAY());
        // Client paid for exactly one day, not five.
        assertEq(uint256(balBefore - jindo.balance(client)), dailyAtto);
    }

    function test_proof_capsAtClientBalance() public {
        // 1 base-unit deposit = 1e12 atto. Each 2 KiB proof debits ~1.46e9 atto,
        // so it takes ~684 proofs to drain. Loop until empty and assert the cap.
        _fundAndApprove(client, 1);
        vm.prank(client);
        jindo.deposit(1);

        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();
        for (uint256 i = 0; i < 700; i++) {
            skip(1 days);
            _doProof(c0, c1, fr);
            if (jindo.balance(client) == 0) break;
        }

        assertEq(jindo.balance(client), 0);
        Jindo.Contract memory c = _read(host, client);
        // accrued cannot exceed the pool that funded it.
        assertEq(uint256(c.accrued), 1e12);

        vm.prank(host);
        jindo.claimEarnings(client);
        assertEq(usdc.balanceOf(host), 1);
    }

    function test_remove_flushesAccruedAndClears() public {
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        // Build up enough accrued to cross 1 base unit through repeated proofs.
        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();
        uint256 dailyAtto = 2048 * uint256(jindo.RATE_BYTE_DAY());
        uint256 proofsToFlush = (1e12 + dailyAtto - 1) / dailyAtto;
        for (uint256 i = 0; i < proofsToFlush; i++) {
            skip(1 days);
            _doProof(c0, c1, fr);
        }
        Jindo.Contract memory cBefore = _read(host, client);
        uint256 expectedBase = uint256(cBefore.accrued) / 1e12;
        assertGt(expectedBase, 0);

        vm.prank(host);
        jindo.remove(client);

        // Pair is gone; host received the whole-base-unit portion.
        assertEq(usdc.balanceOf(host), expectedBase);
        Jindo.Contract memory c = _read(host, client);
        assertEq(c.host, address(0));
    }

    function test_remove_dustOnlyForfeitsOnDelete() public {
        // After a single 2 KiB proof, accrued holds atto dust below 1 base unit.
        // remove() pays out 0 base units and zeroes accrued.
        _fundAndApprove(client, 1_000_000_000);
        vm.prank(client);
        jindo.deposit(1_000_000_000);

        (bytes memory c0, bytes memory c1, bytes32 fr,) = _setupTwoChunkContract();
        skip(1 days);
        _doProof(c0, c1, fr);

        uint256 hostBefore = usdc.balanceOf(host);
        vm.prank(host);
        jindo.remove(client);
        assertEq(usdc.balanceOf(host), hostBefore);
    }
}
