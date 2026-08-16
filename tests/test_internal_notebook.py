"""RDLens-only Notebook channel security and lifecycle contract."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from open_notebook.exceptions import NotFoundError

CREATE_PAYLOAD = {
    "name": "research-workspace-p1",
    "description": "RDLens research workspace",
}


def _client() -> TestClient:
    from api.main import app

    return TestClient(app, client=("127.0.0.1", 50123))


def test_notebook_channel_requires_service_credential(monkeypatch):
    monkeypatch.setenv("OPEN_NOTEBOOK_PASSWORD", "internal-password")
    response = _client().post("/internal/rdlens/notebook", json=CREATE_PAYLOAD)
    assert response.status_code == 401


def test_notebook_channel_rejects_browser_origin(monkeypatch):
    monkeypatch.setenv("OPEN_NOTEBOOK_PASSWORD", "internal-password")
    response = _client().post(
        "/internal/rdlens/notebook",
        json=CREATE_PAYLOAD,
        headers={
            "Authorization": "Bearer internal-password",
            "Origin": "https://browser.example",
        },
    )
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_notebook_channel_rejects_non_internal_client(monkeypatch):
    from api.main import app

    monkeypatch.setenv("OPEN_NOTEBOOK_PASSWORD", "internal-password")
    client = TestClient(app, client=("203.0.113.10", 50123))
    response = client.post(
        "/internal/rdlens/notebook",
        json=CREATE_PAYLOAD,
        headers={"Authorization": "Bearer internal-password"},
    )
    assert response.status_code == 403


def test_notebook_channel_rejects_proxied_requests(monkeypatch):
    monkeypatch.setenv("OPEN_NOTEBOOK_PASSWORD", "internal-password")
    response = _client().post(
        "/internal/rdlens/notebook",
        json=CREATE_PAYLOAD,
        headers={
            "Authorization": "Bearer internal-password",
            "X-Forwarded-For": "203.0.113.10",
        },
    )
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_notebook_channel_forwards_only_after_security_checks(monkeypatch):
    monkeypatch.setenv("OPEN_NOTEBOOK_PASSWORD", "internal-password")
    notebook_id = "notebook:rdlens_p1"
    expected = {
        "notebook_id": notebook_id,
        "id": notebook_id,
        "name": CREATE_PAYLOAD["name"],
        "description": CREATE_PAYLOAD["description"],
    }
    with patch(
        "api.routers.internal_notebooks.create_rdlens_notebook",
        new=AsyncMock(return_value=expected),
    ) as create:
        response = _client().post(
            "/internal/rdlens/notebook",
            json=CREATE_PAYLOAD,
            headers={"Authorization": "Bearer internal-password"},
        )
    assert response.status_code == 200
    assert response.json() == expected
    create.assert_awaited_once()


@pytest.mark.asyncio
async def test_create_builds_notebook_and_returns_id():
    from api.internal_notebook_service import create_rdlens_notebook
    from api.models import RDLensNotebookCreate

    request = RDLensNotebookCreate(**CREATE_PAYLOAD)

    class FakeNotebook:
        def __init__(self, name, description):
            self.name = name
            self.description = description
            self.id = None

        async def save(self):
            self.id = "notebook:rdlens_p1"

    with patch("api.internal_notebook_service.Notebook", new=FakeNotebook):
        result = await create_rdlens_notebook(request)

    assert result["notebook_id"] == "notebook:rdlens_p1"
    assert result["id"] == "notebook:rdlens_p1"
    assert result["name"] == CREATE_PAYLOAD["name"]


@pytest.mark.asyncio
async def test_delete_deletes_notebook():
    from api.internal_notebook_service import delete_rdlens_notebook
    from api.models import RDLensNotebookDelete

    request = RDLensNotebookDelete(notebook_id="notebook:rdlens_p1")

    fake_notebook = AsyncMock()
    fake_notebook.delete = AsyncMock(return_value={})
    with patch(
        "api.internal_notebook_service.Notebook.get",
        new=AsyncMock(return_value=fake_notebook),
    ) as get_notebook:
        result = await delete_rdlens_notebook(request)

    assert result == {"notebook_id": "notebook:rdlens_p1", "deleted": True}
    get_notebook.assert_awaited_once_with("notebook:rdlens_p1")
    fake_notebook.delete.assert_awaited_once()


@pytest.mark.asyncio
async def test_delete_converges_when_notebook_missing():
    from api.internal_notebook_service import delete_rdlens_notebook
    from api.models import RDLensNotebookDelete

    request = RDLensNotebookDelete(notebook_id="notebook:rdlens_p1")

    with patch(
        "api.internal_notebook_service.Notebook.get",
        new=AsyncMock(side_effect=NotFoundError("missing")),
    ) as get_notebook:
        result = await delete_rdlens_notebook(request)

    assert result == {"notebook_id": "notebook:rdlens_p1", "deleted": True}
    get_notebook.assert_awaited_once_with("notebook:rdlens_p1")
