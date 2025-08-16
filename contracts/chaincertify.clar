;; chaincertify
;; Manages issuance and verification of educational certificates on-chain, 
;; enabling tamper-proof credential storage with institutional authorization.

;; constants
(define-constant CONTRACT-OWNER tx-sender)
(define-constant ERR-NOT-AUTHORIZED (err u100))
(define-constant ERR-ALREADY-EXISTS (err u101))
(define-constant ERR-NOT-FOUND (err u102))
(define-constant ERR-INVALID-INSTITUTION (err u103))
(define-constant ERR-CERTIFICATE-REVOKED (err u104))
(define-constant ERR-INVALID-CERTIFICATE-ID (err u105))

;; data maps and vars
;; Map to store authorized educational institutions
(define-map authorized-institutions 
  principal 
  {
    name: (string-ascii 100),
    accreditation-id: (string-ascii 50),
    is-active: bool,
    registered-at: uint
  }
)

;; Map to store certificates
(define-map certificates 
  uint ;; certificate-id
  {
    student-address: principal,
    institution: principal,
    certificate-hash: (buff 32),
    degree-type: (string-ascii 50),
    field-of-study: (string-ascii 100),
    graduation-date: uint,
    issued-at: uint,
    is-revoked: bool,
    metadata-uri: (optional (string-ascii 200))
  }
)

;; Map to track certificates by student
(define-map student-certificates 
  principal 
  (list 50 uint)
)

;; Map to track certificates by institution
(define-map institution-certificates 
  principal 
  (list 1000 uint)
)

;; Counter for certificate IDs
(define-data-var certificate-counter uint u0)

;; Contract metadata
(define-data-var contract-version (string-ascii 10) "1.0.0")

;; private functions
(define-private (is-authorized-institution (institution principal))
  (match (map-get? authorized-institutions institution)
    institution-data (get is-active institution-data)
    false
  )
)

(define-private (get-next-certificate-id)
  (let ((current-id (var-get certificate-counter)))
    (var-set certificate-counter (+ current-id u1))
    (+ current-id u1)
  )
)

(define-private (add-certificate-to-student (student principal) (cert-id uint))
  (let ((current-certs (default-to (list) (map-get? student-certificates student))))
    (map-set student-certificates student (unwrap! (as-max-len? (append current-certs cert-id) u50) false))
  )
)

(define-private (add-certificate-to-institution (institution principal) (cert-id uint))
  (let ((current-certs (default-to (list) (map-get? institution-certificates institution))))
    (map-set institution-certificates institution (unwrap! (as-max-len? (append current-certs cert-id) u1000) false))
  )
)

;; ============================================================================
;; ENHANCED PRIVATE FUNCTIONS
;; ============================================================================

(define-private (validate-certificate-template (template-id uint))
  (match (map-get? certificate-templates template-id)
    template-data (get is-active template-data)
    false
  )
)

(define-private (check-certificate-access (cert-id uint) (viewer principal))
  (match (map-get? certificates cert-id)
    certificate-data
      (or 
        (is-eq viewer (get student-address certificate-data))
        (is-eq viewer (get institution certificate-data))
        (is-some (map-get? certificate-sharing {certificate-id: cert-id, viewer: viewer}))
      )
    false
  )
)

(define-private (update-statistics (operation (string-ascii 20)))
  (if (is-eq operation "issue")
    (var-set total-verified-certificates (+ (var-get total-verified-certificates) u1))
    (if (is-eq operation "revoke")
      (var-set total-revoked-certificates (+ (var-get total-revoked-certificates) u1))
      true
    )
  )
)

(define-private (validate-gpa (gpa uint))
  (and (>= gpa u0) (<= gpa u400)) ;; 0.00 to 4.00 scale (multiplied by 100)
)

(define-private (validate-access-expiry (expires-at (optional uint)))
  (match expires-at
    some-expiry (> some-expiry block-height)
    true ;; no expiry means always valid
  )
)

(define-private (batch-issue-single (cert-data {
  student-address: principal,
  certificate-hash: (buff 32),
  degree-type: (string-ascii 50),
  field-of-study: (string-ascii 100),
  graduation-date: uint,
  metadata-uri: (optional (string-ascii 200))
}))
  (issue-certificate
    (get student-address cert-data)
    (get certificate-hash cert-data)
    (get degree-type cert-data)
    (get field-of-study cert-data)
    (get graduation-date cert-data)
    (get metadata-uri cert-data)
  )
)

;; public functions

;; Register a new educational institution (only contract owner)
(define-public (register-institution 
  (institution principal) 
  (name (string-ascii 100)) 
  (accreditation-id (string-ascii 50))
)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (is-none (map-get? authorized-institutions institution)) ERR-ALREADY-EXISTS)
    
    (map-set authorized-institutions institution {
      name: name,
      accreditation-id: accreditation-id,
      is-active: true,
      registered-at: block-height
    })
    (ok true)
  )
)

;; Deactivate an institution (only contract owner)
(define-public (deactivate-institution (institution principal))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (match (map-get? authorized-institutions institution)
      institution-data
        (begin
          (map-set authorized-institutions institution (merge institution-data {is-active: false}))
          (ok true)
        )
      ERR-NOT-FOUND
    )
  )
)

;; Issue a new certificate (only authorized institutions)
(define-public (issue-certificate 
  (student-address principal)
  (certificate-hash (buff 32))
  (degree-type (string-ascii 50))
  (field-of-study (string-ascii 100))
  (graduation-date uint)
  (metadata-uri (optional (string-ascii 200)))
)
  (let ((cert-id (get-next-certificate-id)))
    (asserts! (is-authorized-institution tx-sender) ERR-INVALID-INSTITUTION)
    
    (map-set certificates cert-id {
      student-address: student-address,
      institution: tx-sender,
      certificate-hash: certificate-hash,
      degree-type: degree-type,
      field-of-study: field-of-study,
      graduation-date: graduation-date,
      issued-at: block-height,
      is-revoked: false,
      metadata-uri: metadata-uri
    })
    
    (add-certificate-to-student student-address cert-id)
    (add-certificate-to-institution tx-sender cert-id)
    (update-statistics "issue")
    
    (ok cert-id)
  )
)

;; Revoke a certificate (only issuing institution)
(define-public (revoke-certificate (cert-id uint))
  (match (map-get? certificates cert-id)
    certificate-data
      (begin
        (asserts! (is-eq tx-sender (get institution certificate-data)) ERR-NOT-AUTHORIZED)
        (map-set certificates cert-id (merge certificate-data {is-revoked: true}))
        (update-statistics "revoke")
        (ok true)
      )
    ERR-NOT-FOUND
  )
)

;; Verify a certificate
(define-read-only (verify-certificate (cert-id uint))
  (match (map-get? certificates cert-id)
    certificate-data
      (ok {
        is-valid: (not (get is-revoked certificate-data)),
        certificate: certificate-data,
        institution-info: (map-get? authorized-institutions (get institution certificate-data))
      })
    ERR-NOT-FOUND
  )
)

;; Get certificate details
(define-read-only (get-certificate (cert-id uint))
  (map-get? certificates cert-id)
)

;; Get certificates by student
(define-read-only (get-student-certificates (student principal))
  (map-get? student-certificates student)
)

;; Get certificates by institution
(define-read-only (get-institution-certificates (institution principal))
  (map-get? institution-certificates institution)
)

;; Get institution info
(define-read-only (get-institution-info (institution principal))
  (map-get? authorized-institutions institution)
)

;; Verify certificate hash (for external verification)
(define-read-only (verify-certificate-hash (cert-id uint) (provided-hash (buff 32)))
  (match (map-get? certificates cert-id)
    certificate-data
      (ok {
        hash-matches: (is-eq (get certificate-hash certificate-data) provided-hash),
        is-revoked: (get is-revoked certificate-data),
        institution: (get institution certificate-data)
      })
    ERR-NOT-FOUND
  )
)

;; Get contract version
(define-read-only (get-contract-version)
  (var-get contract-version)
)

;; Get total certificates issued
(define-read-only (get-total-certificates)
  (var-get certificate-counter)
)

;; ============================================================================
;; ENHANCED PUBLIC FUNCTIONS
;; ============================================================================

;; Create certificate template (institutions only)
(define-public (create-certificate-template
  (name (string-ascii 100))
  (required-fields (list 10 (string-ascii 50)))
  (validation-rules (string-ascii 500))
)
  (let ((template-id (+ (var-get template-counter) u1)))
    (asserts! (is-authorized-institution tx-sender) ERR-INVALID-INSTITUTION)
    
    (map-set certificate-templates template-id {
      name: name,
      institution: tx-sender,
      required-fields: required-fields,
      validation-rules: validation-rules,
      is-active: true,
      created-at: block-height
    })
    
    (var-set template-counter template-id)
    (ok template-id)
  )
)

;; Issue certificate with template
(define-public (issue-certificate-with-template
  (template-id uint)
  (student-address principal)
  (certificate-hash (buff 32))
  (degree-type (string-ascii 50))
  (field-of-study (string-ascii 100))
  (graduation-date uint)
  (metadata-uri (optional (string-ascii 200)))
)
  (begin
    (asserts! (validate-certificate-template template-id) ERR-TEMPLATE-NOT-FOUND)
    (issue-certificate student-address certificate-hash degree-type field-of-study graduation-date metadata-uri)
  )
)

;; Batch issue certificates
(define-public (batch-issue-certificates
  (certificates-data (list 10 {
    student-address: principal,
    certificate-hash: (buff 32),
    degree-type: (string-ascii 50),
    field-of-study: (string-ascii 100),
    graduation-date: uint,
    metadata-uri: (optional (string-ascii 200))
  }))
)
  (begin
    (asserts! (is-authorized-institution tx-sender) ERR-INVALID-INSTITUTION)
    (asserts! (<= (len certificates-data) u10) ERR-BATCH-LIMIT-EXCEEDED)
    
    (ok (map batch-issue-single certificates-data))
  )
)

;; Add certificate grades
(define-public (add-certificate-grades
  (cert-id uint)
  (gpa (optional uint))
  (honors (optional (string-ascii 50)))
  (rank (optional uint))
  (total-credits (optional uint))
  (distinctions (list 5 (string-ascii 100)))
)
  (begin
    (match (map-get? certificates cert-id)
      certificate-data
        (begin
          (asserts! (is-eq tx-sender (get institution certificate-data)) ERR-NOT-AUTHORIZED)
          (match gpa
            some-gpa (asserts! (validate-gpa some-gpa) ERR-INVALID-GRADE)
            true
          )
          
          (map-set certificate-grades cert-id {
            gpa: gpa,
            honors: honors,
            rank: rank,
            total-credits: total-credits,
            distinctions: distinctions
          })
          (ok true)
        )
      ERR-NOT-FOUND
    )
  )
)

;; Grant certificate access
(define-public (grant-certificate-access
  (cert-id uint)
  (viewer principal)
  (access-level (string-ascii 20))
  (expires-at (optional uint))
)
  (begin
    (match (map-get? certificates cert-id)
      certificate-data
        (begin
          (asserts! (is-eq tx-sender (get student-address certificate-data)) ERR-NOT-AUTHORIZED)
          
          (map-set certificate-sharing 
            {certificate-id: cert-id, viewer: viewer}
            {
              granted-by: tx-sender,
              access-level: access-level,
              granted-at: block-height,
              expires-at: expires-at
            }
          )
          (ok true)
        )
      ERR-NOT-FOUND
    )
  )
)

;; Revoke certificate access
(define-public (revoke-certificate-access (cert-id uint) (viewer principal))
  (begin
    (match (map-get? certificates cert-id)
      certificate-data
        (begin
          (asserts! (is-eq tx-sender (get student-address certificate-data)) ERR-NOT-AUTHORIZED)
          (map-delete certificate-sharing {certificate-id: cert-id, viewer: viewer})
          (ok true)
        )
      ERR-NOT-FOUND
    )
  )
)

;; Add endorsement to certificate
(define-public (endorse-certificate (cert-id uint))
  (begin
    (asserts! (is-authorized-institution tx-sender) ERR-INVALID-INSTITUTION)
    (match (map-get? certificates cert-id)
      certificate-data
        (let ((current-endorsements (default-to 
          {endorsers: (list), endorsement-count: u0, required-endorsements: u3, is-fully-endorsed: false}
          (map-get? certificate-endorsements cert-id)
        )))
          (let ((new-endorsers (unwrap! (as-max-len? (append (get endorsers current-endorsements) tx-sender) u10) ERR-BATCH-LIMIT-EXCEEDED))
                (new-count (+ (get endorsement-count current-endorsements) u1)))
            (map-set certificate-endorsements cert-id {
              endorsers: new-endorsers,
              endorsement-count: new-count,
              required-endorsements: (get required-endorsements current-endorsements),
              is-fully-endorsed: (>= new-count (get required-endorsements current-endorsements))
            })
            (ok true)
          )
        )
      ERR-NOT-FOUND
    )
  )
)

;; Set institution verification level (only contract owner)
(define-public (set-institution-verification
  (institution principal)
  (verification-level uint)
  (accreditation-bodies (list 3 (string-ascii 100)))
)
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-AUTHORIZED)
    (asserts! (and (>= verification-level u1) (<= verification-level u5)) ERR-INVALID-INSTITUTION)
    
    (map-set institution-verification institution {
      verification-level: verification-level,
      verified-by: (list),
      verification-date: block-height,
      accreditation-bodies: accreditation-bodies
    })
    (ok true)
  )
)

;; ============================================================================
;; ENHANCED DATA STRUCTURES
;; ============================================================================

;; Certificate Templates System
(define-map certificate-templates 
  uint ;; template-id
  {
    name: (string-ascii 100),
    institution: principal,
    required-fields: (list 10 (string-ascii 50)),
    validation-rules: (string-ascii 500),
    is-active: bool,
    created-at: uint
  }
)

;; Endorsements and Multi-Signature Verification
(define-map certificate-endorsements
  uint ;; certificate-id
  {
    endorsers: (list 10 principal),
    endorsement-count: uint,
    required-endorsements: uint,
    is-fully-endorsed: bool
  }
)

;; Certificate sharing and access control
(define-map certificate-sharing
  {certificate-id: uint, viewer: principal}
  {
    granted-by: principal,
    access-level: (string-ascii 20), ;; "view", "verify", "full"
    granted-at: uint,
    expires-at: (optional uint)
  }
)

;; Certificate grades and achievements
(define-map certificate-grades
  uint ;; certificate-id
  {
    gpa: (optional uint), ;; multiplied by 100 for precision (e.g., 350 = 3.50)
    honors: (optional (string-ascii 50)),
    rank: (optional uint),
    total-credits: (optional uint),
    distinctions: (list 5 (string-ascii 100))
  }
)

;; Institution verification levels
(define-map institution-verification
  principal
  {
    verification-level: uint, ;; 1-5 scale
    verified-by: (list 5 principal),
    verification-date: uint,
    accreditation-bodies: (list 3 (string-ascii 100))
  }
)

;; Contract statistics
(define-data-var total-institutions uint u0)
(define-data-var total-verified-certificates uint u0)
(define-data-var total-revoked-certificates uint u0)
(define-data-var template-counter uint u0)

;; Enhanced error constants
(define-constant ERR-TEMPLATE-NOT-FOUND (err u106))
(define-constant ERR-INSUFFICIENT-ENDORSEMENTS (err u107))
(define-constant ERR-ACCESS-DENIED (err u108))
(define-constant ERR-EXPIRED-ACCESS (err u109))
(define-constant ERR-INVALID-GRADE (err u110))
(define-constant ERR-BATCH-LIMIT-EXCEEDED (err u111))

;; ============================================================================
;; ENHANCED READ-ONLY FUNCTIONS
;; ============================================================================

;; Get certificate with all details
(define-read-only (get-certificate-full-details (cert-id uint))
  (match (map-get? certificates cert-id)
    certificate-data
      (ok {
        certificate: certificate-data,
        grades: (map-get? certificate-grades cert-id),
        endorsements: (map-get? certificate-endorsements cert-id),
        institution-info: (map-get? authorized-institutions (get institution certificate-data)),
        institution-verification: (map-get? institution-verification (get institution certificate-data))
      })
    ERR-NOT-FOUND
  )
)

;; Verify certificate with access control
(define-read-only (verify-certificate-with-access (cert-id uint) (viewer principal))
  (begin
    (asserts! (check-certificate-access cert-id viewer) ERR-ACCESS-DENIED)
    (verify-certificate cert-id)
  )
)

;; Get contract analytics
(define-read-only (get-contract-analytics)
  {
    total-certificates: (var-get certificate-counter),
    total-institutions: (var-get total-institutions),
    total-verified: (var-get total-verified-certificates),
    total-revoked: (var-get total-revoked-certificates),
    total-templates: (var-get template-counter)
  }
)

;; Get certificate template
(define-read-only (get-certificate-template (template-id uint))
  (map-get? certificate-templates template-id)
)

;; Get institution verification details
(define-read-only (get-institution-verification-details (institution principal))
  (map-get? institution-verification institution)
)

;; Get certificate sharing info
(define-read-only (get-certificate-sharing (cert-id uint) (viewer principal))
  (map-get? certificate-sharing {certificate-id: cert-id, viewer: viewer})
)

