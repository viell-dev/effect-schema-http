"""
The parts of the file service that were added after the 2016 port.

Each one arrived with a different consumer and none of them matches the SOAP
conventions in ``main.py``:

- ``?wsdl`` as a bare query key, because that is what every SOAP toolkit sends and
  the 2016 port only ever handled ``/wsdl``.
- ``SOAPAction``, required and required to be quoted, because SOAP 1.1 says so and
  because the ESB in front of this service routes on it.
- A SOAP 1.2 action for ``GetFileMetadata``, added when one consumer upgraded its
  stack and refused to downgrade.
- ``PurgeFiles``, written in 2020 by someone who had read the specification and
  emitted a real ``soap:Fault`` with HTTP 500 — correct, and inconsistent with
  every other action here.
- Metadata documents encoded in ISO-8859-1, because the .NET original wrote
  ``Encoding.Default`` on a Western European server and the file names in the
  archive still contain the bytes it produced.
- ``PROPFIND`` on ``/dav/``, because the document management system speaks WebDAV
  and somebody made it work in an afternoon.
- A multipart upload endpoint the 2019 intern added, which answers JSON.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from email import message_from_bytes

NS = "urn:filestore:2011"

# ---------------------------------------------------------------------------
# SOAPAction
# ---------------------------------------------------------------------------


def check_soap_action(headers, action: str | None) -> str | None:
    """Validate the SOAPAction header for SOAP 1.1.

    Returns an error message, or None when the header is acceptable.

    Quirk: the header is mandatory and must be quoted. SOAP 1.1 requires both, and
    the ESB in front of this service routes on the literal quoted string, so an
    unquoted value reaches the wrong queue rather than failing visibly.
    """
    content_type = headers.get("Content-Type", "")
    if content_type.startswith("application/soap+xml"):
        # SOAP 1.2 carries the action inside the content type instead.
        return None

    raw = headers.get("SOAPAction")
    if raw is None:
        return "SOAPAction header is required (SOAP 1.1)"
    if not (raw.startswith('"') and raw.endswith('"')):
        return f"SOAPAction must be quoted; received {raw}"
    if action is not None and raw.strip('"') != f"{NS}/{action}":
        return f'SOAPAction {raw} does not match the body action {action}'
    return None


def soap12_action(headers) -> str | None:
    """Extract the action from a SOAP 1.2 content type, if this is one."""
    content_type = headers.get("Content-Type", "")
    if not content_type.startswith("application/soap+xml"):
        return None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("action="):
            return part[len("action=") :].strip('"').rsplit("/", 1)[-1]
    return None


# ---------------------------------------------------------------------------
# ISO-8859-1 metadata
# ---------------------------------------------------------------------------


def metadata_document_latin1(record: dict) -> bytes:
    """Build the metadata document the archive consumer expects.

    Quirk: the bytes are ISO-8859-1 and the XML declaration says so, but the HTTP
    ``Content-Type`` says only ``text/xml`` with no charset. RFC 2616 said an
    unlabelled ``text/*`` defaults to ISO-8859-1, which is why nobody fixed it; RFC
    7231 removed that default, and every modern client now assumes UTF-8 and
    mangles every accented file name in the archive.
    """
    document = f"""<?xml version="1.0" encoding="ISO-8859-1"?>
<FileMetadata xmlns="{NS}">
  <FileId>{record["id"]}</FileId>
  <FileName>{record["name"]}</FileName>
  <Archivist>Renée Müller</Archivist>
  <Department>Bücherei</Department>
  <ContentType>{record["content_type"]}</ContentType>
  <FileSize>{record["size"]}</FileSize>
  <LastModified>{record["updated_at"].strftime("%m/%d/%Y %H:%M:%S")}</LastModified>
</FileMetadata>"""
    # Characters outside Latin-1 cannot be represented at all; the original service
    # replaced them with "?" and so does this one.
    return document.encode("iso-8859-1", errors="replace")


# ---------------------------------------------------------------------------
# A real SOAP fault, with a real status
# ---------------------------------------------------------------------------


def soap_fault_500(code: str, reason: str) -> bytes:
    """A genuine SOAP 1.1 fault with HTTP 500, as the specification requires.

    Every other failure in this service is a ``FaultCode`` element inside a 200.
    This one is correct, which makes it the exception a client has to special-case.
    """
    document = f"""<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:{code}</faultcode>
      <faultstring>{reason}</faultstring>
      <detail>
        <fs:PurgeRefused xmlns:fs="{NS}">
          <fs:Reason>{reason}</fs:Reason>
        </fs:PurgeRefused>
      </detail>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>"""
    return document.encode("utf-8")


# ---------------------------------------------------------------------------
# WebDAV
# ---------------------------------------------------------------------------


def propfind_document(records: list[dict]) -> bytes:
    """A WebDAV ``multistatus`` document for ``PROPFIND /dav/``.

    ``207 Multi-Status`` is a perfectly ordinary status that most HTTP clients have
    never been asked to handle, and ``PROPFIND`` is a perfectly ordinary method that
    most HTTP clients hard-code themselves out of.
    """
    responses = []
    for record in records:
        responses.append(
            f"""  <D:response>
    <D:href>/dav/{record["id"]}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>{record["name"]}</D:displayname>
        <D:getcontentlength>{record["size"]}</D:getcontentlength>
        <D:getcontenttype>{record["content_type"]}</D:getcontenttype>
        <D:getlastmodified>{record["updated_at"].strftime("%a, %d %b %Y %H:%M:%S GMT")}</D:getlastmodified>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"""
        )

    document = f"""<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>filestore</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
{chr(10).join(responses)}
</D:multistatus>"""
    return document.encode("utf-8")


# ---------------------------------------------------------------------------
# Multipart, in both directions
# ---------------------------------------------------------------------------


def parse_multipart(content_type: str, body: bytes) -> dict[str, tuple[str | None, bytes]]:
    """Parse a ``multipart/form-data`` body into ``{field: (filename, bytes)}``.

    ``cgi.FieldStorage`` was removed in Python 3.13, so this uses the email parser,
    which is what it always was underneath.
    """
    message = message_from_bytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body
    )
    parts: dict[str, tuple[str | None, bytes]] = {}
    if not message.is_multipart():
        return parts
    for part in message.get_payload():
        name = part.get_param("name", header="content-disposition")
        if name is None:
            continue
        filename = part.get_param("filename", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        parts[str(name)] = (str(filename) if filename else None, payload)
    return parts


def build_multipart(fields: list[tuple[str, str | None, str, bytes]]) -> tuple[str, bytes]:
    """Build a ``multipart/form-data`` payload.

    Used for the bundle download, which hands back the metadata and the bytes in one
    response because the document viewer makes one request and cannot make two.
    """
    boundary = f"----filestore{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, filename, content_type, payload in fields:
        disposition = f'form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        chunks.append(f"--{boundary}\r\n".encode("utf-8"))
        chunks.append(f"Content-Disposition: {disposition}\r\n".encode("utf-8"))
        chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"))
        chunks.append(payload)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return f"multipart/form-data; boundary={boundary}", b"".join(chunks)


def upload_receipt(record: dict) -> bytes:
    """The JSON receipt the 2019 multipart endpoint answers with.

    Quirk: it is the only endpoint on this service that speaks JSON, answers a
    correct ``201``, and sets a ``Location`` header. The intern who wrote it had
    never seen SOAP and nobody asked them to.
    """
    return json.dumps(
        {
            "fileId": record["id"],
            "fileName": record["name"],
            "sizeBytes": record["size"],
            "uploadedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    ).encode("utf-8")
