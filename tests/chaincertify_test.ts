
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

// ============================================================================
// CERTIFICATE MANAGEMENT & REVOCATION TESTS
// ============================================================================

Clarinet.test({
    name: "Certificate revocation - successful revocation by issuing institution",
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
                    types.ascii("Columbia University"),
                    types.ascii("COLUMBIA-001")
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
        
        // Revoke certificate
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "revoke-certificate",
                [types.uint(certificateId)],
                university.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Verify certificate is revoked
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const certificate = call.result.expectSome().expectTuple() as any;
        certificate["is-revoked"].expectBool(true);
        
        // Verify verification shows invalid
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const verification = call.result.expectOk().expectTuple() as any;
        verification["is-valid"].expectBool(false);
    },
});

Clarinet.test({
    name: "Certificate revocation - failure when not issuing institution",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const otherInstitution = accounts.get("wallet_2")!;
        const student = accounts.get("wallet_3")!;
        
        // Setup: Register institutions and issue certificate
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("NYU"),
                    types.ascii("NYU-001")
                ],
                deployer.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(otherInstitution.address),
                    types.ascii("UCLA"),
                    types.ascii("UCLA-001")
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
        
        // Try to revoke certificate from different institution
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "revoke-certificate",
                [types.uint(certificateId)],
                otherInstitution.address
            )
        ]);
        
        block.receipts[0].result.expectErr().expectUint(100);
    },
});

Clarinet.test({
    name: "Certificate hash verification - successful hash validation",
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
                    types.ascii("Berkeley"),
                    types.ascii("BERKELEY-001")
                ],
                deployer.address
            )
        ]);
        
        const certData = getTestCertificateData();
        const certHash = getTestCertificateHash();
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(certHash),
                    types.ascii(certData.degree),
                    types.ascii(certData.field),
                    certData.graduationDate,
                    certData.metadataUri
                ],
                university.address
            )
        ]);
        
        const certificateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Verify certificate hash
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate-hash",
            [types.uint(certificateId), types.buff(certHash)],
            deployer.address
        );
        
        const verification = call.result.expectOk().expectTuple() as any;
        verification["hash-matches"].expectBool(true);
        verification["is-revoked"].expectBool(false);
        verification["institution"].expectPrincipal(university.address);
    },
});

Clarinet.test({
    name: "Certificate hash verification - hash mismatch detection",
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
                    types.ascii("Cornell"),
                    types.ascii("CORNELL-001")
                ],
                deployer.address
            )
        ]);
        
        const certData = getTestCertificateData();
        const certHash = getTestCertificateHash();
        const wrongHash = new Uint8Array(32).fill(2); // Different hash
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(certHash),
                    types.ascii(certData.degree),
                    types.ascii(certData.field),
                    certData.graduationDate,
                    certData.metadataUri
                ],
                university.address
            )
        ]);
        
        const certificateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Verify certificate with wrong hash
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate-hash",
            [types.uint(certificateId), types.buff(wrongHash)],
            deployer.address
        );
        
        const verification = call.result.expectOk().expectTuple() as any;
        verification["hash-matches"].expectBool(false);
        verification["is-revoked"].expectBool(false);
        verification["institution"].expectPrincipal(university.address);
    },
});

Clarinet.test({
    name: "Student certificates tracking - multiple certificates per student",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student = accounts.get("wallet_2")!;
        
        // Setup: Register institution
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Georgetown"),
                    types.ascii("GEORGETOWN-001")
                ],
                deployer.address
            )
        ]);
        
        // Issue multiple certificates for same student
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(new Uint8Array(32).fill(1)),
                    types.ascii("Bachelor of Science"),
                    types.ascii("Computer Science"),
                    types.uint(2022),
                    types.some(types.ascii("https://georgetown.edu/cert/cs/123"))
                ],
                university.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student.address),
                    types.buff(new Uint8Array(32).fill(2)),
                    types.ascii("Master of Science"),
                    types.ascii("Data Science"),
                    types.uint(2024),
                    types.some(types.ascii("https://georgetown.edu/cert/ds/456"))
                ],
                university.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectUint(1);
        block.receipts[1].result.expectOk().expectUint(2);
        
        // Check student certificates
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-student-certificates",
            [types.principal(student.address)],
            deployer.address
        );
        
        const certificates = call.result.expectSome().expectList();
        assertEquals(certificates.length, 2);
        certificates[0].expectUint(1);
        certificates[1].expectUint(2);
    },
});

Clarinet.test({
    name: "Institution certificates tracking - multiple certificates per institution",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student1 = accounts.get("wallet_2")!;
        const student2 = accounts.get("wallet_3")!;
        
        // Setup: Register institution
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Dartmouth"),
                    types.ascii("DARTMOUTH-001")
                ],
                deployer.address
            )
        ]);
        
        // Issue certificates for different students
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student1.address),
                    types.buff(new Uint8Array(32).fill(1)),
                    types.ascii("Bachelor of Arts"),
                    types.ascii("Literature"),
                    types.uint(2023),
                    types.none()
                ],
                university.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student2.address),
                    types.buff(new Uint8Array(32).fill(2)),
                    types.ascii("Bachelor of Science"),
                    types.ascii("Biology"),
                    types.uint(2023),
                    types.none()
                ],
                university.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectUint(1);
        block.receipts[1].result.expectOk().expectUint(2);
        
        // Check institution certificates
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-institution-certificates",
            [types.principal(university.address)],
            deployer.address
        );
        
        const certificates = call.result.expectSome().expectList();
        assertEquals(certificates.length, 2);
        certificates[0].expectUint(1);
        certificates[1].expectUint(2);
    },
});

Clarinet.test({
    name: "Certificate validation - nonexistent certificate",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        
        // Try to get nonexistent certificate
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate",
            [types.uint(999)],
            deployer.address
        );
        
        call.result.expectNone();
        
        // Try to verify nonexistent certificate
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate",
            [types.uint(999)],
            deployer.address
        );
        
        call.result.expectErr().expectUint(102);
        
        // Try to verify hash of nonexistent certificate
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate-hash",
            [types.uint(999), types.buff(getTestCertificateHash())],
            deployer.address
        );
        
        call.result.expectErr().expectUint(102);
    },
});

// ============================================================================
// ENHANCED FEATURES & ADVANCED FUNCTIONALITY TESTS
// ============================================================================

Clarinet.test({
    name: "Certificate templates - create and use template system",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student = accounts.get("wallet_2")!;
        
        // Setup: Register institution
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Stanford"),
                    types.ascii("STANFORD-002")
                ],
                deployer.address
            )
        ]);
        
        // Create certificate template
        const requiredFields = [
            types.ascii("student-name"),
            types.ascii("degree-type"),
            types.ascii("field-of-study"),
            types.ascii("graduation-date")
        ];
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "create-certificate-template",
                [
                    types.ascii("Computer Science Degree Template"),
                    types.list(requiredFields),
                    types.ascii("Must have completed 120 credits with minimum 2.0 GPA")
                ],
                university.address
            )
        ]);
        
        const templateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Verify template creation
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate-template",
            [types.uint(templateId)],
            deployer.address
        );
        
        const template = call.result.expectSome().expectTuple() as any;
        template["name"].expectAscii("Computer Science Degree Template");
        template["institution"].expectPrincipal(university.address);
        template["is-active"].expectBool(true);
        
        // Issue certificate using template
        const certData = getTestCertificateData();
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate-with-template",
                [
                    types.uint(templateId),
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
        
        // Verify certificate was created successfully
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const certificate = call.result.expectSome().expectTuple() as any;
        certificate["degree-type"].expectAscii(certData.degree);
        certificate["field-of-study"].expectAscii(certData.field);
    },
});

Clarinet.test({
    name: "Certificate grades - add comprehensive grading information",
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
                    types.ascii("MIT"),
                    types.ascii("MIT-002")
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
        
        // Add grades and achievements
        const distinctions = [
            types.ascii("Magna Cum Laude"),
            types.ascii("Deans Honor List"),
            types.ascii("Outstanding Senior Thesis")
        ];
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "add-certificate-grades",
                [
                    types.uint(certificateId),
                    types.some(types.uint(385)), // 3.85 GPA (multiplied by 100)
                    types.some(types.ascii("Magna Cum Laude")),
                    types.some(types.uint(5)), // Ranked 5th
                    types.some(types.uint(128)), // 128 credits
                    types.list(distinctions)
                ],
                university.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Verify grades were added
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate-grades",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const grades = call.result.expectSome().expectTuple() as any;
        grades["gpa"].expectSome().expectUint(385);
        grades["honors"].expectSome().expectAscii("Magna Cum Laude");
        grades["rank"].expectSome().expectUint(5);
        grades["total-credits"].expectSome().expectUint(128);
        
        const distinctionsList = grades["distinctions"].expectList();
        assertEquals(distinctionsList.length, 3);
        distinctionsList[0].expectAscii("Magna Cum Laude");
        distinctionsList[1].expectAscii("Deans Honor List");
        distinctionsList[2].expectAscii("Outstanding Senior Thesis");
    },
});

Clarinet.test({
    name: "Certificate endorsements - multi-institution endorsement system",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university1 = accounts.get("wallet_1")!;
        const university2 = accounts.get("wallet_2")!;
        const university3 = accounts.get("wallet_3")!;
        const student = accounts.get("wallet_4")!;
        
        // Setup: Register multiple institutions
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university1.address),
                    types.ascii("Harvard"),
                    types.ascii("HARVARD-002")
                ],
                deployer.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university2.address),
                    types.ascii("MIT"),
                    types.ascii("MIT-003")
                ],
                deployer.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university3.address),
                    types.ascii("Caltech"),
                    types.ascii("CALTECH-002")
                ],
                deployer.address
            )
        ]);
        
        // Issue certificate from first institution
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
                university1.address
            )
        ]);
        
        const certificateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Add endorsements from other institutions
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "endorse-certificate",
                [types.uint(certificateId)],
                university2.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "endorse-certificate",
                [types.uint(certificateId)],
                university3.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        block.receipts[1].result.expectOk().expectBool(true);
        
        // Check endorsements
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate-endorsements",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const endorsements = call.result.expectSome().expectTuple() as any;
        endorsements["endorsement-count"].expectUint(2);
        endorsements["required-endorsements"].expectUint(3);
        endorsements["is-fully-endorsed"].expectBool(false);
        
        const endorsersList = endorsements["endorsers"].expectList();
        assertEquals(endorsersList.length, 2);
        endorsersList[0].expectPrincipal(university2.address);
        endorsersList[1].expectPrincipal(university3.address);
    },
});

Clarinet.test({
    name: "Certificate access control - grant and revoke access permissions",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student = accounts.get("wallet_2")!;
        const employer = accounts.get("wallet_3")!;
        
        // Setup: Register institution and issue certificate
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Yale"),
                    types.ascii("YALE-002")
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
        
        // Grant access to employer
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "grant-certificate-access",
                [
                    types.uint(certificateId),
                    types.principal(employer.address),
                    types.ascii("verify"),
                    types.some(types.uint(100)) // Expires at block 100
                ],
                student.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Check access was granted
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate-sharing",
            [types.uint(certificateId), types.principal(employer.address)],
            deployer.address
        );
        
        const accessInfo = call.result.expectSome().expectTuple() as any;
        accessInfo["granted-by"].expectPrincipal(student.address);
        accessInfo["access-level"].expectAscii("verify");
        accessInfo["expires-at"].expectSome().expectUint(100);
        
        // Revoke access
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "revoke-certificate-access",
                [types.uint(certificateId), types.principal(employer.address)],
                student.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Verify access was revoked
        call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-certificate-sharing",
            [types.uint(certificateId), types.principal(employer.address)],
            deployer.address
        );
        
        call.result.expectNone();
    },
});

Clarinet.test({
    name: "Institution verification levels - set and validate verification levels",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        
        // Setup: Register institution
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Oxford University"),
                    types.ascii("OXFORD-001")
                ],
                deployer.address
            )
        ]);
        
        // Set institution verification level
        const accreditationBodies = [
            types.ascii("WASC Senior College"),
            types.ascii("ABET"),
            types.ascii("AACSB International")
        ];
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "set-institution-verification",
                [
                    types.principal(university.address),
                    types.uint(5), // Highest verification level
                    types.list(accreditationBodies)
                ],
                deployer.address
            )
        ]);
        
        block.receipts[0].result.expectOk().expectBool(true);
        
        // Verify institution verification details
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "get-institution-verification-details",
            [types.principal(university.address)],
            deployer.address
        );
        
        const verification = call.result.expectSome().expectTuple() as any;
        verification["verification-level"].expectUint(5);
        verification["verification-date"].expectUint(2);
        
        const accreditationList = verification["accreditation-bodies"].expectList();
        assertEquals(accreditationList.length, 3);
        accreditationList[0].expectAscii("WASC Senior College");
        accreditationList[1].expectAscii("ABET");
        accreditationList[2].expectAscii("AACSB International");
    },
});

Clarinet.test({
    name: "Advanced certificate verification - comprehensive verification with scoring",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university1 = accounts.get("wallet_1")!;
        const university2 = accounts.get("wallet_2")!;
        const student = accounts.get("wallet_3")!;
        
        // Setup: Register institutions
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university1.address),
                    types.ascii("Cambridge"),
                    types.ascii("CAMBRIDGE-001")
                ],
                deployer.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university2.address),
                    types.ascii("LSE"),
                    types.ascii("LSE-001")
                ],
                deployer.address
            )
        ]);
        
        // Set verification level for issuing institution
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "set-institution-verification",
                [
                    types.principal(university1.address),
                    types.uint(4),
                    types.list([types.ascii("QAA UK"), types.ascii("HEFCE")])
                ],
                deployer.address
            )
        ]);
        
        // Issue certificate
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
                university1.address
            )
        ]);
        
        const certificateId = block.receipts[0].result.expectOk().expectUint(1);
        
        // Add endorsement
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "endorse-certificate",
                [types.uint(certificateId)],
                university2.address
            )
        ]);
        
        // Perform advanced verification
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "verify-certificate-advanced",
            [types.uint(certificateId)],
            deployer.address
        );
        
        const verification = call.result.expectOk().expectTuple() as any;
        verification["is-valid"].expectBool(true);
        
        const certificate = verification["certificate"].expectTuple() as any;
        certificate["is-revoked"].expectBool(false);
        
        const institutionInfo = verification["institution-info"].expectSome().expectTuple() as any;
        institutionInfo["name"].expectAscii("Cambridge");
        
        const endorsements = verification["endorsements"].expectSome().expectTuple() as any;
        endorsements["endorsement-count"].expectUint(1);
        
        const instVerification = verification["institution-verification"].expectSome().expectTuple() as any;
        instVerification["verification-level"].expectUint(4);
        
        // Check verification score (1 endorsement * 10 + verification level 4 * 20 = 90)
        const verificationScore = verification["verification-score"].expectUint(90);
    },
});

Clarinet.test({
    name: "Batch certificate operations - batch verification functionality",
    async fn(chain: Chain, accounts: Map<string, Account>) {
        const deployer = accounts.get("deployer")!;
        const university = accounts.get("wallet_1")!;
        const student1 = accounts.get("wallet_2")!;
        const student2 = accounts.get("wallet_3")!;
        
        // Setup: Register institution
        let block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "register-institution",
                [
                    types.principal(university.address),
                    types.ascii("Toronto"),
                    types.ascii("TORONTO-001")
                ],
                deployer.address
            )
        ]);
        
        // Issue multiple certificates
        const certData1 = getTestCertificateData();
        const certData2 = {
            degree: "Master of Arts",
            field: "History", 
            graduationDate: types.uint(2023),
            metadataUri: types.some(types.ascii("https://toronto.ca/cert/history/789"))
        };
        
        block = chain.mineBlock([
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student1.address),
                    types.buff(new Uint8Array(32).fill(1)),
                    types.ascii(certData1.degree),
                    types.ascii(certData1.field),
                    certData1.graduationDate,
                    certData1.metadataUri
                ],
                university.address
            ),
            Tx.contractCall(
                CONTRACT_NAME,
                "issue-certificate",
                [
                    types.principal(student2.address),
                    types.buff(new Uint8Array(32).fill(2)),
                    types.ascii(certData2.degree),
                    types.ascii(certData2.field),
                    certData2.graduationDate,
                    certData2.metadataUri
                ],
                university.address
            )
        ]);
        
        const cert1Id = block.receipts[0].result.expectOk().expectUint(1);
        const cert2Id = block.receipts[1].result.expectOk().expectUint(2);
        
        // Batch verify certificates
        let call = await chain.callReadOnlyFn(
            CONTRACT_NAME,
            "batch-verify-certificates",
            [types.list([types.uint(cert1Id), types.uint(cert2Id)])],
            deployer.address
        );
        
        const verifications = call.result.expectList();
        assertEquals(verifications.length, 2);
        
        // Both should be valid
        const verification1 = verifications[0].expectOk().expectTuple() as any;
        verification1["is-valid"].expectBool(true);
        
        const verification2 = verifications[1].expectOk().expectTuple() as any;
        verification2["is-valid"].expectBool(true);
    },
});
