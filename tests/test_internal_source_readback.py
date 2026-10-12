"""GET /internal/rdlens/source readback tests (fork issue #66).

Component coverage: security middleware reuse, error semantics
(404/400/422/500), readback response contract (source_id + notebook_id
signature), RecordID binding comparison, row-shape validation, and the
connection lifecycle fixes (budget, cancel propagation, close-error
isolation). Real-database write-then-readback evidence runs against
isolated SurrealDB 2.6.5 and is documented in the PR.
"""

from __future__ import annotations

import asyncio
import contextlib
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from surrealdb import RecordID

from api.internal_source_service import (
    RDLensSourceNotFoundError,
    RDLensSourceReadError,
    read_rdlens_source,
)
from api.models import RDLensSourceRead

QUERY = {
    "source_id": "source:rdlens_f9449a51e0cbbc647f19c3e2aefc26ad",
    "notebook_id": "notebook:rdlens-p1",
}

SOURCE_ID = QUERY["source_id"]


def _client() -> TestClient:
    from api.main import app

    return TestClient(app, client=("127.0.0.1", 50123))


def _source_row(overrides: dict | None = None) -> dict:
    row = {
        "id": RecordID.parse(SOURCE_ID),
        "title": "Document One",
        "topics": [],
        "full_text": "# Authoritative markdown\n",
        "rdlens_document_id": "doc-1",
        "rdlens_document_version": "v2",
        "rdlens_content_hash": "sha256:abc",
    }
    row.update(overrides or {})
    return row


def _notebook_row() -> dict:
    return {"id": RecordID.parse(QUERY["notebook_id"]), "name": "P1"}


def _default_ref_rows() -> list:
    return [
        {
            "id": RecordID.parse("reference:rdlens_x"),
            "in": RecordID.parse(SOURCE_ID),
            "out": RecordID.parse(QUERY["notebook_id"]),
        }
    ]


def _patch_connection():
    """Patch db_connection to yield a mock without touching a real database."""
    return patch(
        "open_notebook.database.repository.db_connection",
        **{
            "return_value.__aenter__": AsyncMock(return_value=AsyncMock()),
            "return_value.__aexit__": AsyncMock(return_value=False),
        },
    )


_UNSET = object()


@contextlib.contextmanager
def _patch_read_queries(
    source_rows: object,
    notebook_rows: object = _UNSET,
    reference_rows: list | object = _UNSET,
):
    """Patch db_connection + the three readback queries on one connection."""
    conn = AsyncMock()

    async def fake_query(sql, vars=None):  # noqa: ARG001
        if "FROM ONLY source" in sql:
            return source_rows
        if "FROM ONLY notebook" in sql:
            return _notebook_row() if notebook_rows is _UNSET else notebook_rows
        if "FROM reference" in sql:
            return _default_ref_rows() if reference_rows is _UNSET else reference_rows
        raise AssertionError(f"unexpected query: {sql}")

    conn.query.side_effect = fake_query
    with _patch_connection() as conn_cm:
        conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
        conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
        yield conn


@pytest.fixture
def adapter_token(monkeypatch):
    monkeypatch.setenv("RD_INTERNAL_SOURCE_ADAPTER_TOKEN", "adapter-only-secret")


class TestSecurityAndRouting:
    """GET sits behind the same boundary as PUT/DELETE."""

    def test_get_requires_service_credential(self, adapter_token):
        response = _client().get("/internal/rdlens/source", params=QUERY)
        assert response.status_code == 401

    def test_get_rejects_browser_origin(self, adapter_token):
        response = _client().get(
            "/internal/rdlens/source",
            params=QUERY,
            headers={
                "Authorization": "Bearer adapter-only-secret",
                "Origin": "https://browser.example",
            },
        )
        assert response.status_code == 403

    def test_get_rejects_proxied_requests(self, adapter_token):
        response = _client().get(
            "/internal/rdlens/source",
            params=QUERY,
            headers={
                "Authorization": "Bearer adapter-only-secret",
                "X-Forwarded-For": "203.0.113.10",
            },
        )
        assert response.status_code == 403

    def test_get_route_forwards_only_after_security_checks(self, adapter_token):
        expected = {
            "source_id": SOURCE_ID,
            "notebook_id": QUERY["notebook_id"],
            "rdlens_document_id": "doc-1",
            "rdlens_document_version": "v2",
            "rdlens_content_hash": "sha256:abc",
            "references": [],
        }
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(return_value=expected),
        ) as read:
            response = _client().get(
                "/internal/rdlens/source",
                params=QUERY,
                headers={"Authorization": "Bearer adapter-only-secret"},
            )
        assert response.status_code == 200
        assert response.json() == expected
        read.assert_awaited_once()


class TestParameterValidation:
    """Missing params → 422; invalid record ids / wrong table → 400."""

    @pytest.mark.asyncio
    async def test_missing_parameters_raise_validation_error(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            RDLensSourceRead(source_id="", notebook_id=QUERY["notebook_id"])
        kwargs: dict = {"source_id": SOURCE_ID}  # notebook_id deliberately absent
        with pytest.raises(ValidationError):
            RDLensSourceRead(**kwargs)

    @pytest.mark.asyncio
    async def test_overlong_parameter_raises_validation_error(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            RDLensSourceRead(
                source_id="source:" + "x" * 300,
                notebook_id=QUERY["notebook_id"],
            )

    @pytest.mark.asyncio
    async def test_invalid_record_id_is_rejected_before_any_query(self):
        with patch(
            "open_notebook.database.repository.db_connection"
        ) as conn_cm, patch(
            "api.internal_source_service.repo_query", new=AsyncMock()
        ):
            with pytest.raises(Exception) as exc_info:
                await read_rdlens_source(
                    RDLensSourceRead(
                        source_id="source-without-colon",
                        notebook_id=QUERY["notebook_id"],
                    )
                )
        conn_cm.assert_not_called()
        assert not isinstance(exc_info.value, RDLensSourceNotFoundError)

    @pytest.mark.asyncio
    async def test_wrong_table_prefix_is_rejected_before_any_query(self):
        """A syntactically valid id against the wrong table is a 400 case."""
        with patch("open_notebook.database.repository.db_connection") as conn_cm:
            with pytest.raises(ValueError, match="table 'source'"):
                await read_rdlens_source(
                    RDLensSourceRead(
                        source_id="notebook:rdlens-p1",
                        notebook_id=QUERY["notebook_id"],
                    )
                )
        conn_cm.assert_not_called()


class TestReadbackContract:
    """Response carries stored values as-is plus ALL references by id."""

    @pytest.mark.asyncio
    async def test_successful_readback_returns_persisted_fields(self):
        with _patch_read_queries(_source_row()) as conn:
            result = await read_rdlens_source(RDLensSourceRead(**QUERY))
        assert result["source_id"] == SOURCE_ID
        assert result["notebook_id"] == QUERY["notebook_id"]
        assert result["rdlens_document_id"] == "doc-1"
        assert result["rdlens_document_version"] == "v2"
        assert result["rdlens_content_hash"] == "sha256:abc"
        assert result["references"][0]["out"] == QUERY["notebook_id"]
        assert conn.query.await_count == 3

    @pytest.mark.asyncio
    async def test_hyphenated_ids_bind_via_recordid_equality(self):
        """Escaped-form ids (hyphenated) still bind: comparison is RecordID
        equality / canonical table:id, never str() (which yields ⟨...⟩)."""
        source_id = "source:rdlens-p1"
        notebook_id = "notebook:acc-nb-1"
        refs = [
            {
                "id": RecordID.parse("reference:rdlens-r1"),
                "in": RecordID.parse(source_id),
                "out": RecordID.parse(notebook_id),
            }
        ]
        with _patch_read_queries(
            _source_row({"id": RecordID.parse(source_id)}),
            notebook_rows={"id": RecordID.parse(notebook_id), "name": "NB"},
            reference_rows=refs,
        ):
            result = await read_rdlens_source(
                RDLensSourceRead(source_id=source_id, notebook_id=notebook_id)
            )
        assert result["source_id"] == source_id  # canonical, NOT ⟨escaped⟩
        assert result["notebook_id"] == notebook_id
        assert result["references"][0]["out"] == notebook_id

    @pytest.mark.asyncio
    async def test_escaped_sdk_id_string_resolves_to_real_record(self):
        """A request id in the SDK's str(RecordID) escaped form
        (``table:⟨id⟩``) resolves the REAL record: the angle-wrapped form is
        decoded (outer brackets stripped + inner content unescaped) into one
        canonical RecordID - RecordID.parse alone keeps the brackets as id
        content and would query a nonexistent record (Round 4 finding)."""
        real_source = RecordID.parse(SOURCE_ID)  # raw id, no brackets
        escaped_source = f"source:⟨{SOURCE_ID.split(':', 1)[1]}⟩"
        escaped_notebook = f"notebook:⟨{QUERY['notebook_id'].split(':', 1)[1]}⟩"
        refs = [
            {
                "id": RecordID.parse("reference:rdlens_x"),
                "in": real_source,
                "out": RecordID.parse(QUERY["notebook_id"]),
            }
        ]
        with _patch_read_queries(
            _source_row(),  # DB returns the real (unwrapped) record
            reference_rows=refs,
        ) as conn:
            result = await read_rdlens_source(
                RDLensSourceRead(
                    source_id=escaped_source, notebook_id=escaped_notebook
                )
            )
        # Echo the plain canonical form, never the wrapper.
        assert result["source_id"] == SOURCE_ID
        assert result["notebook_id"] == QUERY["notebook_id"]
        # Single-candidate query: the bound param is the DECODED record id.
        assert conn.query.await_args_list[0].args[1]["record_id"] == real_source

    @pytest.mark.asyncio
    async def test_mixed_escaped_and_plain_ids_resolve(self):
        escaped_source = f"source:⟨{SOURCE_ID.split(':', 1)[1]}⟩"
        with _patch_read_queries(_source_row()):
            result = await read_rdlens_source(
                RDLensSourceRead(
                    source_id=escaped_source, notebook_id=QUERY["notebook_id"]
                )
            )
        assert result["source_id"] == SOURCE_ID

    @pytest.mark.asyncio
    async def test_escaped_id_with_sdk_escaped_close_bracket_resolves(self):
        """SDK str() of id content containing ⟩ emits ``⟨a\\⟩b⟩``; the decode
        must unescape the inner ``\\⟩`` (naive outer-strip left it escaped -
        Round 5 finding)."""
        from api.internal_source_service import _parse_read_record_id

        record_id = _parse_read_record_id("source:⟨a\\⟩b⟩", "source", "source_id")
        assert record_id.table_name == "source"
        assert record_id.id == "a⟩b"

    @pytest.mark.asyncio
    async def test_literal_bracket_record_addressable_via_sdk_form(self):
        """The SDK form of a literal-bracket id (content '⟨s⟩' serialized as
        '⟨⟨s\\⟩⟩') decodes back to the literal-bracket content."""
        from api.internal_source_service import _parse_read_record_id

        record_id = _parse_read_record_id("source:⟨⟨s\\⟩⟩", "source", "source_id")
        assert record_id.id == "⟨s⟩"

    @pytest.mark.asyncio
    async def test_ambiguous_both_records_exist_still_single_lookup(self):
        """Both the plain record and the literal-bracket record exist: the
        wrapped request resolves to ONE record (no ONLY multi-match 500, no
        cross-record binding pass-through - Round 5 findings)."""
        from surrealdb import RecordID as RID

        from api.internal_source_service import _parse_read_record_id

        # The wrapped form decodes to the plain record; the query param is
        # exactly one RecordID, so ONLY can never see two matches.
        record_id = _parse_read_record_id("source:⟨s⟩", "source", "source_id")
        assert record_id == RID("source", "s")
        assert record_id != RID("source", "⟨s⟩")

    @pytest.mark.asyncio
    async def test_missing_query_still_404s(self):
        """A genuinely absent record still 404s under the single-candidate
        query."""
        with _patch_read_queries(None):
            with pytest.raises(RDLensSourceNotFoundError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_row_id_not_among_candidates_is_read_error(self):
        """A row whose id does not match the decoded request id is a 500,
        not a pass-through."""
        alien = _source_row({"id": RecordID.parse("source:alien")})
        with _patch_read_queries(alien):
            with pytest.raises(RDLensSourceReadError, match="unexpected id"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_missing_identity_fields_read_back_as_null(self):
        row = _source_row(
            {
                "rdlens_document_id": None,
                "rdlens_document_version": None,
                "rdlens_content_hash": None,
            }
        )
        with _patch_read_queries(row):
            result = await read_rdlens_source(RDLensSourceRead(**QUERY))
        assert result["rdlens_document_id"] is None
        assert result["rdlens_document_version"] is None
        assert result["rdlens_content_hash"] is None

    @pytest.mark.asyncio
    async def test_echo_preserves_identity_for_literal_bracket_ids(self):
        """GET on a literal-bracket record (addressed via the SDK's nested
        form) echoes source_id in the SDK-escaped form, NOT the bare plain
        form: a plain echo ``source:⟨s⟩`` re-parsed by the GET parser would
        decode to the plain ``s`` record - a reused response id would
        silently read a DIFFERENT Source (Round 6 finding)."""
        from api.internal_source_service import _parse_read_record_id

        literal = RecordID("source", "⟨s⟩")
        nested_request = "source:⟨⟨s\\⟩⟩"  # SDK form of the literal id
        row = _source_row({"id": literal})
        refs = [
            {
                "id": RecordID("reference", "⟨r⟩"),
                "in": literal,
                "out": RecordID.parse(QUERY["notebook_id"]),
            }
        ]
        with _patch_read_queries(row, reference_rows=refs):
            result = await read_rdlens_source(
                RDLensSourceRead(
                    source_id=nested_request, notebook_id=QUERY["notebook_id"]
                )
            )
        # Echoed id must re-parse to the SAME RecordID.
        echoed = result["source_id"]
        assert echoed != "source:⟨s⟩"  # the identity-switching form
        assert _parse_read_record_id(echoed, "source", "source_id") == literal
        # And it must be the SDK's canonical escaped form.
        assert echoed == "source:⟨⟨s\\⟩⟩"

    @pytest.mark.asyncio
    async def test_echo_uses_plain_form_for_normal_ids(self):
        """Ids without bracket content keep the plain echo form."""
        result_id = "source:whatever"
        row = _source_row({"id": RecordID.parse(result_id)})
        refs = [
            {
                "id": RecordID.parse("reference:rdlens_x"),
                "in": RecordID.parse(result_id),
                "out": RecordID.parse(QUERY["notebook_id"]),
            }
        ]
        with _patch_read_queries(row, reference_rows=refs):
            result = await read_rdlens_source(
                RDLensSourceRead(
                    source_id=result_id, notebook_id=QUERY["notebook_id"]
                )
            )
        assert result["source_id"] == result_id

    @pytest.mark.asyncio
    async def test_echo_reference_endpoints_identity_preserving(self):
        """Reference field echoes go through the same serializer."""
        refs = [
            {
                "id": RecordID("reference", "⟨r⟩"),
                "in": RecordID("source", "⟨s⟩"),
                "out": RecordID("notebook", "⟨n⟩"),
            }
        ]
        with _patch_read_queries(
            _source_row({"id": RecordID("source", "⟨s⟩")}),
            notebook_rows={"id": RecordID("notebook", "⟨n⟩")},
            reference_rows=refs,
        ) as conn:
            result = await read_rdlens_source(
                RDLensSourceRead(
                    source_id="source:⟨⟨s\\⟩⟩", notebook_id="notebook:⟨⟨n\\⟩⟩"
                )
            )
        ref = result["references"][0]
        assert ref["id"] == "reference:⟨⟨r\\⟩⟩"
        assert ref["in"] == "source:⟨⟨s\\⟩⟩"
        assert ref["out"] == "notebook:⟨⟨n\\⟩⟩"
        assert result["notebook_id"] == "notebook:⟨⟨n\\⟩⟩"
        assert conn.query.await_args_list[0].args[1]["record_id"] == RecordID(
            "source", "⟨s⟩"
        )

    @pytest.mark.asyncio
    async def test_all_references_returned_sorted_by_id(self):
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse(QUERY["notebook_id"]),
            },
            {
                "id": RecordID.parse("reference:b"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse("notebook:other"),
            },
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            result = await read_rdlens_source(RDLensSourceRead(**QUERY))
        assert [r["id"] for r in result["references"]] == [
            "reference:a",
            "reference:b",
        ]
        assert any(r["out"] == "notebook:other" for r in result["references"])

    @pytest.mark.asyncio
    async def test_duplicate_reference_rows_are_returned_not_hidden(self):
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse(QUERY["notebook_id"]),
            },
            {
                "id": RecordID.parse("reference:b"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse(QUERY["notebook_id"]),
            },
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            result = await read_rdlens_source(RDLensSourceRead(**QUERY))
        assert len(result["references"]) == 2


class TestRowShapeValidation:
    """Invalid row shapes are 500 (RDLensSourceReadError), never a wrong
    404 or a silent pass-through (review Round 1 #8)."""

    @pytest.mark.asyncio
    async def test_source_row_string_id_is_read_error(self):
        row = _source_row({"id": "source:rdlens_f9449a51e0cbbc647f19c3e2aefc26ad"})
        with _patch_read_queries(row):
            with pytest.raises(RDLensSourceReadError, match="unexpected id"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_source_row_mismatched_id_is_read_error(self):
        row = _source_row({"id": RecordID.parse("source:different")})
        with _patch_read_queries(row):
            with pytest.raises(RDLensSourceReadError, match="unexpected id"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_source_row_wrong_table_id_is_read_error(self):
        row = _source_row({"id": RecordID.parse("notebook:rdlens-p1")})
        with _patch_read_queries(row):
            with pytest.raises(RDLensSourceReadError, match="unexpected id"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_notebook_row_missing_id_is_read_error(self):
        with _patch_read_queries(_source_row(), notebook_rows={"name": "NB"}):
            with pytest.raises(
                RDLensSourceReadError, match="notebook row with unexpected id"
            ):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_empty_dict_source_row_is_read_error(self):
        with _patch_read_queries({}):
            with pytest.raises(RDLensSourceReadError, match="unexpected id"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_non_string_identity_field_is_read_error(self):
        row = _source_row({"rdlens_document_id": 12345})
        with _patch_read_queries(row):
            with pytest.raises(RDLensSourceReadError, match="non-string"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_reference_row_with_null_out_is_read_error_not_404(self):
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "in": RecordID.parse(SOURCE_ID),
                "out": None,
            }
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            with pytest.raises(RDLensSourceReadError, match="reference row"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_reference_row_missing_in_is_read_error(self):
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "out": RecordID.parse(QUERY["notebook_id"]),
            }
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            with pytest.raises(RDLensSourceReadError, match="reference row"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_reference_row_from_wrong_source_is_read_error(self):
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "in": RecordID.parse("source:other-source"),
                "out": RecordID.parse(QUERY["notebook_id"]),
            }
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            with pytest.raises(RDLensSourceReadError, match="reference row"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_reference_id_from_wrong_table_is_read_error(self):
        refs = [
            {
                "id": RecordID.parse("notebook:rdlens-p1"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse(QUERY["notebook_id"]),
            }
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            with pytest.raises(RDLensSourceReadError, match="reference row"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_genuinely_unbound_source_is_404(self):
        """With fully valid shapes, a real binding absence maps to 404."""
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse("notebook:other"),
            }
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            with pytest.raises(RDLensSourceNotFoundError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))


class TestErrorSemantics:
    """404 only for genuinely absent identity; DB failures are 500."""

    @pytest.mark.asyncio
    async def test_missing_source_is_404_not_found(self):
        with _patch_read_queries(None):
            with pytest.raises(RDLensSourceNotFoundError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_missing_notebook_is_404_not_found(self):
        with _patch_read_queries(_source_row(), notebook_rows=None):
            with pytest.raises(RDLensSourceNotFoundError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_unbound_source_is_404_not_found(self):
        refs = [
            {
                "id": RecordID.parse("reference:a"),
                "in": RecordID.parse(SOURCE_ID),
                "out": RecordID.parse("notebook:other"),
            }
        ]
        with _patch_read_queries(_source_row(), reference_rows=refs):
            with pytest.raises(RDLensSourceNotFoundError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_database_failure_is_read_error_not_404(self):
        conn = AsyncMock()
        conn.query.side_effect = RuntimeError("connection refused")
        with _patch_connection() as conn_cm:
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            with pytest.raises(RDLensSourceReadError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_operation_timeout_is_read_error(self):
        conn = AsyncMock()
        conn.query.side_effect = asyncio.TimeoutError()
        with _patch_connection() as conn_cm:
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            with pytest.raises(RDLensSourceReadError, match="budget"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_invalid_result_shape_is_read_error(self):
        with _patch_read_queries(["not-a-dict"]):
            with pytest.raises(RDLensSourceReadError, match="shape"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_invalid_reference_row_is_read_error(self):
        with _patch_read_queries(_source_row(), reference_rows=[{"no_id": True}]):
            with pytest.raises(RDLensSourceReadError, match="reference row"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    # --- Round 2 #5: row-shape validation precedes ANY absence judgment -
    # a malformed row yields 500 even when the other record is missing. ---

    @pytest.mark.asyncio
    async def test_missing_notebook_with_malformed_source_id_is_500_not_404(self):
        bad_source = _source_row({"id": "not-a-record-id"})
        with _patch_read_queries(bad_source, notebook_rows=None):
            with pytest.raises(RDLensSourceReadError, match="unexpected id"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_missing_notebook_with_numeric_identity_field_is_500_not_404(self):
        bad_source = _source_row({"rdlens_document_id": 12345})
        with _patch_read_queries(bad_source, notebook_rows=None):
            with pytest.raises(RDLensSourceReadError, match="non-string"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_missing_source_with_malformed_reference_rows_is_500_not_404(self):
        with _patch_read_queries(None, reference_rows=[{"no_id": True}]):
            with pytest.raises(RDLensSourceReadError, match="reference row"):
                await read_rdlens_source(RDLensSourceRead(**QUERY))

    @pytest.mark.asyncio
    async def test_missing_source_with_valid_reference_rows_still_404(self):
        """Reference rows validate cleanly but the source is absent: the
        404 stands (validation order must not turn absence into 500)."""
        with _patch_read_queries(None):
            with pytest.raises(RDLensSourceNotFoundError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))


class TestRouterErrorMapping:
    """HTTP codes: 422 missing/invalid param, 400 invalid record id, 404
    source_not_found, 500 read failed."""

    def _token_headers(self):
        return {"Authorization": "Bearer adapter-only-secret"}

    def test_invalid_record_id_format_maps_to_400(self, adapter_token):
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(side_effect=ValueError("invalid record id")),
        ):
            response = _client().get(
                "/internal/rdlens/source",
                params={
                    "source_id": SOURCE_ID,
                    "notebook_id": "notebook-without-colon",
                },
                headers=self._token_headers(),
            )
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "invalid_parameter"

    def test_missing_query_params_map_to_422(self, adapter_token):
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(return_value={}),
        ) as read:
            response = _client().get(
                "/internal/rdlens/source", headers=self._token_headers()
            )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "missing_parameter"
        read.assert_not_awaited()

    def test_partially_missing_query_params_map_to_422(self, adapter_token):
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(return_value={}),
        ) as read:
            response = _client().get(
                "/internal/rdlens/source",
                params={"source_id": SOURCE_ID},
                headers=self._token_headers(),
            )
        assert response.status_code == 422
        read.assert_not_awaited()

    def test_overlong_parameter_maps_to_422_not_500(self, adapter_token):
        """Pydantic constraint violations surface as 422, not 500 (M6)."""
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(return_value={}),
        ) as read:
            response = _client().get(
                "/internal/rdlens/source",
                params={
                    "source_id": "source:" + "x" * 300,
                    "notebook_id": QUERY["notebook_id"],
                },
                headers=self._token_headers(),
            )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_parameter"
        read.assert_not_awaited()

    def test_not_found_maps_to_404_with_code(self, adapter_token):
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(side_effect=RDLensSourceNotFoundError("missing")),
        ):
            response = _client().get(
                "/internal/rdlens/source",
                params=QUERY,
                headers=self._token_headers(),
            )
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "source_not_found"

    def test_read_error_maps_to_500(self, adapter_token):
        with patch(
            "api.routers.internal_sources.read_rdlens_source",
            new=AsyncMock(side_effect=RDLensSourceReadError("db down")),
        ):
            response = _client().get(
                "/internal/rdlens/source",
                params=QUERY,
                headers=self._token_headers(),
            )
        assert response.status_code == 500
        assert response.json()["detail"]["code"] == "source_read_failed"


class TestConnectionLifecycle:
    """Budgeted GET connection: try/finally, cancel propagation, close isolation."""

    @pytest.mark.asyncio
    async def test_get_uses_operation_budget(self):
        """The GET passes the 5s budget to db_connection."""
        conn = AsyncMock()
        with patch(
            "open_notebook.database.repository.db_connection"
        ) as conn_cm, patch(
            "api.internal_source_service.repo_query", new=AsyncMock(return_value=[])
        ):
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            with pytest.raises(RDLensSourceReadError):
                await read_rdlens_source(RDLensSourceRead(**QUERY))
        kwargs = conn_cm.call_args.kwargs
        assert kwargs.get("operation_budget_seconds") == 5.0

    @pytest.mark.asyncio
    async def test_readback_runs_all_queries_on_one_connection(self):
        """source/notebook/reference queries share the budgeted connection."""
        conn = AsyncMock()
        conn.query.side_effect = [
            _source_row(),
            _notebook_row(),
            _default_ref_rows(),
        ]
        with patch(
            "open_notebook.database.repository.db_connection"
        ) as conn_cm:
            conn_cm.return_value.__aenter__ = AsyncMock(return_value=conn)
            conn_cm.return_value.__aexit__ = AsyncMock(return_value=False)
            result = await read_rdlens_source(RDLensSourceRead(**QUERY))
        assert result["source_id"] == SOURCE_ID
        assert conn.query.await_count == 3
        for call in conn.query.await_args_list:
            vars_arg = call.args[1]
            if "source_id" in vars_arg:
                assert isinstance(vars_arg["source_id"], RecordID)
            if "notebook_id" in vars_arg:
                assert isinstance(vars_arg["notebook_id"], RecordID)

    @pytest.mark.asyncio
    async def test_close_error_does_not_mask_operation_error(self):
        """Cleanup failure must not replace the operation's exception."""
        from open_notebook.database.repository import _close_connection

        conn = AsyncMock()
        conn.close.side_effect = RuntimeError("close failed")

        with patch("asyncio.current_task", return_value=None):
            # No cancel pending; close raises but must be swallowed.
            await _close_connection(conn, RuntimeError("query failed"), 0)

    @pytest.mark.asyncio
    async def test_external_cancel_during_close_is_reraised(self):
        """A NEW cancellation arriving during close is re-raised (M4)."""
        from open_notebook.database.repository import _close_connection

        conn = AsyncMock()

        async def slow_close():
            await asyncio.sleep(0.01)

        conn.close.side_effect = slow_close

        task = asyncio.current_task()
        assert task is not None
        task.cancel()  # baseline 0 at entry of _close_connection → new cancel
        with pytest.raises(asyncio.CancelledError):
            await _close_connection(conn, None, 0)

    @pytest.mark.asyncio
    async def test_stale_cancel_count_before_entry_is_not_misattributed(self):
        """A cancellation delivered and swallowed BEFORE connection entry
        (stale count == the baseline) must not be reported as a cancellation
        delivered during the connection's lifetime (M4: only NEW cancels
        count). Runs in a child task: the pre-entry cancel poisons the task
        that receives it, and only the child's state is under test."""
        from open_notebook.database.repository import (
            _cancel_count,
            _close_connection,
            _new_cancel_since,
        )

        conn = AsyncMock()  # close completes cleanly

        async def child() -> str:
            # Simulate the caller's earlier cancel: delivered into this
            # task's sleep and swallowed, leaving cancelling() == 1.
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                pass
            baseline = _cancel_count()
            assert baseline == 1
            assert not _new_cancel_since(baseline)
            # Must return normally, NOT raise CancelledError.
            await _close_connection(conn, None, baseline)
            return "clean"

        child_task = asyncio.create_task(child())
        await asyncio.sleep(0.05)
        child_task.cancel()  # lands in the child's sleep, swallowed there
        assert await child_task == "clean"

    @pytest.mark.asyncio
    async def test_normal_close_not_misread_as_cancellation(self):
        from open_notebook.database.repository import _close_connection

        conn = AsyncMock()
        conn.close.side_effect = AsyncMock(return_value=None)
        # No cancellation: must return normally.
        await _close_connection(conn, None, 0)

    @pytest.mark.asyncio
    async def test_two_swallowed_cancels_both_survive_reads(self):
        """The cancel-count read never mutates state: after two delivered-
        and-swallowed cancellations, repeated reads both see 2 (Round 1 #4:
        an uncancel()-based probe would consume one, letting a second
        cancellation go undetected)."""
        from open_notebook.database.repository import _cancel_count

        async def child() -> list:
            # Two separate delivered-and-swallowed cancellations.
            for _ in range(2):
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    pass
            return [_cancel_count(), _cancel_count()]

        child_task = asyncio.create_task(child())
        for _ in range(2):
            await asyncio.sleep(0.05)
            child_task.cancel()
        assert await child_task == [2, 2]

    @pytest.mark.asyncio
    async def test_db_connection_yields_client_and_closes_on_error(self):
        """try/finally covers signin+use: close runs even when queries fail."""
        from open_notebook.database.repository import db_connection

        conn = AsyncMock()
        conn.query.side_effect = RuntimeError("boom")

        with patch(
            "open_notebook.database.repository.AsyncSurreal",
            return_value=conn,
        ):
            with pytest.raises(RuntimeError, match="boom"):
                async with db_connection() as c:
                    await c.query("SELECT 1;")
        conn.close.assert_awaited_once()
