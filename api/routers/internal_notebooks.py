"""Private RDLens Notebook channel routes (not part of browser `/api`)."""

from fastapi import APIRouter

from api.internal_notebook_service import (
    create_rdlens_notebook,
    delete_rdlens_notebook,
)
from api.models import RDLensNotebookCreate, RDLensNotebookDelete

router = APIRouter()


@router.post("/internal/rdlens/notebook")
async def create_notebook(request: RDLensNotebookCreate):
    return await create_rdlens_notebook(request)


@router.delete("/internal/rdlens/notebook")
async def delete_notebook(request: RDLensNotebookDelete):
    return await delete_rdlens_notebook(request)
