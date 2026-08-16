"""RDLens-only Notebook create/delete service (internal channel).

This path only manages the Notebook lifecycle for RDLens research workspaces.
It does not invoke source processing, transformations, providers, native AI,
or embedding commands.
"""

from __future__ import annotations

from api.models import RDLensNotebookCreate, RDLensNotebookDelete
from open_notebook.domain.notebook import Notebook
from open_notebook.exceptions import InvalidInputError, NotFoundError


async def create_rdlens_notebook(request: RDLensNotebookCreate) -> dict:
    """Create one Notebook for an RDLens research workspace and return its id."""

    notebook = Notebook(
        name=request.name,
        description=request.description,
    )
    await notebook.save()
    notebook_id = notebook.id or ""
    if not notebook_id:
        raise InvalidInputError("Notebook create returned no id")
    return {
        "notebook_id": notebook_id,
        "id": notebook_id,
        "name": request.name,
        "description": request.description,
    }


async def delete_rdlens_notebook(request: RDLensNotebookDelete) -> dict:
    """Delete a Notebook by id; a missing notebook converges (idempotent)."""

    try:
        notebook = await Notebook.get(request.notebook_id)
    except NotFoundError:
        return {"notebook_id": request.notebook_id, "deleted": True}
    await notebook.delete()
    return {"notebook_id": request.notebook_id, "deleted": True}
