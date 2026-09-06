# ADR-008: Research Dispatch Freezes an Immutable Scope Snapshot (RWV2-11)

- **Status**: Accepted
- **Date**: 2026-09
- **Related**: [RWV2-11 (#32)](https://github.com/lingyun-hifibio/open-notebook-rdlens/issues/32), [RWV2-10 (#31)](https://github.com/lingyun-hifibio/open-notebook-rdlens/issues/31), RDLens Epic [#317](https://github.com/HiFiBiO-Therapeutics/RDLens/issues/317), RFC [`research_workspace_v2_product_closure_plan_20260905.md`](https://github.com/HiFiBiO-Therapeutics/RDLens/blob/main/dev_docs/plans/research_workspace_v2_product_closure_plan_20260905.md) (§3 唯一 Scope 契约、§8 不变量 2/3)

## Context

RWV2-10 introduced `ResearchScopeProvider` with a frozen `getSnapshot()` but no consumer used it. Search/Chat/Compare/Coverage still dispatched from per-panel prop copies, so "the same scope" was enforced only by coincidence; consent previews could not show the dispatched scope, and Chat retry re-read the **current** scope instead of the failed turn's original one. The RDLens backend treats empty `source_ids/note_ids` as a project-wide relevant-evidence search (`hybrid_rag`, `engine/modes.py` `route_auto_mode(has_source_ids=False)`), so re-dispatching with an empty array is a silent scope *expansion* — exactly what the RFC forbids (D2/D3: no implicit widening from zero selection).

## Decision

**Every research dispatch (Search, Chat, Coverage, Compare) freezes the immutable scope snapshot at click time and derives every downstream value from that one frozen object.**

1. **Single authority, single channel (K7)**: the three panels consume `useResearchScope()` directly; no `selectedSourceIds`/`selectedNoteIds` props remain. `ResearchWorkspace` keeps the provider read only for `SourceNoteSelector`.
2. **Payload = snapshot (K1/K9)**: `entire_project` sends empty arrays (existing backend semantics); `selected` sends the exact IDs. No new `scope_mode` wire field. Coverage's `onSendCoverage(query, snapshot)` and `sendCoverageChat(query, snapshot)` carry the frozen snapshot.
3. **Turn-scoped retry (K4/K12)**: `ResearchChatTurn.scopeSnapshot` (required, null for restored/`messageRowToTurn` rows). Chat retry rebuilds the selection from the **turn's** snapshot; a null snapshot never renders a retry button — a restored turn can never silently re-dispatch with an empty array.
4. **Consent label from the registration, not the provider (K5/K10/K11)**: `runGuarded(operation, { scopeLabel })` stores `{operation, modelId, scopeLabel}` as one record; the egress dialog renders the scope line only when a label was registered (SourceChat/Insights/Transformation/GlobalModelBar register none). Dispatch wrappers derive the label from the values forwarded by the panel — never by re-reading the provider.
5. **Mode-aware gates (K2/K3/K13)**: `entire_project` has no explicit source set, so Compare (Source-only, hard-capped at 50 and limited today to the first 20 listed sources) and Coverage (`all_selected`; backend rejects empty with `coverage_sources_empty`) are disabled with explicit English messages; Search's `document` context level converges to `focused` with a message (backend 422s document-level with empty IDs).

## Consequences

- Dispatch-time scope, consent preview, idempotency/canonical inputs and final request all share one frozen snapshot; changing scope after dispatch never alters an in-flight turn/job.
- Restored turns (Issue #302) cannot retry — honest, no silent widening; per-`note` scope persistence in server history remains a follow-up (RDLens side).
- `entire_project` Compare/Coverage remain disabled until RWV2-14 brings paginated full-source selection; that is an explicit product decision, not an omission.
- No RDLens API/DB/migration change is required by this task.

## Alternatives considered

- **Send `scope_mode` on the wire** — rejected: requires an RDLens contract change; empty-vs-nonempty arrays already carry the exact semantics (RFC §10 ships backend-compatible contracts first).
- **Defensive `validate()` at every dispatch site** — rejected (`ai-plan-self-critique` P6): unreachable and untestable under the provider's invariants; dead code disguised as a safety check.
- **Retry falls back to the current scope when the turn snapshot is null** — rejected: silently changes what the failed turn asked and can widen to the whole project; hiding retry is the honest option.