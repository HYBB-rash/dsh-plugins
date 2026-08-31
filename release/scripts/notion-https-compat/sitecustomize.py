"""Narrow transport compatibility for the create-only Notion automation."""

from __future__ import annotations

import http.client
import os
from typing import Any


_PRODUCTION_API_BASE = "https://api.notion.com/v1"
_PRODUCTION_HOST = "api.notion.com"
_PRODUCTION_PORT = 443


if os.environ.get("NOTION_API_BASE") == _PRODUCTION_API_BASE:
    _http_connection = http.client.HTTPConnection
    _https_connection = http.client.HTTPSConnection

    def _notion_connection(
        host: str,
        port: int | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> http.client.HTTPConnection:
        if host == _PRODUCTION_HOST and port in (None, _PRODUCTION_PORT):
            return _https_connection(host, port=port, *args, **kwargs)
        return _http_connection(host, port=port, *args, **kwargs)

    http.client.HTTPConnection = _notion_connection  # type: ignore[assignment]
