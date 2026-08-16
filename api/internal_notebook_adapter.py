"""Outer security boundary for the RDLens internal Notebook channel."""

from __future__ import annotations

import secrets

from fastapi.responses import JSONResponse

from api.internal_source_adapter import _is_internal_host
from open_notebook.utils.encryption import get_secret_from_env

INTERNAL_NOTEBOOK_PATH = "/internal/rdlens/notebook"

_BROWSER_HEADERS = ("origin", "referer", "sec-fetch-site", "sec-fetch-mode")


class InternalNotebookAdapterMiddleware:
    """Reject public networks, browser requests, and non-service credentials.

    Registered outermost so rejected requests never enter global CORS or the
    ordinary password middleware. The Notebook lifecycle uses the ordinary
    Open Notebook password (``OPEN_NOTEBOOK_PASSWORD``), which RDLens supplies
    as ``research.open_notebook_password`` — deliberately distinct from the
    Source Adapter's dedicated ``RD_INTERNAL_SOURCE_ADAPTER_TOKEN``
    (see tests/test_lifecycle.py 的独立凭据约束).
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") != INTERNAL_NOTEBOOK_PATH:
            return await self.app(scope, receive, send)
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        if any(header in headers for header in _BROWSER_HEADERS):
            return await JSONResponse(
                {"detail": "browser access denied"}, status_code=403
            )(
                scope, receive, send
            )
        if "forwarded" in headers or "x-forwarded-for" in headers:
            return await JSONResponse(
                {"detail": "direct internal connection required"},
                status_code=403,
            )(scope, receive, send)
        client = scope.get("client")
        host = client[0] if client else None
        if not _is_internal_host(host):
            return await JSONResponse(
                {"detail": "internal network required"}, status_code=403
            )(
                scope, receive, send
            )
        expected = get_secret_from_env("OPEN_NOTEBOOK_PASSWORD")
        if not expected:
            return await JSONResponse(
                {"detail": "internal notebook channel unavailable"}, status_code=503
            )(
                scope, receive, send
            )
        authorization = headers.get("authorization", "")
        scheme, separator, credential = authorization.partition(" ")
        if (
            separator != " "
            or scheme.lower() != "bearer"
            or not secrets.compare_digest(credential, expected)
        ):
            return await JSONResponse(
                {"detail": "invalid internal service credential"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )(scope, receive, send)
        return await self.app(scope, receive, send)
