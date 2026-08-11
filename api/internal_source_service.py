"""RDLens-only text Source upsert/delete service.

This path writes only Open Notebook's Source cache and notebook relation.  It
does not invoke source processing, transformations, providers, native AI, or
embedding commands.
"""

from __future__ import annotations

import hashlib

from surrealdb import RecordID

from api.models import RDLensSourceDelete, RDLensSourceUpsert
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
    await repo_query(
        "UPSERT $relation_id CONTENT { in: $source_id, out: $notebook_id };",
        {
            "relation_id": RecordID.parse(_stable_reference_id(source_id)),
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
