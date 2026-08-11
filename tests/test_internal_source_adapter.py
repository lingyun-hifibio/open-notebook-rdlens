"""RDLens-only Source Adapter security and idempotency contract."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from open_notebook.exceptions import NotFoundError

PAYLOAD = {
    "notebook_id": "notebook:rdlens-p1",
    "document_id": "doc-1",
    "document_version": "v2",
    "content_hash": "sha256:abc",
    "markdown": "# Authoritative markdown\n",
    "title": "Document One",
    "source_type": "text",
    "embed": False,
}


def _client() -> TestClient:
    from api.main import app

    return TestClient(app, client=("127.0.0.1", 50123))


def test_adapter_requires_independent_service_credential(monkeypatch):
    monkeypatch.setenv("RD_INTERNAL_SOURCE_ADAPTER_TOKEN", "adapter-only-secret")
    response = _client().put("/internal/rdlens/source", json=PAYLOAD)
    assert response.status_code == 401


def test_adapter_rejects_browser_origin_without_cors(monkeypatch):
    monkeypatch.setenv("RD_INTERNAL_SOURCE_ADAPTER_TOKEN", "adapter-only-secret")
    response = _client().put(
        "/internal/rdlens/source",
        json=PAYLOAD,
        headers={
            "Authorization": "Bearer adapter-only-secret",
            "Origin": "https://browser.example",
        },
    )
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_adapter_rejects_non_internal_client(monkeypatch):
    from api.main import app

    monkeypatch.setenv("RD_INTERNAL_SOURCE_ADAPTER_TOKEN", "adapter-only-secret")
    client = TestClient(app, client=("203.0.113.10", 50123))
    response = client.put(
        "/internal/rdlens/source",
        json=PAYLOAD,
        headers={"Authorization": "Bearer adapter-only-secret"},
    )
    assert response.status_code == 403


def test_adapter_rejects_proxied_requests(monkeypatch):
    monkeypatch.setenv("RD_INTERNAL_SOURCE_ADAPTER_TOKEN", "adapter-only-secret")
    response = _client().put(
        "/internal/rdlens/source",
        json=PAYLOAD,
        headers={
            "Authorization": "Bearer adapter-only-secret",
            "X-Forwarded-For": "203.0.113.10",
        },
    )
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_adapter_route_forwards_only_after_security_checks(monkeypatch):
    monkeypatch.setenv("RD_INTERNAL_SOURCE_ADAPTER_TOKEN", "adapter-only-secret")
    expected = {
        "source_id": "source:rdlens_stable",
        "notebook_id": PAYLOAD["notebook_id"],
        "document_id": PAYLOAD["document_id"],
        "document_version": PAYLOAD["document_version"],
        "content_hash": PAYLOAD["content_hash"],
        "source_type": "text",
        "embed": False,
    }
    with patch(
        "api.routers.internal_sources.upsert_rdlens_source",
        new=AsyncMock(return_value=expected),
    ) as upsert:
        response = _client().put(
            "/internal/rdlens/source",
            json=PAYLOAD,
            headers={"Authorization": "Bearer adapter-only-secret"},
        )
    assert response.status_code == 200
    assert response.json() == expected
    upsert.assert_awaited_once()


@pytest.mark.asyncio
async def test_upsert_binds_notebook_forces_text_and_is_idempotent():
    from api.internal_source_service import upsert_rdlens_source
    from api.models import RDLensSourceUpsert

    request = RDLensSourceUpsert(**PAYLOAD)
    with (
        patch(
            "api.internal_source_service.Notebook.get",
            new=AsyncMock(return_value=object()),
        ) as get_notebook,
        patch(
            "api.internal_source_service.repo_upsert",
            new=AsyncMock(return_value=[]),
        ) as repo_upsert,
        patch(
            "api.internal_source_service.repo_query",
            new=AsyncMock(return_value=[]),
        ) as repo_query,
    ):
        first = await upsert_rdlens_source(request)
        second = await upsert_rdlens_source(request)

    assert first["source_id"] == second["source_id"]
    assert first["source_type"] == "text"
    assert first["embed"] is False
    get_notebook.assert_awaited_with(PAYLOAD["notebook_id"])
    assert repo_upsert.await_count == 2
    for call in repo_upsert.await_args_list:
        data = call.args[2]
        assert data["full_text"] == PAYLOAD["markdown"]
        assert data["title"] == PAYLOAD["title"]
        assert data["rdlens_document_id"] == PAYLOAD["document_id"]
        assert data["rdlens_document_version"] == PAYLOAD["document_version"]
        assert data["rdlens_content_hash"] == PAYLOAD["content_hash"]
        assert "embed" not in data
        assert "provider" not in data
        assert "transformations" not in data
    assert repo_query.await_count == 2


@pytest.mark.asyncio
async def test_upsert_rejects_missing_notebook_before_writing():
    from api.internal_source_service import upsert_rdlens_source
    from api.models import RDLensSourceUpsert

    with (
        patch(
            "api.internal_source_service.Notebook.get",
            new=AsyncMock(side_effect=NotFoundError("missing")),
        ),
        patch(
            "api.internal_source_service.repo_upsert",
            new=AsyncMock(),
        ) as repo_upsert,
    ):
        with pytest.raises(NotFoundError):
            await upsert_rdlens_source(RDLensSourceUpsert(**PAYLOAD))
    repo_upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_delete_is_notebook_bound_and_idempotent():
    from api.internal_source_service import delete_rdlens_source
    from api.models import RDLensSourceDelete

    request = RDLensSourceDelete(
        notebook_id=PAYLOAD["notebook_id"],
        document_id=PAYLOAD["document_id"],
        document_version=PAYLOAD["document_version"],
        source_id=None,
    )
    with (
        patch(
            "api.internal_source_service.Notebook.get",
            new=AsyncMock(return_value=object()),
        ),
        patch(
            "api.internal_source_service.repo_query",
            new=AsyncMock(return_value=[]),
        ) as repo_query,
    ):
        first = await delete_rdlens_source(request)
        second = await delete_rdlens_source(request)

    assert first == second
    assert first["deleted"] is True
    assert first["source_id"].startswith("source:rdlens_")
    assert repo_query.await_count == 2
