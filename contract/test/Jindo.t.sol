// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {Jindo} from "../src/Jindo.sol";

contract JindoTest is Test {
    Jindo jindo;

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
        "Upload(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint256 newSize)"
    );
    bytes32 constant DELETE_TYPEHASH = keccak256(
        "Delete(address host,address client,bytes32 fileRoot,bytes32 priorRoot,bytes32 newRoot,uint256 newSize)"
    );

    function setUp() public {
        jindo = new Jindo();
        host = address(0xA1);
        otherHost = address(0xA2);
        client = vm.addr(CLIENT_PK);
        otherClient = address(0xB2);
    }

    function _read(address h, address c) internal view returns (Jindo.Contract memory) {
        (
            address rh,
            uint64 size,
            address rc,
            uint64 challengeIndex,
            bytes32 root
        ) = jindo.contracts(jindo.key(h, c));
        return Jindo.Contract({
            host: rh,
            size: size,
            client: rc,
            challengeIndex: challengeIndex,
            root: root
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
        assertEq(jindo.clientsOfHost(host, 0), client);
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
        // host serves two clients
        bytes memory sigA = _signUpload(CLIENT_PK, host, client, FILE_ROOT_1, bytes32(0), ROOT_1, 100);
        vm.prank(host);
        jindo.commitUpload(client, FILE_ROOT_1, bytes32(0), ROOT_1, 100, sigA);

        // For the second client we don't have a controlled key, but we don't need a sig to be valid
        // — we only need the row in storage. Skip the second commit and use vm.store to fabricate?
        // Simpler: just create a second row by calling commitUpload with otherClient using a known key.
        uint256 otherClientPk = 0xC4FE;
        address oc = vm.addr(otherClientPk);
        bytes memory sigB = _signUpload(otherClientPk, host, oc, FILE_ROOT_2, bytes32(0), ROOT_2, 200);
        vm.prank(host);
        jindo.commitUpload(oc, FILE_ROOT_2, bytes32(0), ROOT_2, 200, sigB);

        vm.prank(host);
        jindo.remove(client);

        assertEq(jindo.clientsOfHost(host, 0), oc);
        vm.expectRevert();
        jindo.clientsOfHost(host, 1);
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

        // Roll forward so blockhash(prev) is well-defined and rotation has fresh entropy
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
}
