"""Private RDLens Source Adapter routes (not part of browser `/api`)."""

from fastapi import APIRouter

from api.internal_source_service import (
    delete_rdlens_source,
    upsert_rdlens_source,
)
from api.models import RDLensSourceDelete, RDLensSourceUpsert

router = APIRouter()


@router.put("/internal/rdlens/source")
async def upsert_source(request: RDLensSourceUpsert):
    return await upsert_rdlens_source(request)


@router.delete("/internal/rdlens/source")
async def delete_source(request: RDLensSourceDelete):
    return await delete_rdlens_source(request)
