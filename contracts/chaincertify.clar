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

