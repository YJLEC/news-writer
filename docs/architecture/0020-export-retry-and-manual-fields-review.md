# Export Recovery and Manual Field Review

## Scope

This review covers the export failure reported as a successful DOCX followed by a generic error and repeated project revision conflicts, repeat-Prompt confirmation behavior, and manual completion of missing DOCX fields.

## Independent review

The independent review agent confirmed that DOCX publication and project-record persistence must be treated as separate phases. After publication, an uncertain commit must never be recorded as a failed export without first refreshing and reconciling the authoritative project state. The renderer must refresh its session after export-class failures. The same review confirmed that duplicate Prompt detection is a confirmation-only UX guard; parent-version and input-fingerprint validation remain main-process invariants. Manual export fields must be transient, schema validated, and offered only for recoverable structural omissions; invalid AI/internal content remains rejected.

## Implemented boundary

- Export request accepts optional transient title, sign-off, and date text.
- The main process returns a structured `needsInput` result before opening the save dialog when recoverable fields are missing.
- The renderer collects the fields and retries the same export without modifying the immutable version or project content.
- A published export is not appended as a failed record when record persistence is uncertain. The service refreshes and reconciles by export record identity, and renderer export failures trigger an authoritative session refresh.
- Repeated Prompt content only opens a warning. The task host still rejects a stale parent or mismatched preparation fingerprint.
- Explicitly restoring a historical parent preserves a Prompt prepared for that parent; other latest changes stale the Prompt.

## Residual verification

Document, project-service, renderer, IPC, lint, and typecheck tests pass. The full unit gate still contains two pre-existing long-running task/AI integration timeouts; they are retained as an open verification item and are not treated as a successful full gate.
