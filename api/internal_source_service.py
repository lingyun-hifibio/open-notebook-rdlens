"""RDLens-only text Source upsert/delete/readback service.

This path writes only Open Notebook's Source cache and notebook relation.  It
does not invoke source processing, transformations, providers, native AI, or
embedding commands.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any, Dict, List, Optional, cast

from surrealdb import RecordID

from api.models import (
    RDLensSourceDelete,
    RDLensSourceRead,
    RDLensSourceUpsert,
)
from open_notebook.database.repository import repo_query, repo_upsert
from open_notebook.domain.notebook import Notebook
from open_notebook.exceptions import InvalidInputError


def stable_rdlens_source_id(
    notebook_id: str, document_id: str, document_version: str,
) -> str:
    digest = hashlib.sha256(
        f"{notebook_id}\0{document_id}\0{document_version}".encode("utf-8")
    ).hexdigest()[:32]
    return f"source:rdlens_{digest}"


def _stable_reference_id(source_id: str) -> str:
    digest = hashlib.sha256(source_id.encode("utf-8")).hexdigest()[:32]
    return f"reference:rdlens_{digest}"


async def upsert_rdlens_source(request: RDLensSourceUpsert) -> dict:
    """Upsert one deterministic text Source and its exact notebook binding."""

    await Notebook.get(request.notebook_id)
    source_id = stable_rdlens_source_id(
        request.notebook_id, request.document_id, request.document_version,
    )
    await repo_upsert(
        "source",
        source_id,
        {
            "title": (request.title or request.document_id).strip(),
            "topics": [],
            "full_text": request.markdown,
            "rdlens_document_id": request.document_id,
            "rdlens_document_version": request.document_version,
            "rdlens_content_hash": request.content_hash,
        },
        add_timestamp=True,
    )
    # 关系表必须用 RELATE 语法（SurrealDB 拒绝 UPSERT CONTENT 对
    # 关系表的 in/out 赋值）；固定 id 保证幂等（重跑不产生重复关系）。
    await repo_query(
        f"RELATE $source_id -> {_stable_reference_id(source_id)} -> $notebook_id;",
        {
            "source_id": RecordID.parse(source_id),
            "notebook_id": RecordID.parse(request.notebook_id),
        },
    )
    return {
        "source_id": source_id,
        "notebook_id": request.notebook_id,
        "document_id": request.document_id,
        "document_version": request.document_version,
        "content_hash": request.content_hash,
        "source_type": "text",
        "embed": False,
    }


async def delete_rdlens_source(request: RDLensSourceDelete) -> dict:
    """Delete the deterministic Source and relation; missing records succeed."""

    expected_id = stable_rdlens_source_id(
        request.notebook_id, request.document_id, request.document_version,
    )
    if request.source_id is not None and request.source_id != expected_id:
        raise InvalidInputError("source_id does not match notebook document binding")
    await repo_query(
        "DELETE $relation_id; DELETE $source_id;",
        {
            "relation_id": RecordID.parse(_stable_reference_id(expected_id)),
            "source_id": RecordID.parse(expected_id),
        },
    )
    return {"source_id": expected_id, "deleted": True}


class RDLensSourceNotFoundError(Exception):
    """GET-specific: the Source, the notebook, or their binding does not exist.

    Mapped to 404 with detail.code=source_not_found by the router. Distinct
    from domain NotFoundError so a database failure can never be reported as
    "not found" (base.py get() converts every exception to NotFoundError -
    the reason this service uses raw queries instead).
    """


class RDLensSourceReadError(Exception):
    """GET-specific: database failure, invalid result shape, or timeout.

    Mapped to 500 by the router.
    """


_READBACK_SOURCE_QUERY = "SELECT * FROM ONLY source WHERE id IN [$a, $b];"
_READBACK_NOTEBOOK_QUERY = "SELECT * FROM ONLY notebook WHERE id IN [$a, $b];"
_READBACK_REFERENCES_QUERY = (
    "SELECT id, in, out FROM reference WHERE in IN [$a, $b] ORDER BY id;"
)

_IDENTITY_FIELDS = (
    "rdlens_document_id",
    "rdlens_document_version",
    "rdlens_content_hash",
)


def _id_candidates(value: str, expected_table: str, kind: str) -> List[RecordID]:
    """Parse a GET record id into its possible RecordID interpretations.

    RecordID.parse raises ValueError for ids without the ``table:id`` shape -
    the router maps that to 400. The table check rejects cross-table ids the
    parser would otherwise accept (e.g. notebook:... passed as source_id).

    The SDK's str(RecordID) emits the angle-wrapped form for ids that need
    escaping (e.g. ``notebook:⟨rdlens-p1⟩`` for hyphenated ids), but
    RecordID.parse does NOT unwrap it - the brackets stay as id content, so
    the naive parse queries a nonexistent record and a genuinely existing
    one would 404 (Round 4 finding). Two candidates are generated: the naive
    parse and the outer-bracket-stripped reading; the IN-query matches
    whichever record actually exists. (Ids whose content itself contains
    angle brackets cannot be disambiguated from an escaped form without
    reimplementing SurrealDB's EscapeRid; both interpretations are tried
    and the row-id check below still validates the match.)
    """
    if ":" not in value:
        raise ValueError(
            f"{kind} must have the shape table:id (got {value!r})"
        )
    table, rest = value.split(":", 1)
    if table != expected_table:
        raise ValueError(
            f"{kind} must be a record of table {expected_table!r} (got {value!r})"
        )
    plain = RecordID(table, rest)
    candidates: List[RecordID] = [plain]
    if rest.startswith("⟨") and rest.endswith("⟩") and len(rest) >= 2:
        stripped = RecordID(table, rest[1:-1])
        if stripped != plain:
            candidates.append(stripped)
    return candidates


def _record_id_or_none(value: Any) -> Optional[RecordID]:
    """Return value if it is a RecordID, else None (shape validation helper)."""
    return value if isinstance(value, RecordID) else None


async def read_rdlens_source(request: RDLensSourceRead) -> dict:
    """Read back the actual persisted Source identity for RDLens verification.

    Opens one budgeted connection and issues three parameterized queries
    against it (the SDK returns only the first statement's result for a
    multi-statement query, so they must be separate calls). Returns the
    stored values as-is: missing identity fields read back as null - no
    inference from the request, deterministic ids, or body content.
    """
    from open_notebook.database.repository import (
        INTERNAL_GET_OPERATION_BUDGET_SECONDS,
        db_connection,
    )

    # Validate both incoming ids directly - the GET addresses the Source by
    # its actual record id; it is never re-derived from a document triple.
    # Each id yields up to two interpretations (naive parse + outer-bracket-
    # stripped); the IN-queries match whichever record actually exists.
    source_candidates = _id_candidates(request.source_id, "source", "source_id")
    notebook_candidates = _id_candidates(request.notebook_id, "notebook", "notebook_id")

    try:
        async with db_connection(
            operation_budget_seconds=INTERNAL_GET_OPERATION_BUDGET_SECONDS
        ) as connection:
            # repo_query routes through parse_record_ids(), which stringifies
            # RecordIDs into the escaped ⟨...⟩ form; binding comparison needs
            # the actual RecordID objects, so the readback queries bypass it
            # and run on the shared budgeted connection directly.
            source_rows = await connection.query(
                _READBACK_SOURCE_QUERY,
                {"a": source_candidates[0], "b": source_candidates[-1]},
            )
            notebook_rows = await connection.query(
                _READBACK_NOTEBOOK_QUERY,
                {"a": notebook_candidates[0], "b": notebook_candidates[-1]},
            )
            reference_rows = await connection.query(
                _READBACK_REFERENCES_QUERY,
                {"a": source_candidates[0], "b": source_candidates[-1]},
            )
    except asyncio.TimeoutError as e:
        raise RDLensSourceReadError(
            f"source readback exceeded "
            f"{INTERNAL_GET_OPERATION_BUDGET_SECONDS}s operation budget"
        ) from e
    except asyncio.CancelledError:
        raise
    except Exception as e:
        raise RDLensSourceReadError(f"source readback query failed: {e}") from e

    # ONLY SELECT returns None for a missing record and a dict otherwise;
    # anything else is an invalid result shape, not an absence.
    for rows, kind in ((source_rows, "source"), (notebook_rows, "notebook")):
        if rows is not None and not isinstance(rows, dict):
            raise RDLensSourceReadError(
                f"source readback returned an unexpected {kind} result shape"
            )
    if not isinstance(reference_rows, list):
        raise RDLensSourceReadError(
            "source readback returned an unexpected reference shape"
        )

    # Row-shape validation BEFORE any absence judgment (Round 2 #5): a
    # malformed row is a database inconsistency -> 500, even when the OTHER
    # record is missing. Only after every present row validates may a None
    # result be read as absence -> 404.
    source: Optional[Dict[str, Any]] = None
    notebook: Optional[Dict[str, Any]] = None

    if source_rows is not None:
        source = cast(Dict[str, Any], source_rows)
        source_id_value = _record_id_or_none(source.get("id"))
        if (
            source_id_value is None
            or source_id_value.table_name != "source"
            # The IN-query matches either interpretation; the row must be one
            # of the candidates for the id the caller actually sent.
            or source_id_value not in source_candidates
        ):
            raise RDLensSourceReadError(
                "source readback returned a row with unexpected id"
            )
        for field in _IDENTITY_FIELDS:
            value = source.get(field)
            if value is not None and not isinstance(value, str):
                raise RDLensSourceReadError(
                    f"source readback returned a non-string {field}: {value!r}"
                )

    if notebook_rows is not None:
        notebook = cast(Dict[str, Any], notebook_rows)
        notebook_id_value = _record_id_or_none(notebook.get("id"))
        if (
            notebook_id_value is None
            or notebook_id_value.table_name != "notebook"
            or notebook_id_value not in notebook_candidates
        ):
            raise RDLensSourceReadError(
                "source readback returned a notebook row with unexpected id"
            )

    references: List[dict] = []
    reference_outs: List[RecordID] = []
    for row in reference_rows:
        if not isinstance(row, dict):
            raise RDLensSourceReadError(
                "source readback returned an invalid reference row shape"
            )
        ref_id = _record_id_or_none(row.get("id"))
        ref_in = _record_id_or_none(row.get("in"))
        ref_out = _record_id_or_none(row.get("out"))
        if (
            ref_id is None
            or ref_in is None
            or ref_out is None
            or ref_id.table_name != "reference"
            or ref_in.table_name != "source"
            or ref_out.table_name != "notebook"
            # The query filtered on in IN the source candidates; a row naming
            # any other source is an invalid result, not a binding.
            or ref_in not in source_candidates
        ):
            raise RDLensSourceReadError(
                "source readback returned an invalid reference row shape"
            )
        references.append(
            {
                "id": f"{ref_id.table_name}:{str(ref_id.id)}",
                "in": f"{ref_in.table_name}:{str(ref_in.id)}",
                "out": f"{ref_out.table_name}:{str(ref_out.id)}",
            }
        )
        reference_outs.append(ref_out)

    if source is None or notebook is None:
        # All present rows validated; a remaining None is genuine absence.
        # No binding can exist in either case; this is the GET's 404, not a
        # 500.
        raise RDLensSourceNotFoundError(
            f"source {request.source_id} or notebook {request.notebook_id} not found"
        )

    # Bind on RecordID equality: str() on a hyphenated id yields the escaped
    # ⟨...⟩ form, which never equals the plain request string.
    if not any(ref_out in notebook_candidates for ref_out in reference_outs):
        raise RDLensSourceNotFoundError(
            f"source {request.source_id} is not bound to notebook {request.notebook_id}"
        )

    # Echo the record ids as the plain table:id form (the escaped ⟨...⟩
    # wrapper is a serialization artifact, not identity content). The row-id
    # checks above guarantee both values are non-None RecordIDs here.
    assert source_id_value is not None and notebook_id_value is not None
    return {
        "source_id": (
            f"{source_id_value.table_name}:{str(source_id_value.id)}"
        ),
        "notebook_id": (
            f"{notebook_id_value.table_name}:{str(notebook_id_value.id)}"
        ),
        "rdlens_document_id": source.get("rdlens_document_id"),
        "rdlens_document_version": source.get("rdlens_document_version"),
        "rdlens_content_hash": source.get("rdlens_content_hash"),
        "references": references,
    }
