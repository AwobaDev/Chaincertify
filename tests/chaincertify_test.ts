
import { Clarinet, Tx, Chain, Account, types } from 'https://deno.land/x/clarinet@v0.14.0/index.ts';
import { assertEquals } from 'https://deno.land/std@0.90.0/testing/asserts.ts';

// Test constants
const CONTRACT_NAME = "chaincertify";
const ERR_NOT_AUTHORIZED = types.uint(100);
const ERR_ALREADY_EXISTS = types.uint(101);
const ERR_NOT_FOUND = types.uint(102);
const ERR_INVALID_INSTITUTION = types.uint(103);
const ERR_CERTIFICATE_REVOKED = types.uint(104);

// Helper functions
function getTestCertificateHash(): Uint8Array {
    return new Uint8Array(32).fill(1);
}

function getTestCertificateData() {
    return {
        degree: "Bachelor of Science",
        field: "Computer Science",
        graduationDate: types.uint(2024),
        metadataUri: types.some(types.ascii("https://university.edu/cert/123"))
    };
}

// ============================================================================
// FOUNDATION TESTS - CORE FUNCTIONALITY
// ============================================================================

Clarinet.test({
    name: "Contract initialization - verify initial state",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        
        // Check initial certificate counter
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-total-certificates",
            [],
            deployer.address
        );
        call.result.expectUint(0);
        
        // Check contract version
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-contract-version",
            [],
            deployer.address
        );
        call.result.expectAscii("1.0.0");
        
        // Check contract analytics
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-contract-analytics",
            [],
            deployer.address
        );
        
        const analytics = call.result.expectTuple() as any;
        analytics["total-certificates"].expectUint(0);
        analytics["total-institutions"].expectUint(0);
        analytics["total-verified"].expectUint(0);
        analytics["total-revoked"].expectUint(0);
        analytics["total-templates"].expectUint(0);
    },
});

Clarinet.test({
    name: "Institution registration - successful registration by contract owner",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Harvard University"),
                    types.ascii("HARVARD-001")
                ],
                deployer.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Verify institution was registered
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-institution-info",
            [types.principal(university.address)],
            deployer.address
        );
        
        const institutionInfo = call.result.expectSome().expectTuple() as any;
        institutionInfo["name"].expectAscii("Harvard University");
        institutionInfo["accreditation-id"].expectAscii("HARVARD-001");
        institutionInfo["is-active"].expectBool(true);
        institutionInfo["registered-at"].expectUint(1);
    },
});

Clarinet.test({
    name: "Institution registration - failure when not contract owner",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const nonOwner = accounts.get("wallet_1")!;
        const university = accounts.get("wallet_2")!;
        
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("MIT"),
                    types.ascii("MIT-001")
                ],
                nonOwner.address
            )
        ]);
        
        block.receipts[0].result.expectErr().expectUint(100);
    },
});

Clarinet.test({
    name: "Institution registration - failure when institution already exists",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        
        // Register institution first time
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Stanford University"),
                    types.ascii("STANFORD-001")
                ],
                deployer.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Try to register same institution again
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Stanford University Duplicate"),
                    types.ascii("STANFORD-002")
                ],
                deployer.address
            )
        ]);
        
        block.receipts[0].result.expectErr().expectUint(101);
    },
});

Clarinet.test({
    name: "Institution deactivation - successful deactivation by contract owner",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        
        // Register institution first
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("CalTech"),
                    types.ascii("CALTECH-001")
                ],
                deployer.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Deactivate institution
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "deactivate-institution",
                [types.principal(university.address)],
                deployer.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Verify institution is deactivated
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-institution-info",
            [types.principal(university.address)],
            deployer.address
        );
        
        const institutionInfo = call.result.expectSome().expectTuple() as any;
        institutionInfo["is-active"].expectBool(false);
    },
});

Clarinet.test({
    name: "Certificate issuance - successful issuance by authorized institution",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student = accounts.get("wallet_2")!;
        
        // Register institution
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Yale University"),
                    types.ascii("YALE-001")
                ],
                deployer.address
            )
        ]);
        
        const certData = getTestCertificateData();
        
        // Issue certificate
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(getTestCertificateHash()),
                    types.ascii(certData.degree),
                    types.ascii(certData.field),
                    certData.graduationDate,
                    certData.metadataUri
                ],
                university.address
            )
        ]);
        
        const certificateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Verify certificate was created
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const certificate = call.result.expectSome().expectTuple() as any;
        certificate["student-address"].expectPrincipal(student.address);
        certificate["institution"].expectPrincipal(university.address);
        certificate["degree-type"].expectAscii(certData.degree);
        certificate["field-of-study"].expectAscii(certData.field);
        certificate["graduation-date"].expectUint(2024);
        certificate["is-revoked"].expectBool(false);
        
        // Check total certificates counter
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-total-certificates",
            [],
            deployer.address
        );
        call.result.expectUint(1);
    },
});

Clarinet.test({
    name: "Certificate issuance - failure by unauthorized institution",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const unauthorizedInstitution = accounts.get("wallet_1")!;
        const student = accounts.get("wallet_2")!;
        
        const certData = getTestCertificateData();
        
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(getTestCertificateHash()),
                    types.ascii(certData.degree),
                    types.ascii(certData.field),
                    certData.graduationDate,
                    certData.metadataUri
                ],
                unauthorizedInstitution.address
            )
        ]);
        
        block.receipts[0].result.expectErr().expectUint(103);
    },
});

Clarinet.test({
    name: "Certificate verification - successful verification of valid certificate",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student = accounts.get("wallet_2")!;
        
        // Setup: Register institution and issue certificate
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Princeton University"),
                    types.ascii("PRINCETON-001")
                ],
                deployer.address
            )
        ]);
        
        const certData = getTestCertificateData();
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(getTestCertificateHash()),
                    types.ascii(certData.degree),
                    types.ascii(certData.field),
                    certData.graduationDate,
                    certData.metadataUri
                ],
                university.address
            )
        ]);
        
        const certificateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Verify certificate
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const verification = call.result.expectOk().expectTuple() as any;
        verification["is-valid"].expectBool(true);
        
        const certificate = verification["certificate"].expectTuple() as any;
        certificate["is-revoked"].expectBool(false);
        
        const institutionInfo = verification["institution-info"].expectSome().expectTuple() as any;
        institutionInfo["name"].expectAscii("Princeton University");
        institutionInfo["is-active"].expectBool(true);
    },
});
