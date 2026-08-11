"""Outer security boundary for the RDLens internal Source Adapter."""

from __future__ import annotations

import ipaddress
import secrets

from fastapi.responses import JSONResponse

from open_notebook.utils.encryption import get_secret_from_env

INTERNAL_SOURCE_PATH = "/internal/rdlens/source"

_INTERNAL_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    )
)


def _is_internal_host(host: str | None) -> bool:
    try:
        address = ipaddress.ip_address(host or "")
    except ValueError:
        return False
    return any(address in network for network in _INTERNAL_NETWORKS)


class InternalSourceAdapterMiddleware:
    """Reject public networks, browser requests, and non-service credentials.

    Registered outermost so rejected requests never enter global CORS or the
    ordinary password middleware.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("path") != INTERNAL_SOURCE_PATH:
            return await self.app(scope, receive, send)
        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        if any(
            header in headers
            for header in ("origin", "referer", "sec-fetch-site", "sec-fetch-mode")
        ):
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
        expected = get_secret_from_env("RD_INTERNAL_SOURCE_ADAPTER_TOKEN")
        if not expected:
            return await JSONResponse(
                {"detail": "internal adapter unavailable"}, status_code=503
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
