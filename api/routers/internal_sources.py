"""Private RDLens Source Adapter routes (not part of browser `/api`)."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from api.internal_source_service import (
    RDLensSourceNotFoundError,
    RDLensSourceReadError,
    delete_rdlens_source,
    read_rdlens_source,
    upsert_rdlens_source,
)
from api.models import (
    RDLensSourceDelete,
    RDLensSourceRead,
    RDLensSourceUpsert,
)

router = APIRouter()


@router.put("/internal/rdlens/source")
async def upsert_source(request: RDLensSourceUpsert):
    return await upsert_rdlens_source(request)


@router.delete("/internal/rdlens/source")
async def delete_source(request: RDLensSourceDelete):
    return await delete_rdlens_source(request)


@router.get("/internal/rdlens/source")
async def read_source(request: Request):
    """Read back persisted Source identity for write-then-read verification.

    Query parameters only (no body on GET): source_id + notebook_id address
    the Source record directly. 422 = missing/invalid parameters (including
    constraint violations such as an overlong id), 400 = syntactically
    invalid record id (no ``table:id`` shape or wrong table prefix), 404
    (detail.code=source_not_found) = source/notebook/binding absent, 500 =
    database failure, timeout, or invalid result shape.
    """
    missing = [
        name for name in ("source_id", "notebook_id") if not request.query_params.get(name)
    ]
    if missing:
        return JSONResponse(
            status_code=422,
            content={
                "detail": {
                    "code": "missing_parameter",
                    "message": f"missing query parameter(s): {', '.join(missing)}",
                }
            },
        )
    # Pydantic constraint violations (e.g. an overlong id) raise before the
    # service runs; without this handler they would surface as a 500.
    try:
        parsed = RDLensSourceRead(
            source_id=request.query_params.get("source_id", ""),
            notebook_id=request.query_params.get("notebook_id", ""),
        )
    except ValidationError as e:
        return JSONResponse(
            status_code=422,
            content={
                "detail": {
                    "code": "invalid_parameter",
                    "message": "; ".join(err["msg"] for err in e.errors()),
                }
            },
        )
    # RecordID syntax + table-prefix validation happens before any query in
    # the service; ValueError from RecordID.parse is surfaced as 400.
    try:
        return await read_rdlens_source(parsed)
    except RDLensSourceNotFoundError as e:
        return JSONResponse(
            status_code=404,
            content={"detail": {"code": "source_not_found", "message": str(e)}},
        )
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"detail": {"code": "invalid_parameter", "message": str(e)}},
        )
    except RDLensSourceReadError as e:
        return JSONResponse(
            status_code=500,
            content={"detail": {"code": "source_read_failed", "message": str(e)}},
        )
